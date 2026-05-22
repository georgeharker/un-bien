#![allow(dead_code)]

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay::{serve, PeerRegistry, PresenceManager, RoomManager};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::{
    connect_async,
    tungstenite::Message,
    WebSocketStream, MaybeTlsStream,
};

pub type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Binds a relay on a random port and returns that port.
pub async fn start_relay() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let presence = Arc::new(PresenceManager::new());
    let rooms = Arc::new(RoomManager::new());
    let registry = Arc::new(PeerRegistry::new(presence.clone(), rooms.clone()));
    tokio::spawn(serve(listener, registry, presence, rooms, std::future::pending::<()>()));
    port
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
