use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::presence::PresenceManager;

/// Maps authenticated peer IDs (base64 of Ed25519 pubkey) to their send channels.
/// Each registered connection gets a unique `conn_id`; `unregister` only removes
/// the entry when the stored `conn_id` matches, preventing a reconnect from
/// erasing the entry of the newer connection.
#[derive(Debug)]
pub struct PeerRegistry {
    next_conn: AtomicU64,
    senders: Mutex<HashMap<String, (u64, mpsc::UnboundedSender<Message>)>>,
    presence: Arc<PresenceManager>,
}

impl PeerRegistry {
    pub fn new(presence: Arc<PresenceManager>) -> Self {
        Self {
            next_conn: AtomicU64::new(0),
            senders: Mutex::new(HashMap::new()),
            presence,
        }
    }

    /// Registers `peer_id` → `tx`, returns a unique `conn_id` for this connection,
    /// and broadcasts `peer_online` to all current subscribers.
    pub async fn register(&self, peer_id: String, tx: mpsc::UnboundedSender<Message>) -> u64 {
        let conn_id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        {
            self.senders.lock().unwrap().insert(peer_id.clone(), (conn_id, tx));
        }
        let subscribers = self.presence.subscribers_of(&peer_id).await;
        if !subscribers.is_empty() {
            let msg = serde_json::json!({"type": "peer_online", "peer": peer_id}).to_string();
            for sub in subscribers {
                self.forward(&sub, Message::text(msg.clone()));
            }
        }
        conn_id
    }

    /// Removes the entry for `peer_id` only if the stored conn_id matches,
    /// broadcasts `peer_offline` to subscribers, and cleans up presence state.
    pub async fn unregister(&self, peer_id: &str, conn_id: u64) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        {
            let mut lock = self.senders.lock().unwrap();
            if let Some(&(stored, _)) = lock.get(peer_id)
                && stored == conn_id
            {
                lock.remove(peer_id);
            }
        }

        let subscribers = self.presence.subscribers_of(peer_id).await;
        if !subscribers.is_empty() {
            let msg = serde_json::json!({"type": "peer_offline", "peer": peer_id, "since_ts": now_ms})
                .to_string();
            for sub in subscribers {
                self.forward(&sub, Message::text(msg.clone()));
            }
        }

        self.presence.record_offline(peer_id, now_ms).await;
        self.presence.unsubscribe_all(peer_id).await;
    }

    /// Returns `true` if `peer_id` is currently connected.
    pub fn is_online(&self, peer_id: &str) -> bool {
        self.senders.lock().unwrap().contains_key(peer_id)
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
    use crate::presence::PresenceManager;

    #[tokio::test]
    async fn duplicate_register_keeps_latest() {
        let presence = Arc::new(PresenceManager::new());
        let reg = PeerRegistry::new(presence);
        let peer = "peer_a".to_string();

        let (tx_a, mut rx_a) = mpsc::unbounded_channel::<Message>();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<Message>();

        let conn_a = reg.register(peer.clone(), tx_a).await;
        // second register overwrites — tx_a is dropped, rx_a is now disconnected
        let conn_b = reg.register(peer.clone(), tx_b).await;

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
        reg.unregister(&peer, conn_a).await;
        assert!(
            reg.forward(&peer, Message::text("still alive")),
            "conn_b must still be registered after stale unregister"
        );
        let _ = rx_b.try_recv();

        // unregister with the CURRENT conn_id removes the entry
        reg.unregister(&peer, conn_b).await;
        assert!(
            !reg.forward(&peer, Message::text("gone")),
            "forward must return false after correct unregister"
        );
    }
}
