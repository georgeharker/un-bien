use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Duration;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{info, warn};

use crate::auth::challenge::{
    challenge_line, gen_nonce, parse_hello, verify_auth, HELLO_TIMEOUT_MS,
};
use crate::peers::registry::PeerRegistry;
use crate::protocol::outer::{OuterEnvelope, parse_line};

pub async fn handle_peer(stream: TcpStream, registry: Arc<PeerRegistry>) {
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
    info!(peer = %peer_short, addr = %peer_addr, "authenticated");

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let conn_id = registry.register(peer_id.clone(), tx);

    // ── 4. Routing loop ───────────────────────────────────────────────────
    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    None | Some(Err(_)) => break,
                    Some(Ok(msg)) => {
                        if msg.is_close() {
                            break;
                        }
                        let text = match msg.to_text() {
                            Ok(t) => t.to_string(),
                            Err(_) => continue, // binary/ping — ignore
                        };
                        match parse_line(&text) {
                            Err(e) => {
                                warn!(peer = %peer_short, err = %e, "invalid envelope, dropping");
                            }
                            Ok(env) => {
                                let ct_len = env.ct.len();
                                let dest = env.peer;
                                let dest_tail = dest[dest.len().saturating_sub(8)..].to_string();
                                // Rewrite peer = sender so the recipient knows who sent it.
                                // Semantics (per protocol.md): outbound peer = dest, inbound peer = sender.
                                let rewritten = OuterEnvelope {
                                    peer: peer_id.clone(),
                                    ct: env.ct,
                                };
                                let fwd_line = serde_json::to_string(&rewritten)
                                    .expect("OuterEnvelope serialisation is infallible");
                                if !registry.forward(&dest, Message::text(fwd_line)) {
                                    warn!(
                                        from = %peer_short,
                                        dest = %dest_tail,
                                        bytes = ct_len,
                                        "dest peer not found, dropping",
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
        }
    }

    registry.unregister(&peer_id, conn_id);
    info!(peer = %peer_short, addr = %peer_addr, "disconnected");
}
