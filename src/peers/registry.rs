use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::presence::PresenceManager;
use crate::rooms::{RoomManager, RoomMeta};

type RoomKey = (String, String); // (peer_id, room_id)
type ConnEntry = (u64, RoomMeta, mpsc::UnboundedSender<Message>);

/// Maps (peer_id, room_id) pairs to their send channels.
///
/// Key invariant: each (peer_id, room_id) allows at most one live connection.
/// A second registration for the same pair returns `Err(())` so the caller can
/// send an error frame and close the new WS, matching D9 of plano 17.
#[derive(Debug)]
pub struct PeerRegistry {
    next_conn: AtomicU64,
    senders: Mutex<HashMap<RoomKey, ConnEntry>>,
    presence: Arc<PresenceManager>,
    rooms: Arc<RoomManager>,
}

impl PeerRegistry {
    pub fn new(presence: Arc<PresenceManager>, rooms: Arc<RoomManager>) -> Self {
        Self {
            next_conn: AtomicU64::new(0),
            senders: Mutex::new(HashMap::new()),
            presence,
            rooms,
        }
    }

    /// Registers `(peer_id, room_meta.room_id)` → `tx`.
    ///
    /// Returns `Ok(conn_id)` on success.
    /// Returns `Err(())` if the (peer_id, room_id) pair is already registered — caller
    /// must send an error frame and close the WS.
    pub async fn register(
        &self,
        peer_id: String,
        room_meta: RoomMeta,
        tx: mpsc::UnboundedSender<Message>,
    ) -> Result<u64, ()> {
        let room_id = room_meta.room_id.clone();
        let key = (peer_id.clone(), room_id.clone());

        let conn_id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let is_first_room;
        {
            let mut lock = self.senders.lock().unwrap();
            if lock.contains_key(&key) {
                return Err(());
            }
            is_first_room = !lock.keys().any(|(p, _)| p == &peer_id);
            lock.insert(key, (conn_id, room_meta.clone(), tx));
        }

        // Broadcast room_announced to room subscribers.
        // Use to_value so skip_serializing_if on RoomMeta fields applies automatically.
        let room_subs = self.rooms.subscribers_of(&peer_id).await;
        if !room_subs.is_empty() {
            let mut announced =
                serde_json::to_value(&room_meta).expect("RoomMeta serialization is infallible");
            announced["type"] = "room_announced".into();
            announced["peer"] = peer_id.as_str().into();
            let msg = announced.to_string();
            for sub in &room_subs {
                self.forward_to_all_rooms_of(sub, Message::text(msg.clone()));
            }
        }

        // peer_online only fires on the first room (0 → 1).
        if is_first_room {
            let pres_subs = self.presence.subscribers_of(&peer_id).await;
            if !pres_subs.is_empty() {
                let msg =
                    serde_json::json!({"type": "peer_online", "peer": peer_id}).to_string();
                for sub in pres_subs {
                    self.forward_to_all_rooms_of(&sub, Message::text(msg.clone()));
                }
            }
        }

        Ok(conn_id)
    }

    /// Removes the `(peer_id, room_id)` entry only if the stored conn_id matches,
    /// broadcasts `room_ended`, and — when this was the last room — also broadcasts
    /// `peer_offline` and cleans up presence/room subscriptions.
    pub async fn unregister(&self, peer_id: &str, room_id: &str, conn_id: u64) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        {
            let mut lock = self.senders.lock().unwrap();
            let key = (peer_id.to_string(), room_id.to_string());
            if let Some(&(stored, _, _)) = lock.get(&key)
                && stored == conn_id
            {
                lock.remove(&key);
            }
        }

        // Broadcast room_ended to room subscribers.
        let room_subs = self.rooms.subscribers_of(peer_id).await;
        if !room_subs.is_empty() {
            let msg = serde_json::json!({
                "type": "room_ended",
                "peer": peer_id,
                "room_id": room_id,
                "since_ts": now_ms,
            })
            .to_string();
            for sub in &room_subs {
                self.forward_to_all_rooms_of(sub, Message::text(msg.clone()));
            }
        }

        // Check if the peer has any remaining rooms; if not, go fully offline.
        let has_other_rooms = {
            let lock = self.senders.lock().unwrap();
            lock.keys().any(|(p, _)| p == peer_id)
        };

        if !has_other_rooms {
            let pres_subs = self.presence.subscribers_of(peer_id).await;
            if !pres_subs.is_empty() {
                let msg = serde_json::json!({
                    "type": "peer_offline",
                    "peer": peer_id,
                    "since_ts": now_ms,
                })
                .to_string();
                for sub in pres_subs {
                    self.forward_to_all_rooms_of(&sub, Message::text(msg.clone()));
                }
            }
            self.presence.record_offline(peer_id, now_ms).await;
            self.presence.unsubscribe_all(peer_id).await;
        }
    }

    /// Returns `true` if `peer_id` has at least one active room.
    pub fn is_online(&self, peer_id: &str) -> bool {
        let lock = self.senders.lock().unwrap();
        lock.keys().any(|(p, _)| p == peer_id)
    }

    /// Returns metadata for all active rooms of `peer_id`.
    pub fn rooms_of(&self, peer_id: &str) -> Vec<RoomMeta> {
        let lock = self.senders.lock().unwrap();
        lock.iter()
            .filter(|((p, _), _)| p == peer_id)
            .map(|(_, (_, meta, _))| meta.clone())
            .collect()
    }

    /// Forwards `msg` to the specific `(dest_peer, dest_room)` pair.
    /// Returns `false` if the pair is unknown or the channel is closed.
    /// Never inspects message content.
    pub fn forward(&self, dest_peer: &str, dest_room: &str, msg: Message) -> bool {
        let lock = self.senders.lock().unwrap();
        let key = (dest_peer.to_string(), dest_room.to_string());
        if let Some((_, _, tx)) = lock.get(&key) {
            tx.send(msg).is_ok()
        } else {
            false
        }
    }

    /// Updates the stored `model` for `(peer_id, room_id)` and broadcasts
    /// `room_meta_updated` to all room subscribers. Returns `false` if the
    /// (peer_id, room_id) pair is not registered (caller should warn + drop).
    pub async fn update_room_meta(
        &self,
        peer_id: &str,
        room_id: &str,
        model: Option<String>,
    ) -> bool {
        {
            let mut lock = self.senders.lock().unwrap();
            let key = (peer_id.to_string(), room_id.to_string());
            match lock.get_mut(&key) {
                Some((_, meta, _)) => meta.model = model.clone(),
                None => return false,
            }
        }

        let room_subs = self.rooms.subscribers_of(peer_id).await;
        if !room_subs.is_empty() {
            let msg = serde_json::json!({
                "type": "room_meta_updated",
                "peer": peer_id,
                "room_id": room_id,
                "meta": { "model": model },
            })
            .to_string();
            for sub in &room_subs {
                self.forward_to_all_rooms_of(sub, Message::text(msg.clone()));
            }
        }

        true
    }

    /// Sends `msg` to every active room of `peer_id` (used for control-frame pushes
    /// where the subscriber's room isn't known in advance).
    fn forward_to_all_rooms_of(&self, peer_id: &str, msg: Message) {
        let lock = self.senders.lock().unwrap();
        for ((p, _), (_, _, tx)) in lock.iter() {
            if p == peer_id {
                let _ = tx.send(msg.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presence::PresenceManager;
    use crate::rooms::{RoomManager, RoomMeta};

    fn make_meta(room_id: &str) -> RoomMeta {
        RoomMeta { room_id: room_id.into(), name: None, cwd: None, model: None, started_at: 0 }
    }

    fn make_registry() -> PeerRegistry {
        let presence = Arc::new(PresenceManager::new());
        let rooms = Arc::new(RoomManager::new());
        PeerRegistry::new(presence, rooms)
    }

    #[tokio::test]
    async fn two_rooms_same_peer_both_accepted() {
        let reg = make_registry();
        let peer = "peer_a".to_string();

        let (tx_main, mut rx_main) = mpsc::unbounded_channel::<Message>();
        let (tx_work, mut rx_work) = mpsc::unbounded_channel::<Message>();

        let conn_main = reg.register(peer.clone(), make_meta("main"), tx_main).await.unwrap();
        let conn_work = reg.register(peer.clone(), make_meta("work"), tx_work).await.unwrap();

        assert_ne!(conn_main, conn_work);

        // Forward to "main" reaches rx_main
        assert!(reg.forward(&peer, "main", Message::text("to_main")));
        assert_eq!(rx_main.try_recv().unwrap().to_text().unwrap(), "to_main");

        // Forward to "work" reaches rx_work
        assert!(reg.forward(&peer, "work", Message::text("to_work")));
        assert_eq!(rx_work.try_recv().unwrap().to_text().unwrap(), "to_work");

        // Unregister "work" — "main" still alive
        reg.unregister(&peer, "work", conn_work).await;
        assert!(!reg.forward(&peer, "work", Message::text("gone")));
        assert!(reg.forward(&peer, "main", Message::text("still_there")));
        let _ = rx_main.try_recv();
    }

    #[tokio::test]
    async fn duplicate_room_rejected() {
        let reg = make_registry();
        let peer = "peer_a".to_string();

        let (tx1, _rx1) = mpsc::unbounded_channel::<Message>();
        let (tx2, _rx2) = mpsc::unbounded_channel::<Message>();

        assert!(reg.register(peer.clone(), make_meta("main"), tx1).await.is_ok());
        assert!(reg.register(peer.clone(), make_meta("main"), tx2).await.is_err(),
            "second registration for same (peer, room) must be rejected");
    }

    #[tokio::test]
    async fn stale_unregister_is_noop() {
        let reg = make_registry();
        let peer = "peer_a".to_string();

        let (tx_a, _) = mpsc::unbounded_channel::<Message>();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<Message>();

        // Register twice for different rooms to get conn_a and conn_b
        let conn_a = reg.register(peer.clone(), make_meta("main"), tx_a).await.unwrap();
        // Unregister "main" with conn_a, then register a fresh conn for "main"
        reg.unregister(&peer, "main", conn_a).await;
        let conn_b = reg.register(peer.clone(), make_meta("main"), tx_b).await.unwrap();

        // Stale unregister with old conn_a is no-op (conn_b still alive)
        reg.unregister(&peer, "main", conn_a).await;
        assert!(reg.forward(&peer, "main", Message::text("alive")));
        assert_eq!(rx_b.try_recv().unwrap().to_text().unwrap(), "alive");

        // Correct unregister removes entry
        reg.unregister(&peer, "main", conn_b).await;
        assert!(!reg.forward(&peer, "main", Message::text("gone")));
    }
}
