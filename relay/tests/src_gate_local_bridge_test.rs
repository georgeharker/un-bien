//! The 2026-10-31 production gap ("not paired", intermittently): a phone
//! sending to a SAME-RELAY machine in a room the machine is not registered
//! in (stale room id in the app, reconnect window) misses
//! `registry.forward` and falls into the federated fallback — where the
//! §3 SRC gate runs. The gate reads ONLY the federated owner-set view
//! (`FederatedSessions::machine_owners`), which — before the fix — was fed
//! exclusively by the peering exchange. A locally-paired machine read
//! `dest_owners_known=false` and the gate REFUSED a paired sender with
//! unknown_peer; the app renders that as "not paired".
//!
//! Fixed by the local bridge: every locally-verified pairing_set push also
//! lands in the federated view (`learn_local_machine_pairing`), so the
//! strict gate has the same machine-signed truth the local gates hold.
//! Strictness is preserved: a machine that never pushed a pairing_set is
//! still refused (strict-on-unknown) — that refusal is pinned here too.

mod common;

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use common::{connect_and_auth_with_room, next_non_handshake, start_relay_state};

/// A machine-signed pairing_set push frame — the exact wire shape the
/// extension sends on (re)connect: {type, blob, sig} with the blob a
/// JSON {machine_pk, owners, version, issued_at} signed by the machine.
fn signed_pairing_push(machine: &SigningKey, owners: &[String], version: u64) -> Value {
    let machine_pk = B64.encode(machine.verifying_key().to_bytes());
    let blob = serde_json::to_vec(&json!({
        "machine_pk": machine_pk,
        "owners": owners,
        "version": version,
        "issued_at": 1u64,
    }))
    .unwrap();
    let sig = machine.sign(&blob);
    json!({
        "type": "pairing_set",
        "blob": B64.encode(&blob),
        "sig": B64.encode(sig.to_bytes()),
    })
}

/// The room-miss repro: phone → machine at a (peer, room) with no live
/// connection. This is the frame that took the SRC-gate path in production
/// (relay 0.8.6, cascade) and was refused with dest_owners_known=false.
fn room_miss_envelope(machine_epk: &str, room: &str) -> Value {
    json!({
        "peer": machine_epk,
        "room": room,
        "ct": "ZUN0", // base64 of opaque non-pair plaintext; is_pair_envelope → false
    })
}

/// THE GAP, end to end: the machine's locally-pushed pairing_set must clear
/// the SRC gate for the paired phone, so a same-relay room miss drops
/// ("dest not found") instead of refusing a paired sender with
/// unknown_peer ("not paired"). The live-room delivery in the same stream
/// proves the wiring; the phone's socket must hold no error frame.
#[tokio::test]
async fn same_relay_room_miss_no_longer_refuses_a_paired_phone() {
    let (port, _pairing) = start_relay_state().await;
    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let phone_sk = SigningKey::generate(&mut rand::thread_rng());
    let machine_epk = B64.encode(machine_sk.verifying_key().to_bytes());
    let phone_epk = B64.encode(phone_sk.verifying_key().to_bytes());

    // Machine connects (its real room) and pushes its SIGNED allow-list —
    // exactly the production flow (the log's "pairing_set: stored SIGNED
    // allow-list machine=5lF+Lxp4...").
    let (mut machine_ws, _) = connect_and_auth_with_room(port, &machine_sk, "machine-room").await;
    machine_ws
        .send(Message::text(
            signed_pairing_push(&machine_sk, std::slice::from_ref(&phone_epk), 1).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await; // let the relay store + bridge it

    // Phone connects — it IS paired (the machine's allow-list names it).
    let (mut phone_ws, _) = connect_and_auth_with_room(port, &phone_sk, "app-room").await;

    // THE REPRO: a room the machine is NOT registered in. Local delivery
    // misses → the federated fallback → the §3 SRC gate. Before the bridge:
    // unknown_peer ("not paired"). After: the gate passes and the miss
    // drops (warn "dest (peer, room) not found") — the phone hears NOTHING.
    phone_ws
        .send(Message::text(
            room_miss_envelope(&machine_epk, "gone-room").to_string(),
        ))
        .await
        .unwrap();

    // Positive control in the SAME stream: a delivery to the room the
    // machine IS in must arrive — proving the refusal (if any) came from
    // the gate, not a broken pipeline.
    phone_ws
        .send(Message::text(
            room_miss_envelope(&machine_epk, "machine-room").to_string(),
        ))
        .await
        .unwrap();
    let delivered = next_non_handshake(&mut machine_ws).await;
    assert_eq!(delivered["ct"], "ZUN0", "the live-room envelope arrives");
    assert_eq!(
        delivered["peer"], phone_epk,
        "rewritten to the sender's epk"
    );

    // The phone's socket must hold NO error frame (bounded drain: the
    // pre-fix refusal would have been queued BEFORE the machine's delivery;
    // a clean timeout — or a socket close with no refusal — is the pass).
    let refusal = tokio::time::timeout(Duration::from_millis(400), async {
        while let Some(Ok(msg)) = phone_ws.next().await {
            let Ok(text) = msg.to_text() else {
                continue;
            };
            if let Ok(v) = serde_json::from_str::<Value>(text) {
                if v["type"] == "error" {
                    return v;
                }
            }
        }
        Value::Null // socket closed — no refusal
    })
    .await;
    match refusal {
        Err(_) => { /* clean timeout: nothing was ever queued */ }
        Ok(v) => {
            assert!(v.is_null(), "no error frame may reach the phone: got {v}");
        }
    }
}

/// STRICT-ON-UNKNOWN preserved (the reason this is a bridge, not a gate
/// exemption): a machine that never pushed a pairing_set stays UNKNOWN to
/// the §3 gate — the room-miss sender is refused unknown_peer even though
/// an (unsigned, test-only) local allow-list entry let it past the
/// CONTENT gate. This is the production refusal shape, deliberately kept.
#[tokio::test]
async fn unknown_machine_still_refuses_strict_on_unknown() {
    let (port, pairing) = start_relay_state().await;
    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let phone_sk = SigningKey::generate(&mut rand::thread_rng());
    let machine_epk = B64.encode(machine_sk.verifying_key().to_bytes());
    let phone_epk = B64.encode(phone_sk.verifying_key().to_bytes());

    // Machine connects but NEVER pushes a pairing_set — dest_owners unknown.
    let (_machine_ws, _) = connect_and_auth_with_room(port, &machine_sk, "machine-room").await;

    // Test-only local allow-list entry so the CONTENT gate passes and the
    // frame reaches the SRC gate (the path under test).
    pairing.set(machine_epk.clone(), vec![phone_epk]);

    let (mut phone_ws, _) = connect_and_auth_with_room(port, &phone_sk, "app-room").await;
    phone_ws
        .send(Message::text(
            room_miss_envelope(&machine_epk, "any-room").to_string(),
        ))
        .await
        .unwrap();

    let refusal = next_non_handshake(&mut phone_ws).await;
    assert_eq!(refusal["type"], "error", "the SRC gate refuses");
    assert_eq!(refusal["code"], "unknown_peer", "strict on unknown");
    assert_eq!(
        refusal["peer"], machine_epk,
        "routed refusal names the dest"
    );
}
