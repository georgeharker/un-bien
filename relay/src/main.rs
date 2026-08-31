use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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

    let state = relay::AppState {
        registry,
        presence,
        rooms,
        mesh,
        mesh_auth,
        metrics,
    };
    let app = relay::build_router(state);

    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;

    info!("relay listening on {addr} (WebSocket + /health + /mesh)");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl_c handler");
        info!("ctrl_c received, shutting down");
    })
    .await
    .context("axum::serve failed")?;

    Ok(())
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
        .with(tracing_subscriber::EnvFilter::from_default_env())
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
            eprintln!(
                "unbien-relay: cannot open log file at {} ({err}); logging to stdout only",
                path.display()
            );
            None
        }
    }
}
