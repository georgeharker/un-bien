mod common;
use common::{connect_and_auth, connect_and_auth_with_key, start_relay};

use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn random_key() -> SigningKey {
    SigningKey::generate(&mut rand::thread_rng())
}

/// B subscribes to A before A connects. When A connects, B must receive peer_online.
#[tokio::test]
async fn subscribe_then_peer_connects_pushes_online() {
    let port = start_relay().await;
    let sk_a = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());

    let (mut ws_b, _) = connect_and_auth(port).await;

    // B subscribes to A (A is not connected yet)
    ws_b.send(Message::text(
        json!({"type": "subscribe_presence", "peers": [&peer_a]}).to_string(),
    ))
    .await
    .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    // A connects
    let (_ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;

    // B must receive peer_online within 1s
    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_b.next(),
    )
    .await
    .expect("timed out waiting for peer_online")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "peer_online", "expected peer_online, got {v}");
    assert_eq!(v["peer"], peer_a);
}

/// B subscribes to A. A disconnects. B must receive peer_offline with a since_ts.
#[tokio::test]
async fn peer_disconnects_pushes_offline_with_since_ts() {
    let port = start_relay().await;
    let sk_a = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());

    let (ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;
    let (mut ws_b, _) = connect_and_auth(port).await;

    // B subscribes to A
    ws_b.send(Message::text(
        json!({"type": "subscribe_presence", "peers": [&peer_a]}).to_string(),
    ))
    .await
    .unwrap();

    // Backfill (Fix #2) pushes a peer_online for the already-online A —
    // consume it so the assertion below only sees the peer_offline frame.
    let backfill = tokio::time::timeout(
        tokio::time::Duration::from_millis(200),
        ws_b.next(),
    )
    .await
    .expect("timed out waiting for backfill")
    .unwrap()
    .unwrap();
    let bf: serde_json::Value = serde_json::from_str(backfill.to_text().unwrap()).unwrap();
    assert_eq!(bf["type"], "peer_online", "expected backfill peer_online, got {bf}");

    // A drops its WS (simulates disconnect)
    drop(ws_a);
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // B must receive peer_offline with a numeric since_ts
    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_b.next(),
    )
    .await
    .expect("timed out waiting for peer_offline")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "peer_offline", "expected peer_offline, got {v}");
    assert_eq!(v["peer"], peer_a);
    assert!(
        v["since_ts"].as_i64().is_some(),
        "since_ts must be a numeric epoch-ms, got {}",
        v["since_ts"]
    );
}

/// presence_check for a peer that has never connected → offline, since_ts null.
#[tokio::test]
async fn presence_check_returns_offline_for_unknown_peer() {
    let port = start_relay().await;
    let sk_a = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());

    let (mut ws_b, _) = connect_and_auth(port).await;
    ws_b.send(Message::text(
        json!({"type": "presence_check", "peers": [&peer_a]}).to_string(),
    ))
    .await
    .unwrap();

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_b.next(),
    )
    .await
    .expect("timed out waiting for presence response")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "presence");
    let states = v["states"].as_array().unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!(states[0]["peer"], peer_a);
    assert_eq!(states[0]["online"], false, "peer_a should be offline");
    assert!(states[0]["since_ts"].is_null(), "since_ts should be null for never-seen peer");
}

/// presence_check for a peer that IS connected → online, since_ts null.
#[tokio::test]
async fn presence_check_returns_online_for_connected_peer() {
    let port = start_relay().await;
    let sk_a = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_a = B64.encode(sk_a.verifying_key().to_bytes());

    let (_ws_a, _) = connect_and_auth_with_key(port, &sk_a).await;
    let (mut ws_b, _) = connect_and_auth(port).await;

    ws_b.send(Message::text(
        json!({"type": "presence_check", "peers": [&peer_a]}).to_string(),
    ))
    .await
    .unwrap();

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_b.next(),
    )
    .await
    .expect("timed out waiting for presence response")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "presence");
    let states = v["states"].as_array().unwrap();
    assert_eq!(states[0]["peer"], peer_a);
    assert_eq!(states[0]["online"], true, "peer_a should be online");
    assert!(states[0]["since_ts"].is_null(), "since_ts is null when online");
}

/// Fix #2 — subscribe_presence backfill: if the target peer is ALREADY online
/// when the subscription is registered, the relay must immediately push
/// peer_online to the subscriber (no presence_check round-trip needed).
#[tokio::test]
async fn subscribe_after_peer_already_online_backfills_peer_online() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    // Pi comes online FIRST.
    let (_ws_pi, _) = connect_and_auth_with_key(port, &sk_pi).await;

    // App connects later, then subscribes.
    let (mut ws_app, _) = connect_and_auth(port).await;
    ws_app
        .send(Message::text(
            json!({"type": "subscribe_presence", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();

    // App must receive peer_online via backfill, not having to call presence_check.
    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for backfilled peer_online")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "peer_online", "expected backfilled peer_online, got: {v}");
    assert_eq!(v["peer"], peer_pi);
}

/// Fix #1 — peer_online fires on EVERY successful register, not just on
/// the 0→1 transition. Ensures that a fresh connection from a peer always
/// signals presence even when a zombie/duplicate conn is still in the registry.
#[tokio::test]
async fn second_conn_same_peer_still_emits_peer_online() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    // App subscribes first.
    let (mut ws_app, _) = connect_and_auth(port).await;
    ws_app
        .send(Message::text(
            json!({"type": "subscribe_presence", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    // First Pi conn → first peer_online.
    let (_ws_pi_1, _) = connect_and_auth_with_key(port, &sk_pi).await;
    let m1 = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("missed first peer_online")
    .unwrap()
    .unwrap();
    let v1: serde_json::Value = serde_json::from_str(m1.to_text().unwrap()).unwrap();
    assert_eq!(v1["type"], "peer_online");

    // Second Pi conn at the SAME (peer, room) — simulates zombie + reconnect.
    // Plan 23 (Wave 2C) allows this. peer_online must STILL fire so the app
    // doesn't get stuck in offline state if it missed the first event.
    let (_ws_pi_2, _) = connect_and_auth_with_key(port, &sk_pi).await;
    let m2 = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("missed second peer_online (regression)")
    .unwrap()
    .unwrap();
    let v2: serde_json::Value = serde_json::from_str(m2.to_text().unwrap()).unwrap();
    assert_eq!(v2["type"], "peer_online", "second register must also emit peer_online, got: {v2}");
    assert_eq!(v2["peer"], peer_pi);
}
