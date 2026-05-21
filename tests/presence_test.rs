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
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

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
