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

use crate::peers::pairing::PairingRegistry;
use crate::relay_keypair::RelayKeypair;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use notify::Watcher;
use rand::RngCore as _;

/// The relay's own name (for relay_peer_list / relay_peer_update frames).
/// Reads `UNBIEN_RELAY_NAME` env var; defaults to the hostname, then "relay".
fn relay_own_name() -> String {
    if let Ok(name) = std::env::var("UNBIEN_RELAY_NAME") {
        if !name.is_empty() {
            return name;
        }
    }
    // Fall back to the system hostname (gethostname syscall) — not the
    // HOSTNAME env var, which isn't set under launchd/systemd.
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "relay".to_string())
}

/// The relay's own WebSocket URL (for the URL exchange in relay_hello).
/// Reads `UNBIEN_RELAY_URL` env var; defaults to empty (not advertised).
fn relay_own_url() -> Option<String> {
    std::env::var("UNBIEN_RELAY_URL")
        .ok()
        .filter(|u| !u.is_empty())
}

/// Generate a random 32-byte nonce, base64-encoded.
fn gen_relay_nonce() -> String {
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    B64.encode(nonce)
}

/// Sign the relay identity fields (nonce + pubkey + name + url) with the
/// relay's keypair. Returns the base64 signature.
fn sign_relay_identity(keypair: &RelayKeypair, nonce: &str, name: &str, url: &str) -> String {
    let msg = format!("{nonce}|{}|{name}|{url}", keypair.pubkey_b64());
    keypair.sign(msg.as_bytes())
}

/// Verify a peer's relay identity signature. Returns true if the signature
/// is valid for the given pubkey + identity fields.
fn verify_relay_identity(pubkey: &str, nonce: &str, name: &str, url: &str, sig: &str) -> bool {
    let msg = format!("{nonce}|{pubkey}|{name}|{url}");
    RelayKeypair::verify(pubkey, msg.as_bytes(), sig)
}

use std::sync::Arc;

use crate::AppState;

use crate::mesh::store::MeshStore;
use crate::paths::relay_peers_path;

/// A peer relay entry from `relay-peers.json`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RelayPeerConfig {
    pub url: String,
    pub name: String,
    /// The peer relay's pinned Ed25519 public key (base64). If present, the
    /// relay verifies the peer's identity on connect. If absent, only
    /// shared-owner verification is used (backward compat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,
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
/// Collect owner hashes from BOTH the mesh_versions table (if the app
/// published a mesh blob) AND the PairingRegistry (owner pubkeys from the
/// extension's pairing_set pushes — works without the app). The
/// PairingRegistry is the primary source: a pi session connects → the
/// extension sends pairing_set with the owner pubkeys → the relay stores
/// them → the federation check uses them.
fn trust_root_hashes(mesh: &MeshStore, pairing: &PairingRegistry) -> HashSet<String> {
    crate::membership::trust_root_hashes(mesh, pairing)
}

/// Check if two relay's owner hash sets share a common owner.
fn has_common_owner(ours: &HashSet<String>, theirs: &HashSet<String>) -> bool {
    ours.intersection(theirs).next().is_some()
}

/// Broadcast the current federated_peer_list to all connected WS clients.
/// Called after every federated session change (set_peer_rooms, add_room,
/// remove_room, clear_peer) so apps/extensions discover federated peers.
pub async fn broadcast_federated_list(registry: &PeerRegistry, federated: &FederatedSessions) {
    let json = federated.federated_peer_list_json().await;
    registry.broadcast_to_all(Message::Text(json));
}

/// The wire frame exchanged on connect.
#[derive(Debug, Deserialize, Serialize)]
pub struct RelayHello {
    #[serde(rename = "type")]
    pub kind: String,
    pub owners: Vec<String>,
    /// The relay's Ed25519 public key (base64) — its identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_pubkey: Option<String>,
    /// The relay's name (for display + routing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_name: Option<String>,
    /// The relay's WebSocket URL (for the URL exchange — the peer can
    /// connect back if it wants symmetric peering).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    /// Random nonce (base64) for replay protection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// Signature over (nonce + relay_pubkey + relay_name + relay_url),
    /// proving possession of the private key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RelayHelloAck {
    #[serde(rename = "type")]
    pub kind: String,
    pub federate: bool,
    pub owners: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_pubkey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

/// Start the outbound peering tasks. Each peer relay gets a tokio task.
/// A filesystem watcher (notify) watches relay-peers.json for changes +
/// spawns new peering loops for new peers — no restart needed after
/// `unbien relay peer add`. A 30s fallback poll catches any missed events.
pub fn start_peering(
    mesh: Arc<MeshStore>,
    registry: Arc<PeerRegistry>,
    pairing: Arc<PairingRegistry>,
    federated: Arc<FederatedSessions>,
) {
    tokio::spawn(async move {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let peers_path = crate::paths::relay_peers_path();

        // Helper: read config + spawn peering loops for new peers.
        let spawn_new = |seen: &mut std::collections::HashSet<String>| {
            let config = read_peer_config();
            if config.is_empty() && seen.is_empty() {
                info!("no federated peer relays configured (relay-peers.json empty or absent)");
            }
            for peer in &config {
                if seen.contains(&peer.name) {
                    continue;
                }
                info!(peer = %peer.name, url = %peer.url, pubkey = ?peer.pubkey.as_deref().map(|p| &p[..8]), "starting peering task");
                seen.insert(peer.name.clone());
                let peer = peer.clone();
                let mesh = Arc::clone(&mesh);
                let registry = Arc::clone(&registry);
                let pairing = Arc::clone(&pairing);
                let federated = Arc::clone(&federated);
                tokio::spawn(async move {
                    peering_loop(mesh, registry, pairing, federated, peer).await;
                });
            }
        };

        // Initial read.
        spawn_new(&mut seen);

        // Watch relay-peers.json for changes.
        let (watch_tx, mut watch_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let _watcher =
            match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    if matches!(
                        event.kind,
                        notify::EventKind::Modify(_) | notify::EventKind::Create(_)
                    ) {
                        let _ = watch_tx.send(());
                    }
                }
            }) {
                Ok(mut w) => {
                    // Watch the parent dir (watching the file itself misses atomic saves
                    // that replace the file — the inode changes. Watching the dir catches
                    // the create event for the new file).
                    let _ = w.watch(
                        peers_path.parent().unwrap_or(&peers_path),
                        notify::RecursiveMode::NonRecursive,
                    );
                    info!("watching relay-peers.json for changes (fswatch)");
                    Some(w)
                }
                Err(e) => {
                    warn!(error = %e, "fswatch unavailable — falling back to 5s poll");
                    None
                }
            };

        loop {
            tokio::select! {
                // File changed — re-read config (debounce 100ms for atomic save
                // sequences that fire multiple events).
                _ = watch_rx.recv() => {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    // Drain any queued events (debounce).
                    while watch_rx.try_recv().is_ok() {}
                    spawn_new(&mut seen);
                }
                // Fallback: re-read every 30s in case the watcher misses an event.
                _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                    spawn_new(&mut seen);
                }
            }
        }
    });
}

/// Per-peer: connect → hello → federate or disconnect → backoff → reconnect.
async fn peering_loop(
    mesh: Arc<MeshStore>,
    registry: Arc<PeerRegistry>,
    pairing: Arc<PairingRegistry>,
    federated: Arc<FederatedSessions>,
    peer: RelayPeerConfig,
) {
    let mut backoff = 1u64;
    loop {
        match connect_and_verify(&mesh, &registry, &pairing, &federated, &peer).await {
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
    pairing: &Arc<PairingRegistry>,
    federated: &Arc<FederatedSessions>,
    peer: &RelayPeerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Convert http(s):// to ws(s):// — tokio_tungstenite requires ws/wss.
    let raw_url = format!("{}/relay-peer", peer.url.trim_end_matches('/'));
    let ws_url = raw_url
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1);
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await?;

    // Send our relay_hello (with relay identity for pairing).
    let ours: Vec<String> = trust_root_hashes(mesh, pairing).into_iter().collect();
    let keypair = crate::relay_keypair::load_or_generate(None);
    let nonce = gen_relay_nonce();
    let name = relay_own_name();
    let url = relay_own_url().unwrap_or_default();
    let sig = sign_relay_identity(&keypair, &nonce, &name, &url);
    let hello = RelayHello {
        kind: "relay_hello".into(),
        owners: ours.clone(),
        relay_pubkey: Some(keypair.pubkey_b64()),
        relay_name: Some(name),
        relay_url: if url.is_empty() { None } else { Some(url) },
        nonce: Some(nonce),
        sig: Some(sig),
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

    // Verify the peer's relay identity (optional layer — if the peer's
    // relay_hello_ack includes identity fields). Same-owner (checked above)
    // is the gate; this is additional identity verification. If a pubkey is
    // pinned in the config (from the pairing URL), verify it matches. If not
    // pinned, just verify the signature proves possession. Either way, this
    // never refuses a same-owner peer — it only adds identity assurance.
    if let (Some(peer_pubkey), Some(peer_nonce), Some(peer_sig)) =
        (&ack.relay_pubkey, &ack.nonce, &ack.sig)
    {
        if let Some(pinned) = &peer.pubkey {
            if pinned != peer_pubkey {
                info!(peer = %peer.name, pinned = %pinned, got = %peer_pubkey, "relay pubkey mismatch");
                return Err("relay pubkey mismatch".into());
            }
        }
        let peer_name = ack.relay_name.as_deref().unwrap_or("");
        let peer_url = ack.relay_url.as_deref().unwrap_or("");
        if !verify_relay_identity(peer_pubkey, peer_nonce, peer_name, peer_url, peer_sig) {
            info!(peer = %peer.name, "relay identity signature invalid");
            return Err("relay identity signature invalid".into());
        }
    }

    info!(peer = %peer.name, "federated with peer relay (shared owner verified)");

    // Phase 3: exchange peer lists.
    let local_rooms = FederatedSessions::local_rooms_by_epk(registry);
    let peer_list = RelayPeerList {
        kind: "relay_peer_list".into(),
        relay_name: relay_own_name(),
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
    broadcast_federated_list(registry, federated).await;

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
                                broadcast_federated_list(registry, federated)
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
                                broadcast_federated_list(registry, federated)
                                    .await;
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                // Try relay_forward (deliver to local pi + send ack).
                if let Ok(forward) = serde_json::from_str::<RelayForward>(&text) {
                    // Loop prevention: drop if we've already handled this forward.
                    if forward.visited.contains(&relay_own_name()) {
                        let ack = RelayForwardAck {
                            kind: "relay_forward_ack".into(),
                            request_id: forward.request_id,
                            status: "unknown_peer".into(),
                        };
                        let _ = ws_sink
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                serde_json::to_string(&ack).unwrap_or_default().into(),
                            ))
                            .await;
                        continue;
                    }
                    // Verify the forward's provenance (shared helper).
                    let sig_valid = crate::membership::verify_relay_forward(
                        &forward.request_id,
                        &forward.from_epk,
                        &forward.target_epk,
                        &forward.visited,
                        &forward.relay_pubkey,
                        &forward.relay_sig,
                    );
                    if !sig_valid {
                        let ack = RelayForwardAck {
                            kind: "relay_forward_ack".into(),
                            request_id: forward.request_id,
                            status: "unknown_peer".into(),
                        };
                        let _ = ws_sink
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                serde_json::to_string(&ack).unwrap_or_default().into(),
                            ))
                            .await;
                        continue;
                    }
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
    broadcast_federated_list(registry, federated).await;
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

    // Symmetric identity verification (matches the outbound check): verify
    // the connecting relay's signature +, if a peer with this name is
    // configured with a pinned pubkey, that it matches.
    if let (Some(peer_pubkey), Some(peer_nonce), Some(peer_sig)) =
        (&hello.relay_pubkey, &hello.nonce, &hello.sig)
    {
        let peer_name = hello.relay_name.as_deref().unwrap_or("");
        let peer_url_hello = hello.relay_url.as_deref().unwrap_or("");
        if !verify_relay_identity(peer_pubkey, peer_nonce, peer_name, peer_url_hello, peer_sig) {
            warn!("relay-peer: identity signature invalid, declining");
            return;
        }
        // Pinning: a configured peer with this name must present the pinned pubkey.
        if peer_name.len() > 0 {
            let configured = read_peer_config().into_iter().find(|p| p.name == peer_name);
            if let Some(cfg) = configured {
                if let Some(pinned) = &cfg.pubkey {
                    if pinned != peer_pubkey {
                        warn!(peer = %peer_name, pinned = %pinned, got = %peer_pubkey, "relay-peer: pubkey mismatch, declining");
                        return;
                    }
                }
            }
        }
    }

    // Check for a common owner.
    let theirs: HashSet<String> = hello.owners.into_iter().collect();
    let ours: Vec<String> = trust_root_hashes(&state.mesh, &state.pairing)
        .into_iter()
        .collect();
    let ours_set: HashSet<String> = ours.iter().cloned().collect();
    let federate = has_common_owner(&ours_set, &theirs);

    // Send relay_hello_ack (with relay identity for pairing).
    let keypair = crate::relay_keypair::load_or_generate(None);
    let nonce = gen_relay_nonce();
    let name = relay_own_name();
    let url = relay_own_url().unwrap_or_default();
    let sig = sign_relay_identity(&keypair, &nonce, &name, &url);
    let ack = RelayHelloAck {
        kind: "relay_hello_ack".into(),
        federate,
        owners: ours,
        relay_pubkey: Some(keypair.pubkey_b64()),
        relay_name: Some(name),
        relay_url: if url.is_empty() { None } else { Some(url) },
        nonce: Some(nonce),
        sig: Some(sig),
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
    broadcast_federated_list(&state.registry, &state.federated).await;

    // Send our local rooms.
    let local_rooms = FederatedSessions::local_rooms_by_epk(&state.registry);
    let our_list = RelayPeerList {
        kind: "relay_peer_list".into(),
        relay_name: relay_own_name(), // our own name (was "self" placeholder)
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
                                broadcast_federated_list(&state.registry, &state.federated)
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
                                broadcast_federated_list(&state.registry, &state.federated)
                                    .await;
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                // Try relay_forward (deliver to local pi + send ack).
                if let Ok(forward) = serde_json::from_str::<RelayForward>(&text) {
                    // Loop prevention: drop if we've already handled this forward.
                    if forward.visited.contains(&relay_own_name()) {
                        let ack = RelayForwardAck {
                            kind: "relay_forward_ack".into(),
                            request_id: forward.request_id,
                            status: "unknown_peer".into(),
                        };
                        let _ = socket_sink
                            .send(Message::Text(serde_json::to_string(&ack).unwrap_or_default()))
                            .await;
                        continue;
                    }
                    // Verify the forward's provenance (shared helper).
                    let sig_valid = crate::membership::verify_relay_forward(
                        &forward.request_id,
                        &forward.from_epk,
                        &forward.target_epk,
                        &forward.visited,
                        &forward.relay_pubkey,
                        &forward.relay_sig,
                    );
                    if !sig_valid {
                        let ack = RelayForwardAck {
                            kind: "relay_forward_ack".into(),
                            request_id: forward.request_id,
                            status: "unknown_peer".into(),
                        };
                        let _ = socket_sink
                            .send(Message::Text(serde_json::to_string(&ack).unwrap_or_default()))
                            .await;
                        continue;
                    }
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
    broadcast_federated_list(&state.registry, &state.federated).await;
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
            relay_pubkey: None,
            relay_name: None,
            relay_url: None,
            nonce: None,
            sig: None,
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
/// Authenticated: the forwarding relay signs (request_id + from_epk +
/// target_epk + visited) with its keypair so the receiving relay can
/// verify provenance.
#[derive(Debug, Deserialize, Serialize)]
pub struct RelayForward {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub from_epk: String,
    pub target_epk: String,
    pub envelope: serde_json::Value,
    /// Relays that have already handled this forward (loop prevention).
    #[serde(default)]
    pub visited: Vec<String>,
    /// The forwarding relay's Ed25519 public key (base64).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_pubkey: Option<String>,
    /// Signature over (request_id + from_epk + target_epk + visited joined).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_sig: Option<String>,
    /// Outer-envelope forward (app→pi / ub frames, e.g. CLI remote launch):
    /// when BOTH are present, `envelope` is ABSENT and these carry the
    /// opaque {peer, room, ct} outer form to deliver verbatim to
    /// (target_epk, room) via registry.forward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ct: Option<String>,
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
    /// epk → list of peer_relay_names (for forwarding — multi-route fallback)
    epk_to_relays: Mutex<HashMap<String, Vec<String>>>,
    /// peer_relay_name → WS sender channel (for relay_forward, raw JSON text)
    forward_senders: Mutex<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>,
    /// request_id → oneshot sender (for relay_forward_ack replies)
    pending_forwards: Mutex<HashMap<String, oneshot::Sender<RelayForwardAck>>>,
}

impl FederatedSessions {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            epk_to_relays: Mutex::new(HashMap::new()),
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
        let mut epk_map = self.epk_to_relays.lock().await;

        // Remove old entries for this peer relay.
        sessions.retain(|k, _| k.0 != peer_relay);
        for relays in epk_map.values_mut() {
            relays.retain(|r| r != peer_relay);
        }
        epk_map.retain(|_, relays| !relays.is_empty());

        // Insert new entries.
        for (epk, rooms) in rooms_by_epk {
            sessions.insert((peer_relay.to_string(), epk.clone()), rooms);
            epk_map.entry(epk).or_default().push(peer_relay.to_string());
        }
    }

    /// Add a single room for a peer relay (on relay_peer_update add).
    pub async fn add_room(&self, peer_relay: &str, epk: &str, room: RoomMeta) {
        let mut sessions = self.sessions.lock().await;
        let key = (peer_relay.to_string(), epk.to_string());
        let rooms = sessions.entry(key).or_default();
        // Upsert: a meta update (e.g. /name rename) reuses "add" — replace
        // the existing room with the same room_id so the stale copy
        // (old name/model/working) doesn't shadow the fresh one.
        if let Some(existing) = rooms.iter_mut().find(|r| r.room_id == room.room_id) {
            *existing = room;
        } else {
            rooms.push(room);
        }
        let mut epk_map = self.epk_to_relays.lock().await;
        let relays = epk_map.entry(epk.to_string()).or_default();
        if !relays.contains(&peer_relay.to_string()) {
            relays.push(peer_relay.to_string());
        }
    }

    /// Remove a single room (on relay_peer_update remove).
    pub async fn remove_room(&self, peer_relay: &str, epk: &str, room_id: &str) {
        let mut sessions = self.sessions.lock().await;
        let key = (peer_relay.to_string(), epk.to_string());
        let mut should_remove_relay = false;
        if let Some(rooms) = sessions.get_mut(&key) {
            rooms.retain(|r| r.room_id != room_id);
            if rooms.is_empty() {
                sessions.remove(&key);
                should_remove_relay = true;
            }
        }
        if should_remove_relay {
            let mut epk_map = self.epk_to_relays.lock().await;
            if let Some(relays) = epk_map.get_mut(epk) {
                relays.retain(|r| r != peer_relay);
                if relays.is_empty() {
                    epk_map.remove(epk);
                }
            }
        }
    }

    /// Remove all sessions from a peer relay (on disconnect).
    pub async fn clear_peer(&self, peer_relay: &str) {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|k, _| k.0 != peer_relay);
        let mut epk_map = self.epk_to_relays.lock().await;
        for relays in epk_map.values_mut() {
            relays.retain(|r| r != peer_relay);
        }
        epk_map.retain(|_, relays| !relays.is_empty());
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
    /// Returns the first relay name (backward compat — single route).
    pub async fn relay_for_epk(&self, epk: &str) -> Option<String> {
        self.epk_to_relays
            .lock()
            .await
            .get(epk)
            .and_then(|relays| relays.first().cloned())
    }

    /// Look up ALL peer relays that have a given epk (for multi-route
    /// fallback in forwarding). Returns the list in insertion order.
    pub async fn relays_for_epk(&self, epk: &str) -> Vec<String> {
        self.epk_to_relays
            .lock()
            .await
            .get(epk)
            .cloned()
            .unwrap_or_default()
    }

    /// Whether any federated sessions exist (to gate the on-connect push —
    /// avoid sending an empty federated_peer_list to every new connection
    /// when there's no federation).
    pub async fn has_federated_sessions(&self) -> bool {
        !self.epk_to_relays.lock().await.is_empty()
    }

    /// Build the `federated_peer_list` control frame (Phase 4) for broadcasting
    /// to all connected WS clients. Contains every federated peer's epk,
    /// relay_name, and room metadata so the extension can populate its
    /// `BrokerRemote.federatedPeers` map + include them in `list_peers`.
    pub async fn federated_peer_list_json(&self) -> String {
        let sessions = self.sessions.lock().await;
        // Group by epk: (relay_name, epk) → rooms → {epk, relay_name, rooms}
        // Dedup rooms by room_id across relays (multi-homed pi case).
        let mut by_epk: HashMap<
            String,
            (
                String,
                Vec<serde_json::Value>,
                std::collections::HashSet<String>,
            ),
        > = HashMap::new();
        for ((relay, epk), rooms) in sessions.iter() {
            let entry = by_epk
                .entry(epk.clone())
                .or_insert_with(|| (relay.clone(), Vec::new(), std::collections::HashSet::new()));
            for room in rooms {
                // Skip duplicate room_ids (same room from a different relay).
                if entry.2.contains(&room.room_id) {
                    continue;
                }
                // Skip launcher daemon control rooms: the `is_daemon` cap marks
                // them (the app filters them from display; here we keep them off
                // discovery entirely so agents don't see "droplet:/Users/...@droplet").
                let is_daemon = room
                    .extra
                    .get("caps")
                    .and_then(|c| c.as_array())
                    .map(|caps| caps.iter().any(|c| c.as_str() == Some("is_daemon")))
                    .unwrap_or(false);
                if is_daemon {
                    continue;
                }
                entry.2.insert(room.room_id.clone());
                if let Ok(val) = serde_json::to_value(room) {
                    entry.1.push(val);
                }
            }
        }
        let peers: Vec<serde_json::Value> = by_epk
            .into_iter()
            .map(|(epk, (relay, rooms, _))| {
                serde_json::json!({
                    "epk": epk,
                    "relay_name": relay,
                    "rooms": rooms,
                })
            })
            .collect();
        serde_json::json!({
            "type": "federated_peer_list",
            "peers": peers,
        })
        .to_string()
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
            .entry(peer_relay.to_string())
            .or_default()
            .push(tx);
    }

    /// Unregister dead senders for a peer relay (called on disconnect).
    /// Retains senders that are still alive (other connections to the same
    /// relay stay usable — symmetric peering creates two connections).
    pub async fn unregister_sender(&self, peer_relay: &str) {
        let mut senders = self.forward_senders.lock().await;
        if let Some(vec) = senders.get_mut(peer_relay) {
            vec.retain(|tx| !tx.is_closed());
        }
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
    ) -> Option<(String, oneshot::Receiver<RelayForwardAck>)> {
        // Multi-route fallback: try each relay that has the target epk,
        // in order, until we find one with an alive sender.
        let relay_names = self.relays_for_epk(target_epk).await;
        if relay_names.is_empty() {
            return None;
        }
        let own_name = relay_own_name();
        let tx = {
            let senders = self.forward_senders.lock().await;
            let mut found = None;
            for relay_name in &relay_names {
                if let Some(vec) = senders.get(relay_name) {
                    if let Some(alive) = vec.iter().find(|tx| !tx.is_closed()) {
                        found = Some(alive.clone());
                        break;
                    }
                }
            }
            found
        };
        let tx = tx?;
        let request_id = format!("{}", rand::random::<u64>());
        // Sign the forward with the relay's keypair (authenticated forwarding).
        let keypair = crate::relay_keypair::load_or_generate(None);
        let visited = vec![own_name];
        let sig_msg = format!("{request_id}|{from_epk}|{target_epk}|{}", visited.join(","));
        let relay_sig = keypair.sign(sig_msg.as_bytes());
        let forward = RelayForward {
            kind: "relay_forward".into(),
            request_id: request_id.clone(),
            from_epk: from_epk.to_string(),
            target_epk: target_epk.to_string(),
            envelope,
            visited: visited.clone(),
            relay_pubkey: Some(keypair.pubkey_b64()),
            relay_sig: Some(relay_sig),
            room: None,
            ct: None,
        };
        let (otx, orx) = oneshot::channel();
        self.pending_forwards
            .lock()
            .await
            .insert(request_id.clone(), otx);
        let _ = tx.send(serde_json::to_string(&forward).unwrap_or_default());
        Some((request_id, orx))
    }

    /// Cancel a pending forward (clean up the oneshot entry on timeout).
    /// Prevents the pending_forwards map from leaking entries when the ack
    /// never arrives (peer relay offline/unresponsive).
    pub async fn cancel_forward(&self, request_id: &str) {
        self.pending_forwards.lock().await.remove(request_id);
    }

    /// Forward an OUTER envelope (app→pi / ub frame, opaque {peer, room, ct})
    /// to a federated peer relay. Same channel + ack mechanism as
    /// forward_to_federated, but the payload is the opaque outer form — the
    /// receiving relay delivers it via registry.forward to (target, room).
    pub async fn forward_outer_to_federated(
        &self,
        from_epk: &str,
        target_epk: &str,
        room: &str,
        ct: &str,
    ) -> Option<oneshot::Receiver<RelayForwardAck>> {
        let relay_names = self.relays_for_epk(target_epk).await;
        if relay_names.is_empty() {
            return None;
        }
        let own_name = relay_own_name();
        let tx = {
            let senders = self.forward_senders.lock().await;
            let mut found = None;
            for relay_name in &relay_names {
                if let Some(vec) = senders.get(relay_name) {
                    if let Some(alive) = vec.iter().find(|tx| !tx.is_closed()) {
                        found = Some(alive.clone());
                        break;
                    }
                }
            }
            found
        }?;
        let request_id = format!("{}", rand::random::<u64>());
        let keypair = crate::relay_keypair::load_or_generate(None);
        let visited = vec![own_name];
        let sig_msg = format!("{request_id}|{from_epk}|{target_epk}|{}", visited.join(","));
        let relay_sig = keypair.sign(sig_msg.as_bytes());
        let forward = RelayForward {
            kind: "relay_forward".into(),
            request_id: request_id.clone(),
            from_epk: from_epk.to_string(),
            target_epk: target_epk.to_string(),
            envelope: serde_json::Value::Null,
            visited,
            relay_pubkey: Some(keypair.pubkey_b64()),
            relay_sig: Some(relay_sig),
            room: Some(room.to_string()),
            ct: Some(ct.to_string()),
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

    /// Broadcast a relay_peer_update to all connected federated peer relays.
    /// Called when a local pi connects ("add") or disconnects ("remove").
    /// Uses `relay_own_name()` so the receiver keys the session correctly.
    pub async fn broadcast_update(&self, action: &str, epk: &str, room: serde_json::Value) {
        let relay_name = relay_own_name();
        let update = RelayPeerUpdate {
            kind: "relay_peer_update".into(),
            relay_name,
            action: action.to_string(),
            epk: epk.to_string(),
            room,
        };
        let text = serde_json::to_string(&update).unwrap_or_default();
        let senders = self.forward_senders.lock().await;
        for vec in senders.values() {
            for tx in vec {
                let _ = tx.send(text.clone());
            }
        }
    }
}

impl Default for FederatedSessions {
    fn default() -> Self {
        Self::new()
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
