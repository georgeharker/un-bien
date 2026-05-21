#![allow(dead_code)]

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay::{serve, PeerRegistry, PresenceManager};
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
    let registry = Arc::new(PeerRegistry::new(presence.clone()));
    tokio::spawn(serve(listener, registry, presence, std::future::pending::<()>()));
    port
}

/// Connects to the relay and completes the full auth handshake using a caller-supplied key.
/// Returns (ws_stream, peer_id_b64).
pub async fn connect_and_auth_with_key(port: u16, sk: &SigningKey) -> (WsStream, String) {
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    let vk = sk.verifying_key();
    let pubkey_b64 = B64.encode(vk.to_bytes());

    ws.send(Message::text(
        json!({"type": "hello", "pubkey": pubkey_b64}).to_string(),
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

    // Give server a moment to process auth and register this peer.
    tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;

    (ws, pubkey_b64)
}

/// Connects to the relay with a fresh random key.
pub async fn connect_and_auth(port: u16) -> (WsStream, String) {
    let sk = SigningKey::generate(&mut rand::thread_rng());
    connect_and_auth_with_key(port, &sk).await
}
