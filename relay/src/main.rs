use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // --version / -V: the first diagnostic question under the deploy-stale-
    // binary trap is "which build is running" — print and exit.
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && (args[1] == "--version" || args[1] == "-V") {
        println!("unbien-relay {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    init_tracing();

    let port: u16 = std::env::var("UNBIEN_RELAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);

    // Read (and memoize) the outer-envelope size ceiling once at startup, then
    // log the effective value so ops can confirm RELAY_MAX_CT_MIB took effect.
    let max_ct_bytes = relay::protocol::outer::max_ct_bytes();
    info!(max_ct_bytes, "outer envelope size limit");

    // The DB lands under the shared state root (`UNBIEN_STATE_DIR` /
    // XDG-style default) — `UNBIEN_MESH_DB_PATH` still wins as the direct
    // override (Docker presets it to /data/mesh.db). The old CWD-relative
    // `data/mesh.db` default is gone: it littered whatever directory the
    // relay happened to start in. MeshStore::open creates the parent dir.
    let db_path = relay::paths::resolve_mesh_db_path();

    let mesh = Arc::new(
        relay::MeshStore::open(&db_path)
            .with_context(|| format!("failed to open mesh DB at {}", db_path.display()))?,
    );
    info!("mesh storage opened at {}", db_path.display());

    let presence = Arc::new(relay::PresenceManager::new());
    let rooms = Arc::new(relay::RoomManager::new());
    let metrics = Arc::new(relay::FirehoseMetrics::new());
    let registry = Arc::new(relay::PeerRegistry::new(
        presence.clone(),
        rooms.clone(),
        metrics.clone(),
    ));
    let mesh_auth = Arc::new(relay::MeshAuthCache::new());
    // Pairing allow-list in its OWN sqlite store (design 01M1ZE43): survives
    // restart so the fail-closed gate doesn't re-open a leak window each boot.
    let pairing_db = relay::paths::resolve_pairing_db_path();
    let pairing = Arc::new(
        relay::PairingRegistry::with_store(&pairing_db).unwrap_or_else(|e| {
            // tracing (not eprintln!): lands in relay.log DATESTAMPED — an
            // undated fallback notice is undiagnosable next to dated lines.
            warn!(
                "pairing store open failed at {}: {e}; falling back to in-memory (still fail-closed; re-pushed on each connect)",
                pairing_db.display()
            );
            relay::PairingRegistry::new()
        }),
    );

    // Background reporter: drain firehose counters every 10 s and emit a
    // single structured log line. Quiet windows are silent.
    let metrics_for_reporter = metrics.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        interval.tick().await; // first tick is immediate; skip it
        loop {
            interval.tick().await;
            metrics_for_reporter.report_and_reset();
        }
    });

    // BIND ADDRESSES (UNBIEN_RELAY_BIND): comma-separated hostnames or IPs,
    // each optionally host:port (default UNBIEN_RELAY_PORT). Default
    // 0.0.0.0 = all interfaces, the historical behavior. The lockdown form:
    // UNBIEN_RELAY_BIND=localhost,droplet.<tailnet>.ts.net — names resolve
    // at startup (MagicDNS resolves to this machine's own tailnet
    // address), so the socket never opens on any other interface. Each
    // address gets its own listener + server task sharing one router.
    let bind_spec = std::env::var("UNBIEN_RELAY_BIND").unwrap_or_else(|_| "0.0.0.0".to_string());
    // Resolving ONCE here drives BOTH the listeners and the endpoint
    // advertisement — the auth path never re-resolves (a stalled MagicDNS
    // lookup must not block peer handshakes).
    let addrs = relay::parse_bind_addrs(&bind_spec, port)?;

    let federated = Arc::new(relay::peering::FederatedSessions::new());
    // Endpoint advertisement computed ONCE: the spec as dialed + the resolved
    // listener addresses (parse_bind_addrs did the DNS at startup already).
    let endpoints = Arc::new(relay::peering::relay_bind_urls_for(&bind_spec, port, &addrs));
    // The relay's own URL: DNS ONCE here (memoized inside) — never on the
    // per-handshake path.
    let advertised_url = relay::peering::relay_own_url().unwrap_or_default();
    let state = relay::AppState {
        registry,
        presence,
        rooms,
        pairing,
        mesh,
        mesh_auth,
        metrics,
        relay_name: relay::peering::default_relay_name(),
        federated: Arc::clone(&federated),
        ws_port: Some(port),
        endpoints,
        advertised_url,
    };
    relay::peering::start_peering(
        std::sync::Arc::clone(&state.mesh),
        std::sync::Arc::clone(&state.registry),
        std::sync::Arc::clone(&state.pairing),
        Arc::clone(&federated),
    );
    let app = relay::build_router(state);

    let mut servers = Vec::new();
    for addr in addrs {
        let listener = TcpListener::bind(addr)
            .await
            .with_context(|| format!("failed to bind {addr}"))?;
        info!("relay listening on {addr} (WebSocket + /health + /mesh)");
        let service = app
            .clone()
            .into_make_service_with_connect_info::<SocketAddr>();
        servers.push(tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, service)
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await
            {
                tracing::error!("server on {addr} failed: {e}");
                std::process::exit(1);
            }
        }));
    }

    for server in servers {
        let _ = server.await;
    }

    Ok(())
}

/// `debug.relay` pref: the relay has no CLI/config surface of its own, so it
/// reads the SAME global un-bien config the extension uses —
/// `$PI_CODING_AGENT_DIR|~/.pi` + `/extensions/un-bien.json` — and, when
/// `debug.relay` is true, upgrades the filter to INFO (mesh storage, listen,
/// peer/room lifecycle — all datestamped by the fmt layers). An explicit
/// RUST_LOG always wins; the default (pref off / config unreadable) is
/// today's behavior — `EnvFilter::from_default_env()`, ERROR-only when
/// RUST_LOG is unset. Read ONCE at startup; restart the relay to pick up a
/// flip.
fn relay_log_filter() -> tracing_subscriber::EnvFilter {
    if std::env::var_os("RUST_LOG").is_some() {
        return tracing_subscriber::EnvFilter::from_default_env();
    }
    let enabled = std::env::var("PI_CODING_AGENT_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| std::path::PathBuf::from(h).join(".pi")))
        .map(|base| base.join("extensions").join("un-bien.json"))
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("debug")
                .and_then(|d| d.get("relay"))
                .and_then(|b| b.as_bool())
        })
        .unwrap_or(false);
    if enabled {
        tracing_subscriber::EnvFilter::try_new("info").unwrap_or_default()
    } else {
        tracing_subscriber::EnvFilter::from_default_env()
    }
}

/// Install the global subscriber: stdout exactly as `tracing_subscriber::
/// fmt::init()` behaved (same default fmt layer, same `EnvFilter` from
/// `RUST_LOG`), plus a best-effort second layer appending to
/// `<state root>/relay.log`. The relay used to depend on whoever launched it
/// to redirect output somewhere useful (relay.log ended up in the CONFIG
/// tree by accident); now it owns a log file in its own state root. If the
/// file can't be opened, the stdout-only setup proceeds untouched.
fn init_tracing() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let file_layer = open_relay_log().map(|file| {
        tracing_subscriber::fmt::layer()
            .with_ansi(false) // plain text in a log file
            .with_writer(std::sync::Mutex::new(file))
    });
    tracing_subscriber::registry()
        .with(relay_log_filter())
        .with(tracing_subscriber::fmt::layer())
        .with(file_layer)
        .init();
}

/// Open `<state root>/relay.log` for append, creating the state root if
/// needed. Best-effort: on failure, note it on stderr and return None.
fn open_relay_log() -> Option<std::fs::File> {
    let path = relay::paths::resolve_relay_log_path();
    let open = || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
    };
    match open() {
        Ok(file) => Some(file),
        Err(err) => {
            // tracing (not eprintln!): datestamped on stdout — which the
            // service units redirect into relay.log — so this notice lines up
            // with the rest of the log even though the file layer is off.
            error!(
                "unbien-relay: cannot open log file at {} ({err}); logging to stdout only",
                path.display()
            );
            None
        }
    }
}
