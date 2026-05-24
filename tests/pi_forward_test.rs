//! Plan 25 Wave A — integration tests for Pi-to-Pi envelope forwarding.
//!
//! Each test spins up the full unified relay (WS + HTTP), publishes one or
//! more Owner-signed mesh blobs that determine membership, connects Pi-A
//! (and sometimes Pi-B) via WebSocket, and asserts the forwarding /
//! transport-error behavior.

mod common;
use common::{connect_and_auth_with_key, start_relay};

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;

fn random_key() -> SigningKey {
    SigningKey::generate(&mut rand::thread_rng())
}

fn pk_hash_hex(pk: &[u8]) -> String {
    let d = Sha256::digest(pk);
    let mut s = String::with_capacity(64);
    for b in d {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Publishes an Owner-signed `mesh_versions` blob via the relay's HTTP API.
/// `members` is the list of Pi-pubkeys (base64 strings) that this Owner
/// authorizes as siblings.
async fn publish_owner_blob(
    base_http: &str,
    owner_sk: &SigningKey,
    members: &[&str],
    version: u64,
) {
    let owner_pk_bytes = owner_sk.verifying_key().to_bytes();
    let owner_pk_b64 = B64.encode(owner_pk_bytes);
    let members_json: Vec<Value> = members
        .iter()
        .map(|m| json!({ "remote_epk": m }))
        .collect();
    let blob = json!({
        "owner_pk": owner_pk_b64,
        "version": version,
        "members": members_json,
        "issued_at": 1700000000000_u64,
    });
    let blob_bytes = serde_json::to_vec(&blob).unwrap();
    let sig = owner_sk.sign(&blob_bytes);
    let envelope = json!({
        "blob": B64.encode(&blob_bytes),
        "sig": B64.encode(sig.to_bytes()),
    });
    let hash = pk_hash_hex(&owner_pk_bytes);
    let client = reqwest::Client::new();
    let r = client
        .post(format!("{base_http}/mesh/{hash}"))
        .json(&envelope)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "mesh blob publish must succeed");
}

/// Sends a `pi_envelope` frame from an already-authenticated Pi WS.
async fn send_pi_envelope(
    ws: &mut common::WsStream,
    to_pc: &str,
    envelope: Value,
) {
    ws.send(Message::text(
        json!({
            "type": "pi_envelope",
            "to_pc": to_pc,
            "envelope": envelope,
        })
        .to_string(),
    ))
    .await
    .unwrap();
}

/// Receives the next text frame (with timeout) and parses as JSON.
async fn recv_json(ws: &mut common::WsStream, label: &str) -> Value {
    let msg = tokio::time::timeout(tokio::time::Duration::from_secs(2), ws.next())
        .await
        .unwrap_or_else(|_| panic!("{label} timed out waiting for frame"))
        .unwrap()
        .unwrap();
    serde_json::from_str(msg.to_text().unwrap())
        .unwrap_or_else(|e| panic!("{label} got non-JSON frame: {e}"))
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

/// Happy path: Pi-A and Pi-B belong to the same Owner's mesh and both are
/// online. Envelope from A arrives at B verbatim, wrapped as `pi_envelope_in`
/// with `from_pc = peer_a_pk`.
#[tokio::test]
async fn happy_path_same_owner_envelope_delivered_verbatim() {
    let port = start_relay().await;
    let base_http = format!("http://127.0.0.1:{port}");

    let owner = random_key();
    let sk_a = random_key();
    let sk_b = random_key();
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());
    let peer_b = B64.encode(sk_b.verifying_key().to_bytes());

    publish_owner_blob(&base_http, &owner, &[&peer_a, &peer_b], 1).await;

    let (mut ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;
    let (mut ws_b, _) = connect_and_auth_with_key(port, &sk_b).await;

    let envelope = json!({
        "from": "casa:sess-3",
        "to": "trab:agent-1",
        "id": "u1",
        "re": null,
        "body": { "type": "hello", "text": "ping" },
    });
    let t0 = std::time::Instant::now();
    send_pi_envelope(&mut ws_a, &peer_b, envelope.clone()).await;

    let frame = recv_json(&mut ws_b, "ws_b").await;
    let latency = t0.elapsed();
    assert_eq!(frame["type"], "pi_envelope_in");
    assert_eq!(frame["from_pc"], peer_a, "must carry authenticated sender pk");
    assert_eq!(
        frame["envelope"], envelope,
        "envelope must be forwarded verbatim"
    );
    assert!(
        latency < std::time::Duration::from_millis(100),
        "loopback latency {latency:?} should be well under 100ms"
    );
}

/// Pi-B is NOT connected when A sends. Relay synthesizes a transport_error
/// envelope and returns it to A as `pi_envelope_in`. Body carries
/// `type=transport_error, reason=offline` and `re` matches the original id.
#[tokio::test]
async fn pi_b_offline_returns_transport_error_offline() {
    let port = start_relay().await;
    let base_http = format!("http://127.0.0.1:{port}");

    let owner = random_key();
    let sk_a = random_key();
    let sk_b = random_key();
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());
    let peer_b = B64.encode(sk_b.verifying_key().to_bytes());

    publish_owner_blob(&base_http, &owner, &[&peer_a, &peer_b], 1).await;

    // Only A connects — B is offline.
    let (mut ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;

    let envelope = json!({
        "from": "casa:sess-3",
        "to": "trab:agent-1",
        "id": "u-offline",
        "re": null,
        "body": { "type": "ping" },
    });
    send_pi_envelope(&mut ws_a, &peer_b, envelope).await;

    let frame = recv_json(&mut ws_a, "ws_a transport_error").await;
    assert_eq!(frame["type"], "pi_envelope_in");
    assert_eq!(frame["from_pc"], "_relay");
    assert_eq!(frame["envelope"]["body"]["type"], "transport_error");
    assert_eq!(frame["envelope"]["body"]["reason"], "offline");
    assert_eq!(frame["envelope"]["re"], "u-offline", "must correlate via re");
    assert_eq!(frame["envelope"]["from"], "_relay");
    assert_eq!(frame["envelope"]["to"], "casa:sess-3");
}

/// Pi-A and Pi-B belong to DIFFERENT Owners. The relay's mesh authorization
/// rejects the forward; A gets `transport_error: not_authorized`.
#[tokio::test]
async fn cross_owner_returns_transport_error_not_authorized() {
    let port = start_relay().await;
    let base_http = format!("http://127.0.0.1:{port}");

    let owner_1 = random_key();
    let owner_2 = random_key();
    let sk_a = random_key();
    let sk_b = random_key();
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());
    let peer_b = B64.encode(sk_b.verifying_key().to_bytes());

    // Two separate Owners, each with just one Pi in their mesh.
    publish_owner_blob(&base_http, &owner_1, &[&peer_a], 1).await;
    publish_owner_blob(&base_http, &owner_2, &[&peer_b], 1).await;

    let (mut ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;
    let (mut _ws_b, _) = connect_and_auth_with_key(port, &sk_b).await;

    let envelope = json!({
        "from": "casa:sess-3",
        "to": "trab:agent-1",
        "id": "u-cross",
        "re": null,
        "body": { "type": "ping" },
    });
    send_pi_envelope(&mut ws_a, &peer_b, envelope).await;

    let frame = recv_json(&mut ws_a, "ws_a transport_error").await;
    assert_eq!(frame["type"], "pi_envelope_in");
    assert_eq!(frame["from_pc"], "_relay");
    assert_eq!(frame["envelope"]["body"]["type"], "transport_error");
    assert_eq!(frame["envelope"]["body"]["reason"], "not_authorized");
    assert_eq!(frame["envelope"]["re"], "u-cross");
}

/// Malformed `pi_envelope` (missing `to_pc` / `envelope`): relay returns
/// `transport_error: bad_envelope` to A. The error envelope's `re` is null
/// because we can't recover the original id.
#[tokio::test]
async fn malformed_pi_envelope_returns_transport_error_bad_envelope() {
    let port = start_relay().await;

    let sk_a = random_key();
    let (mut ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;

    // No `to_pc`, no `envelope` — pure stub.
    ws_a.send(Message::text(json!({ "type": "pi_envelope" }).to_string()))
        .await
        .unwrap();

    let frame = recv_json(&mut ws_a, "ws_a bad_envelope").await;
    assert_eq!(frame["type"], "pi_envelope_in");
    assert_eq!(frame["from_pc"], "_relay");
    assert_eq!(frame["envelope"]["body"]["type"], "transport_error");
    assert_eq!(frame["envelope"]["body"]["reason"], "bad_envelope");
    assert!(
        frame["envelope"]["re"].is_null(),
        "re must be null when original id is unrecoverable"
    );
}

/// Cache behavior: after a successful authorization lookup, subsequent
/// envelopes between the same two Pis don't require re-scanning SQLite.
/// We can't easily count SQL hits at this layer, but we can verify that
/// repeated forwards in quick succession all succeed without observable
/// regression.
#[tokio::test]
async fn cache_warm_subsequent_envelopes_still_delivered() {
    let port = start_relay().await;
    let base_http = format!("http://127.0.0.1:{port}");

    let owner = random_key();
    let sk_a = random_key();
    let sk_b = random_key();
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());
    let peer_b = B64.encode(sk_b.verifying_key().to_bytes());
    publish_owner_blob(&base_http, &owner, &[&peer_a, &peer_b], 1).await;

    let (mut ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;
    let (mut ws_b, _) = connect_and_auth_with_key(port, &sk_b).await;

    for i in 0..5 {
        let env = json!({
            "from": "casa:s",
            "to": "trab:a",
            "id": format!("u{i}"),
            "re": null,
            "body": { "type": "ping", "seq": i },
        });
        send_pi_envelope(&mut ws_a, &peer_b, env.clone()).await;
        let frame = recv_json(&mut ws_b, &format!("ws_b iter {i}")).await;
        assert_eq!(frame["envelope"]["id"], format!("u{i}"));
        assert_eq!(frame["envelope"]["body"]["seq"], i);
    }
}
