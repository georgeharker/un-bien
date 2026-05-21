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

    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;

    info!("relay listening on {addr}");

    let presence = Arc::new(relay::PresenceManager::new());
    let registry = Arc::new(relay::PeerRegistry::new(presence.clone()));

    relay::serve(listener, registry, presence, async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl_c handler");
        info!("ctrl_c received, shutting down");
    })
    .await;

    Ok(())
}
