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
pub fn start_peering(mesh: Arc<MeshStore>) {
    let config = read_peer_config();
    if config.is_empty() {
        info!("no federated peer relays configured (relay-peers.json empty or absent)");
        return;
    }
    for peer in &config {
        info!(peer = %peer.name, url = %peer.url, "starting peering task");
        let peer = peer.clone();
        let mesh = Arc::clone(&mesh);
        tokio::spawn(async move {
            peering_loop(mesh, peer).await;
        });
    }
}

/// Per-peer: connect → hello → federate or disconnect → backoff → reconnect.
async fn peering_loop(mesh: std::sync::Arc<MeshStore>, peer: RelayPeerConfig) {
    let mut backoff = 1u64;
    loop {
        match connect_and_verify(&mesh, &peer).await {
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
    mesh: &std::sync::Arc<MeshStore>,
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

    // Phase 2: keep open until peer disconnects. Phase 3 adds exchange here.
    while let Some(msg) = ws.next().await {
        match msg {
            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) | Err(_) => break,
            Ok(_) => { /* Phase 3 will handle peer list + forwarding */ }
        }
    }
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

    // Phase 2: keep open. Phase 3 adds exchange here.
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => { /* Phase 3 will handle peer list + forwarding */ }
        }
    }
}
