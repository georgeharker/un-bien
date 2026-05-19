use std::collections::HashMap;
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Maps authenticated peer IDs (base64 of Ed25519 pubkey) to their send channels.
/// Each registered connection gets a unique `conn_id`; `unregister` only removes
/// the entry when the stored `conn_id` matches, preventing a reconnect from
/// erasing the entry of the newer connection.
#[derive(Debug, Default)]
pub struct PeerRegistry {
    next_conn: AtomicU64,
    senders: Mutex<HashMap<String, (u64, mpsc::UnboundedSender<Message>)>>,
}

impl PeerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `peer_id` → `tx` and returns a unique `conn_id` for this connection.
    /// If `peer_id` was already registered, the old entry (and its sender) is replaced.
    pub fn register(&self, peer_id: String, tx: mpsc::UnboundedSender<Message>) -> u64 {
        let conn_id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        self.senders.lock().unwrap().insert(peer_id, (conn_id, tx));
        conn_id
    }

    /// Removes the entry for `peer_id` only if the stored conn_id equals `conn_id`.
    /// A stale unregister (from a superseded connection) is a no-op.
    pub fn unregister(&self, peer_id: &str, conn_id: u64) {
        let mut lock = self.senders.lock().unwrap();
        if let Some(&(stored, _)) = lock.get(peer_id)
            && stored == conn_id
        {
            lock.remove(peer_id);
        }
    }

    /// Forwards `msg` to `dest`. Returns `false` if peer is unknown or channel closed.
    /// Never inspects message content.
    pub fn forward(&self, dest: &str, msg: Message) -> bool {
        let lock = self.senders.lock().unwrap();
        if let Some((_, tx)) = lock.get(dest) {
            tx.send(msg).is_ok()
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplicate_register_keeps_latest() {
        let reg = PeerRegistry::new();
        let peer = "peer_a".to_string();

        let (tx_a, mut rx_a) = mpsc::unbounded_channel::<Message>();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<Message>();

        let conn_a = reg.register(peer.clone(), tx_a);
        // second register overwrites — tx_a is dropped, rx_a is now disconnected
        let conn_b = reg.register(peer.clone(), tx_b);

        assert_ne!(conn_a, conn_b, "each registration must produce a distinct conn_id");

        // rx_a is orphaned: all senders dropped, channel is closed
        assert!(
            rx_a.try_recv().is_err(),
            "rx_a must be closed after tx_a was evicted"
        );

        // forward reaches only the latest registration (tx_b)
        assert!(reg.forward(&peer, Message::text("hello")));
        assert_eq!(rx_b.try_recv().unwrap().to_text().unwrap(), "hello");

        // unregister with the OLD conn_id must be a no-op
        reg.unregister(&peer, conn_a);
        assert!(
            reg.forward(&peer, Message::text("still alive")),
            "conn_b must still be registered after stale unregister"
        );
        let _ = rx_b.try_recv();

        // unregister with the CURRENT conn_id removes the entry
        reg.unregister(&peer, conn_b);
        assert!(
            !reg.forward(&peer, Message::text("gone")),
            "forward must return false after correct unregister"
        );
    }
}
