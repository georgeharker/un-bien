use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let port: u16 = std::env::var("REMOTEPI_RELAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);

    // Default puts the SQLite file (and any transient -journal) under data/,
    // so bare-metal `cargo run` doesn't litter the project root.
    let db_path = std::env::var("REMOTEPI_MESH_DB_PATH")
        .unwrap_or_else(|_| "data/mesh.db".to_string());

    let mesh = Arc::new(
        relay::MeshStore::open(&db_path)
            .with_context(|| format!("failed to open mesh DB at {db_path}"))?,
    );
    info!("mesh storage opened at {db_path}");

    let presence = Arc::new(relay::PresenceManager::new());
    let rooms = Arc::new(relay::RoomManager::new());
    let registry = Arc::new(relay::PeerRegistry::new(presence.clone(), rooms.clone()));

    let state = relay::AppState { registry, presence, rooms, mesh };
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
