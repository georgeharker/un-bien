mod common;
use common::{connect_and_auth, start_relay};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

/// Peer A sends an OuterEnvelope addressed to peer B.
/// B receives a rewritten envelope where outer.peer = A (the sender),
/// not B (the original dest) — per protocol.md semantics.
#[tokio::test]
async fn two_peers_route_message() {
    let port = start_relay().await;
    let (mut ws_a, peer_a) = connect_and_auth(port).await;
    let (mut ws_b, peer_b) = connect_and_auth(port).await;

    let ct = "aGVsbG8="; // "hello" in base64, never decoded by relay
    // A sends: peer = dest (peer_b)
    ws_a.send(Message::text(json!({"peer": peer_b, "ct": ct}).to_string()))
        .await
        .unwrap();

    let received = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_b.next(),
    )
    .await
    .expect("timed out waiting for forwarded message")
    .unwrap()
    .unwrap();

    // B receives: peer = sender (peer_a), ct unchanged
    let received_json: serde_json::Value =
        serde_json::from_str(received.to_text().unwrap()).unwrap();
    assert_eq!(received_json["peer"], peer_a, "relay must rewrite peer to sender id");
    assert_eq!(received_json["ct"], ct, "ct must be forwarded unchanged");
}

/// Sending to an unknown peer ID is silently dropped; the sender's connection stays alive.
#[tokio::test]
async fn dest_offline_drops_silently() {
    let port = start_relay().await;
    let (mut ws_a, _) = connect_and_auth(port).await;

    let envelope = json!({"peer": "bm9uZXhpc3RlbnRwZWVy", "ct": "aGVsbG8="}).to_string();
    ws_a.send(Message::text(envelope)).await.unwrap();

    // If the relay silently drops it, no message arrives and no close frame is sent.
    let result = tokio::time::timeout(
        tokio::time::Duration::from_millis(200),
        ws_a.next(),
    )
    .await;

    assert!(
        result.is_err(),
        "expected no message (connection alive), got {:?}",
        result
    );
}

/// A client that sends an invalid signature must have its WS closed within 100 ms.
#[tokio::test]
async fn invalid_sig_closes_ws() {
    let port = start_relay().await;
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use ed25519_dalek::SigningKey;
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let vk = sk.verifying_key();

    // send hello
    ws.send(Message::text(
        json!({"type": "hello", "pubkey": B64.encode(vk.to_bytes())}).to_string(),
    ))
    .await
    .unwrap();

    // receive and ignore challenge (we won't sign correctly)
    let challenge_msg = ws.next().await.unwrap().unwrap();
    let v: serde_json::Value =
        serde_json::from_str(challenge_msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "challenge");

    // send all-zero signature (invalid)
    ws.send(Message::text(
        json!({"type": "auth", "sig": B64.encode([0u8; 64])}).to_string(),
    ))
    .await
    .unwrap();

    // relay must close within 100 ms
    let close_result = tokio::time::timeout(
        tokio::time::Duration::from_millis(100),
        ws.next(),
    )
    .await;

    assert!(
        close_result.is_ok(),
        "relay did not close the connection within 100 ms"
    );
    match close_result.unwrap() {
        None | Some(Ok(Message::Close(_))) | Some(Err(_)) => {} // all acceptable
        Some(Ok(other)) => panic!("unexpected message after bad auth: {other:?}"),
    }
}
