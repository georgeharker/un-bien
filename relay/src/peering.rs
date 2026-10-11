//! Relay-to-relay peering (federation).
//!
//! Phase 2: connect to peer relays + shared-owner verification. Each relay
//! reads `relay-peers.json` (per-machine, managed by the CLI), connects
//! outbound to each peer relay's `/relay-peer` endpoint, and exchanges
//! `relay_hello` frames carrying the owner public-key hashes each relay
//! knows (from `mesh_versions`). If the two relays share a common owner
//! (hash intersection is non-empty), they federate — the connection stays
//! open for Phase 3 (peer list exchange + cross-relay forwarding). If no
//! common owner, they disconnect.

use std::collections::HashSet;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use std::sync::Arc;

use crate::AppState;

use crate::mesh::store::MeshStore;
use crate::paths::relay_peers_path;

/// A peer relay entry from `relay-peers.json`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RelayPeerConfig {
    pub url: String,
    pub name: String,
}

/// Read the peering config from `<state_root>/relay-peers.json`.
pub fn read_peer_config() -> Vec<RelayPeerConfig> {
    let path = relay_peers_path();
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => {
                    warn!("relay-peers.json parse error: {e}");
                    return Vec::new();
                }
            };
            let empty = serde_json::Value::Array(vec![]);
            let peers = parsed
                .get("peers")
                .and_then(|v| v.as_array())
                .unwrap_or(empty.as_array().unwrap());
            peers
                .iter()
                .filter_map(|p| serde_json::from_value(p.clone()).ok())
                .collect()
        }
        Err(_) => Vec::new(),
    }
}

/// The owner hashes this relay knows about (from `mesh_versions`).
fn owner_hashes(mesh: &MeshStore) -> HashSet<String> {
    mesh.all_owner_hashes()
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Check if two relay's owner hash sets share a common owner.
fn has_common_owner(ours: &HashSet<String>, theirs: &HashSet<String>) -> bool {
    ours.intersection(theirs).next().is_some()
}

/// The wire frame exchanged on connect.
#[derive(Debug, Deserialize, Serialize)]
pub struct RelayHello {
    #[serde(rename = "type")]
    pub kind: String,
    pub owners: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RelayHelloAck {
    #[serde(rename = "type")]
    pub kind: String,
    pub federate: bool,
    pub owners: Vec<String>,
}

/// Start the outbound peering tasks. Each peer relay gets a tokio task.
pub fn start_peering(
    mesh: Arc<MeshStore>,
    registry: Arc<PeerRegistry>,
    federated: Arc<FederatedSessions>,
) {
    let config = read_peer_config();
    if config.is_empty() {
        info!("no federated peer relays configured (relay-peers.json empty or absent)");
        return;
    }
    for peer in &config {
        info!(peer = %peer.name, url = %peer.url, "starting peering task");
        let peer = peer.clone();
        let mesh = Arc::clone(&mesh);
        let registry = Arc::clone(&registry);
        let federated = Arc::clone(&federated);
        tokio::spawn(async move {
            peering_loop(mesh, registry, federated, peer).await;
        });
    }
}

/// Per-peer: connect → hello → federate or disconnect → backoff → reconnect.
async fn peering_loop(
    mesh: Arc<MeshStore>,
    registry: Arc<PeerRegistry>,
    federated: Arc<FederatedSessions>,
    peer: RelayPeerConfig,
) {
    let mut backoff = 1u64;
    loop {
        match connect_and_verify(&mesh, &registry, &federated, &peer).await {
            Ok(()) => {
                info!(peer = %peer.name, "federated peer disconnected, reconnecting");
                backoff = 1;
            }
            Err(e) => {
                warn!(peer = %peer.name, error = %e, "peering connection failed");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

/// Connect outbound, exchange hellos, verify shared ownership.
async fn connect_and_verify(
    mesh: &Arc<MeshStore>,
    registry: &Arc<PeerRegistry>,
    federated: &Arc<FederatedSessions>,
    peer: &RelayPeerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws_url = format!("{}/relay-peer", peer.url.trim_end_matches('/'));
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await?;

    // Send our relay_hello.
    let ours: Vec<String> = owner_hashes(mesh).into_iter().collect();
    let hello = RelayHello {
        kind: "relay_hello".into(),
        owners: ours.clone(),
    };
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::to_string(&hello)?.into(),
    ))
    .await?;

    // Receive relay_hello_ack.
    let msg = ws
        .next()
        .await
        .ok_or("peer closed before relay_hello_ack")?;
    let text = match msg? {
        tokio_tungstenite::tungstenite::Message::Text(t) => t,
        _ => return Err("expected text frame".into()),
    };
    let ack: RelayHelloAck = serde_json::from_str(&text)?;

    if !ack.federate {
        info!(peer = %peer.name, "peer declined federation (no common owner)");
        return Err("no common owner".into());
    }

    // Double-check the intersection ourselves.
    let theirs: HashSet<String> = ack.owners.into_iter().collect();
    let ours_set: HashSet<String> = ours.into_iter().collect();
    if !has_common_owner(&ours_set, &theirs) {
        info!(peer = %peer.name, "no common owner (double-check)");
        return Err("no common owner (double-check)".into());
    }

    info!(peer = %peer.name, "federated with peer relay (shared owner verified)");

    // Phase 3: exchange peer lists.
    let local_rooms = FederatedSessions::local_rooms_by_epk(registry);
    let peer_list = RelayPeerList {
        kind: "relay_peer_list".into(),
        relay_name: peer.name.clone(),
        rooms_by_epk: local_rooms,
    };
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::to_string(&peer_list)?.into(),
    ))
    .await?;

    // Receive the peer's relay_peer_list.
    let msg = ws
        .next()
        .await
        .ok_or("peer closed before relay_peer_list")?;
    let text = match msg? {
        tokio_tungstenite::tungstenite::Message::Text(t) => t,
        _ => return Err("expected relay_peer_list".into()),
    };
    let peer_list: RelayPeerList = serde_json::from_str(&text)?;
    federated
        .set_peer_rooms(&peer_list.relay_name, peer_list.rooms_by_epk)
        .await;
    info!(peer = %peer.name, "stored federated sessions from peer relay");

    // Keep the connection open for incremental updates + forwarding (Phase 3c).
    // Split the WS so we can read incoming frames + send outbound forwards.
    let (mut ws_sink, mut ws_stream) = ws.split();

    // Channel for outbound relay_forward frames (written by handle_pi_envelope
    // via FederatedSessions::forward_to_federated).
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    federated.register_sender(&peer.name, tx).await;

    loop {
        tokio::select! {
            // Incoming frames from the peer relay.
            msg = ws_stream.next() => {
                let text = match msg {
                    None | Some(Err(_)) => break,
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => break,
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => t,
                    Some(Ok(_)) => continue,
                };
                // Try relay_peer_update (incremental session changes).
                if let Ok(update) = serde_json::from_str::<RelayPeerUpdate>(&text) {
                    match update.action.as_str() {
                        "add" => {
                            if let Ok(room) =
                                serde_json::from_value::<RoomMeta>(update.room.clone())
                            {
                                federated
                                    .add_room(&update.relay_name, &update.epk, room)
                                    .await;
                            }
                        }
                        "remove" => {
                            if let Some(room_id) =
                                update.room.get("room_id").and_then(|v| v.as_str())
                            {
                                federated
                                    .remove_room(&update.relay_name, &update.epk, room_id)
                                    .await;
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                // Try relay_forward (deliver to local pi + send ack).
                if let Ok(forward) = serde_json::from_str::<RelayForward>(&text) {
                    let outbound = serde_json::json!({
                        "type": "pi_envelope_in",
                        "from_pc": forward.from_epk,
                        "envelope": forward.envelope,
                    });
                    let status = if registry.forward_to_peer(
                        &forward.target_epk,
                        Message::Text(outbound.to_string()),
                    ) {
                        "forwarded"
                    } else {
                        "unknown_peer"
                    };
                    let ack = RelayForwardAck {
                        kind: "relay_forward_ack".into(),
                        request_id: forward.request_id,
                        status: status.into(),
                    };
                    let _ = ws_sink
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            serde_json::to_string(&ack).unwrap_or_default().into(),
                        ))
                        .await;
                    continue;
                }
                // Try relay_forward_ack (resolve pending forward).
                if let Ok(ack) = serde_json::from_str::<RelayForwardAck>(&text) {
                    federated.resolve_forward_ack(ack).await;
                }
            }
            // Outbound forwards from the channel (from handle_pi_envelope).
            outbound = rx.recv() => {
                match outbound {
                    Some(text) => {
                        if ws_sink
                            .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    // Cleanup on disconnect.
    federated.unregister_sender(&peer.name).await;
    federated.clear_peer(&peer.name).await;
    Ok(())
}

// ── Inbound handler (/relay-peer) ─────────────────────────────────────────

pub async fn relay_peer_ws_handler(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_inbound_peer(state, socket))
}

async fn handle_inbound_peer(state: AppState, mut socket: WebSocket) {
    // Receive relay_hello.
    let msg = match socket.recv().await {
        Some(Ok(Message::Text(t))) => t,
        _ => {
            warn!("relay-peer: expected relay_hello, got disconnect");
            return;
        }
    };
    let hello: RelayHello = match serde_json::from_str(&msg) {
        Ok(h) => h,
        Err(e) => {
            warn!("relay-peer: failed to parse relay_hello: {e}");
            return;
        }
    };

    // Check for a common owner.
    let theirs: HashSet<String> = hello.owners.into_iter().collect();
    let ours: Vec<String> = owner_hashes(&state.mesh).into_iter().collect();
    let ours_set: HashSet<String> = ours.iter().cloned().collect();
    let federate = has_common_owner(&ours_set, &theirs);

    // Send relay_hello_ack.
    let ack = RelayHelloAck {
        kind: "relay_hello_ack".into(),
        federate,
        owners: ours,
    };
    if socket
        .send(Message::Text(
            serde_json::to_string(&ack).unwrap_or_default(),
        ))
        .await
        .is_err()
    {
        return;
    }

    if !federate {
        info!("relay-peer: declined (no common owner)");
        return;
    }

    info!("relay-peer: federated (shared owner verified)");

    // Phase 3: receive the peer's relay_peer_list, store it, then send ours.
    let msg = match socket.recv().await {
        Some(Ok(Message::Text(t))) => t,
        _ => {
            warn!("relay-peer: expected relay_peer_list, got disconnect");
            return;
        }
    };
    let peer_list: RelayPeerList = match serde_json::from_str(&msg) {
        Ok(l) => l,
        Err(e) => {
            warn!("relay-peer: failed to parse relay_peer_list: {e}");
            return;
        }
    };
    state
        .federated
        .set_peer_rooms(&peer_list.relay_name, peer_list.rooms_by_epk)
        .await;
    info!(
        relay = %peer_list.relay_name,
        "stored federated sessions from inbound peer relay"
    );

    // Send our local rooms.
    let local_rooms = FederatedSessions::local_rooms_by_epk(&state.registry);
    let our_list = RelayPeerList {
        kind: "relay_peer_list".into(),
        relay_name: "self".into(), // TODO: the relay's own name (from config or hostname).
        rooms_by_epk: local_rooms,
    };
    if socket
        .send(Message::Text(
            serde_json::to_string(&our_list).unwrap_or_default(),
        ))
        .await
        .is_err()
    {
        return;
    }

    // Keep open for incremental updates + forwarding (Phase 3c).
    // Split the socket so we can read incoming frames + send outbound forwards.
    let (mut socket_sink, mut socket_stream) = socket.split();

    // Channel for outbound relay_forward frames (from handle_pi_envelope).
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state
        .federated
        .register_sender(&peer_list.relay_name, tx)
        .await;

    loop {
        tokio::select! {
            // Incoming frames from the peer relay.
            msg = socket_stream.next() => {
                let text = match msg {
                    None | Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(_)) => continue,
                };
                // Try relay_peer_update (incremental session changes).
                if let Ok(update) = serde_json::from_str::<RelayPeerUpdate>(&text) {
                    match update.action.as_str() {
                        "add" => {
                            if let Ok(room) =
                                serde_json::from_value::<RoomMeta>(update.room.clone())
                            {
                                state
                                    .federated
                                    .add_room(&update.relay_name, &update.epk, room)
                                    .await;
                            }
                        }
                        "remove" => {
                            if let Some(room_id) =
                                update.room.get("room_id").and_then(|v| v.as_str())
                            {
                                state
                                    .federated
                                    .remove_room(&update.relay_name, &update.epk, room_id)
                                    .await;
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                // Try relay_forward (deliver to local pi + send ack).
                if let Ok(forward) = serde_json::from_str::<RelayForward>(&text) {
                    let outbound = serde_json::json!({
                        "type": "pi_envelope_in",
                        "from_pc": forward.from_epk,
                        "envelope": forward.envelope,
                    });
                    let status = if state
                        .registry
                        .forward_to_peer(&forward.target_epk, Message::Text(outbound.to_string()))
                    {
                        "forwarded"
                    } else {
                        "unknown_peer"
                    };
                    let ack = RelayForwardAck {
                        kind: "relay_forward_ack".into(),
                        request_id: forward.request_id,
                        status: status.into(),
                    };
                    let _ = socket_sink
                        .send(Message::Text(serde_json::to_string(&ack).unwrap_or_default()))
                        .await;
                    continue;
                }
                // Try relay_forward_ack (resolve pending forward).
                if let Ok(ack) = serde_json::from_str::<RelayForwardAck>(&text) {
                    state.federated.resolve_forward_ack(ack).await;
                }
            }
            // Outbound forwards from the channel (from handle_pi_envelope).
            outbound = rx.recv() => {
                match outbound {
                    Some(text) => {
                        if socket_sink.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    // Cleanup on disconnect.
    state
        .federated
        .unregister_sender(&peer_list.relay_name)
        .await;
    state.federated.clear_peer(&peer_list.relay_name).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn shared_owner_intersection() {
        let a: HashSet<String> = ["hash1", "hash2"].into_iter().map(String::from).collect();
        let b: HashSet<String> = ["hash2", "hash3"].into_iter().map(String::from).collect();
        assert!(has_common_owner(&a, &b)); // common: hash2

        let c: HashSet<String> = ["hash4"].into_iter().map(String::from).collect();
        assert!(!has_common_owner(&a, &c)); // no common

        let empty: HashSet<String> = HashSet::new();
        assert!(!has_common_owner(&a, &empty)); // empty
        assert!(!has_common_owner(&empty, &empty)); // both empty
    }

    #[test]
    fn relay_hello_serde() {
        let hello = RelayHello {
            kind: "relay_hello".into(),
            owners: vec!["hash1".into(), "hash2".into()],
        };
        let json = serde_json::to_string(&hello).unwrap();
        assert!(json.contains("\"type\":\"relay_hello\""));
        assert!(json.contains("\"owners\""));

        let ack: RelayHelloAck = serde_json::from_str(
            r#"{"type":"relay_hello_ack","federate":true,"owners":["hash1"]}"#,
        )
        .unwrap();
        assert!(ack.federate);
        assert_eq!(ack.owners, vec!["hash1"]);
    }

    #[test]
    fn read_peer_config_absent() {
        // No file at a nonexistent path → empty (read_peer_config uses
        // relay_peers_path() which resolves from env; this test verifies the
        // "file not found" path returns empty, not an error).
        // We can't easily override the path in read_peer_config (it uses
        // relay_peers_path() with no override), so this test is a smoke test
        // that the function doesn't panic when the file is absent.
        let _ = read_peer_config();
    }

    #[test]
    fn read_peer_config_from_temp_file() {
        let tmp = std::env::temp_dir().join("unbien-relay-peers-test.json");
        std::fs::write(
            &tmp,
            r#"{"peers":[{"url":"http://100.x:3000","name":"hostB"},{"url":"http://100.y:3000","name":"hostC"}]}"#,
        )
        .unwrap();
        // read_peer_config uses relay_peers_path() (no override), so we can't
        // point it at tmp. Instead, test the parsing logic directly.
        let raw = std::fs::read_to_string(&tmp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let empty = serde_json::Value::Array(vec![]);
        let peers = parsed
            .get("peers")
            .and_then(|v| v.as_array())
            .unwrap_or(empty.as_array().unwrap());
        assert_eq!(peers.len(), 2);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn read_peer_config_malformed() {
        let tmp = std::env::temp_dir().join("unbien-relay-peers-malformed.json");
        std::fs::write(&tmp, "not json").unwrap();
        let raw = std::fs::read_to_string(&tmp).unwrap();
        let result: Result<serde_json::Value, _> = serde_json::from_str(&raw);
        assert!(result.is_err()); // malformed JSON → error → empty
        let _ = std::fs::remove_file(&tmp);
    }
}

// ── Phase 3: FederatedSessions + peer list exchange + cross-relay forwarding ─

use crate::peers::registry::PeerRegistry;
use crate::rooms::RoomMeta;
use std::collections::HashMap;
use tokio::sync::{Mutex, mpsc, oneshot};

/// Wire frame: a pi_envelope forwarded across relays (Phase 3c).
#[derive(Debug, Deserialize, Serialize)]
pub struct RelayForward {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub from_epk: String,
    pub target_epk: String,
    pub envelope: serde_json::Value,
}

/// Wire frame: the ack for a relay_forward (Phase 3c).
#[derive(Debug, Deserialize, Serialize)]
pub struct RelayForwardAck {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub status: String, // "forwarded" | "unknown_peer"
}

/// Stores rooms from federated peer relays. Keyed by (peer_relay_name, epk)
/// → Vec<RoomMeta>. Also maintains an epk → peer_relay_name index for
/// forwarding (which peer relay handles a given target epk?).
pub struct FederatedSessions {
    /// (peer_relay_name, epk) → Vec<RoomMeta>
    sessions: Mutex<HashMap<(String, String), Vec<RoomMeta>>>,
    /// epk → peer_relay_name (for forwarding)
    epk_to_relay: Mutex<HashMap<String, String>>,
    /// peer_relay_name → WS sender channel (for relay_forward, raw JSON text)
    forward_senders: Mutex<HashMap<String, mpsc::UnboundedSender<String>>>,
    /// request_id → oneshot sender (for relay_forward_ack replies)
    pending_forwards: Mutex<HashMap<String, oneshot::Sender<RelayForwardAck>>>,
}

impl FederatedSessions {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            epk_to_relay: Mutex::new(HashMap::new()),
            forward_senders: Mutex::new(HashMap::new()),
            pending_forwards: Mutex::new(HashMap::new()),
        }
    }

    /// Replace all sessions from a given peer relay (on relay_peer_list).
    pub async fn set_peer_rooms(
        &self,
        peer_relay: &str,
        rooms_by_epk: HashMap<String, Vec<RoomMeta>>,
    ) {
        let mut sessions = self.sessions.lock().await;
        let mut epk_map = self.epk_to_relay.lock().await;

        // Remove old entries for this peer relay.
        sessions.retain(|k, _| k.0 != peer_relay);
        epk_map.retain(|_, relay| relay.as_str() != peer_relay);

        // Insert new entries.
        for (epk, rooms) in rooms_by_epk {
            sessions.insert((peer_relay.to_string(), epk.clone()), rooms);
            epk_map.insert(epk, peer_relay.to_string());
        }
    }

    /// Add a single room for a peer relay (on relay_peer_update add).
    pub async fn add_room(&self, peer_relay: &str, epk: &str, room: RoomMeta) {
        let mut sessions = self.sessions.lock().await;
        let key = (peer_relay.to_string(), epk.to_string());
        sessions.entry(key).or_default().push(room);
        self.epk_to_relay
            .lock()
            .await
            .insert(epk.to_string(), peer_relay.to_string());
    }

    /// Remove a single room (on relay_peer_update remove).
    pub async fn remove_room(&self, peer_relay: &str, epk: &str, room_id: &str) {
        let mut sessions = self.sessions.lock().await;
        let key = (peer_relay.to_string(), epk.to_string());
        if let Some(rooms) = sessions.get_mut(&key) {
            rooms.retain(|r| r.room_id != room_id);
            if rooms.is_empty() {
                sessions.remove(&key);
                self.epk_to_relay.lock().await.remove(epk);
            }
        }
    }

    /// Remove all sessions from a peer relay (on disconnect).
    pub async fn clear_peer(&self, peer_relay: &str) {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|k, _| k.0 != peer_relay);
        self.epk_to_relay
            .lock()
            .await
            .retain(|_, relay| relay != peer_relay);
    }

    /// Get all federated rooms for a given epk (for rooms_check).
    pub async fn rooms_for_epk(&self, epk: &str) -> Vec<(String, RoomMeta)> {
        let sessions = self.sessions.lock().await;
        sessions
            .iter()
            .filter(|((_, e), _)| e == epk)
            .flat_map(|((relay, _), rooms)| rooms.iter().map(move |r| (relay.clone(), r.clone())))
            .collect()
    }

    /// Look up which peer relay handles a given epk (for forwarding).
    pub async fn relay_for_epk(&self, epk: &str) -> Option<String> {
        self.epk_to_relay.lock().await.get(epk).cloned()
    }

    /// Get all local rooms from the registry, grouped by epk (for sending
    /// to peer relays on the relay_peer_list exchange).
    pub fn local_rooms_by_epk(registry: &PeerRegistry) -> HashMap<String, Vec<RoomMeta>> {
        registry.all_rooms_by_epk()
    }

    // ── Phase 3c: cross-relay forwarding ────────────────────────────────

    /// Register a WS sender channel for a federated peer relay (called by
    /// the peering loop after the connection is established).
    pub async fn register_sender(&self, peer_relay: &str, tx: mpsc::UnboundedSender<String>) {
        self.forward_senders
            .lock()
            .await
            .insert(peer_relay.to_string(), tx);
    }

    /// Unregister (called on disconnect).
    pub async fn unregister_sender(&self, peer_relay: &str) {
        self.forward_senders.lock().await.remove(peer_relay);
    }

    /// Forward a pi_envelope to a federated peer relay. Looks up which peer
    /// relay has the target epk, sends the relay_forward frame, and returns a
    /// oneshot receiver for the ack. Returns None if no federated relay has
    /// the target.
    pub async fn forward_to_federated(
        &self,
        from_epk: &str,
        target_epk: &str,
        envelope: serde_json::Value,
    ) -> Option<oneshot::Receiver<RelayForwardAck>> {
        let relay_name = self.relay_for_epk(target_epk).await?;
        let tx = {
            let senders = self.forward_senders.lock().await;
            senders.get(&relay_name)?.clone()
        };
        let request_id = format!("{}", rand::random::<u64>());
        let forward = RelayForward {
            kind: "relay_forward".into(),
            request_id: request_id.clone(),
            from_epk: from_epk.to_string(),
            target_epk: target_epk.to_string(),
            envelope,
        };
        let (otx, orx) = oneshot::channel();
        self.pending_forwards.lock().await.insert(request_id, otx);
        let _ = tx.send(serde_json::to_string(&forward).unwrap_or_default());
        Some(orx)
    }

    /// Handle a relay_forward_ack received from a peer relay. Resolves the
    /// pending oneshot.
    pub async fn resolve_forward_ack(&self, ack: RelayForwardAck) {
        if let Some(tx) = self.pending_forwards.lock().await.remove(&ack.request_id) {
            let _ = tx.send(ack);
        }
    }
}

/// Wire frame: a peer relay's full room list (sent after federation).
#[derive(Debug, Deserialize, Serialize)]
pub struct RelayPeerList {
    #[serde(rename = "type")]
    pub kind: String,
    /// The sending relay's name (for attribution).
    pub relay_name: String,
    /// Rooms grouped by the remote machine's epk.
    pub rooms_by_epk: HashMap<String, Vec<RoomMeta>>,
}

/// Wire frame: an incremental room update (add/remove).
#[derive(Debug, Deserialize, Serialize)]
pub struct RelayPeerUpdate {
    #[serde(rename = "type")]
    pub kind: String,
    pub relay_name: String,
    pub action: String, // "add" | "remove"
    pub epk: String,
    pub room: serde_json::Value, // RoomMeta (add) or {"room_id": "..."} (remove)
}
