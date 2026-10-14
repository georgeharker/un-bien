mod common;
use common::{connect_and_auth, start_relay, start_relay_state};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

/// Peer A sends an OuterEnvelope addressed to peer B.
/// B receives a rewritten envelope where outer.peer = A (the sender),
/// not B (the original dest) — per protocol.md semantics.
#[tokio::test]
async fn two_peers_route_message() {
    let (port, pairing) = start_relay_state().await;
    let (mut ws_a, peer_a) = connect_and_auth(port).await;
    let (mut ws_b, peer_b) = connect_and_auth(port).await;

    // Pair A→B so the fail-closed content gate (design 01M1ZE43) permits the
    // forward. Configured IN-PROCESS — the sanctioned test path; the machine
    // pushes its allow-list over the wire only as a SIGNED frame now
    // (signed-only, design 01M23MKVG), which the pairing unit tests cover.
    pairing.set(peer_a.clone(), vec![peer_b.clone()]);

    let ct = "aGVsbG8="; // "hello" in base64, never decoded by relay
    // A sends: peer = dest (peer_b)
    ws_a.send(Message::text(json!({"peer": peer_b, "ct": ct}).to_string()))
        .await
        .unwrap();

    let received = tokio::time::timeout(tokio::time::Duration::from_secs(1), ws_b.next())
        .await
        .expect("timed out waiting for forwarded message")
        .unwrap()
        .unwrap();

    // B receives: peer = sender (peer_a), ct unchanged
    let received_json: serde_json::Value =
        serde_json::from_str(received.to_text().unwrap()).unwrap();
    assert_eq!(
        received_json["peer"], peer_a,
        "relay must rewrite peer to sender id"
    );
    assert_eq!(received_json["ct"], ct, "ct must be forwarded unchanged");
}

/// Sending to a dest the relay cannot authorize AT ALL (no local session,
/// no federated route, no advertised owner set) is REFUSED to the sender
/// with a routed `unknown_peer` error frame — federation v2 §3 STRICT: an
/// unknown dest owner set refuses ALL senders, no optimistic forwarding.
/// The connection stays alive. (The pre-slice-2 contract was a silent drop;
/// the routed refusal is what lets the app distinguish not-paired from
/// offline. A KNOWN federated machine with a dead ROOM still drops silently —
/// pinned by federation_test.rs's dead-room leg.)
#[tokio::test]
async fn dest_unknown_refused_to_sender() {
    let (port, pairing) = start_relay_state().await;
    let (mut ws_a, peer_a) = connect_and_auth(port).await;

    // Authorize the (offline) dest in the SENDER's own allow-list so the
    // first content gate PASSES and we exercise the SRC owner-set gate
    // (strict-unknown), not a pairing refusal. Configured in-process
    // (signed-only wire protocol is covered by the pairing tests).
    let dest = "bm9uZXhpc3RlbnRwZWVy".to_string();
    pairing.set(peer_a.clone(), vec![dest.clone()]);

    let envelope = json!({"peer": dest, "ct": "aGVsbG8="}).to_string();
    ws_a.send(Message::text(envelope)).await.unwrap();

    let refused = tokio::time::timeout(tokio::time::Duration::from_secs(1), ws_a.next())
        .await
        .expect("timed out waiting for the routed refusal")
        .unwrap()
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(refused.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["code"], "unknown_peer");
    assert_eq!(v["peer"], json!(dest), "the refusal names the dest");

    // The connection stays alive (no close frame follows the refusal).
    let alive = tokio::time::timeout(tokio::time::Duration::from_millis(200), ws_a.next()).await;
    assert!(
        alive.is_err(),
        "refusal must not close the sender, got {alive:?}"
    );
}

/** An envelope whose ct exceeds RELAY_MAX_CT_MIB is REFUSED TO THE SENDER with
 * a payload_too_large error frame (not a silent drop) and the connection stays
 * alive; an unparseable envelope gets invalid_envelope the same way. (Oversize
 * rides the 16 MiB default after the backfill raise.) */
#[tokio::test]
async fn oversized_ct_refused_to_sender() {
    let (port, _pairing) = start_relay_state().await;
    let (mut ws_a, peer_a) = connect_and_auth(port).await;

    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
    // 20 MiB decoded payload → over the 16 MiB default cap.
    let ct = B64.encode(vec![0u8; 20 * 1024 * 1024]);
    ws_a.send(Message::text(json!({"peer": peer_a, "ct": ct}).to_string()))
        .await
        .unwrap();

    let refused = tokio::time::timeout(tokio::time::Duration::from_secs(1), ws_a.next())
        .await
        .expect("timed out waiting for refusal")
        .unwrap()
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(refused.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["code"], "payload_too_large");

    // Unparseable envelope → invalid_envelope, same refusal story.
    ws_a.send(Message::text("this is not json".to_string()))
        .await
        .unwrap();
    let refused2 = tokio::time::timeout(tokio::time::Duration::from_secs(1), ws_a.next())
        .await
        .expect("timed out waiting for refusal 2")
        .unwrap()
        .unwrap();
    let v2: serde_json::Value = serde_json::from_str(refused2.to_text().unwrap()).unwrap();
    assert_eq!(v2["code"], "invalid_envelope");
}

/// A client that sends an invalid signature must have its WS closed within 100 ms.
#[tokio::test]
async fn invalid_sig_closes_ws() {
    let port = start_relay().await;
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
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
    let v: serde_json::Value = serde_json::from_str(challenge_msg.to_text().unwrap()).unwrap();
    assert_eq!(v["type"], "challenge");

    // send all-zero signature (invalid)
    ws.send(Message::text(
        json!({"type": "auth", "sig": B64.encode([0u8; 64])}).to_string(),
    ))
    .await
    .unwrap();

    // relay must close within 100 ms
    let close_result =
        tokio::time::timeout(tokio::time::Duration::from_millis(100), ws.next()).await;

    assert!(
        close_result.is_ok(),
        "relay did not close the connection within 100 ms"
    );
    match close_result.unwrap() {
        None | Some(Ok(Message::Close(_))) | Some(Err(_)) => {} // all acceptable
        Some(Ok(other)) => panic!("unexpected message after bad auth: {other:?}"),
    }
}
