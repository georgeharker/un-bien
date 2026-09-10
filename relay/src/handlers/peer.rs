use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::Response;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::{self, Duration};
use tracing::{info, warn};

use crate::AppState;
use crate::auth::challenge::{
    HELLO_TIMEOUT_MS, challenge_line, gen_nonce, parse_hello, verify_auth,
};
use crate::protocol::outer::{OuterEnvelope, ParseError, is_pair_envelope, parse_line};
use crate::rooms::{RoomMeta, RoomMetaPatch};

/// WS framing limits — PINNED EXPLICITLY (these happen to be axum/tungstenite's
/// defaults; now they can't silently change with an upgrade). The SEMANTIC ct
/// cap (RELAY_MAX_CT_MIB, default 4 MiB decoded) is the tighter ceiling peers
/// actually hit; framing must merely exceed it with margin — a max-size ct
/// (~5.34 MiB base64 + envelope) has to fit in ONE frame/message.
const MAX_WS_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

/// Axum route handler: validates the WebSocket upgrade and hands the upgraded
/// socket to `handle_peer`, which owns the connection for its lifetime.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> Response {
    ws.max_frame_size(MAX_WS_FRAME_BYTES)
        .max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_peer(socket, addr, state))
}

/// Owns one peer's WebSocket connection: hello/challenge/auth → register →
/// routing loop (forwarding outer envelopes + handling presence/rooms control
/// frames + sending 25 s keepalive pings) → unregister on disconnect.
async fn handle_peer(socket: WebSocket, peer_addr: SocketAddr, state: AppState) {
    let peer_addr = peer_addr.to_string();
    let (mut sink, mut stream) = socket.split();

    // ── 1. Wait for hello (with timeout) ──────────────────────────────────
    let hello_result =
        tokio::time::timeout(Duration::from_millis(HELLO_TIMEOUT_MS), stream.next()).await;

    let hello_text = match hello_result {
        Ok(Some(Ok(Message::Text(t)))) => t,
        _ => {
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
        .send(Message::Text(challenge_line(&nonce_b64)))
        .await
        .is_err()
    {
        return;
    }

    // ── 3. Receive and verify auth ────────────────────────────────────────
    let auth_text = match stream.next().await {
        Some(Ok(Message::Text(t))) => t,
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
        let thinking = room_meta_val
            .and_then(|m| m.get("thinking"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let working = room_meta_val
            .and_then(|m| m.get("working"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        // Any room_meta keys the relay does not model itself (e.g. an app-level
        // session `parent`) ride through verbatim so app-owned metadata reaches
        // subscribers without the relay learning its meaning.
        let extra: std::collections::BTreeMap<String, serde_json::Value> = room_meta_val
            .and_then(|m| m.as_object())
            .map(|obj| {
                obj.iter()
                    .filter(|(k, _)| {
                        !matches!(
                            k.as_str(),
                            "name" | "cwd" | "model" | "thinking" | "working"
                        )
                    })
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        RoomMeta {
            room_id,
            name,
            cwd,
            model,
            thinking,
            working,
            started_at,
            extra,
        }
    };
    let room_id = room_meta.room_id.clone();

    info!(peer = %peer_short, room = %room_id, addr = %peer_addr, "authenticated");

    let registry = state.registry.clone();
    let presence = state.presence.clone();
    let rooms = state.rooms.clone();
    let mesh = state.mesh.clone();
    let mesh_auth = state.mesh_auth.clone();
    let metrics = state.metrics.clone();
    let pairing = state.pairing.clone();

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let conn_id = registry.register(peer_id.clone(), room_meta, tx).await;

    // Per-conn dedup state for control-frame replies. Suppress identical
    // re-emits of `presence` (single cache slot — there's only one
    // subscription set per conn) and `rooms` (one slot per target peer).
    let mut last_presence_resp: Option<String> = None;
    let mut last_rooms_resp: HashMap<String, String> = HashMap::new();

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
                        let text = match msg {
                            Message::Text(t) => t,
                            Message::Close(_) => break,
                            // Pong frames are keepalive responses; Ping frames are
                            // answered automatically by axum's WS. Drop both.
                            Message::Ping(_) | Message::Pong(_) => continue,
                            Message::Binary(_) => continue, // ignore binary
                        };

                        // Parse as JSON to check for relay control frames.
                        let frame: serde_json::Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                // NOT a silent drop (2026-09-10 story): refuse to
                                // the sender — same refusal shape as parse_line's
                                // payload_too_large / invalid_envelope below.
                                warn!(peer = %peer_short, err = %e,
                                      "invalid json, refused to sender");
                                let refusal = serde_json::json!({
                                    "type": "error",
                                    "code": "invalid_envelope",
                                    "detail": e.to_string(),
                                })
                                .to_string();
                                if sink.send(Message::Text(refusal)).await.is_err() {
                                    break 'routing;
                                }
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
                                    presence.subscribe(peer_id.clone(), peers.clone()).await;
                                    // Backfill: push peer_online for any already-online
                                    // peers in the list, so subscribers don't have to
                                    // call presence_check to discover current state.
                                    registry.backfill_presence(&peer_id, &peers);
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
                                    // Dedup: skip reply if identical to the
                                    // previous one we sent on this conn. The
                                    // first reply always goes through (cache
                                    // is None until the first emit).
                                    if last_presence_resp.as_deref() == Some(resp.as_str()) {
                                        metrics.inc_presence_suppressed(1);
                                    } else {
                                        last_presence_resp = Some(resp.clone());
                                        if sink.send(Message::Text(resp)).await.is_err() {
                                            break;
                                        }
                                        metrics.inc_presence_emitted(1);
                                    }
                                }

                                // ── rooms control frames (plano 17) ──
                                "subscribe_rooms" => {
                                    // ROOMS gate (design 01M1ZE43): the effective subscription
                                    // is the request ∩ this requester's allow-list membership.
                                    // Record the RAW request too, so a later pairing_set that
                                    // grants a machine re-derives the subscription without a
                                    // reconnect (order-independent push, design 01M23Z6MK).
                                    rooms.set_requested(peer_id.clone(), peers.clone()).await;
                                    let allowed: Vec<String> = peers
                                        .into_iter()
                                        .filter(|target| pairing.allows(target, &peer_id))
                                        .collect();
                                    rooms.subscribe(peer_id.clone(), allowed).await;
                                }
                                // ── pairing allow-list push (design 01M1ZE43) ──
                                // The pushing peer_id IS the machine declaring who may
                                // list its rooms. Full-set replace (extension re-pushes on
                                // every change), then re-filter existing subscribers so a
                                // revoke / reconnect-race drops stale watchers immediately.
                                "pairing_set" => {
                                    // SIGNED-ONLY (design 01M23MKVG, george 'No legacy
                                    // support'): the push MUST be a machine-signed {blob,sig}
                                    // envelope — verify_strict, monotonic, and bound to THIS
                                    // connection's peer_id (a machine may sign only its own
                                    // list). A plaintext {owners} push is not accepted at all,
                                    // so the relay can never store an allow-list it did not
                                    // cryptographically verify — authority parity with
                                    // mesh_versions, no forgeable path. None => rejected.
                                    let owner_set: Option<std::collections::HashSet<String>> =
                                        if let (Some(blob_b64), Some(sig_b64)) = (
                                            frame.get("blob").and_then(|v| v.as_str()),
                                            frame.get("sig").and_then(|v| v.as_str()),
                                        ) {
                                            match (B64.decode(blob_b64), B64.decode(sig_b64)) {
                                                (Ok(blob), Ok(sig)) => {
                                                    match crate::peers::pairing::verify_pairing_blob(
                                                        &blob, &sig,
                                                    ) {
                                                        Ok(p) if p.machine_pk == peer_id => {
                                                            let version = p.version;
                                                            let set: std::collections::HashSet<
                                                                String,
                                                            > = p.owners.iter().cloned().collect();
                                                            match pairing.set_signed(
                                                                peer_id.clone(),
                                                                p.owners,
                                                                version,
                                                                &blob,
                                                                &sig,
                                                            ) {
                                                                Ok(()) => {
                                                                    tracing::info!(machine = %peer_id, count = set.len(), version, "pairing_set: stored SIGNED allow-list");
                                                                    Some(set)
                                                                }
                                                                Err(stale) => {
                                                                    tracing::info!(machine = %peer_id, new = stale.new, current = stale.current, "pairing_set rejected: stale version");
                                                                    None
                                                                }
                                                            }
                                                        }
                                                        Ok(p) => {
                                                            tracing::warn!(signer = %p.machine_pk, conn = %peer_id, "pairing_set rejected: signer is not this connection (authority binding)");
                                                            None
                                                        }
                                                        Err(e) => {
                                                            tracing::warn!(err = %e, machine = %peer_id, "pairing_set rejected: signature verify failed");
                                                            None
                                                        }
                                                    }
                                                }
                                                _ => {
                                                    tracing::warn!(machine = %peer_id, "pairing_set rejected: bad base64 blob/sig");
                                                    None
                                                }
                                            }
                                        } else {
                                            tracing::warn!(machine = %peer_id, "pairing_set rejected: unsigned push (signed blob+sig required; design 01M23MKVG)");
                                            None
                                        };
                                    if let Some(owner_set) = owner_set {
                                        // Reconcile M's live subscribers = (who requested M) ∩
                                        // allowed: adds a subscribe-before-pairing owner now
                                        // that it is granted, drops a revoked one (design
                                        // 01M23Z6MK).
                                        rooms.reconcile_subscribers(&peer_id, &owner_set).await;
                                    }
                                }
                                "unsubscribe_rooms" => {
                                    rooms.unsubscribe(&peer_id, peers).await;
                                }
                                "rooms_check" => {
                                    for target_peer in &peers {
                                        // ROOMS gate (design 01M1ZE43): refuse to list an
                                        // unpaired machine's rooms. Routed + peer-attributed
                                        // (not a silent drop) so the app distinguishes
                                        // not-paired from offline.
                                        if !pairing.allows(target_peer, &peer_id) {
                                            let refusal = serde_json::json!({
                                                "type": "error",
                                                "code": "unknown_peer",
                                                "peer": target_peer,
                                            })
                                            .to_string();
                                            if sink.send(Message::Text(refusal)).await.is_err() {
                                                break 'routing;
                                            }
                                            continue;
                                        }
                                        let active_rooms = registry.rooms_of(target_peer);
                                        let resp = serde_json::json!({
                                            "type": "rooms",
                                            "peer": target_peer,
                                            "rooms": active_rooms,
                                        })
                                        .to_string();
                                        // Dedup per (conn, target_peer):
                                        // first reply always sent; subsequent
                                        // identical snapshots dropped.
                                        if last_rooms_resp.get(target_peer) == Some(&resp) {
                                            metrics.inc_rooms_suppressed(1);
                                            continue;
                                        }
                                        last_rooms_resp.insert(target_peer.clone(), resp.clone());
                                        if sink.send(Message::Text(resp)).await.is_err() {
                                            break 'routing;
                                        }
                                        metrics.inc_rooms_emitted(1);
                                    }
                                }

                                // ── room meta update (plano 18 + 28 + 32) ──
                                // `meta.model`, `meta.thinking` and
                                // `meta.working` are patched independently: a
                                // field absent from `meta` is *left alone* on
                                // the room (not cleared). For the nullable
                                // string fields, an explicit `null` clears
                                // them. `working` is a plain bool, so it only
                                // ever toggles — a non-bool/absent value leaves
                                // it untouched. Mirrors the JSON Merge Patch
                                // shape clients already produce.
                                "room_meta_update" => {
                                    let target_room = frame
                                        .get("room_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(&room_id)
                                        .to_string();
                                    let meta_obj = frame
                                        .get("meta")
                                        .and_then(|v| v.as_object());
                                    let model_patch = meta_obj
                                        .and_then(|m| m.get("model"))
                                        .map(|v| v.as_str().map(String::from));
                                    let thinking_patch = meta_obj
                                        .and_then(|m| m.get("thinking"))
                                        .map(|v| v.as_str().map(String::from));
                                    let name_patch = meta_obj
                                        .and_then(|m| m.get("name"))
                                        .map(|v| v.as_str().map(String::from));
                                    let working_patch = meta_obj
                                        .and_then(|m| m.get("working"))
                                        .and_then(|v| v.as_bool());
                                    // Subagent parentage (set-once in `extra`) so
                                    // a child can re-advertise a late-learned
                                    // parent without a re-announce.
                                    let parent_patch = meta_obj
                                        .and_then(|m| m.get("parent"))
                                        .and_then(|v| v.as_str())
                                        .map(String::from);
                                    let parent_session_patch = meta_obj
                                        .and_then(|m| m.get("parentSessionId"))
                                        .and_then(|v| v.as_str())
                                        .map(String::from);
                                    let patch = RoomMetaPatch {
                                        model: model_patch,
                                        thinking: thinking_patch,
                                        name: name_patch,
                                        working: working_patch,
                                        parent: parent_patch,
                                        parent_session_id: parent_session_patch,
                                    };
                                    if !registry
                                        .update_room_meta(&peer_id, &target_room, patch)
                                        .await
                                    {
                                        warn!(
                                            peer = %peer_short,
                                            room = %target_room,
                                            "room_meta_update for unknown (peer, room), dropping"
                                        );
                                    }
                                }

                                // ── Pi-to-Pi envelope forward (plano 25 W-A) ──
                                "pi_envelope" => {
                                    use crate::handlers::pi_forward::{
                                        PiForwardResult, handle_pi_envelope,
                                    };
                                    match handle_pi_envelope(
                                        &peer_id,
                                        &frame,
                                        &registry,
                                        mesh.clone(),
                                        mesh_auth.clone(),
                                    )
                                    .await
                                    {
                                        PiForwardResult::Forwarded => {}
                                        PiForwardResult::TransportError(err_msg) => {
                                            if sink.send(err_msg).await.is_err() {
                                                break;
                                            }
                                        }
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
                                // NOT a silent drop: refuse TO THE SENDER (the
                                // unknown_peer refusal pattern, 01M1ZE43) so an
                                // oversized/invalid envelope SURFACES instead of
                                // vanishing. payload_too_large is actionable — the
                                // peer can tell the user "message too large".
                                let code = if matches!(e, ParseError::TooLarge { .. }) {
                                    "payload_too_large"
                                } else {
                                    "invalid_envelope"
                                };
                                warn!(peer = %peer_short, err = %e, "invalid envelope, refused to sender");
                                let refusal = serde_json::json!({
                                    "type": "error",
                                    "code": code,
                                    "detail": e.to_string(),
                                })
                                .to_string();
                                if sink.send(Message::Text(refusal)).await.is_err() {
                                    break 'routing;
                                }
                            }
                            Ok(env) => {
                                let ct_len = env.ct.len();
                                let dest_peer = env.peer;
                                let dest_room = env.room;
                                // CONTENT GATE (design 01M1ZE43, fail-closed): forward
                                // only if the (machine, owner) relationship is in the
                                // allow-list — either direction, since the MACHINE's
                                // list authorizes both app→machine and machine→app.
                                // EXEMPT pairing frames (peek ct for pair_request /
                                // pair_ok) so pairing bootstraps before the
                                // relationship exists. Routed unknown_peer refusal so
                                // the app distinguishes not-paired from offline.
                                let paired = pairing.allows(&dest_peer, &peer_id)
                                    || pairing.allows(&peer_id, &dest_peer);
                                if !paired && !is_pair_envelope(&env.ct) {
                                    let refusal = serde_json::json!({
                                        "type": "error",
                                        "code": "unknown_peer",
                                        "peer": dest_peer,
                                    })
                                    .to_string();
                                    if sink.send(Message::Text(refusal)).await.is_err() {
                                        break 'routing;
                                    }
                                    continue;
                                }
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
                                // Skip-sender: pass our own conn_id so multi-device
                                // Owners don't echo their own outbound messages.
                                if !registry.forward(
                                    &dest_peer,
                                    &dest_room,
                                    Message::Text(fwd_line),
                                    conn_id,
                                ) {
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
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    registry.unregister(&peer_id, &room_id, conn_id).await;
    rooms.unsubscribe_all(&peer_id).await;
    info!(peer = %peer_short, room = %room_id, addr = %peer_addr, "disconnected");
}
