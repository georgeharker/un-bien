mod common;
use common::{connect_and_auth, connect_and_auth_with_key, connect_and_auth_with_room, start_relay};

use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn random_key() -> SigningKey {
    SigningKey::generate(&mut rand::thread_rng())
}

/// B subscribes to Pi's rooms. Pi connects with a named room → B gets room_announced.
#[tokio::test]
async fn subscribe_rooms_then_peer_opens_room_pushes_announced() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    // App (B) subscribes to Pi's room events before Pi connects.
    let (mut ws_app, _) = connect_and_auth(port).await;
    ws_app
        .send(Message::text(
            json!({"type": "subscribe_rooms", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    // Pi connects with a specific room.
    let (_ws_pi, _) = connect_and_auth_with_room(port, &sk_pi, "aB12CD34eF56").await;

    // App must receive room_announced.
    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for room_announced")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "room_announced", "got: {v}");
    assert_eq!(v["peer"], peer_pi);
    assert_eq!(v["room_id"], "aB12CD34eF56");
    assert!(v["started_at"].as_i64().is_some(), "started_at must be epoch-ms");
}

/// Pi connects; App subscribes then Pi disconnects → App gets room_ended.
#[tokio::test]
async fn peer_disconnects_pushes_room_ended() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    let (ws_pi, _) = connect_and_auth_with_room(port, &sk_pi, "work").await;
    let (mut ws_app, _) = connect_and_auth(port).await;

    ws_app
        .send(Message::text(
            json!({"type": "subscribe_rooms", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    drop(ws_pi);
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for room_ended")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "room_ended", "got: {v}");
    assert_eq!(v["peer"], peer_pi);
    assert_eq!(v["room_id"], "work");
    assert!(v["since_ts"].as_i64().is_some(), "since_ts must be epoch-ms");
}

/// rooms_check for a peer with no active connections → rooms: [].
#[tokio::test]
async fn rooms_check_empty_for_offline_peer() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    let (mut ws_app, _) = connect_and_auth(port).await;
    ws_app
        .send(Message::text(
            json!({"type": "rooms_check", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for rooms response")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "rooms");
    assert_eq!(v["peer"], peer_pi);
    assert_eq!(v["rooms"].as_array().unwrap().len(), 0);
}

/// rooms_check while two rooms are active → both room_ids appear in snapshot.
#[tokio::test]
async fn rooms_check_returns_all_active_rooms() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    let (_ws_pi_work, _) = connect_and_auth_with_room(port, &sk_pi, "work").await;
    let (_ws_pi_home, _) = connect_and_auth_with_room(port, &sk_pi, "home").await;

    let (mut ws_app, _) = connect_and_auth(port).await;
    ws_app
        .send(Message::text(
            json!({"type": "rooms_check", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for rooms response")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "rooms");
    let rooms = v["rooms"].as_array().unwrap();
    assert_eq!(rooms.len(), 2, "expected 2 rooms, got: {rooms:?}");
    let ids: Vec<&str> = rooms.iter().map(|r| r["room_id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"work"), "missing 'work'");
    assert!(ids.contains(&"home"), "missing 'home'");
}

/// Messages route to the exact (peer, room) — a different room of the same peer does NOT receive them.
#[tokio::test]
async fn forward_routes_by_room_not_just_peer() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    let (mut ws_pi_work, _) = connect_and_auth_with_room(port, &sk_pi, "work").await;
    let (mut ws_pi_home, _) = connect_and_auth_with_room(port, &sk_pi, "home").await;

    let (mut ws_app, peer_app) = connect_and_auth(port).await;

    let ct = "dGVzdA=="; // "test" base64

    // App sends to Pi's "work" room.
    ws_app
        .send(Message::text(
            json!({"peer": peer_pi, "room": "work", "ct": ct}).to_string(),
        ))
        .await
        .unwrap();

    // Pi's "work" room must receive it.
    let received = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_pi_work.next(),
    )
    .await
    .expect("timed out waiting for message at work room")
    .unwrap()
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(received.to_text().unwrap()).unwrap();
    assert_eq!(v["ct"], ct);
    assert_eq!(v["peer"], peer_app, "relay must rewrite peer to sender");
    assert_eq!(v["room"], "main", "relay must include sender's room");

    // Pi's "home" room must NOT receive anything.
    let spurious = tokio::time::timeout(
        tokio::time::Duration::from_millis(150),
        ws_pi_home.next(),
    )
    .await;
    assert!(spurious.is_err(), "home room must not receive messages sent to work room");
}

/// A second connection attempt for the same (peer, room) must be rejected with an error frame.
#[tokio::test]
async fn duplicate_room_connection_rejected_over_ws() {
    let port = start_relay().await;
    let sk_pi = random_key();

    // First connection succeeds.
    let (_ws_pi_1, _) = connect_and_auth_with_room(port, &sk_pi, "work").await;

    // Second connection for the same room should receive an error frame.
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use ed25519_dalek::Signer;
    use futures_util::SinkExt;

    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws2, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    let vk = sk_pi.verifying_key();
    let pubkey_b64 = B64.encode(vk.to_bytes());

    ws2.send(Message::text(
        json!({"type": "hello", "pubkey": pubkey_b64, "room_id": "work"}).to_string(),
    ))
    .await
    .unwrap();

    let challenge_msg = ws2.next().await.unwrap().unwrap();
    let cj: serde_json::Value =
        serde_json::from_str(challenge_msg.to_text().unwrap()).unwrap();
    let nonce_arr: [u8; 32] = B64.decode(cj["nonce"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let sig = sk_pi.sign(&nonce_arr);
    ws2.send(Message::text(
        json!({"type": "auth", "sig": B64.encode(sig.to_bytes())}).to_string(),
    ))
    .await
    .unwrap();

    let resp = tokio::time::timeout(
        tokio::time::Duration::from_millis(200),
        ws2.next(),
    )
    .await
    .expect("timed out waiting for rejection")
    .unwrap()
    .unwrap();

    match resp {
        Message::Text(t) => {
            let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
            assert_eq!(v["code"], "room_already_open", "expected room_already_open, got: {v}");
        }
        Message::Close(_) => {} // also acceptable — relay may close immediately
        other => panic!("unexpected frame: {other:?}"),
    }
}

/// Pi connects with room_meta.model → room_announced received by subscriber includes model.
#[tokio::test]
async fn room_announced_includes_model_from_hello() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use ed25519_dalek::Signer;

    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    let (mut ws_app, _) = connect_and_auth(port).await;
    ws_app
        .send(Message::text(
            json!({"type": "subscribe_rooms", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    // Pi connects with room_meta.model
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws_pi, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let vk = sk_pi.verifying_key();
    ws_pi
        .send(Message::text(
            json!({
                "type": "hello",
                "pubkey": B64.encode(vk.to_bytes()),
                "room_id": "work",
                "room_meta": {"name": "my-proj", "model": "claude-opus-4-7"},
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let challenge_msg = ws_pi.next().await.unwrap().unwrap();
    let cj: serde_json::Value = serde_json::from_str(challenge_msg.to_text().unwrap()).unwrap();
    let nonce_arr: [u8; 32] = B64.decode(cj["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
    let sig = sk_pi.sign(&nonce_arr);
    ws_pi
        .send(Message::text(
            json!({"type": "auth", "sig": B64.encode(sig.to_bytes())}).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for room_announced")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "room_announced");
    assert_eq!(v["model"], "claude-opus-4-7", "model must be present in room_announced");
    assert_eq!(v["name"], "my-proj");
}

/// Pi sends room_meta_update → subscribers receive room_meta_updated with new model.
#[tokio::test]
async fn room_meta_update_broadcasts_to_subscribers() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    let (mut ws_pi, _) = connect_and_auth_with_key(port, &sk_pi).await; // room = "main"
    let (mut ws_app, _) = connect_and_auth(port).await;

    ws_app
        .send(Message::text(
            json!({"type": "subscribe_rooms", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    // Pi sends room_meta_update for its own "main" room.
    ws_pi
        .send(Message::text(
            json!({
                "type": "room_meta_update",
                "room_id": "main",
                "meta": {"model": "claude-haiku-4-5-20251001"},
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for room_meta_updated")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "room_meta_updated", "got: {v}");
    assert_eq!(v["peer"], peer_pi);
    assert_eq!(v["room_id"], "main");
    assert_eq!(v["meta"]["model"], "claude-haiku-4-5-20251001");
}

/// rooms_check after room_meta_update reflects the updated model.
#[tokio::test]
async fn rooms_check_reflects_updated_model() {
    let port = start_relay().await;
    let sk_pi = random_key();
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let peer_pi = B64.encode(sk_pi.verifying_key().to_bytes());

    let (mut ws_pi, _) = connect_and_auth_with_key(port, &sk_pi).await;
    let (mut ws_app, _) = connect_and_auth(port).await;

    // Update model first.
    ws_pi
        .send(Message::text(
            json!({"type": "room_meta_update", "room_id": "main", "meta": {"model": "claude-sonnet-4-6"}})
                .to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    // Request snapshot.
    ws_app
        .send(Message::text(
            json!({"type": "rooms_check", "peers": [&peer_pi]}).to_string(),
        ))
        .await
        .unwrap();

    let msg = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        ws_app.next(),
    )
    .await
    .expect("timed out waiting for rooms response")
    .unwrap()
    .unwrap();

    let v: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "rooms");
    let rooms = v["rooms"].as_array().unwrap();
    assert_eq!(rooms.len(), 1);
    assert_eq!(rooms[0]["model"], "claude-sonnet-4-6", "rooms_check must show updated model");
}
