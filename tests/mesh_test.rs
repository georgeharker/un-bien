//! Integration tests for `/mesh/:owner_pk_hash` HTTP endpoints (plan 24 W1).
//!
//! After plan 24 fix (unified server), these tests mount the full router
//! (WS + `/health` + `/mesh`) — same surface a real client sees.

use std::net::SocketAddr;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use relay::{AppState, MeshStore, PeerRegistry, PresenceManager, RoomManager, build_router};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// Spawns the unified relay on a random localhost port with a persistent
/// SQLite DB inside a `TempDir`. Returns `(base_url, temp_dir)` — keep the
/// dir alive for the duration of the test.
async fn spawn_relay() -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("mesh.db");
    let mesh = Arc::new(MeshStore::open(&db_path).unwrap());
    let presence = Arc::new(PresenceManager::new());
    let rooms = Arc::new(RoomManager::new());
    let registry = Arc::new(PeerRegistry::new(presence.clone(), rooms.clone()));
    let state = AppState { registry, presence, rooms, mesh };

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
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
    (format!("http://127.0.0.1:{port}"), dir)
}

/// Computes `sha256(owner_pk)` as lowercase hex — matches the relay's
/// `owner_pk_hash` exactly.
fn pk_hash(pk: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(pk);
    let mut out = String::with_capacity(64);
    for b in d {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Builds a signed mesh envelope (wire format) using the given signing key
/// and version. The blob is canonical-ish JSON (we don't enforce canonical
/// for tests since we sign the bytes we produce here).
fn make_envelope(sk: &SigningKey, version: u64) -> (Value, String) {
    let pk_b64 = B64.encode(sk.verifying_key().to_bytes());
    // Canonical-ish: keys sorted, no spaces. serde_json::to_vec preserves
    // the order in serde_json::json! — we use a Map and insert in sorted order.
    let blob_value = json!({
        "issued_at": 1700000000000_u64,
        "members": [],
        "owner_pk": pk_b64,
        "version": version,
    });
    let blob_bytes = serde_json::to_vec(&blob_value).unwrap();
    let sig = sk.sign(&blob_bytes);
    let envelope = json!({
        "blob": B64.encode(&blob_bytes),
        "sig": B64.encode(sig.to_bytes()),
    });
    let hash = pk_hash(&sk.verifying_key().to_bytes());
    (envelope, hash)
}

#[tokio::test]
async fn post_v1_then_get_returns_v1() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let (env, hash) = make_envelope(&sk, 1);

    let client = reqwest::Client::new();
    let resp = client.post(format!("{base}/mesh/{hash}")).json(&env).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["version"], 1);

    let resp = client.get(format!("{base}/mesh/{hash}")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["version"], 1);
    assert!(body["blob"].is_string());
    assert!(body["sig"].is_string());
}

#[tokio::test]
async fn post_v2_after_v1_advances_state() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());

    let (env1, hash) = make_envelope(&sk, 1);
    let (env2, _) = make_envelope(&sk, 2);

    let client = reqwest::Client::new();
    let r = client.post(format!("{base}/mesh/{hash}")).json(&env1).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let r = client.post(format!("{base}/mesh/{hash}")).json(&env2).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);

    let body: Value = client
        .get(format!("{base}/mesh/{hash}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["version"], 2);
}

#[tokio::test]
async fn post_stale_version_returns_409() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());

    let (env2, hash) = make_envelope(&sk, 2);
    let (env1, _) = make_envelope(&sk, 1);

    let client = reqwest::Client::new();
    let r = client.post(format!("{base}/mesh/{hash}")).json(&env2).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);

    let r = client.post(format!("{base}/mesh/{hash}")).json(&env1).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn post_same_version_returns_409() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());

    let (env, hash) = make_envelope(&sk, 7);

    let client = reqwest::Client::new();
    let r = client.post(format!("{base}/mesh/{hash}")).json(&env).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);

    let r = client.post(format!("{base}/mesh/{hash}")).json(&env).send().await.unwrap();
    assert_eq!(
        r.status(),
        StatusCode::CONFLICT,
        "re-posting same version must be 409"
    );
}

#[tokio::test]
async fn get_with_since_below_current_returns_blob() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let (env, hash) = make_envelope(&sk, 5);

    let client = reqwest::Client::new();
    client.post(format!("{base}/mesh/{hash}")).json(&env).send().await.unwrap();

    let r = client.get(format!("{base}/mesh/{hash}?since=3")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["version"], 5);
}

#[tokio::test]
async fn get_with_since_at_or_above_current_returns_304() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let (env, hash) = make_envelope(&sk, 5);

    let client = reqwest::Client::new();
    client.post(format!("{base}/mesh/{hash}")).json(&env).send().await.unwrap();

    let r = client.get(format!("{base}/mesh/{hash}?since=5")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_MODIFIED);

    let r = client.get(format!("{base}/mesh/{hash}?since=999")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn get_unknown_owner_returns_404() {
    let (base, _dir) = spawn_relay().await;
    let r = reqwest::get(format!("{base}/mesh/{}", "0".repeat(64))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn post_with_invalid_signature_returns_403() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut env, hash) = make_envelope(&sk, 1);
    // Replace sig with random bytes.
    env["sig"] = json!(B64.encode([0u8; 64]));

    let client = reqwest::Client::new();
    let r = client.post(format!("{base}/mesh/{hash}")).json(&env).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn post_with_url_hash_mismatch_returns_403() {
    let (base, _dir) = spawn_relay().await;
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let (env, _real_hash) = make_envelope(&sk, 1);
    let bogus_hash = "f".repeat(64);

    let client = reqwest::Client::new();
    let r = client.post(format!("{base}/mesh/{bogus_hash}")).json(&env).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn post_with_bad_json_returns_400() {
    let (base, _dir) = spawn_relay().await;
    let client = reqwest::Client::new();
    let r = client
        .post(format!("{base}/mesh/{}", "0".repeat(64)))
        .header("content-type", "application/json")
        .body("{not valid json")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn post_body_over_500kb_returns_413() {
    let (base, _dir) = spawn_relay().await;
    // 600 KB body — exceeds the 500 KB cap.
    let huge = "a".repeat(600 * 1024);
    let body = json!({"blob": huge, "sig": "AA"});

    let client = reqwest::Client::new();
    let r = client
        .post(format!("{base}/mesh/{}", "0".repeat(64)))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn health_endpoint_returns_200_ok() {
    let (base, _dir) = spawn_relay().await;
    let r = reqwest::get(format!("{base}/health")).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.text().await.unwrap(), "OK");
}

/// Unified server: `/health`, `/mesh/:hash`, and WS upgrade all coexist on
/// the same port. Hits all three back-to-back to prove the routing.
#[tokio::test]
async fn unified_port_serves_health_mesh_and_ws() {
    let (base, _dir) = spawn_relay().await;
    let host_port = base.strip_prefix("http://").unwrap();

    // 1) /health → 200
    let r = reqwest::get(format!("{base}/health")).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);

    // 2) GET /mesh/<unknown hash> → 404
    let r = reqwest::get(format!("{base}/mesh/{}", "0".repeat(64))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);

    // 3) WebSocket upgrade succeeds on the same port (no /ws prefix).
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    let ws_url = format!("ws://{host_port}");
    let (mut ws, _) = connect_async(&ws_url).await.expect("WS handshake must succeed");
    // Send something invalid as hello → relay drops connection cleanly,
    // proving the WS handler is wired.
    ws.send(Message::text("not a valid hello")).await.unwrap();
    let _ = ws.next().await; // expect None / close — either is fine
}
