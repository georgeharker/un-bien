use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{self, Duration};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{info, warn};

use crate::auth::challenge::{
    challenge_line, gen_nonce, parse_hello, verify_auth, HELLO_TIMEOUT_MS,
};
use crate::peers::registry::PeerRegistry;
use crate::presence::PresenceManager;
use crate::protocol::outer::{OuterEnvelope, parse_line};
use crate::rooms::{RoomManager, RoomMeta};

pub async fn handle_peer(
    stream: TcpStream,
    registry: Arc<PeerRegistry>,
    presence: Arc<PresenceManager>,
    rooms: Arc<RoomManager>,
) {
    let peer_addr = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "unknown".into());

    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            warn!(addr = %peer_addr, err = %e, "WS handshake failed");
            return;
        }
    };

    let (mut sink, mut stream) = ws.split();

    // ── 1. Wait for hello (with timeout) ──────────────────────────────────
    let hello_result = tokio::time::timeout(
        Duration::from_millis(HELLO_TIMEOUT_MS),
        stream.next(),
    )
    .await;

    let hello_text = match hello_result {
        Ok(Some(Ok(msg))) => match msg.to_text() {
            Ok(t) => t.to_string(),
            Err(_) => return,
        },
        Ok(_) | Err(_) => {
            warn!(addr = %peer_addr, "no hello received, closing");
            return;
        }
    };

    let vk = match parse_hello(&hello_text) {
        Ok(vk) => vk,
        Err(e) => {
            warn!(addr = %peer_addr, err = %e, "bad hello, closing");
            return;
        }
    };

    // ── 2. Send challenge ─────────────────────────────────────────────────
    let (nonce, nonce_b64) = gen_nonce();
    if sink
        .send(Message::text(challenge_line(&nonce_b64)))
        .await
        .is_err()
    {
        return;
    }

    // ── 3. Receive and verify auth ────────────────────────────────────────
    let auth_text = match stream.next().await {
        Some(Ok(msg)) => match msg.to_text() {
            Ok(t) => t.to_string(),
            Err(_) => return,
        },
        _ => return,
    };

    if let Err(e) = verify_auth(&nonce, &vk, &auth_text) {
        warn!(addr = %peer_addr, err = %e, "auth failed, closing");
        let _ = sink.send(Message::Close(None)).await;
        return;
    }

    let peer_id = B64.encode(vk.to_bytes());
    let peer_short = peer_id[peer_id.len().saturating_sub(8)..].to_string();

    // Extract room_id and room_meta from hello (auth handled separately above).
    let room_meta = {
        let hello: serde_json::Value =
            serde_json::from_str(&hello_text).unwrap_or(serde_json::Value::Null);
        let room_id = hello
            .get("room_id")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_string();
        let room_meta_val = hello.get("room_meta");
        let name = room_meta_val
            .and_then(|m| m.get("name"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let cwd = room_meta_val
            .and_then(|m| m.get("cwd"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let model = room_meta_val
            .and_then(|m| m.get("model"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        RoomMeta { room_id, name, cwd, model, started_at }
    };
    let room_id = room_meta.room_id.clone();

    info!(peer = %peer_short, room = %room_id, addr = %peer_addr, "authenticated");

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let conn_id = match registry.register(peer_id.clone(), room_meta, tx).await {
        Ok(id) => id,
        Err(()) => {
            warn!(peer = %peer_short, room = %room_id, "room already open, rejecting");
            let _ = sink
                .send(Message::text(
                    serde_json::json!({"type": "error", "code": "room_already_open"})
                        .to_string(),
                ))
                .await;
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
    };

    // ── 4. Routing loop ───────────────────────────────────────────────────
    // Send a WS Ping every 25 s so NAT/LB idle timers don't close the connection.
    // First tick fires after 25 s (not immediately).
    let mut heartbeat = time::interval_at(
        time::Instant::now() + Duration::from_secs(25),
        Duration::from_secs(25),
    );

    'routing: loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    None | Some(Err(_)) => break,
                    Some(Ok(msg)) => {
                        if msg.is_close() {
                            break;
                        }
                        // Pong frames are keepalive responses — discard silently.
                        // Ping frames are answered automatically by tungstenite's next().
                        if msg.is_pong() || msg.is_ping() {
                            continue;
                        }
                        let text = match msg.to_text() {
                            Ok(t) => t.to_string(),
                            Err(_) => continue, // binary frame — ignore
                        };

                        // Parse as JSON to check for relay control frames.
                        let frame: serde_json::Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                warn!(peer = %peer_short, err = %e, "invalid json, dropping");
                                continue;
                            }
                        };

                        // Frames with a top-level "type" are handled by the relay itself.
                        if let Some(t) = frame.get("type").and_then(|v| v.as_str()) {
                            let peers: Vec<String> = frame
                                .get("peers")
                                .and_then(|v| v.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|v| v.as_str().map(String::from))
                                        .collect()
                                })
                                .unwrap_or_default();

                            match t {
                                // ── presence control frames (plano 12) ──
                                "subscribe_presence" => {
                                    presence.subscribe(peer_id.clone(), peers).await;
                                }
                                "unsubscribe_presence" => {
                                    presence.unsubscribe(&peer_id, peers).await;
                                }
                                "presence_check" => {
                                    let states = presence
                                        .snapshot(&peers, |p| registry.is_online(p))
                                        .await;
                                    let resp = serde_json::json!({
                                        "type": "presence",
                                        "states": states,
                                    })
                                    .to_string();
                                    if sink.send(Message::text(resp)).await.is_err() {
                                        break;
                                    }
                                }

                                // ── rooms control frames (plano 17) ──
                                "subscribe_rooms" => {
                                    rooms.subscribe(peer_id.clone(), peers).await;
                                }
                                "unsubscribe_rooms" => {
                                    rooms.unsubscribe(&peer_id, peers).await;
                                }
                                "rooms_check" => {
                                    for target_peer in &peers {
                                        let active_rooms = registry.rooms_of(target_peer);
                                        let resp = serde_json::json!({
                                            "type": "rooms",
                                            "peer": target_peer,
                                            "rooms": active_rooms,
                                        })
                                        .to_string();
                                        if sink.send(Message::text(resp)).await.is_err() {
                                            break 'routing;
                                        }
                                    }
                                }

                                // ── room meta update (plano 18) ──
                                "room_meta_update" => {
                                    let target_room = frame
                                        .get("room_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(&room_id)
                                        .to_string();
                                    let model = frame
                                        .get("meta")
                                        .and_then(|m| m.get("model"))
                                        .and_then(|v| v.as_str())
                                        .map(String::from);
                                    if !registry
                                        .update_room_meta(&peer_id, &target_room, model)
                                        .await
                                    {
                                        warn!(
                                            peer = %peer_short,
                                            room = %target_room,
                                            "room_meta_update for unknown (peer, room), dropping"
                                        );
                                    }
                                }

                                _ => {
                                    warn!(
                                        peer = %peer_short,
                                        frame_type = %t,
                                        "unknown control frame type, dropping"
                                    );
                                }
                            }
                            continue; // do not fall through to envelope path
                        }

                        // No "type" field → outer envelope (opaque routing).
                        match parse_line(&text) {
                            Err(e) => {
                                warn!(peer = %peer_short, err = %e, "invalid envelope, dropping");
                            }
                            Ok(env) => {
                                let ct_len = env.ct.len();
                                let dest_peer = env.peer;
                                let dest_room = env.room;
                                let dest_tail =
                                    dest_peer[dest_peer.len().saturating_sub(8)..].to_string();
                                // Rewrite: recipient sees sender's peer_id + sender's room_id.
                                let rewritten = OuterEnvelope {
                                    peer: peer_id.clone(),
                                    room: room_id.clone(),
                                    ct: env.ct,
                                };
                                let fwd_line = serde_json::to_string(&rewritten)
                                    .expect("OuterEnvelope serialisation is infallible");
                                if !registry.forward(&dest_peer, &dest_room, Message::text(fwd_line)) {
                                    warn!(
                                        from = %peer_short,
                                        dest = %dest_tail,
                                        room = %dest_room,
                                        bytes = ct_len,
                                        "dest (peer, room) not found, dropping",
                                    );
                                }
                            }
                        }
                    }
                }
            }
            result = rx.recv() => {
                match result {
                    Some(msg) => {
                        if sink.send(msg).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = heartbeat.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
        }
    }

    registry.unregister(&peer_id, &room_id, conn_id).await;
    rooms.unsubscribe_all(&peer_id).await;
    info!(peer = %peer_short, room = %room_id, addr = %peer_addr, "disconnected");
}
