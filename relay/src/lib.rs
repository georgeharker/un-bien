pub mod auth;
pub mod handlers;
mod identity;
pub mod membership;
pub mod mesh;
pub mod metrics;
pub mod paths;
pub mod peering;
pub mod peers;
pub mod presence;
pub mod protocol;
pub mod relay_keypair;
pub mod rooms;

use std::sync::Arc;

use axum::{
    Router,
    extract::{DefaultBodyLimit, FromRef},
    routing::get,
};

pub use handlers::pi_forward::MeshAuthCache;
pub use mesh::MeshStore;
pub use metrics::FirehoseMetrics;
pub use peering::FederatedSessions;
pub use peers::pairing::PairingRegistry;
pub use peers::registry::PeerRegistry;
pub use presence::PresenceManager;
pub use rooms::{RoomManager, RoomMeta, RoomMetaPatch};

/// Shared state injected into every axum handler.
///
/// The relay serves WebSocket upgrades (`GET /`), health checks (`GET /health`),
/// and mesh membership endpoints (`GET/POST /mesh/:hash`) on a single port —
/// they all read from this struct.
#[derive(Clone)]
pub struct AppState {
    /// This relay's own peering identity (hello name + visited stamping).
    /// Defaults to the hostname in production; tests override it so multiple
    /// in-process relays have distinct identities.
    pub relay_name: String,
    pub registry: Arc<PeerRegistry>,
    pub presence: Arc<PresenceManager>,
    pub rooms: Arc<RoomManager>,
    /// Per-machine pairing allow-list (extension-pushed) gating the ROOMS
    /// plane. Design 01M1ZE43.
    pub pairing: Arc<PairingRegistry>,
    pub mesh: Arc<MeshStore>,
    /// Plan 25 — caches `Pi-pubkey → mesh siblings` to avoid hitting SQLite
    /// for every `pi_envelope` forward (60 s TTL).
    pub mesh_auth: Arc<MeshAuthCache>,
    /// In-process counters for emit/suppress accounting (firehose dedup).
    /// A background task drains and logs them every 10 s.
    pub metrics: Arc<FirehoseMetrics>,
    /// Federated sessions from peer relays (Phase 3).
    pub federated: Arc<crate::peering::FederatedSessions>,
    /// The WS listener port (P7/P6: `identity_ack` endpoint advertisement).
    /// Set by the binary; in-process test relays set their random port.
    pub ws_port: Option<u16>,
    /// STARTUP-RESOLVED endpoint advertisement (P6): dialable URLs served.
    /// Computed ONCE at boot — DNS never runs on the auth path (a slow
    /// MagicDNS lookup there stalls every peer handshake). Unsigned
    /// REACHABILITY metadata: a spoofed endpoint fails the client's pin.
    pub endpoints: Arc<Vec<String>>,
    /// The relay's own advertised URL (relay_own_url(), DNS — resolved ONCE
    /// at startup; `identity_ack` signs over it; empty = not advertised).
    pub advertised_url: String,
}

// Allows mesh handlers to keep using `State<Arc<MeshStore>>` instead of
// reaching into the full `AppState`.
impl FromRef<AppState> for Arc<MeshStore> {
    fn from_ref(state: &AppState) -> Self {
        state.mesh.clone()
    }
}

/// Builds the unified axum router: WebSocket upgrade + HTTP API.
///
/// Mount it with `axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())`
/// — the WS handler extracts `ConnectInfo<SocketAddr>` for log spans.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(handlers::peer::ws_handler))
        .route("/health", get(|| async { "OK" }))
        .route("/relay-peer", get(peering::relay_peer_ws_handler))
        .route(
            "/mesh/:owner_pk_hash",
            get(mesh::handler::get_mesh).post(mesh::handler::post_mesh),
        )
        .layer(DefaultBodyLimit::max(mesh::handler::MAX_BODY_BYTES))
        .with_state(state)
}

/// Parse a `UNBIEN_RELAY_BIND` spec: comma-separated hostnames or IPs, each
/// optionally `host:port` (port defaults to `default_port`). Names resolve
/// via DNS at call time — the common lockdown form is
/// `localhost,<machine>.<tailnet>.ts.net`, where the MagicDNS name resolves
/// to this machine's own tailnet address, keeping the listening socket OFF
/// every other interface. Unresolvable entries are an ERROR (a wrong bind
/// must fail loudly, not silently skip); resolved duplicates are deduped.
pub fn parse_bind_addrs(
    spec: &str,
    default_port: u16,
) -> anyhow::Result<Vec<std::net::SocketAddr>> {
    use anyhow::Context as _;
    use std::net::ToSocketAddrs;
    let mut out: Vec<std::net::SocketAddr> = Vec::new();
    for entry in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        // IPv6 literals carry colons — parse the plain IP first so they take
        // the default port and get bracketed; anything else with a colon is
        // host:port.
        let hostport = if let Ok(ip) = entry.parse::<std::net::IpAddr>() {
            match ip {
                std::net::IpAddr::V6(_) => format!("[{ip}]:{default_port}"),
                _ => format!("{ip}:{default_port}"),
            }
        } else if entry.contains(':') {
            entry.to_string()
        } else {
            format!("{entry}:{default_port}")
        };
        let resolved: Vec<std::net::SocketAddr> = hostport
            .to_socket_addrs()
            .with_context(|| format!("cannot resolve bind address {entry}"))?
            .collect();
        if resolved.is_empty() {
            anyhow::bail!("bind address {entry} resolved to nothing");
        }
        for addr in resolved {
            if !out.contains(&addr) {
                out.push(addr);
            }
        }
    }
    anyhow::ensure!(!out.is_empty(), "no bind addresses in {spec:?}");
    Ok(out)
}

#[cfg(test)]
mod bind_tests {
    use super::parse_bind_addrs;

    #[test]
    fn ip_literals_and_default_port() {
        assert_eq!(
            parse_bind_addrs("127.0.0.1", 3000).unwrap(),
            vec!["127.0.0.1:3000".parse().unwrap()]
        );
    }

    #[test]
    fn multiple_entries_dedup_and_explicit_ports() {
        // localhost resolves to BOTH stacks on many systems — dedup by the
        // resolved set, and explicit host:port wins over the default port.
        let addrs = parse_bind_addrs("127.0.0.1, 127.0.0.1:3443, 0.0.0.0", 3000).unwrap();
        assert!(addrs.contains(&"127.0.0.1:3000".parse().unwrap()));
        assert!(addrs.contains(&"127.0.0.1:3443".parse().unwrap()));
        assert!(addrs.contains(&"0.0.0.0:3000".parse().unwrap()));
        assert_eq!(addrs.len(), 3);
    }

    #[test]
    fn ipv6_literal_takes_the_default_port() {
        assert_eq!(
            parse_bind_addrs("::1", 3000).unwrap(),
            vec!["[::1]:3000".parse().unwrap()]
        );
    }

    #[test]
    fn unresolvable_is_a_loud_error() {
        // .invalid is the RFC-reserved never-resolving TLD.
        assert!(parse_bind_addrs("nope.invalid", 3000).is_err());
    }

    #[test]
    fn empty_spec_is_rejected() {
        assert!(parse_bind_addrs("", 3000).is_err());
        assert!(parse_bind_addrs(" , ", 3000).is_err());
    }
}
