use std::sync::Arc;

use anyhow::Context;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, warn};

/// Minimal HTTP server that replies `200 OK` to any request.
/// Used by Docker / load-balancer health checks.
async fn run_health_server(port: u16) {
    let addr = format!("0.0.0.0:{port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            warn!("health server could not bind {addr}: {e}");
            return;
        }
    };
    info!("health check listening on {addr}");
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(async move {
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                .await;
        });
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let port: u16 = std::env::var("REMOTEPI_RELAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);

    let health_port: u16 = std::env::var("REMOTEPI_HEALTH_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);

    tokio::spawn(run_health_server(health_port));

    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;

    info!("relay listening on {addr}");

    let presence = Arc::new(relay::PresenceManager::new());
    let rooms = Arc::new(relay::RoomManager::new());
    let registry = Arc::new(relay::PeerRegistry::new(presence.clone(), rooms.clone()));

    relay::serve(listener, registry, presence, rooms, async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl_c handler");
        info!("ctrl_c received, shutting down");
    })
    .await;

    Ok(())
}
