pub mod auth;
pub mod handlers;
pub mod mesh;
pub mod peers;
pub mod presence;
pub mod protocol;
pub mod rooms;

use std::sync::Arc;

use axum::{
    Router,
    extract::{DefaultBodyLimit, FromRef},
    routing::get,
};

pub use mesh::MeshStore;
pub use peers::registry::PeerRegistry;
pub use presence::PresenceManager;
pub use rooms::{RoomManager, RoomMeta};

/// Shared state injected into every axum handler.
///
/// The relay serves WebSocket upgrades (`GET /`), health checks (`GET /health`),
/// and mesh membership endpoints (`GET/POST /mesh/:hash`) on a single port —
/// they all read from this struct.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<PeerRegistry>,
    pub presence: Arc<PresenceManager>,
    pub rooms: Arc<RoomManager>,
    pub mesh: Arc<MeshStore>,
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
        .route(
            "/mesh/:owner_pk_hash",
            get(mesh::handler::get_mesh).post(mesh::handler::post_mesh),
        )
        .layer(DefaultBodyLimit::max(mesh::handler::MAX_BODY_BYTES))
        .with_state(state)
}
