#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay::{
    AppState, FirehoseMetrics, MeshAuthCache, MeshStore, PeerRegistry, PresenceManager,
    RoomManager, build_router,
};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

pub type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Binds the unified relay (WS + `/health` + `/mesh`) on a random localhost
/// port and returns that port. Mesh storage is `:memory:` for these tests —
/// use the helper in `tests/mesh_test.rs` when you need a persistent DB.
pub async fn start_relay() -> u16 {
    start_relay_state().await.0
}

/// Like [`start_relay`] but also hands back the relay's `PairingRegistry` Arc,
/// so tests can configure the (fail-closed, design 01M1ZE43) rooms/content gate
/// IN-PROCESS — `pairing.set(machine, vec![owner])` — before the app checks.
/// Synchronous + race-free: the set is applied (under the shared Mutex) before
/// the app's subsequent WS frame is processed by the relay.
pub async fn start_relay_state() -> (u16, Arc<relay::PairingRegistry>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mesh = Arc::new(MeshStore::open_in_memory().unwrap());
    let presence = Arc::new(PresenceManager::new());
    let rooms = Arc::new(RoomManager::new());
    let metrics = Arc::new(FirehoseMetrics::new());
    let registry = Arc::new(PeerRegistry::new(
        presence.clone(),
        rooms.clone(),
        metrics.clone(),
    ));
    let mesh_auth = Arc::new(MeshAuthCache::new());
    let pairing = Arc::new(relay::PairingRegistry::new());
    let state = AppState {
        registry,
        presence,
        rooms,
        pairing: pairing.clone(),
        mesh,
        mesh_auth,
        federated: Arc::new(relay::peering::FederatedSessions::new()),
        relay_name: relay::peering::default_relay_name(),
        metrics,
        ws_port: Some(port),
        advertised_url: String::new(),
        endpoints: Arc::new(Vec::new()),
    };
    let app = build_router(state);
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    // Give axum a moment to start accepting.
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
    (port, pairing)
}

/// An in-process relay with an explicit peering identity (`relay_name` +
/// `FederatedSessions::with_name`). Multiple in-process relays MUST have
/// distinct own_names or hello/visited stamping self-collides (the hostname
/// is shared). NOTE: `UNBIEN_STATE_DIR` is process-global — relays spawned in
/// the same test share it (and therefore the relay identity keypair + the
/// relay-peers.json file). Callers that set it must serialize (see the
/// `STATE_LOCK` pattern in tests/federation_test.rs).
pub struct TestRelay {
    pub port: u16,
    pub state: AppState,
}

pub async fn spawn_relay_named(name: &str) -> TestRelay {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mesh = Arc::new(MeshStore::open_in_memory().unwrap());
    let presence = Arc::new(PresenceManager::new());
    let rooms = Arc::new(RoomManager::new());
    let metrics = Arc::new(FirehoseMetrics::new());
    let registry = Arc::new(PeerRegistry::new(
        presence.clone(),
        rooms.clone(),
        metrics.clone(),
    ));
    let mesh_auth = Arc::new(MeshAuthCache::new());
    let state = AppState {
        registry: registry.clone(),
        presence: presence.clone(),
        rooms: rooms.clone(),
        pairing: Arc::new(relay::PairingRegistry::new()),
        mesh: mesh.clone(),
        mesh_auth,
        relay_name: name.to_string(),
        federated: Arc::new(relay::peering::FederatedSessions::with_name(name)),
        metrics: metrics.clone(),
        ws_port: Some(port),
        advertised_url: String::new(),
        endpoints: Arc::new(Vec::new()),
    };
    let app = relay::build_router(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
    TestRelay { port, state }
}

/// Connects using a caller-supplied key and room_id, completes the full auth handshake.
/// Returns (ws_stream, peer_id_b64).
pub async fn connect_and_auth_with_room(
    port: u16,
    sk: &SigningKey,
    room_id: &str,
) -> (WsStream, String) {
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    let vk = sk.verifying_key();
    let pubkey_b64 = B64.encode(vk.to_bytes());

    ws.send(Message::text(
        json!({"type": "hello", "pubkey": pubkey_b64, "room_id": room_id}).to_string(),
    ))
    .await
    .unwrap();

    let challenge_msg = ws.next().await.unwrap().unwrap();
    let challenge_json: serde_json::Value =
        serde_json::from_str(challenge_msg.to_text().unwrap()).unwrap();
    let nonce_b64 = challenge_json["nonce"].as_str().unwrap();
    let nonce_arr: [u8; 32] = B64.decode(nonce_b64).unwrap().try_into().unwrap();

    let sig = sk.sign(&nonce_arr);
    ws.send(Message::text(
        json!({"type": "auth", "sig": B64.encode(sig.to_bytes())}).to_string(),
    ))
    .await
    .unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;
    // P7: drop the identity_ack here — it is ALWAYS the first post-auth frame
    // (the relay sends it before registration/routing), so a short drain
    // can never consume data or control frames. Every test's readers then
    // see the first DATa frame as they did pre-P7.
    drop_handshake(&mut ws, 200).await;

    (ws, pubkey_b64)
}

/// Connects with a caller-supplied key, defaults to room "main".
pub async fn connect_and_auth_with_key(port: u16, sk: &SigningKey) -> (WsStream, String) {
    connect_and_auth_with_room(port, sk, "main").await
}

/// Connects with a fresh random key, defaults to room "main".
pub async fn connect_and_auth(port: u16) -> (WsStream, String) {
    let sk = SigningKey::generate(&mut rand::thread_rng());
    connect_and_auth_with_key(port, &sk).await
}

/// Read the next frame, skipping AUTH-HANDSHAKE frames (P7: the relay sends a
/// signed `identity_ack` right after auth, before any routing) and the
/// relay's keepalive noise (non-text ping/pong frames). A type-less JSON
/// frame is DATA (outer envelopes are {peer, room, ct}) and IS returned.
pub async fn next_non_handshake(ws: &mut WsStream) -> serde_json::Value {
    loop {
        let msg = ws
            .next()
            .await
            .unwrap_or_else(|| panic!("stream closed while awaiting a frame"))
            .unwrap_or_else(|e| panic!("stream error while awaiting a frame: {e}"));
        let text = match msg.to_text() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if text.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v["type"] == "identity_ack" {
            continue;
        }
        return v;
    }
}

/// Bounded version for DRAINS: after auth there is exactly one handshake
/// frame to drop; an unbudgeted drain waits forever for a frame only later
/// traffic can produce (the classic drain-before-send deadlock).
/// Connect an app AND pair it into `machine_peer`'s allow-list in one step, so
/// the fail-closed rooms/content gate (design 01M1ZE43) permits it. Accumulates
/// (never clobbers an existing owner), and the in-process `set` is applied
/// before the returned app issues any rooms_check/subscribe — race-free.
pub async fn connect_app_paired(
    port: u16,
    pairing: &Arc<relay::PairingRegistry>,
    machine_peer: &str,
) -> (WsStream, String) {
    let (ws, peer) = connect_and_auth(port).await;
    let mut owners: Vec<String> = pairing
        .owners_of(machine_peer)
        .map(|s| s.into_iter().collect())
        .unwrap_or_default();
    if !owners.contains(&peer) {
        owners.push(peer.clone());
    }
    pairing.set(machine_peer.to_string(), owners);
    (ws, peer)
}

/// Drop the post-auth handshake frame (identity_ack) within `ms` — never
/// blocks: a missing ack just means nothing to drop.
pub async fn drop_handshake(ws: &mut WsStream, ms: u64) {
    let _ = tokio::time::timeout(std::time::Duration::from_millis(ms), async {
        loop {
            let Some(Ok(msg)) = ws.next().await else {
                return; // closed/errored: nothing more to drop
            };
            let Ok(text) = msg.to_text() else {
                continue; // ping/pong/close noise
            };
            if text.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
                continue;
            };
            if v["type"] == "identity_ack" {
                return; // ack dropped — done
            }
            return; // a DATA frame or anything else: stop before consuming it
        }
    })
    .await;
}
