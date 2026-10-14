//! Relay-to-relay peering (federation).
//!
//! Federation v2 (slice 1): the link gate is EXPLICIT PAIRING — a peer
//! relay federates only when its Ed25519 public key is pinned in
//! `relay-peers.json` (written by the pairing URL flow), or when it
//! presents a valid single-use pairing secret held in the file's `pending`
//! list (the one-pair auto-add, which pins exactly that presented key).
//! The shared-owner hash intersection RETIRED as a gate: owner sets stay on
//! the wire and are logged for observability, but pairing decides.
//!
//! Federation v2 (slice 3, transitive exchange + directed hops): all hosts
//! become transitively known to the entire paired network — the
//! `relay_peer_list` advertisement is ONE SEGMENT PER ORIGIN (the sender's
//! own rooms + machine pairings, plus everything it learned from other
//! peers, origin-tagged, self-origin filtered, never back to the arrival
//! link — propagation terminates), and incremental `relay_peer_update` /
//! `relay_pairings_update` frames re-advertise onward minus their arrival
//! link. Advertisement implies route: a forward to a target epk resolves
//! the ORIGIN and rides the via link (origin → arrival links); a `visited`
//! loop guard + per-hop re-signing carry an onward hop, whose ack returns
//! verbatim along the delivery path via a bounded request_id → backlink
//! map.
//!
//! Each relay reads `relay-peers.json` (per-machine, CLI-owned — see
//! [`crate::peers::peers_config`]) fresh, connects outbound to each pinned
//! peer relay's `/relay-peer` endpoint, and exchanges `relay_hello` frames
//! carrying the owner public-key hashes each relay knows (from
//! `mesh_versions`). After the gate both sides exchange the segmented
//! `relay_peer_list` (rooms + machine pairing sets, per origin) and stay
//! open for cross-relay forwarding.

use std::collections::HashSet;
use std::time::{Duration, Instant};

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

/// Federation protocol version this relay speaks (federation v2 §4).
/// 1 = pre-slice-3: one `relay_peer_list` frame (local rooms only), no
/// sequence marker, direct-hop forwarding only. 2 = slice 3: segmented
/// transitive advertisement (`done: true` on the last segment) + onward
/// hops + ack backlinks. Absent on the wire ⇒ 1 (old peers, both
/// directions degrade to old behavior).
pub const FED_PROTO: u32 = 2;

/// Bound for the request_id → backlink map (onward hops awaiting their
/// dest ack): the source's forward timeout is 5 s, so 30 s covers the ack
/// generously; the map is also hard-capped (LRU-evicted).
const HOP_BACKLINK_TTL: Duration = Duration::from_secs(30);
const HOP_BACKLINK_MAX: usize = 1024;

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

/// First 8 chars of a base64 key for logs (never log full keys).
fn short_key(key: &str) -> String {
    key.chars().take(8).collect()
}

use std::sync::Arc;

use crate::AppState;

use crate::mesh::store::MeshStore;
use crate::paths::relay_peers_path;

// The peer/pairing config file (relay-peers.json) lives in
// `crate::peers::peers_config` — shared by the inbound handler (which also
// WRITES it: the pairing auto-add) and the outbound peering loop. Re-exported
// here so existing `relay::peering::*` paths keep resolving.
pub use crate::peers::peers_config::{
    PendingRelayPair, RelayPeerConfig, read_peer_config, read_pending,
};

/// Whether relay federation is ENABLED — the gate (not merely the absence
/// of peers in relay-peers.json). Reads `federation.enabled` from
/// relay-peers.json FRESH on every call: the CLI can flip it live
/// (`unbien relay federation on|off`). Default false — federation is opt-in.
pub fn federation_enabled() -> bool {
    // CONFIG first: `federation.enabled` in ~/.config/un-bien/relay.json.
    if let Ok(raw) = std::fs::read_to_string(crate::paths::relay_config_path()) {
        if let Some(enabled) = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.get("federation")
                    .and_then(|f| f.get("enabled"))
                    .and_then(|e| e.as_bool())
            })
        {
            return enabled;
        }
    }
    // Legacy fallback: the flag used to live in the state file's
    // federation.enabled (before the settings/state split).
    match std::fs::read_to_string(relay_peers_path()) {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.get("federation")
                    .and_then(|f| f.get("enabled"))
                    .and_then(|e| e.as_bool())
            })
            .unwrap_or(false),
        Err(_) => false,
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
    /// One-pair (federation v2 §2): a single-use pairing TOKEN (base64),
    /// from a relay-pair:// URL. When it matches an outstanding pending
    /// entry on the RECEIVING relay, the receiver auto-adds the presenter
    /// (pinned to the presented key) and consumes the entry. Not a key —
    /// the relay's private keys never leave their machine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pair_secret: Option<String>,
    /// The sender's federation protocol version ([`FED_PROTO`]) — gates the
    /// segmented advertisement + onward-hop exchange (slice 3). Absent ⇒ 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fed_proto: Option<u32>,
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
    /// Wire symmetry with RelayHello (a relay answering a pair-secret hello
    /// may echo the token; consumers ignore it when absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pair_secret: Option<String>,
    /// Named decline reason on a `federate: false` ack (e.g. "unpinned_peer",
    /// "pairing_secret_unknown") — the 403-style explicit refusal, so the
    /// dialing relay's logs show WHY the handshake failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The sender's federation protocol version ([`FED_PROTO`]) — gates the
    /// segmented advertisement + onward-hop exchange (slice 3). Absent ⇒ 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fed_proto: Option<u32>,
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
    if !federation_enabled() {
        info!("relay federation disabled (relay-peers.json federation.enabled false/absent)");
        return;
    }
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
/// Verify + learn the peer's doc against its PRESENTED key; loud-warn when
/// the doc does not name us (strict declination lands with peer management).
fn learn_peer_doc_or_warn(
    federated: &Arc<FederatedSessions>,
    presented_pk: &str,
    env: &Option<PeerPairingEnvelope>,
    peer_label: &str,
    our_name: &str,
) {
    let Some(env) = env else { return };
    match verify_peer_pairing_doc(env, presented_pk) {
        Ok(doc) => {
            if !doc.peers.iter().any(|n| n == our_name) {
                warn!(
                    peer = %peer_label,
                    "peer pairing doc does not name us (theirs names {:?})",
                    doc.peers
                );
            }
            let version = doc.version;
            let peers = doc.peers;
            let pk = presented_pk.to_string();
            let f = Arc::clone(federated);
            tokio::spawn(async move {
                f.learn_peer_doc(&pk, version, peers).await;
            });
        }
        Err(e) => warn!(peer = %peer_label, err = %e, "peer pairing doc rejected"),
    }
}
async fn peering_loop(
    mesh: Arc<MeshStore>,
    registry: Arc<PeerRegistry>,
    pairing: Arc<PairingRegistry>,
    federated: Arc<FederatedSessions>,
    peer: RelayPeerConfig,
) {
    let mut backoff = 1u64;
    let mut warned_unpinned = false;
    loop {
        // Live gate: flipping federation off retires the peer's federated
        // sessions + idles; flipping back on reconnects — no restart.
        if !federation_enabled() {
            federated.unregister_sender(&peer.name).await;
            federated.clear_peer(&peer.name).await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            continue;
        }
        // FRESH config every cycle: the CLI can pin the peer (or change its
        // URL) after the loop was spawned — the fswatch spawner only starts
        // loops for NEW names, it never refreshes a loop it already spawned.
        let Some(current) = read_peer_config().into_iter().find(|p| p.name == peer.name) else {
            // Removed from the config: retire its federated state and idle
            // (the entry may come back; never dial a deconfigured peer).
            federated.unregister_sender(&peer.name).await;
            federated.clear_peer(&peer.name).await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        };
        // STRICT PIN GATE (outbound, federation v2 §1): a configured peer
        // WITHOUT a pinned pubkey is NOT dialed. One loud warn per peer
        // (not per retry cycle — no spam); the 5s re-pickup below means a
        // pin added later starts dialing without a restart.
        if current.pubkey.is_none() {
            if !warned_unpinned {
                warned_unpinned = true;
                warn!(
                    peer = %current.name,
                    url = %current.url,
                    "configured peer has NO pinned pubkey — NOT dialing. Pair it: 'unbien relay pair' on the peer relay, then 'unbien relay peer add relay-pair://…' here"
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        }
        match connect_and_verify(&mesh, &registry, &pairing, &federated, &current).await {
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

/// Connect outbound, exchange hellos, verify the explicit pairing.
async fn connect_and_verify(
    mesh: &Arc<MeshStore>,
    registry: &Arc<PeerRegistry>,
    pairing: &Arc<PairingRegistry>,
    federated: &Arc<FederatedSessions>,
    peer: &RelayPeerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // The pinned pubkey is the gate — peering_loop refuses to dial unpinned
    // peers; this is a defensive double-check (a config race could hand us
    // an entry without one).
    let pinned = peer
        .pubkey
        .as_deref()
        .ok_or("configured peer has no pinned pubkey — not dialing")?;

    // Convert http(s):// to ws(s):// — tokio_tungstenite requires ws/wss.
    let raw_url = format!("{}/relay-peer", peer.url.trim_end_matches('/'));
    let ws_url = raw_url
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1);
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await?;

    // Send our relay_hello (with relay identity for pairing). The pairing
    // secret rides along when the CLI stored one from the pairing URL —
    // the peer auto-adds us (pinned to the identity below) when it matches
    // an outstanding pending entry.
    let ours: Vec<String> = trust_root_hashes(mesh, pairing).into_iter().collect();
    let keypair = crate::relay_keypair::load_or_generate(None);
    let nonce = gen_relay_nonce();
    let name = federated.own_name();
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
        pair_secret: peer.pair_secret.clone(),
        fed_proto: Some(FED_PROTO),
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
        warn!(
            peer = %peer.name,
            reason = ack.reason.as_deref().unwrap_or("unspecified"),
            "peer relay DECLINED federation"
        );
        return Err(format!(
            "peer declined: {}",
            ack.reason.as_deref().unwrap_or("unspecified reason")
        )
        .into());
    }

    // Owner-set intersection: OBSERVABILITY ONLY (federation v2 §1) — the
    // pinned pairing above is the gate; log the intersection, never decline
    // on it. `owners` stays on the wire for logging + future use.
    {
        let theirs: HashSet<String> = ack.owners.iter().cloned().collect();
        let ours_set: HashSet<String> = ours.iter().cloned().collect();
        let common_owner = has_common_owner(&ours_set, &theirs);
        info!(
            peer = %peer.name,
            common_owner,
            "owner-set intersection with peer (observability only — pairing is the gate)"
        );
    }

    // Identity is MANDATORY for a pinned peer: the ack must present the
    // pinned key (exact match) + a signature proving possession of it.
    let (peer_pubkey, peer_nonce, peer_sig) = match (&ack.relay_pubkey, &ack.nonce, &ack.sig) {
        (Some(pk), Some(n), Some(s)) => (pk, n, s),
        _ => {
            warn!(peer = %peer.name, "pinned peer presented no relay identity, declining");
            return Err("pinned peer presented no relay identity".into());
        }
    };
    if peer_pubkey != pinned {
        warn!(
            peer = %peer.name,
            pinned = %short_key(pinned),
            got = %short_key(peer_pubkey),
            "relay pubkey mismatch — declining"
        );
        return Err("relay pubkey mismatch".into());
    }
    let peer_name = ack.relay_name.as_deref().unwrap_or("");
    let peer_url = ack.relay_url.as_deref().unwrap_or("");
    if !verify_relay_identity(peer_pubkey, peer_nonce, peer_name, peer_url, peer_sig) {
        warn!(peer = %peer.name, "relay identity signature invalid — declining");
        return Err("relay identity signature invalid".into());
    }

    info!(peer = %peer.name, "federated with peer relay (explicitly paired: pinned key verified)");

    // ── Slice 3: the TRANSITIVE advertisement exchange (federation v2 §4) ──
    // Everything outbound (advertisement, acks, forwards) rides ONE FIFO
    // channel drained by the writer task — the shared frame handler can
    // then ack on the arrival connection without owning a sink, and the
    // steady loop only reads.
    let (mut ws_sink, mut ws_stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if ws_sink
                .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    // The peer's protocol version decides the wire shape (additive +
    // back-compat): a pre-slice-3 peer gets EXACTLY ONE segment (our local
    // rooms) with NO marker — old behavior preserved.
    let peer_proto = ack.fed_proto.unwrap_or(1);
    // The peer's announced relay_name — an origin never advertised back to
    // itself, and a link never advertises the peer at its far end the
    // peer's own data.
    let peer_origin = ack.relay_name.clone().unwrap_or_default();
    send_advertisement(
        federated,
        registry,
        pairing,
        &tx,
        &AdvertiseTarget {
            proto: peer_proto,
            link: &peer.name,
            origin: &peer_origin,
            doc_for: &peer.name,
        },
    )
    .await;

    // Receive the peer's advertisement: ONE segment per origin; `done:
    // Some(true)` marks the last. A pre-slice-3 peer sends exactly ONE
    // unmarked frame. Non-segment frames interleaving the sequence
    // (incremental updates, forwards) are handled generically, not
    // dropped.
    let presented_pk = ack.relay_pubkey.clone().unwrap_or_default();
    let mut received = 0usize;
    loop {
        if peer_proto < FED_PROTO && received >= 1 {
            break;
        }
        let text = match tokio::time::timeout(Duration::from_secs(10), ws_stream.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) => t,
            Ok(Some(Ok(_))) => continue,
            _ => break, // closed or stalled mid-sequence — keep what we learned
        };
        if let Ok(list) = serde_json::from_str::<RelayPeerList>(&text) {
            let done = list.done == Some(true);
            received += 1;
            if received == 1 {
                learn_peer_doc_or_warn(
                    federated,
                    &presented_pk,
                    &list.peer_doc,
                    &peer.name,
                    &federated.own_name(),
                );
            }
            learn_peer_list_segment(federated, registry, &peer.name, list).await;
            if done {
                break;
            }
        } else {
            handle_peer_frame(federated, registry, &peer.name, &tx, &text).await;
        }
    }
    if received == 0 {
        writer.abort();
        return Err("peer closed before relay_peer_list".into());
    }
    info!(peer = %peer.name, "stored federated sessions from peer relay");

    // Register the link's channel: onward re-advertisement (updates minus
    // their arrival link) + via-routing ride it from the first moment.
    federated.register_sender(&peer.name, tx.clone()).await;

    // Steady state: incremental updates, forwards + acks (shared handler —
    // the SAME code as the inbound loop, so the two cannot drift).
    loop {
        let text = match ws_stream.next().await {
            None | Some(Err(_)) => break,
            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => break,
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => t,
            Some(Ok(_)) => continue,
        };
        handle_peer_frame(federated, registry, &peer.name, &tx, &text).await;
    }

    // Cleanup on disconnect: the writer task owns the sink — aborting it
    // closes the socket and closes the channel, so the registered sender
    // reports dead and is dropped by unregister_sender.
    writer.abort();
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
    // Gate: refuse federation entirely when disabled (403 — explicit, not a
    // silent drop, so a peer relay's logs show WHY the handshake failed).
    if !federation_enabled() {
        return (
            axum::http::StatusCode::FORBIDDEN,
            "relay federation disabled (relay-peers.json federation.enabled)",
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| handle_inbound_peer(state, socket))
}

/// Build + send a relay_hello_ack. Declines carry a NAMED reason (the
/// 403-style explicit refusal, so the dialing relay's logs show WHY the
/// handshake failed); the success ack has no reason.
async fn send_hello_ack(
    socket: &mut WebSocket,
    federate: bool,
    owners: Vec<String>,
    own_name: &str,
    reason: Option<&str>,
) {
    let keypair = crate::relay_keypair::load_or_generate(None);
    let nonce = gen_relay_nonce();
    let url = relay_own_url().unwrap_or_default();
    let sig = sign_relay_identity(&keypair, &nonce, own_name, &url);
    let ack = RelayHelloAck {
        kind: "relay_hello_ack".into(),
        federate,
        owners,
        relay_pubkey: Some(keypair.pubkey_b64()),
        relay_name: Some(own_name.to_string()),
        relay_url: if url.is_empty() { None } else { Some(url) },
        nonce: Some(nonce),
        sig: Some(sig),
        pair_secret: None,
        reason: reason.map(String::from),
        fed_proto: Some(FED_PROTO),
    };
    let _ = socket
        .send(Message::Text(
            serde_json::to_string(&ack).unwrap_or_default(),
        ))
        .await;
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

    let ours: Vec<String> = trust_root_hashes(&state.mesh, &state.pairing)
        .into_iter()
        .collect();
    let own_name = state.federated.own_name();

    // ── The link gate: EXPLICIT PAIRING (federation v2 §1–§2) ──
    // The shared-owner hash intersection RETIRED as a gate: it is computed
    // + logged below for observability, but PAIRING decides — either (a) a
    // valid single-use pairing secret held in relay-peers.json `pending`
    // (auto-add, pinned to the presented key), or (b) the strict pin gate:
    // the presenter's key must already be pinned in peers[].
    let federate = if let Some(pair_secret) = hello.pair_secret.as_deref() {
        // (a) One-pair: identity verification is MANDATORY on this path —
        // the auto-added entry pins the PRESENTED key, so the hello must
        // prove possession of it first.
        let (peer_pubkey, peer_nonce, peer_sig) =
            match (&hello.relay_pubkey, &hello.nonce, &hello.sig) {
                (Some(pk), Some(n), Some(s)) => (pk, n, s),
                _ => {
                    warn!("relay-peer: pairing hello missing identity fields, declining");
                    send_hello_ack(
                        &mut socket,
                        false,
                        ours,
                        &own_name,
                        Some("pairing_identity_missing"),
                    )
                    .await;
                    return;
                }
            };
        let peer_name = hello.relay_name.as_deref().unwrap_or("");
        let peer_url = hello.relay_url.as_deref().unwrap_or("");
        if !verify_relay_identity(peer_pubkey, peer_nonce, peer_name, peer_url, peer_sig) {
            warn!(
                peer = %peer_name,
                "relay-peer: pairing hello identity signature INVALID, declining"
            );
            send_hello_ack(
                &mut socket,
                false,
                ours,
                &own_name,
                Some("pairing_identity_invalid"),
            )
            .await;
            return;
        }
        // The auto-added entry records the presenter's OWN advertised
        // url/name — both required non-empty (a nameless/urlless entry can
        // never be dialed back).
        if peer_url.is_empty() || peer_name.is_empty() {
            warn!(
                peer = %peer_name,
                "relay-peer: pairing hello missing relay_name/relay_url, declining"
            );
            send_hello_ack(
                &mut socket,
                false,
                ours,
                &own_name,
                Some("pairing_missing_name_or_url"),
            )
            .await;
            return;
        }
        match crate::peers::peers_config::consume_pending_and_add_peer(
            pair_secret,
            peer_url,
            peer_name,
            peer_pubkey,
        ) {
            Ok(true) => {
                info!(
                    peer = %peer_name,
                    url = %peer_url,
                    "PAIRING: valid pending secret — peer AUTO-ADDED (pinned) + pending entry consumed"
                );
                true
            }
            Ok(false) => {
                warn!(
                    peer = %peer_name,
                    "relay-peer: pairing secret matches NO pending entry (wrong or already used), declining"
                );
                send_hello_ack(
                    &mut socket,
                    false,
                    ours,
                    &own_name,
                    Some("pairing_secret_unknown"),
                )
                .await;
                return;
            }
            Err(e) => {
                warn!(
                    peer = %peer_name,
                    err = %e,
                    "relay-peer: pairing auto-add FAILED (config write), declining"
                );
                send_hello_ack(
                    &mut socket,
                    false,
                    ours,
                    &own_name,
                    Some("pairing_write_failed"),
                )
                .await;
                return;
            }
        }
    } else {
        // (b) STRICT PIN GATE: the presenter's key must be PINNED in
        // relay-peers.json. Identity signature verification is mandatory
        // for configured peers.
        let Some(peer_pubkey) = hello.relay_pubkey.as_deref() else {
            warn!("relay-peer: unpinned presenter (no relay_pubkey in hello), declining");
            send_hello_ack(&mut socket, false, ours, &own_name, Some("unpinned_peer")).await;
            return;
        };
        let (peer_nonce, peer_sig) = match (hello.nonce.as_deref(), hello.sig.as_deref()) {
            (Some(n), Some(s)) => (n, s),
            _ => {
                warn!(
                    peer_pubkey = %short_key(peer_pubkey),
                    "relay-peer: presenter missing identity signature, declining"
                );
                send_hello_ack(
                    &mut socket,
                    false,
                    ours,
                    &own_name,
                    Some("identity_missing"),
                )
                .await;
                return;
            }
        };
        let peer_name = hello.relay_name.as_deref().unwrap_or("");
        let peer_url = hello.relay_url.as_deref().unwrap_or("");
        if !verify_relay_identity(peer_pubkey, peer_nonce, peer_name, peer_url, peer_sig) {
            warn!(
                peer = %peer_name,
                "relay-peer: identity signature INVALID, declining"
            );
            send_hello_ack(
                &mut socket,
                false,
                ours,
                &own_name,
                Some("identity_invalid"),
            )
            .await;
            return;
        }
        let pinned = read_peer_config()
            .iter()
            .any(|p| p.pubkey.as_deref() == Some(peer_pubkey));
        if !pinned {
            warn!(
                peer = %peer_name,
                pubkey = %short_key(peer_pubkey),
                "relay-peer: presenter pubkey NOT PINNED in relay-peers.json, declining"
            );
            send_hello_ack(&mut socket, false, ours, &own_name, Some("unpinned_peer")).await;
            return;
        }
        true
    };

    // Owner-set intersection: OBSERVABILITY ONLY (federation v2 §1) — log
    // it, never decide federation on it. `owners` stays on the wire.
    {
        let theirs: HashSet<String> = hello.owners.iter().cloned().collect();
        let ours_set: HashSet<String> = ours.iter().cloned().collect();
        let common_owner = has_common_owner(&ours_set, &theirs);
        info!(
            common_owner,
            "owner-set intersection with inbound peer (observability only — pairing is the gate)"
        );
    }

    // Send relay_hello_ack (with relay identity for pairing).
    send_hello_ack(&mut socket, federate, ours, &own_name, None).await;

    info!("relay-peer: federated (explicitly paired)");

    // ── Slice 3: the TRANSITIVE advertisement exchange (federation v2 §4) ──
    // Same single-write-path design as the outbound loop: everything
    // outbound (advertisement, acks, forwards) rides ONE FIFO channel
    // drained by the writer task, so the shared frame handler can ack on
    // the arrival connection without owning a sink.
    let (mut socket_sink, mut socket_stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if socket_sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Receive the peer's advertisement: ONE segment per origin; `done:
    // Some(true)` marks the last; a pre-slice-3 peer sends exactly ONE
    // unmarked frame. The FIRST segment's relay_name is the arrival LINK
    // name (the dialing relay's own segment is always first). Non-segment
    // frames interleaving the sequence are handled generically, not
    // dropped.
    let peer_proto = hello.fed_proto.unwrap_or(1);
    let presented_pk = hello.relay_pubkey.clone().unwrap_or_default();
    let mut arrival_link: Option<String> = None;
    let mut received = 0usize;
    loop {
        if peer_proto < FED_PROTO && received >= 1 {
            break;
        }
        let text = match tokio::time::timeout(Duration::from_secs(10), socket_stream.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => t,
            Ok(Some(Ok(_))) => continue,
            _ => break, // closed or stalled mid-sequence — keep what we learned
        };
        if let Ok(list) = serde_json::from_str::<RelayPeerList>(&text) {
            let done = list.done == Some(true);
            received += 1;
            if received == 1 {
                learn_peer_doc_or_warn(
                    &state.federated,
                    &presented_pk,
                    &list.peer_doc,
                    "inbound",
                    &state.federated.own_name(),
                );
            }
            let link = arrival_link.get_or_insert_with(|| list.relay_name.clone());
            learn_peer_list_segment(&state.federated, &state.registry, link, list).await;
            if done {
                break;
            }
        } else {
            handle_peer_frame(
                &state.federated,
                &state.registry,
                arrival_link.as_deref().unwrap_or(""),
                &tx,
                &text,
            )
            .await;
        }
    }
    if received == 0 {
        warn!("relay-peer: expected relay_peer_list, got disconnect");
        writer.abort();
        return;
    }
    let arrival_link = arrival_link.unwrap_or_default();
    info!(
        relay = %arrival_link,
        "stored federated sessions from inbound peer relay"
    );

    // Register the link's channel: onward re-advertisement (updates minus
    // their arrival link) + via-routing ride it from the first moment.
    state
        .federated
        .register_sender(&arrival_link, tx.clone())
        .await;

    // Send OUR advertisement: self segment (own local rooms + pairings)
    // plus one segment per known ORIGIN — never the peer's own data back,
    // never back to the arrival link, self-origin filtered.
    send_advertisement(
        &state.federated,
        &state.registry,
        &state.pairing,
        &tx,
        &AdvertiseTarget {
            proto: peer_proto,
            link: &arrival_link,
            origin: &arrival_link,
            doc_for: hello.relay_name.as_deref().unwrap_or(""),
        },
    )
    .await;

    // Steady state: incremental updates, forwards + acks (shared handler —
    // the SAME code as the outbound loop, so the two cannot drift).
    loop {
        let text = match socket_stream.next().await {
            None | Some(Err(_)) => break,
            Some(Ok(Message::Close(_))) => break,
            Some(Ok(Message::Text(t))) => t,
            Some(Ok(_)) => continue,
        };
        handle_peer_frame(&state.federated, &state.registry, &arrival_link, &tx, &text).await;
    }

    // Cleanup on disconnect: the writer task owns the sink — aborting it
    // closes the socket and closes the channel, so the registered sender
    // reports dead and is dropped by unregister_sender.
    writer.abort();
    state.federated.unregister_sender(&arrival_link).await;
    state.federated.clear_peer(&arrival_link).await;
    broadcast_federated_list(&state.registry, &state.federated).await;
}

// ── Shared advertisement + frame handling (ONE code path for BOTH peering
//    loops — the inbound/outbound drift bugs live in the dual-loop history) ─

/// Learn one origin-tagged `relay_peer_list` segment (federation v2 §4).
/// `arrival_link` is the LINK name the segment arrived on (the via-map
/// entry: advertisement implies route). SELF-ORIGIN segments are IGNORED
/// — a relay never accepts advertisements naming itself; this is the
/// propagation terminator (together with the never-back rule).
async fn learn_peer_list_segment(
    federated: &Arc<FederatedSessions>,
    registry: &Arc<PeerRegistry>,
    arrival_link: &str,
    list: RelayPeerList,
) {
    if list.relay_name == federated.own_name() {
        warn!(
            origin = %list.relay_name,
            "ignoring advertisement naming ourselves (self-origin filter)"
        );
        return;
    }
    federated.learn_via(&list.relay_name, arrival_link).await;
    federated
        .set_peer_rooms(&list.relay_name, list.rooms_by_epk)
        .await;
    federated
        .learn_machine_pairings(
            arrival_link,
            &list.relay_name,
            list.machine_pairings
                .into_iter()
                .map(|p| (p.machine, p.version, p.blob, p.sig))
                .collect(),
        )
        .await;
    broadcast_federated_list(registry, federated).await;
}

/// Build + send the full advertisement for one peer link (federation v2 §4):
/// the SELF segment (own local rooms + own machines' signed pairings,
/// ALWAYS FIRST so a pre-slice-3 peer reading one frame gets exactly the
/// old behavior) plus one segment per known ORIGIN — everything learned
/// from other peers, origin-tagged, self-origin filtered, never the peer
/// its own data back, never back to the link it arrived on.
///
/// Sequence semantics: protocol-2 peers get `done: Some(false)` on every
/// segment except the last (`done: Some(true)`); a pre-slice-3 peer gets
/// EXACTLY ONE segment (its local rooms) with NO marker — additive +
/// back-compat.
async fn send_advertisement(
    federated: &Arc<FederatedSessions>,
    registry: &Arc<PeerRegistry>,
    pairing: &Arc<PairingRegistry>,
    conn: &mpsc::UnboundedSender<String>,
    target: &AdvertiseTarget<'_>,
) {
    let mut segments = federated
        .advertisement_segments(registry, pairing, target.link, target.origin)
        .await;
    // The self segment carries OUR signed peer-pairing doc (presenting
    // ourselves to `target.doc_for`); transit segments carry none — a
    // transit relay cannot present the origin's identity.
    if let Some(first) = segments.first_mut() {
        let kp = crate::relay_keypair::load_or_generate(None);
        first.peer_doc = Some(build_peer_doc_envelope(&kp, target.doc_for));
    }
    if target.proto >= FED_PROTO {
        let last = segments.len();
        for (i, seg) in segments.iter_mut().enumerate() {
            seg.done = Some(i + 1 == last);
            let _ = conn.send(serde_json::to_string(seg).unwrap_or_default());
        }
    } else {
        // Pre-slice-3 peer: ONE segment (local rooms), no marker.
        if let Some(seg) = segments.first() {
            let _ = conn.send(serde_json::to_string(seg).unwrap_or_default());
        }
    }
}

/// The peer-side context of ONE link's advertisement exchange: what proto
/// the peer speaks (segment markers vs the single legacy frame), which LINK
/// the advertisement rides (never-back exclusion), the peer's announced
/// ORIGIN name (never advertise a peer its own data back), and the name to
/// present in our peer-pairing doc.
struct AdvertiseTarget<'a> {
    proto: u32,
    link: &'a str,
    origin: &'a str,
    doc_for: &'a str,
}

/// Handle ONE inbound text frame from a federated peer relay — the SHARED
/// steady-state path for BOTH peering loops (and for frames interleaving
/// the advertisement sequence). `arrival_link` is the LINK name the frame
/// arrived on (never-back exclusion + via routing + route learning);
/// `conn_tx` is the arrival connection's outbound channel — acks and
/// onward re-advertisements ride it (or another link's channel).
async fn handle_peer_frame(
    federated: &Arc<FederatedSessions>,
    registry: &Arc<PeerRegistry>,
    arrival_link: &str,
    conn_tx: &mpsc::UnboundedSender<String>,
    text: &str,
) {
    // relay_peer_update — incremental session change (origin-tagged via
    // relay_name). Self-origin updates are ignored (self-origin filter);
    // everything else re-advertises ONWARD minus the arrival link.
    if let Ok(update) = serde_json::from_str::<RelayPeerUpdate>(text) {
        if update.relay_name == federated.own_name() {
            return;
        }
        match update.action.as_str() {
            "add" => {
                if let Ok(room) = serde_json::from_value::<RoomMeta>(update.room.clone()) {
                    federated.learn_via(&update.relay_name, arrival_link).await;
                    federated
                        .add_room(&update.relay_name, &update.epk, room)
                        .await;
                    broadcast_federated_list(registry, federated).await;
                    federated.relay_update_onward(arrival_link, text).await;
                }
            }
            "remove" => {
                if let Some(room_id) = update.room.get("room_id").and_then(|v| v.as_str()) {
                    federated
                        .remove_room(&update.relay_name, &update.epk, room_id)
                        .await;
                    broadcast_federated_list(registry, federated).await;
                    federated.relay_update_onward(arrival_link, text).await;
                }
            }
            _ => {}
        }
        return;
    }
    // relay_pairings_update — incremental pairing change. Origin-tagged
    // (slice 3): an ABSENT origin field means the sending relay itself
    // (pre-slice-3 peers broadcast only their OWN machines' pushes — the
    // attribution is then the arrival link, conservative for purge).
    if let Ok(upd) = serde_json::from_str::<serde_json::Value>(text)
        && upd["kind"].as_str() == Some("relay_pairings_update")
    {
        let origin = upd["origin"].as_str().unwrap_or(arrival_link).to_string();
        if origin == federated.own_name() {
            return; // self-origin filter
        }
        if let (Some(machine), Some(blob), Some(sig)) = (
            upd["machine"].as_str(),
            upd["blob"].as_str(),
            upd["sig"].as_str(),
        ) {
            federated
                .learn_machine_pairing(
                    arrival_link,
                    &origin,
                    machine,
                    upd["version"].as_u64().unwrap_or(0),
                    blob.to_string(),
                    sig.to_string(),
                )
                .await;
            federated.learn_via(&origin, arrival_link).await;
            federated.relay_update_onward(arrival_link, text).await;
        }
        return;
    }
    // relay_forward — deliver locally, HOP ONWARD, or ack (slice 3).
    if let Ok(forward) = serde_json::from_str::<RelayForward>(text) {
        handle_relay_forward(federated, registry, arrival_link, conn_tx, forward).await;
        return;
    }
    // relay_forward_ack — return VERBATIM along the hop path (the bounded
    // id→backlink map), or resolve our own pending forward.
    if let Ok(ack) = serde_json::from_str::<RelayForwardAck>(text) {
        if let Some(backlink) = federated.take_hop_backlink(&ack.request_id).await {
            let _ = backlink.send(text.to_string());
        } else {
            federated.resolve_forward_ack(ack).await;
        }
    }
}

/// One verified `relay_forward`: deliver locally when the target is ours;
/// otherwise HOP ONWARD per the advertisement-implied route (re-signed by
/// THIS relay, `visited` + own name, ack relayed back along the recorded
/// backlink). Unroutable targets still ack `unknown_peer` — a route miss is
/// refused + logged, never fanned out (federation v2 §4).
async fn handle_relay_forward(
    federated: &Arc<FederatedSessions>,
    registry: &Arc<PeerRegistry>,
    arrival_link: &str,
    conn_tx: &mpsc::UnboundedSender<String>,
    forward: RelayForward,
) {
    let ack_on = |status: &str| {
        let ack = RelayForwardAck {
            kind: "relay_forward_ack".into(),
            request_id: forward.request_id.clone(),
            status: status.to_string(),
        };
        let _ = conn_tx.send(serde_json::to_string(&ack).unwrap_or_default());
    };
    // Loop guard (unchanged): a relay never handles a forward twice.
    if forward.visited.contains(&federated.own_name()) {
        ack_on("unknown_peer");
        return;
    }
    // Per-hop provenance (unchanged): the IMMEDIATE sender's signature over
    // (request_id + from_epk + target_epk + visited).
    let sig_valid = crate::membership::verify_relay_forward(
        &forward.request_id,
        &forward.from_epk,
        &forward.target_epk,
        &forward.visited,
        &forward.relay_pubkey,
        &forward.relay_sig,
    );
    if !sig_valid {
        ack_on("unknown_peer");
        return;
    }
    // The verified packet IS the route source: learn that the sender's
    // origin epk rides this link (reply legs for app epks — refreshed per
    // frame, purged with the link).
    federated.learn_route(&forward.from_epk, arrival_link).await;

    // Local delivery — only when the target is OURS. A target that is
    // online here but hits a DEAD ROOM drops silently (the contract);
    // forwarding a local target onward to a federated route would be
    // wrong (the machine is HERE).
    if registry.is_online(&forward.target_epk) {
        // Outer-envelope forward (app→pi / ub frames): the opaque
        // {peer, room, ct} rides the SAME verified provenance the inner
        // form has — authenticated-forwarding REQUIRED. Delivered
        // verbatim to (target, room), with NO dest-side re-check (9779b88
        // — the deciding relay is always the SOURCE: its pairing + the §3
        // owner-set gates decided).
        if forward.room.is_some() && forward.ct.is_some() {
            let ack_status = if registry.forward(
                &forward.target_epk,
                forward.room.as_deref().unwrap_or_default(),
                Message::Text(
                    serde_json::json!({
                        "peer": forward.from_epk,
                        "room": forward.room.clone().unwrap_or_default(),
                        "ct": forward.ct.clone().unwrap_or_default(),
                    })
                    .to_string(),
                ),
                PeerRegistry::NO_SKIP_CONN,
            ) {
                "forwarded"
            } else {
                "unknown_peer"
            };
            ack_on(ack_status);
            return;
        }
        let outbound = serde_json::json!({
            "type": "pi_envelope_in",
            "from_pc": forward.from_epk,
            "envelope": forward.envelope,
        });
        let status =
            if registry.forward_to_peer(&forward.target_epk, Message::Text(outbound.to_string())) {
                "forwarded"
            } else {
                "unknown_peer"
            };
        ack_on(status);
        return;
    }

    // Not local — ONWARD HOP (federation v2 §4): re-sign with THIS relay's
    // keypair (same request_id + from/target + payload, visited + own
    // name), send on the advertisement-implied via link, and record the
    // id→backlink so the dest's ack returns verbatim along the delivery
    // path. `visited` stays the loop guard; no ack here — the dest acks.
    let keypair = crate::relay_keypair::load_or_generate(None);
    if federated
        .hop_forward(&keypair, arrival_link, &forward, conn_tx.clone())
        .await
        .is_some()
    {
        return;
    }
    // Unknown/unroutable target — the routed refusal (never a fan-out).
    warn!(
        target = %&forward.target_epk[..forward.target_epk.len().min(8)],
        "relay_forward target has no local session and no federated route — acking unknown_peer"
    );
    ack_on("unknown_peer");
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
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
            pair_secret: None,
            fed_proto: None,
        };
        let json = serde_json::to_string(&hello).unwrap();
        assert!(json.contains("\"type\":\"relay_hello\""));
        assert!(json.contains("\"owners\""));
        assert!(
            !json.contains("pair_secret"),
            "absent secret stays off the wire"
        );

        // The one-pair token rides the hello when present.
        let paired = RelayHello {
            pair_secret: Some("tok".into()),
            ..hello
        };
        let json = serde_json::to_string(&paired).unwrap();
        assert!(json.contains("\"pair_secret\":\"tok\""));
        let back: RelayHello = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pair_secret.as_deref(), Some("tok"));

        let ack: RelayHelloAck = serde_json::from_str(
            r#"{"type":"relay_hello_ack","federate":true,"owners":["hash1"]}"#,
        )
        .unwrap();
        assert!(ack.federate);
        assert_eq!(ack.owners, vec!["hash1"]);
        assert!(
            ack.pair_secret.is_none(),
            "ack consumer ignores absent secret"
        );
        assert!(ack.reason.is_none());

        // A named decline: the reason must round-trip (the 403-style explicit
        // refusal — the dialing relay's logs show WHY).
        let decline: RelayHelloAck = serde_json::from_str(
            r#"{"type":"relay_hello_ack","federate":false,"owners":[],"reason":"unpinned_peer"}"#,
        )
        .unwrap();
        assert!(!decline.federate);
        assert_eq!(decline.reason.as_deref(), Some("unpinned_peer"));
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

    // ── Slice 3 (federation v2 §4): wire serde, via-routing, onward hop +
    //    ack backlink, advertisement segments, link-death purge ─────────

    #[test]
    fn peer_list_done_and_fed_proto_serde() {
        // `done` + `fed_proto` are ADDITIVE: absent ⇒ None on the wire (old
        // peers see neither field), present ⇒ round-trip.
        let old_frame = serde_json::from_str::<RelayPeerList>(
            r#"{"type":"relay_peer_list","relay_name":"relay-a","rooms_by_epk":{}}"#,
        )
        .unwrap();
        assert!(old_frame.done.is_none());
        assert!(
            serde_json::to_string(&old_frame)
                .unwrap()
                .find("done")
                .is_none()
        );

        let marked = RelayPeerList {
            done: Some(false),
            ..old_frame.clone()
        };
        let json = serde_json::to_string(&marked).unwrap();
        assert!(json.contains("\"done\":false"));
        let back: RelayPeerList = serde_json::from_str(&json).unwrap();
        assert_eq!(back.done, Some(false));

        let hello = serde_json::from_str::<RelayHello>(
            r#"{"type":"relay_hello","owners":[],"fed_proto":2}"#,
        )
        .unwrap();
        assert_eq!(hello.fed_proto, Some(FED_PROTO));
        let ack = serde_json::from_str::<RelayHelloAck>(
            r#"{"type":"relay_hello_ack","federate":true,"owners":[]}"#,
        )
        .unwrap();
        assert!(ack.fed_proto.is_none(), "absent proto ⇒ old peer (1)");
    }

    fn room(id: &str) -> RoomMeta {
        RoomMeta {
            room_id: id.into(),
            name: None,
            cwd: None,
            model: None,
            thinking: None,
            working: false,
            started_at: 0,
            extra: Default::default(),
        }
    }

    /// A machine-SIGNED pairing blob (b64 blob + b64 sig) — the same shape
    /// the extension pushes and the exchange carries.
    fn signed_pairing_blob(
        machine: &SigningKey,
        owners: &[String],
        version: u64,
    ) -> (String, String, String) {
        let machine_pk = B64.encode(machine.verifying_key().to_bytes());
        let blob = serde_json::json!({
            "machine_pk": machine_pk,
            "owners": owners,
            "version": version,
            "issued_at": 1_700_000_000_000_u64,
        });
        let blob_bytes = serde_json::to_vec(&blob).unwrap();
        let sig = machine.sign(&blob_bytes);
        (
            machine_pk,
            B64.encode(&blob_bytes),
            B64.encode(sig.to_bytes()),
        )
    }

    #[tokio::test]
    async fn via_routing_resolves_transitive_origins() {
        // B knows origin "relay-c" (rooms) via LINK "link-bc" — a forward to
        // the machine's epk must ride the VIA link's channel, even though no
        // sender is registered under the ORIGIN name (advertisement implies
        // route).
        let fed = FederatedSessions::with_name("relay-b");
        let mut rooms = HashMap::new();
        rooms.insert("machine-epk".to_string(), vec![room("main")]);
        fed.set_peer_rooms("relay-c", rooms).await;
        fed.learn_via("relay-c", "link-bc").await;
        assert_eq!(fed.relays_for_epk("machine-epk").await, vec!["relay-c"]);

        let (tx, rx) = mpsc::unbounded_channel::<String>();
        fed.register_sender("link-bc", tx).await;

        let tx = fed.sender_for_candidate("relay-c", None).await;
        assert!(tx.is_some(), "origin resolves through the via map");
        // The direct-link resolution still works (a candidate that IS a link).
        assert!(fed.sender_for_candidate("link-bc", None).await.is_some());
        // The arrival link is excluded on the onward hop.
        assert!(
            fed.sender_for_candidate("relay-c", Some("link-bc"))
                .await
                .is_none()
        );
        drop(rx);
    }

    #[tokio::test]
    async fn hop_forward_re_signs_and_acks_relay_verbatim() {
        // The chain A→B→C: B holds a route for the machine (origin relay-c
        // via link-bc) and receives A's forward on the A-link. The HOP must
        // re-sign with B's key (visited + relay-b) and record the backlink so
        // C's ack returns VERBATIM to A's connection.
        let fed = FederatedSessions::with_name("relay-b");
        let mut rooms = HashMap::new();
        rooms.insert("machine-epk".to_string(), vec![room("main")]);
        fed.set_peer_rooms("relay-c", rooms).await;
        fed.learn_via("relay-c", "link-bc").await;
        let (onward_tx, mut onward_rx) = mpsc::unbounded_channel::<String>();
        fed.register_sender("link-bc", onward_tx).await;
        let (arrival_tx, mut arrival_rx) = mpsc::unbounded_channel::<String>();

        // A's signed forward (target NOT local at B).
        let a_sk = SigningKey::generate(&mut rand::thread_rng());
        let a_kp = RelayKeypair {
            verifying_key: a_sk.verifying_key(),
            signing_key: a_sk,
        };
        let forward = RelayForward {
            kind: "relay_forward".into(),
            request_id: "req-1".into(),
            from_epk: "app-epk".into(),
            target_epk: "machine-epk".into(),
            envelope: serde_json::json!({"opaque": true}),
            visited: vec!["relay-a".into()],
            relay_pubkey: Some(a_kp.pubkey_b64()),
            relay_sig: Some(a_kp.sign(b"sig")),
            room: None,
            ct: None,
        };
        let b_sk = SigningKey::generate(&mut rand::thread_rng());
        let b_kp = RelayKeypair {
            verifying_key: b_sk.verifying_key(),
            signing_key: b_sk,
        };
        let onward = fed
            .hop_forward(&b_kp, "link-ab", &forward, arrival_tx)
            .await;
        assert_eq!(onward.as_deref(), Some("relay-c"), "hop rides the via link");

        // The onward frame: same request_id + payload, visited grown, signed
        // by B (per-hop provenance — verify_relay_forward passes).
        let text = onward_rx.recv().await.expect("onward frame");
        let hop: RelayForward = serde_json::from_str(&text).unwrap();
        assert_eq!(hop.request_id, "req-1");
        assert_eq!(
            hop.visited,
            vec!["relay-a".to_string(), "relay-b".to_string()]
        );
        assert_eq!(hop.envelope, serde_json::json!({"opaque": true}));
        assert!(crate::membership::verify_relay_forward(
            &hop.request_id,
            &hop.from_epk,
            &hop.target_epk,
            &hop.visited,
            &hop.relay_pubkey,
            &hop.relay_sig,
        ));

        // No immediate ack (the dest acks) — but the backlink relays C's ack
        // VERBATIM to the arrival connection.
        let back = fed.take_hop_backlink("req-1").await;
        assert!(back.is_some(), "backlink recorded for the hop");
        assert!(fed.take_hop_backlink("req-1").await.is_none(), "single ack");
        let ack_text = serde_json::to_string(&RelayForwardAck {
            kind: "relay_forward_ack".into(),
            request_id: "req-1".into(),
            status: "forwarded".into(),
        })
        .unwrap();
        back.unwrap().send(ack_text.clone()).unwrap();
        assert_eq!(arrival_rx.recv().await.as_deref(), Some(ack_text.as_str()));
    }

    fn empty_registry() -> Arc<PeerRegistry> {
        Arc::new(PeerRegistry::new(
            Arc::new(crate::PresenceManager::new()),
            Arc::new(crate::RoomManager::new()),
            Arc::new(crate::metrics::FirehoseMetrics::new()),
        ))
    }

    #[tokio::test]
    async fn advertisement_segments_origin_tagged_and_filtered() {
        use ed25519_dalek::SigningKey;
        // B knows origin relay-c (rooms + a pairing) via link-bc. Advertising
        // to A: the SELF segment first, then an origin-tagged relay-c segment
        // (never A's own data back, never back to link-bc).
        let fed = FederatedSessions::with_name("relay-b");
        let mut rooms = HashMap::new();
        rooms.insert("machine-epk".to_string(), vec![room("main")]);
        fed.set_peer_rooms("relay-c", rooms).await;
        fed.learn_via("relay-c", "link-bc").await;
        let machine = SigningKey::generate(&mut rand::thread_rng());
        let (machine_pk, blob, sig) = signed_pairing_blob(&machine, &[B64.encode([7u8; 32])], 1);
        fed.learn_machine_pairings(
            "link-bc",
            "relay-c",
            vec![(machine_pk.clone(), 1, blob.clone(), sig.clone())],
        )
        .await;

        let registry = empty_registry();
        let pairing = PairingRegistry::new();

        // To A (link-ab, origin relay-a): self + relay-c.
        let segments = fed
            .advertisement_segments(&registry, &pairing, "link-ab", "relay-a")
            .await;
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].relay_name, "relay-b", "self segment FIRST");
        assert_eq!(segments[1].relay_name, "relay-c", "origin-tagged transit");
        assert_eq!(segments[1].rooms_by_epk.len(), 1);
        assert_eq!(segments[1].machine_pairings.len(), 1);
        assert_eq!(segments[1].machine_pairings[0].machine, machine_pk);
        assert_eq!(
            segments[1].machine_pairings[0].blob, blob,
            "signed blob verbatim"
        );
        assert!(
            segments[1].peer_doc.is_none(),
            "transit segments carry no doc"
        );

        // Never-back: advertising on link-bc (the arrival link) excludes relay-c.
        let segments = fed
            .advertisement_segments(&registry, &pairing, "link-bc", "relay-c")
            .await;
        assert_eq!(segments.len(), 1, "origin arrived on link-bc — never back");
        assert_eq!(segments[0].relay_name, "relay-b");
    }

    #[tokio::test]
    async fn clear_peer_purges_origins_and_pairings_conservatively() {
        use ed25519_dalek::SigningKey;
        // A machine's pairing learned via B purges when B's link dies —
        // even though the origin is named relay-c; rooms keyed by the
        // origin purge when the origin loses its LAST via link.
        let fed = FederatedSessions::with_name("relay-a");
        let mut rooms = HashMap::new();
        rooms.insert("machine-epk".to_string(), vec![room("main")]);
        fed.set_peer_rooms("relay-c", rooms).await;
        fed.learn_via("relay-c", "link-bc").await;
        let machine = SigningKey::generate(&mut rand::thread_rng());
        let (machine_pk, blob, sig) = signed_pairing_blob(&machine, &[B64.encode([7u8; 32])], 1);
        fed.learn_machine_pairings(
            "link-bc",
            "relay-c",
            vec![(machine_pk.clone(), 1, blob, sig)],
        )
        .await;
        assert!(fed.machine_owners(&machine_pk).await.is_some());

        fed.clear_peer("link-bc").await;
        assert!(fed.relays_for_epk("machine-epk").await.is_empty());
        assert!(
            fed.machine_owners(&machine_pk).await.is_none(),
            "source-link purge"
        );

        // Multi-link survival: an origin reachable via TWO links keeps its
        // sessions + pairings when ONE dies.
        let mut rooms = HashMap::new();
        rooms.insert("machine-epk".to_string(), vec![room("main")]);
        fed.set_peer_rooms("relay-c", rooms).await;
        fed.learn_via("relay-c", "link-bc").await;
        fed.learn_via("relay-c", "link-cd").await;
        let machine = SigningKey::generate(&mut rand::thread_rng());
        let (machine_pk, blob, sig) = signed_pairing_blob(&machine, &[B64.encode([7u8; 32])], 2);
        fed.learn_machine_pairings(
            "link-cd",
            "relay-c",
            vec![(machine_pk.clone(), 2, blob, sig)],
        )
        .await;
        fed.clear_peer("link-bc").await;
        assert_eq!(
            fed.relays_for_epk("machine-epk").await.len(),
            1,
            "still via link-cd"
        );
        assert!(fed.machine_owners(&machine_pk).await.is_some());
        fed.clear_peer("link-cd").await;
        assert!(
            fed.relays_for_epk("machine-epk").await.is_empty(),
            "last link gone"
        );
    }
}

// ── Phase 3: FederatedSessions + peer list exchange + cross-relay forwarding ─

use crate::peers::registry::PeerRegistry;
use crate::rooms::RoomMeta;
use std::collections::{HashMap, VecDeque};
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
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RelayForwardAck {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub status: String, // "forwarded" | "unknown_peer"
}

/// Stores rooms from federated peer relays. Keyed by (peer_relay_name, epk)
/// → Vec<RoomMeta>. Also maintains an epk → peer_relay_name index for
/// forwarding (which peer relay handles a given target epk?).
/// Stores rooms from federated peer relays. Keyed by (ORIGIN relay name,
/// epk) → Vec<RoomMeta> (federation v2 §4: origin-tagged — a transit relay
/// re-advertises segments under the origin's name). Also maintains an epk →
/// origin/link name index for forwarding (which relay handles a given
/// target epk?) and the VIA map (origin → the links its advertisement
/// arrived on — advertisement implies route).
pub struct FederatedSessions {
    /// This relay's identity for hello/visited stamping (default: hostname).
    own_name: String,
    /// (origin relay name, epk) → Vec<RoomMeta>
    sessions: Mutex<HashMap<(String, String), Vec<RoomMeta>>>,
    /// epk → list of origin/link names (for forwarding — multi-route fallback;
    /// room-hosted epks name ORIGINS, app epks name learned-route LINKS)
    epk_to_relays: Mutex<HashMap<String, Vec<String>>>,
    /// peer_relay_name (LINK) → WS sender channel (for relay_forward, raw
    /// JSON text)
    forward_senders: Mutex<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>,
    pending_forwards: Mutex<HashMap<String, oneshot::Sender<RelayForwardAck>>>,
    /// Federated pairing snapshot (check-before-forward design):
    /// machine epk → learned set. PUBLIC data exchanged over the paired
    /// link; version-monotonic per machine; purged with the SOURCE link in
    /// clear_peer (conservative). The machine-SIGNED blob+sig are kept
    /// verbatim so transit re-advertisement needs no re-signing (only the
    /// machine can sign).
    machine_pairings: Mutex<FederatedMachinePairings>,
    /// Learned peer-pairing documents: presented relay pubkey → (version,
    /// peer names). Signature-verified at the handshake; used for state and
    /// future strict gating.
    peer_docs: Mutex<HashMap<String, (u64, Vec<String>)>>,
    /// VIA map (federation v2 §4): ORIGIN relay name → the LINK name(s) its
    /// advertisement arrived on. Advertisement implies route — a forward
    /// to an origin's epk rides the via link's channel; purged with the
    /// link (an origin that loses its last link purges entirely).
    via: Mutex<HashMap<String, Vec<String>>>,
    /// ONWARD HOP backlinks (federation v2 §4): request_id → the arrival
    /// connection's outbound channel, so the dest's ack returns VERBATIM
    /// to the relay the forward arrived from (no id rewriting). Bounded
    /// (LRU-evicted) + TTL-pruned.
    hop_backlinks: Mutex<VecDeque<(String, Instant, mpsc::UnboundedSender<String>)>>,
}

pub fn default_relay_name() -> String {
    relay_own_name()
}

impl FederatedSessions {
    pub fn new() -> Self {
        Self::with_name(&default_relay_name())
    }

    /// Explicit identity (tests / multi-relay in-process rigs).
    pub fn with_name(own_name: &str) -> Self {
        Self {
            own_name: own_name.to_string(),
            sessions: Mutex::new(HashMap::new()),
            epk_to_relays: Mutex::new(HashMap::new()),
            forward_senders: Mutex::new(HashMap::new()),
            pending_forwards: Mutex::new(HashMap::new()),
            machine_pairings: Mutex::new(HashMap::new()),
            peer_docs: Mutex::new(HashMap::new()),
            via: Mutex::new(HashMap::new()),
            hop_backlinks: Mutex::new(VecDeque::new()),
        }
    }

    pub fn own_name(&self) -> String {
        self.own_name.clone()
    }

    /// Learn that `epk` is reachable via `relay_name`, from a SIG-VERIFIED
    /// inbound forward's provenance (the packet IS the route source — no
    /// separate route protocol). App clients host no rooms, so this is the
    /// ONLY way their epk ever enters the map — and every verified forward
    /// refreshes it, so the entry lives exactly as long as the conversation.
    /// Entries vanish automatically when the peering link dies (clear_peer
    /// purges all routes for a peer relay).
    pub async fn learn_route(&self, epk: &str, relay_name: &str) {
        let mut map = self.epk_to_relays.lock().await;
        let entry = map.entry(epk.to_string()).or_default();
        if !entry.iter().any(|r| r == relay_name) {
            entry.push(relay_name.to_string());
        }
    }

    /// VIA map (federation v2 §4): record that ORIGIN `origin`'s
    /// advertisement arrived on LINK `link` — advertisement implies route
    /// (a forward to the origin's epks rides this link's channel), and the
    /// entry is the re-advertisement never-back exclusion + the purge
    /// domain (clear_peer drops the link from every origin's via list; an
    /// origin that loses its last link is gone entirely).
    pub async fn learn_via(&self, origin: &str, link: &str) {
        if origin.is_empty() || link.is_empty() {
            return;
        }
        let mut via = self.via.lock().await;
        let entry = via.entry(origin.to_string()).or_default();
        if !entry.iter().any(|l| l == link) {
            entry.push(link.to_string());
        }
    }

    /// Resolve a routing candidate (a direct LINK name or a transitive
    /// ORIGIN name) to a live outbound channel: direct links win, origins
    /// resolve through the via map. `exclude_link` skips one link (the
    /// onward hop never sends back along the arrival link).
    async fn sender_for_candidate(
        &self,
        candidate: &str,
        exclude_link: Option<&str>,
    ) -> Option<mpsc::UnboundedSender<String>> {
        let mut links = vec![candidate.to_string()];
        links.extend(
            self.via
                .lock()
                .await
                .get(candidate)
                .cloned()
                .unwrap_or_default(),
        );
        let senders = self.forward_senders.lock().await;
        for link in &links {
            if exclude_link == Some(link.as_str()) {
                continue;
            }
            if let Some(vec) = senders.get(link) {
                if let Some(alive) = vec.iter().find(|tx| !tx.is_closed()) {
                    return Some(alive.clone());
                }
            }
        }
        None
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

    /// Learn pairing snapshots from a peering advertisement (check-before-
    /// forward): machine epk → owners as PUBLIC data over the paired link.
    /// Version-monotonic per machine. `source_link` is the LINK the frame
    /// arrived on (purge domain — conservative: a pairing learned via a
    /// link is gone when that link dies); `origin` is the ORIGIN relay whose
    /// machine pushed it (origin-tagged transit re-advertisement).
    pub async fn learn_machine_pairings(
        &self,
        source_link: &str,
        origin: &str,
        entries: Vec<(String, u64, String, String)>,
    ) {
        let mut map = self.machine_pairings.lock().await;
        for (machine, _envelope_version, blob_b64, sig_b64) in entries {
            // VERIFY (settled design): the exchange carries MACHINE-SIGNED
            // pairing envelopes; claims without a valid machine signature are
            // dropped — a peer cannot inject owner claims it cannot sign.
            // These verified sets are the load-bearing authorization data for
            // the §3 content gates (both planes), strict on unknown.
            let Ok(blob_bytes) = B64.decode(blob_b64.as_bytes()) else {
                continue;
            };
            let Ok(sig_bytes) = B64.decode(sig_b64.as_bytes()) else {
                continue;
            };
            let Ok(p) = crate::peers::pairing::verify_pairing_blob(&blob_bytes, &sig_bytes) else {
                continue;
            };
            if p.machine_pk != machine {
                continue;
            }
            let version = p.version;
            if let Some(cur) = map.get(&machine)
                && cur.version >= version
            {
                continue;
            }
            map.insert(
                machine,
                FederatedMachinePairing {
                    version,
                    owners: p.owners.into_iter().collect(),
                    blob: blob_b64,
                    sig: sig_b64,
                    origin: origin.to_string(),
                    source: source_link.to_string(),
                },
            );
        }
    }

    /// Learn one update pushed by a peered relay (pairing_set change event).
    pub async fn learn_machine_pairing(
        &self,
        source_link: &str,
        origin: &str,
        machine: &str,
        version: u64,
        blob_b64: String,
        sig_b64: String,
    ) {
        self.learn_machine_pairings(
            source_link,
            origin,
            vec![(machine.to_string(), version, blob_b64, sig_b64)],
        )
        .await;
    }
    /// The dest machine's advertised owner set, for the source-side
    /// check-before-forward gate (federation v2 §3). None ⇒ not exchanged
    /// yet ⇒ the deciding source relay REFUSES (strict — no optimistic
    /// forwarding; the dest relay never re-decides, 9779b88).
    pub async fn machine_owners(&self, machine_epk: &str) -> Option<HashSet<String>> {
        self.machine_pairings
            .lock()
            .await
            .get(machine_epk)
            .map(|p| p.owners.clone())
    }

    /// Learn a verified peer-pairing document (version-monotonic per key).
    pub async fn learn_peer_doc(&self, relay_pk: &str, version: u64, peers: Vec<String>) {
        let mut map = self.peer_docs.lock().await;
        if let Some((cur, _)) = map.get(relay_pk)
            && *cur > version
        {
            return;
        }
        map.insert(relay_pk.to_string(), (version, peers));
    }

    /// A learned peer's paired-name set (its doc), for state/warn checks.
    pub async fn peer_doc_peers(&self, relay_pk: &str) -> Option<Vec<String>> {
        self.peer_docs
            .lock()
            .await
            .get(relay_pk)
            .map(|(_, p)| p.clone())
    }

    /// Test/state helper: does ANY learned peer doc name `our_name`?
    pub async fn paired_by_any_doc(&self, our_name: &str) -> bool {
        self.peer_docs
            .lock()
            .await
            .values()
            .any(|(_, peers)| peers.iter().any(|n| n == our_name))
    }

    /// Push a machine pairing update to all peered relays — a machine's
    /// pairing_set change must reach every relay holding a check-before-
    /// forward view of its owners. Origin-tagged (slice 3): the frame names
    /// THIS relay as the origin, so transit relays re-advertise it onward
    /// under the right origin name (absent origin ⇒ the sending relay
    /// itself, for pre-slice-3 peers).
    pub async fn broadcast_machine_pairing(
        &self,
        machine: &str,
        version: u64,
        owners_blob_b64: &str,
        owners_sig_b64: &str,
    ) {
        let frame = serde_json::json!({
            "kind": "relay_pairings_update",
            "origin": self.own_name,
            "machine": machine,
            "version": version,
            "blob": owners_blob_b64,
            "sig": owners_sig_b64,
        })
        .to_string();
        let senders = self.forward_senders.lock().await;
        for txs in senders.values() {
            for tx in txs {
                let _ = tx.send(frame.clone());
            }
        }
    }

    /// Re-advertise an incremental update (`relay_peer_update` /
    /// `relay_pairings_update`) ONWARD to every federated link EXCEPT the
    /// one it arrived on (federation v2 §4 — never back; self-origin
    /// filtering at the receivers terminates propagation). The frame text
    /// rides verbatim — its origin tags are already correct.
    pub async fn relay_update_onward(&self, except_link: &str, text: &str) {
        let senders = self.forward_senders.lock().await;
        for (link, txs) in senders.iter() {
            if link == except_link {
                continue;
            }
            for tx in txs {
                let _ = tx.send(text.to_string());
            }
        }
    }

    /// Remove all state that rode a LINK (on disconnect): sessions and
    /// epk-index entries for ORIGINS that lost their last via link, learned
    /// routes naming the link, and owner-set snapshots whose SOURCE link (or
    /// whose origin) is the dead one — conservative and correct (a machine's
    /// pairing learned via B purges when B's link dies; it re-learns on
    /// re-advertisement).
    pub async fn clear_peer(&self, peer_relay: &str) {
        let mut sessions = self.sessions.lock().await;
        // 1. VIA: drop the dead link from every origin's list; origins that
        //    lost their LAST link purge entirely (advertisement implied
        //    their route — the route is gone).
        let mut via = self.via.lock().await;
        let mut purged_origins: HashSet<String> = HashSet::new();
        via.retain(|origin, links| {
            links.retain(|l| l != peer_relay);
            if links.is_empty() {
                purged_origins.insert(origin.clone());
                false
            } else {
                true
            }
        });
        // 2. sessions: purged origins + any legacy entries keyed by the link
        //    name itself.
        sessions.retain(|k, _| k.0 != peer_relay && !purged_origins.contains(&k.0));
        // 3. epk index: the dead link (learned routes) + purged origins.
        let mut epk_map = self.epk_to_relays.lock().await;
        for relays in epk_map.values_mut() {
            relays.retain(|r| r != peer_relay && !purged_origins.contains(r));
        }
        epk_map.retain(|_, relays| !relays.is_empty());
        drop(epk_map);
        drop(sessions);
        drop(via);
        // 4. owner-set snapshots: source-link purge (conservative) + purged
        //    origins.
        self.machine_pairings
            .lock()
            .await
            .retain(|_, p| p.source != peer_relay && !purged_origins.contains(&p.origin));
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

    /// Build the full advertisement for one peer link (federation v2 §4):
    /// the SELF segment (own local rooms + own machines' signed pairings,
    /// always FIRST — pre-slice-3 peers read exactly one frame) plus one
    /// segment per known ORIGIN — everything learned from OTHER peers,
    /// origin-tagged, self-origin filtered, never the peer its own data
    /// back, never back to the link the origin's data arrived on. No hop
    /// cap — the self-origin + never-back rules terminate propagation.
    /// Callers fill `peer_doc` on the self segment + `done` markers per the
    /// peer's protocol version.
    pub async fn advertisement_segments(
        &self,
        registry: &PeerRegistry,
        pairing: &PairingRegistry,
        peer_link: &str,
        peer_origin: &str,
    ) -> Vec<RelayPeerList> {
        // Group the learned state by ORIGIN (sessions are already keyed by
        // origin; pairings carry their origin).
        let mut rooms_by_origin: HashMap<String, HashMap<String, Vec<RoomMeta>>> = HashMap::new();
        {
            let sessions = self.sessions.lock().await;
            for ((origin, epk), rooms) in sessions.iter() {
                rooms_by_origin
                    .entry(origin.clone())
                    .or_default()
                    .insert(epk.clone(), rooms.clone());
            }
        }
        let mut pairings_by_origin: HashMap<String, Vec<(String, FederatedMachinePairing)>> =
            HashMap::new();
        {
            let pairings = self.machine_pairings.lock().await;
            for (machine, p) in pairings.iter() {
                pairings_by_origin
                    .entry(p.origin.clone())
                    .or_default()
                    .push((machine.clone(), p.clone()));
            }
        }

        let mut segments = vec![RelayPeerList {
            kind: "relay_peer_list".into(),
            relay_name: self.own_name.clone(),
            rooms_by_epk: FederatedSessions::local_rooms_by_epk(registry),
            machine_pairings: pairing
                .signed_blobs()
                .into_iter()
                .map(|(machine, version, blob, sig)| RelayMachinePairing {
                    machine,
                    version,
                    blob: B64.encode(&blob),
                    sig: B64.encode(&sig),
                })
                .collect(),
            peer_doc: None, // the caller fills (needs the peer's name)
            done: None,     // send_advertisement sets the markers
        }];

        let via = self.via.lock().await;
        let mut origins: Vec<String> = rooms_by_origin
            .keys()
            .chain(pairings_by_origin.keys())
            .cloned()
            .collect();
        origins.sort();
        origins.dedup();
        for origin in origins {
            // Self-origin filter + never the peer its own data back (by
            // origin name AND by link name — covers both naming styles).
            if origin == self.own_name || origin == peer_link || origin == peer_origin {
                continue;
            }
            // Never back to the link this origin's data arrived on.
            if via
                .get(&origin)
                .is_some_and(|links| links.iter().any(|l| l == peer_link))
            {
                continue;
            }
            let rooms = rooms_by_origin.remove(&origin).unwrap_or_default();
            let pairings: Vec<RelayMachinePairing> = pairings_by_origin
                .get(&origin)
                .map(|entries| {
                    entries
                        .iter()
                        .filter(|(_, p)| p.source != peer_link)
                        .map(|(machine, p)| RelayMachinePairing {
                            machine: machine.clone(),
                            version: p.version,
                            blob: p.blob.clone(),
                            sig: p.sig.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            if rooms.is_empty() && pairings.is_empty() {
                continue;
            }
            segments.push(RelayPeerList {
                kind: "relay_peer_list".into(),
                relay_name: origin,
                rooms_by_epk: rooms,
                machine_pairings: pairings,
                peer_doc: None, // only the SELF segment carries our doc
                done: None,
            });
        }
        segments
    }

    /// ONWARD HOP (federation v2 §4): re-sign `forward` with THIS relay's
    /// keypair (same request_id, from_epk/target_epk and payload verbatim,
    /// with `visited` grown by our own name) and send it down the route the
    /// target's advertisement implies. Never back along `arrival_link`,
    /// never to a relay already in `visited`. Records the id→backlink so
    /// the dest's ack returns verbatim to the relay the forward arrived
    /// from. Returns the onward link name when a route was found.
    pub async fn hop_forward(
        &self,
        keypair: &crate::relay_keypair::RelayKeypair,
        arrival_link: &str,
        forward: &RelayForward,
        backlink: mpsc::UnboundedSender<String>,
    ) -> Option<String> {
        let relay_names = self.relays_for_epk(&forward.target_epk).await;
        for relay_name in &relay_names {
            if relay_name == arrival_link || forward.visited.contains(relay_name) {
                continue;
            }
            if let Some(tx) = self
                .sender_for_candidate(relay_name, Some(arrival_link))
                .await
            {
                let mut visited = forward.visited.clone();
                visited.push(self.own_name.clone());
                let sig_msg = format!(
                    "{}|{}|{}|{}",
                    forward.request_id,
                    forward.from_epk,
                    forward.target_epk,
                    visited.join(",")
                );
                let hop = RelayForward {
                    kind: "relay_forward".into(),
                    request_id: forward.request_id.clone(),
                    from_epk: forward.from_epk.clone(),
                    target_epk: forward.target_epk.clone(),
                    envelope: forward.envelope.clone(),
                    visited: visited.clone(),
                    relay_pubkey: Some(keypair.pubkey_b64()),
                    relay_sig: Some(keypair.sign(sig_msg.as_bytes())),
                    room: forward.room.clone(),
                    ct: forward.ct.clone(),
                };
                self.record_hop_backlink(&forward.request_id, backlink)
                    .await;
                let _ = tx.send(serde_json::to_string(&hop).unwrap_or_default());
                return Some(relay_name.clone());
            }
        }
        None
    }

    /// Record a hop's id→backlink (bounded LRU + TTL — the source's forward
    /// times out after 5 s, so 30 s covers the ack generously).
    async fn record_hop_backlink(&self, request_id: &str, tx: mpsc::UnboundedSender<String>) {
        let mut q = self.hop_backlinks.lock().await;
        let now = Instant::now();
        q.retain(|(_, at, _)| now.duration_since(*at) < HOP_BACKLINK_TTL);
        while q.len() >= HOP_BACKLINK_MAX {
            q.pop_front();
        }
        q.push_back((request_id.to_string(), now, tx));
    }

    /// Take the backlink for an ack'd hop, if any (single ack — the entry
    /// is consumed). None ⇒ the ack is for OUR OWN pending forward.
    async fn take_hop_backlink(&self, request_id: &str) -> Option<mpsc::UnboundedSender<String>> {
        let mut q = self.hop_backlinks.lock().await;
        let now = Instant::now();
        q.retain(|(_, at, _)| now.duration_since(*at) < HOP_BACKLINK_TTL);
        let idx = q.iter().position(|(id, _, _)| id == request_id)?;
        q.remove(idx).map(|(_, _, tx)| tx)
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
        // Multi-route fallback: try each candidate that has the target epk,
        // in order, until one resolves to a live sender. The list holds BOTH
        // kinds — direct LINK names (announced rooms from a directly-paired
        // relay, learned routes from verified inbound forwards) and transitive
        // ORIGIN names (which resolve through the via map — advertisement
        // implies route, federation v2 §4).
        let relay_names = self.relays_for_epk(target_epk).await;
        let own_name = self.own_name.clone();
        let mut tx = None;
        for relay_name in &relay_names {
            if let Some(t) = self.sender_for_candidate(relay_name, None).await {
                tx = Some(t);
                break;
            }
        }
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
    ) -> Option<(String, oneshot::Receiver<RelayForwardAck>)> {
        // Same via-map candidate resolution as forward_to_federated
        // (direct links first, then the origin's via links).
        let relay_names = self.relays_for_epk(target_epk).await;
        let own_name = self.own_name.clone();
        let mut tx = None;
        for relay_name in &relay_names {
            if let Some(t) = self.sender_for_candidate(relay_name, None).await {
                tx = Some(t);
                break;
            }
        }
        let tx = tx?;
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
        self.pending_forwards
            .lock()
            .await
            .insert(request_id.clone(), otx);
        let _ = tx.send(serde_json::to_string(&forward).unwrap_or_default());
        Some((request_id, orx))
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
        let relay_name = self.own_name.clone();
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
/// Federation v2 §4 (slice 3): the advertisement is ONE SEGMENT PER ORIGIN —
/// `relay_name` names the ORIGIN (the relay whose machines host the rooms
/// / pushed the pairings), which for the sender's own segment is the sender
/// itself. `done: Some(true)` marks the LAST segment of the sequence;
/// `done: Some(false)` means more segments follow; ABSENT means the whole
/// advertisement is this one frame (pre-slice-3 peers — additive +
/// back-compat).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RelayPeerList {
    #[serde(rename = "type")]
    pub kind: String,
    /// The ORIGIN relay's name (the sender itself for the self segment).
    pub relay_name: String,
    /// Rooms grouped by the remote machine's epk.
    pub rooms_by_epk: HashMap<String, Vec<RoomMeta>>,
    /// Federated pairing snapshot (check-before-forward): the origin's
    /// machines' owner sets, PUBLIC data. Default keeps the handshake
    /// wire-compatible with peers on older versions.
    #[serde(default)]
    pub machine_pairings: Vec<RelayMachinePairing>,
    /// The sender's signed peer-pairing document (b64{doc,sig}), presenting
    /// itself (its relay pubkey rides the wire/handshake). Verified against
    /// the presented key; stored version-monotonically. Only the SELF
    /// segment carries one (a transit relay cannot present the origin's
    /// identity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_doc: Option<PeerPairingEnvelope>,
    /// Sequence marker (slice 3): `Some(true)` on the LAST segment;
    /// `Some(false)` when more segments follow; absent ⇒ single-frame
    /// advertisement (pre-slice-3 peers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
}

/// Federated machine pairing snapshots (federation v2 §4): machine epk →
/// the learned, machine-SIGNED owner-set envelope. The blob+sig are kept
/// verbatim so transit re-advertisement needs no re-signing (only the
/// machine can sign — transit cannot forge owner sets); `origin` tags the
/// relay whose machine pushed it (origin-tagged re-advertisement) and
/// `source` the LINK it arrived on (purge domain — conservative).
#[derive(Debug, Clone)]
pub struct FederatedMachinePairing {
    pub version: u64,
    pub owners: HashSet<String>,
    /// The machine-signed pairing envelope (b64 blob + b64 sig), verbatim.
    pub blob: String,
    pub sig: String,
    /// The ORIGIN relay whose machine pushed this set.
    pub origin: String,
    /// The LINK this advertisement arrived on.
    pub source: String,
}

/// Federated machine pairing snapshots: machine epk → learned set.
pub type FederatedMachinePairings = HashMap<String, FederatedMachinePairing>;

/// Signed peer-pairing document (relay-pairing as protocol, design
/// 2026-10-14): a relay signs {relay_pk, peers, version} — its paired relay
/// NAME set, full-set replace, versioned. A peer pairing exists only when
/// both relays hold and exchange valid docs (strict mutual naming gate lands
/// with `peer add` management); tonight the doc is exchanged, verified, and
/// stored, and violations are logged loudly instead of declining live paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerPairingDoc {
    /// The signer's relay pubkey (b64) — binds the doc to the key it signed.
    pub relay_pk: String,
    /// Paired peer relay names.
    pub peers: Vec<String>,
    pub version: u64,
}
/// b64(doc) + b64(sig) over the doc bytes, signed by the presenting relay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerPairingEnvelope {
    pub doc: String,
    pub sig: String,
}
/// Verify + decode a peer pairing doc against the PRESENTED relay pubkey.
/// Build+sign this relay's peer-pairing doc (protocol design 2026-10-14).
fn build_peer_doc_envelope(kp: &RelayKeypair, peer_name: &str) -> PeerPairingEnvelope {
    let doc = PeerPairingDoc {
        relay_pk: kp.pubkey_b64(),
        peers: vec![peer_name.to_string()],
        version: 1,
    };
    let bytes = serde_json::to_vec(&doc).unwrap_or_default();
    PeerPairingEnvelope {
        doc: B64.encode(&bytes),
        sig: kp.sign(&bytes),
    }
}

pub fn verify_peer_pairing_doc(
    env: &PeerPairingEnvelope,
    presented_pk: &str,
) -> Result<PeerPairingDoc, String> {
    let doc_bytes = B64
        .decode(env.doc.as_bytes())
        .map_err(|_| "bad b64 doc".to_string())?;
    RelayKeypair::verify(presented_pk, &doc_bytes, &env.sig)
        .then(|| serde_json::from_slice::<PeerPairingDoc>(&doc_bytes))
        .ok_or("peer pairing doc signature verify failed".to_string())?
        .map_err(|e| format!("bad peer pairing doc json: {e}"))
}

/// One machine's advertised owner set (check-before-forward design).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RelayMachinePairing {
    pub machine: String,
    pub version: u64,
    pub blob: String,
    pub sig: String,
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
