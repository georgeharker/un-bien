pub mod auth;
pub mod handlers;
pub mod peers;
pub mod presence;
pub mod protocol;
pub mod rooms;

use std::sync::Arc;

use tokio::net::TcpListener;

use handlers::peer::handle_peer;
pub use peers::registry::PeerRegistry;
pub use presence::PresenceManager;
pub use rooms::{RoomManager, RoomMeta};

/// Accepts WebSocket connections in a loop, spawning a task per peer.
/// Exits cleanly when `shutdown` resolves (e.g. ctrl_c).
pub async fn serve(
    listener: TcpListener,
    registry: Arc<PeerRegistry>,
    presence: Arc<PresenceManager>,
    rooms: Arc<RoomManager>,
    shutdown: impl std::future::Future<Output = ()>,
) {
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((socket, addr)) => {
                        tracing::info!(addr = %addr, "new connection");
                        let reg = Arc::clone(&registry);
                        let pres = Arc::clone(&presence);
                        let rms = Arc::clone(&rooms);
                        tokio::spawn(handle_peer(socket, reg, pres, rms));
                    }
                    Err(e) => {
                        tracing::error!(err = %e, "accept error");
                    }
                }
            }
            _ = &mut shutdown => {
                tracing::info!("relay shutting down");
                break;
            }
        }
    }
}
