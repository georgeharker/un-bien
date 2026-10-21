//! Federated-peering integration tests — TWO real in-process relays, real
//! WS peering between them, a machine on relay B and an app client on relay
//! A. Pins the cross-relay flows that single-relay tests cannot see:
//! request leg (app→machine), learned-route reply leg (machine→app).
//!
//! Each test is self-contained because `cargo test` runs files concurrently:
//! every test uses the same UNBIEN_STATE_DIR (idempotent writes, same value)
//! and its own temp relay-peers.json contents. The peering loop and the
//! auth'd WS clients are real; only the mesh blob upload piggybacks on the
//! /mesh HTTP endpoint.
//!
//! The STATE_LOCK guard is DELIBERATELY held across every await in a test —
//! that is the serialization — so the pedantic await-holding-lock lint is
//! off.
#![allow(clippy::await_holding_lock)]

mod common;

use common::{
    WsStream, connect_and_auth, connect_and_auth_with_key, connect_and_auth_with_room,
    spawn_relay_named,
};
use std::sync::Mutex;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;

/// UNBIEN_STATE_DIR is process-global and every test here both sets it and
/// resolves the relay keypair + relay-peers.json through it — the tests in
/// this file MUST NOT interleave (a flipped env mid-handshake would make a
/// relay present a key the other side never pinned).
static STATE_LOCK: Mutex<()> = Mutex::new(());

fn owner_pk_hash(pk: &[u8]) -> String {
    let d = Sha256::digest(pk);
    hex(&d)
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

/// Publishes the SAME owner mesh blob to both relays (shared owner = the
/// peering trust root) via the /mesh endpoint. Returns the owner pk b64.
async fn publish_shared_owner(
    owner: &SigningKey,
    member_epks: &[String],
    base_a: &str,
    base_b: &str,
) -> String {
    let owner_pk_b64 = B64.encode(owner.verifying_key().to_bytes());
    let members: Vec<Value> = member_epks
        .iter()
        .map(|remote_epk| {
            json!({
                "remote_epk": remote_epk,
                "relay_url": base_a,
                "paired_at": "2025-01-01T00:00:00.000Z",
            })
        })
        .collect();
    let blob = json!({
        "owner_pk": owner_pk_b64,
        "version": 1,
        "members": members,
        "issued_at": 1_700_000_000_000_u64,
    });
    let blob_bytes = serde_json::to_vec(&blob).unwrap();
    let sig = owner.sign(&blob_bytes);
    let envelope = json!({
        "blob": B64.encode(&blob_bytes),
        "sig": B64.encode(sig.to_bytes()),
    });
    let hash = owner_pk_hash(owner.verifying_key().as_bytes());
    let client = reqwest::Client::new();
    for base in [base_a, base_b] {
        let r = client
            .post(format!("{base}/mesh/{hash}"))
            .json(&envelope)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "mesh publish failed on {base}");
    }
    owner_pk_b64
}

/// Hermetic state dir + pinned peer config (federation v2: the link gate is
/// the PIN — the peering trust root is the relay identity keypair, not the
/// shared owner). `pinned_pk` is the relay's own Ed25519 pubkey (in-process
/// relays share the state dir, hence the keypair).
fn state_dir_setup(peer_b_url: &str, pinned_pk: &str) {
    let dir = std::env::var("UNBIEN_STATE_DIR").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        std::path::Path::new(&dir).join("relay-peers.json"),
        json!({
            "federation": {"enabled": true},
            "peers": [
                {"name": "relay-b", "url": peer_b_url, "pubkey": pinned_pk}
            ]
        })
        .to_string(),
    )
    .unwrap();
}

fn outer_frame(peer: &str, room: &str, inner: &Value) -> String {
    format!(
        "{}",
        json!({
            "peer": peer,
            "room": room,
            "ct": B64.encode(serde_json::to_vec(inner).unwrap()),
        })
    )
}

/// Next non-pong text frame the given ws receives.
async fn next_text(ws: &mut WsStream) -> Option<String> {
    while let Ok(Some(m)) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
        let t = match m.ok()? {
            Message::Text(t) => t,
            Message::Pong(_) | Message::Ping(_) => continue,
            _ => return None,
        };
        let wire: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
        // Skip relay control frames (typed) — outer routed envelopes are untyped.
        if wire.get("type").is_some() {
            continue;
        }
        return Some(t.to_string());
    }
    None
}

/// Next text frame INCLUDING typed frames (refusals are typed; next_text
/// skips them).
async fn next_any_text(ws: &mut WsStream) -> Option<String> {
    while let Ok(Some(m)) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
        match m.ok()? {
            Message::Text(t) => return Some(t.to_string()),
            Message::Pong(_) | Message::Ping(_) => continue,
            _ => return None,
        }
    }
    None
}
fn inner_of(outer_wire: &str) -> Value {
    let outer: Value = serde_json::from_str(outer_wire).unwrap();
    let ct = outer["ct"].as_str().unwrap();
    serde_json::from_slice(&B64.decode(ct).unwrap()).unwrap()
}

/// THE end-to-end test: app on relay A talks to a machine on relay B and the
/// machine's REPLIES reach the app (request leg + learned-route reply leg —
/// the route is learned in transit, from the request packet's provenance).
#[tokio::test]
async fn app_request_and_machine_reply_cross_two_relays() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .with_test_writer()
        .try_init();
    // HERMETIC STATE DIR FIRST: everything later (relay-peers.json, the
    // hello keypair) resolves inside this tempdir — never the user's real
    // ~/.local/state/un-bien.
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;
    let owner = SigningKey::generate(&mut rand::thread_rng());

    // Machine on B, app on A (each with its own key → distinct epks).
    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut machine, machine_epk) = connect_and_auth_with_key(relay_b.port, &machine_sk).await;
    let (mut app, app_epk) = connect_and_auth_with_key(relay_a.port, &app_sk).await;

    // Membership: the owner blob names BOTH epks — the rig installs the epks
    // it intends to use (pairing is per-relay; membership is owner-signed
    // and shared across both relays).
    publish_shared_owner(
        &owner,
        &[machine_epk.clone(), app_epk.clone()],
        &format!("http://127.0.0.1:{}", relay_a.port),
        &format!("http://127.0.0.1:{}", relay_b.port),
    )
    .await;

    // Pairing on B: the machine's allow-list names the app (the reply leg's
    // content gate — either direction) — the fail-closed grant, as a real
    // pairing_set push would establish.
    relay_b
        .state
        .pairing
        .set(machine_epk.clone(), vec![app_epk.clone()]);

    // Strict pairing world: the machine pushes its machine-SIGNED pairing_set
    // to relay B (owners = [app, owner] — the app device it serves + the
    // shared human owner, the same shape the real extension pushes). The
    // handshake then exchanges it and the source relay's §3 owner-set gate
    // forwards the app's requests.
    let owner_pk_b64 = B64.encode(owner.verifying_key().to_bytes());
    {
        let machine_pk = B64.encode(machine_sk.verifying_key().to_bytes());
        let owners = vec![app_epk.clone(), owner_pk_b64.clone()];
        let blob_bytes = serde_json::to_vec(&json!({
            "machine_pk": machine_pk,
            "owners": owners,
            "version": 1,
            "issued_at": 1_700_000_000_000u64,
        }))
        .unwrap();
        let sig = machine_sk.sign(&blob_bytes);
        relay_b
            .state
            .pairing
            .set_signed(machine_epk.clone(), owners, 1, &blob_bytes, &sig.to_bytes())
            .expect("e2e machine pairing push");
    }

    // Owner-set gates are strict on BOTH sides (federation v2 §3): the
    // machine→app REPLY leg is decided at relay B, whose §3 gate needs the
    // APP's advertised owner set too. The rig therefore pushes the app's
    // machine-SIGNED pairing_set to relay A (owners = [owner] — the app
    // declares the owner it belongs to, exactly as a paired device would),
    // so A's handshake exchange advertises it and B's gate sees the
    // sender-owner ∩ dest-owner intersection (the owner) ≠ ∅.
    {
        let app_pk = B64.encode(app_sk.verifying_key().to_bytes());
        let owners = vec![owner_pk_b64];
        let blob_bytes = serde_json::to_vec(&json!({
            "machine_pk": app_pk,
            "owners": owners,
            "version": 1,
            "issued_at": 1_700_000_000_000u64,
        }))
        .unwrap();
        let sig = app_sk.sign(&blob_bytes);
        relay_a
            .state
            .pairing
            .set_signed(app_epk.clone(), owners, 1, &blob_bytes, &sig.to_bytes())
            .expect("e2e app pairing push");
    }

    // Peering: A connects out to B (same mechanism as production: config file
    // + start_peering). Machine rooms must already exist on B for the
    // handshake exchange to carry them. The pin is the STRICT GATE
    // (federation v2 §1): both in-process relays share the state dir, so
    // the identity keypair is shared — pre-create it so the pin is the key
    // the handshake actually presents.
    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    relay::peering::start_peering(
        relay_a.state.mesh.clone(),
        relay_a.state.registry.clone(),
        relay_a.state.pairing.clone(),
        relay_a.state.federated.clone(),
    );

    // Wait for A to learn B's rooms (request-leg federated gate on A).
    let mut learned = false;
    for _ in 0..50 {
        if relay_a.state.federated.has_federated_sessions().await {
            learned = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(learned, "relay A never learned relay B's federated rooms");

    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "s1"}});
    let reply_payload = json!({"type": "ub", "reply": true, "request_id": "s1"});

    // ── Request leg: app (A) → machine (B) ──
    app.send(Message::text(outer_frame(&machine_epk, "main", &payload)))
        .await
        .unwrap();
    let got = next_text(&mut machine)
        .await
        .expect("machine got no request");
    let forward: Value = serde_json::from_str(&got).unwrap();
    assert_eq!(
        forward["peer"],
        Value::String(app_epk.clone()),
        "machine must see the app as sender"
    );
    assert_eq!(inner_of(&got), payload, "request inner must round-trip");

    // ── Reply leg: machine (B) → app (A) — learned route in action ──
    machine
        .send(Message::text(outer_frame(&app_epk, "main", &reply_payload)))
        .await
        .unwrap();
    let got = next_text(&mut app)
        .await
        .expect("app got no reply (learned route failed)");
    let reply: Value = serde_json::from_str(&got).unwrap();
    assert_eq!(
        reply["peer"],
        Value::String(machine_epk.clone()),
        "app must see the machine as sender"
    );
    assert_eq!(inner_of(&got), reply_payload, "reply inner must round-trip");

    // ── Stream leg: continued machine→app frames (live deltas) ride the same
    // learned route (the session stream after attach).
    for i in 0..3 {
        let frame = outer_frame(&app_epk, "main", &json!({"type": "ub", "delta": i}));
        machine.send(Message::text(frame)).await.unwrap();
        let got = next_text(&mut app).await.expect("app lost the stream");
        assert_eq!(inner_of(&got)["delta"], json!(i));
    }

    // ── Dead-room attach: a session/room address the machine does NOT host
    // is DROPPED SILENTLY (the established contract, dest_offline_drops
    // _silently) — the spinner problem is prevented APP-SIDE: the app knows
    // the live federated rooms (federated_peer_list) and must not attempt a
    // backfill against a room that isn't in that set. Assert the drop is
    // silent and the connection stays alive.
    app.send(Message::text(outer_frame(
        &machine_epk,
        "dead-room-xyz",
        &json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "dead"}}),
    )))
    .await
    .unwrap();
    let result = tokio::time::timeout(Duration::from_millis(1500), app.next()).await;
    assert!(
        result.is_err(),
        "dead-room attach must be dropped silently, got {result:?}"
    );
}

/// Check-before-forward + federated pairing exchange (design: the relay
/// receives for all federated targets + self, checks the dest machine's
/// ADVERTISED owner set before forwarding, dest decides on arrival):
/// 1. machine on B declares pairing (owners = [app]) — the handshake
///    propagates the set to relay A's federated view.
/// 2. app (an owner) on A sends → forwarded (dest machine receives).
/// 3. a STRANGER on A sends → refused AT THE SOURCE (unknown_peer error
///    frame), machine receives nothing.
#[tokio::test]
async fn federated_pairing_exchange_and_source_refusal() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;
    let owner = SigningKey::generate(&mut rand::thread_rng());

    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_sk = SigningKey::generate(&mut rand::thread_rng());
    let stranger_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut machine, machine_epk) = connect_and_auth_with_key(relay_b.port, &machine_sk).await;
    let (mut app, app_epk) = connect_and_auth_with_key(relay_a.port, &app_sk).await;
    let (mut stranger, stranger_epk) = connect_and_auth_with_key(relay_a.port, &stranger_sk).await;

    publish_shared_owner(
        &owner,
        &[machine_epk.clone(), app_epk.clone(), stranger_epk.clone()],
        &format!("http://127.0.0.1:{}", relay_a.port),
        &format!("http://127.0.0.1:{}", relay_b.port),
    )
    .await;

    // Machine declares its pairing on relay B: owners = [app] ONLY.
    {
        let mkey = machine_sk.verifying_key().to_bytes();
        let b64u = |b: &[u8]| B64.encode(b);
        let _ = &mkey;
        let owners = vec![app_epk.clone()];
        let blob = json!({
            "machine_pk": b64u(&mkey),
            "owners": owners,
            "version": 1,
            "issued_at": 1_700_000_000_000u64,
        });
        let blob_bytes = serde_json::to_vec(&blob).unwrap();
        let sig = machine_sk.sign(&blob_bytes);
        relay_b
            .state
            .pairing
            .set_signed(machine_epk.clone(), owners, 1, &blob_bytes, &sig.to_bytes())
            .expect("machine pairing set (v1)");
    }

    // Peering: A connects out to B (handshake exchanges room lists AND the
    // pairing snapshot). The pin is the strict gate — pre-create the shared
    // identity keypair so the pin matches what the handshake presents.
    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    relay::peering::start_peering(
        relay_a.state.mesh.clone(),
        relay_a.state.registry.clone(),
        relay_a.state.pairing.clone(),
        relay_a.state.federated.clone(),
    );

    // Leg 1: the owner set propagated to A's federated view.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let learned = loop {
        if tokio::time::Instant::now() >= deadline {
            break false;
        }
        if let Some(owners) = relay_a.state.federated.machine_owners(&machine_epk).await
            && owners.contains(&app_epk)
        {
            break true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(
        learned,
        "relay A never learned the machine's advertised owner set"
    );

    // Leg 1b: the signed peer-pairing docs were exchanged AND verified —
    // relay A holds B's (or the shared rig key's) doc naming relay A
    // (relay-pairing protocol: paired = both sides hold docs naming each
    // other; strict declination lands with peer management).
    assert!(
        relay_a.state.federated.paired_by_any_doc("relay-a").await,
        "relay A holds no verified peer-pairing doc naming itself"
    );

    // Leg 2: an owner forwards; the dest machine receives.
    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "s1"}});
    app.send(Message::text(outer_frame(&machine_epk, "main", &payload)))
        .await
        .unwrap();
    let got = next_text(&mut machine)
        .await
        .expect("owner forward blocked");
    assert_eq!(inner_of(&got), payload);

    // Leg 3: a STRANGER is refused AT THE SOURCE; the machine gets nothing.
    stranger
        .send(Message::text(outer_frame(
            &machine_epk,
            "main",
            &json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "bad"}}),
        )))
        .await
        .unwrap();
    // Refusal hunt: skip typed control frames (federated_peer_list broadcasts
    // fire on connect/room churn) until the error frame arrives.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut err: Option<Value> = None;
    while tokio::time::Instant::now() < deadline {
        let Some(text) = next_any_text(&mut stranger).await else {
            break;
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if v["type"] == "error" {
            err = Some(v);
            break;
        }
    }
    let err = err.expect("stranger got no refusal");
    assert_eq!(err["code"], "unknown_peer");
    assert_eq!(err["peer"], json!(machine_epk));
    // The machine hears nothing for the stranger's span.
    let quiet = tokio::time::timeout(Duration::from_millis(800), next_text(&mut machine)).await;
    assert!(quiet.is_err(), "machine must NOT receive stranger traffic");
}

// ── Federation v2 slice 2 — owner-set content gates (§3), pinned e2e ──────
//
// One rule over MACHINE-SIGNED owner sets, decided at the SOURCE relay only,
// strict on unknown: sender-owner ∩ target-owner ≠ ∅. Below, the agent
// plane (pi_envelope) and the outer plane (app→machine envelopes) each get
// an intersection-allow case, a cross-owner refusal, and a strict-unknown
// refusal. NO machine exemptions: a machine IS its owner set.

/// Push a machine-SIGNED pairing_set IN-PROCESS (the sanctioned rig path —
/// the wire push is signed-only and covered by the pairing tests): the same
/// blob shape the extension signs, stored via set_signed so the peering
/// handshake advertises it to the peer relay.
fn push_signed_pairing(
    sk: &SigningKey,
    machine_epk: &str,
    owners: Vec<String>,
    version: u64,
    registry: &relay::PairingRegistry,
) {
    let blob_bytes = serde_json::to_vec(&json!({
        "machine_pk": B64.encode(sk.verifying_key().to_bytes()),
        "owners": owners,
        "version": version,
        "issued_at": 1_700_000_000_000u64,
    }))
    .unwrap();
    let sig = sk.sign(&blob_bytes);
    registry
        .set_signed(
            machine_epk.to_string(),
            owners,
            version,
            &blob_bytes,
            &sig.to_bytes(),
        )
        .expect("rig pairing push");
}

/// Start relay A's peering loop (A dials B, pinned on the shared in-process
/// identity keypair — federation v2 §1's gate; §3's owner sets are CONTENT
/// data, not link data).
fn start_peering_on(relay_a: &common::TestRelay) {
    relay::peering::start_peering(
        relay_a.state.mesh.clone(),
        relay_a.state.registry.clone(),
        relay_a.state.pairing.clone(),
        relay_a.state.federated.clone(),
    );
}

/// A fresh random keypair's pubkey b64 (owner/device keys for the signed
/// sets — opaque epk material to the relay).
fn fresh_epk() -> String {
    B64.encode(
        SigningKey::generate(&mut rand::thread_rng())
            .verifying_key()
            .to_bytes(),
    )
}

/// Send a pi_envelope frame; returns the envelope sent (for verbatim checks).
async fn send_pi_envelope(ws: &mut WsStream, to_pc: &str, id: &str) -> Value {
    let envelope = json!({
        "from": "source:agent",
        "to": "target:agent",
        "id": id,
        "re": null,
        "body": { "type": "ping" },
    });
    ws.send(Message::text(
        json!({
            "type": "pi_envelope",
            "to_pc": to_pc,
            "envelope": envelope,
        })
        .to_string(),
    ))
    .await
    .unwrap();
    envelope
}

/// Hunt typed AND untyped frames until `probe` hits (5 s deadline). Typed
/// control traffic (federated_peer_list churn, presence) is skipped by the
/// probe, not by the transport.
async fn next_matching<T>(ws: &mut WsStream, what: &str, probe: impl Fn(&Value) -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        let Some(text) = next_any_text(ws).await else {
            break;
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if let Some(hit) = probe(&v) {
            return hit;
        }
    }
    panic!("never received {what}");
}

/// Assert NO frame matching `probe` arrives within the span (typed control
/// frames are permitted through — the probe decides what counts).
async fn assert_never_matches(ws: &mut WsStream, what: &str, probe: impl Fn(&Value) -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
    while tokio::time::Instant::now() < deadline {
        let Some(text) = next_any_text(ws).await else {
            return; // transport idle for 5 s — quiet
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        assert!(!probe(&v), "{what} MUST NOT arrive, got: {v}");
    }
}

/// AGENT PLANE — shared owner in both machine-signed sets ⇒ forwarded
/// cross-relay. Sender pi on A and target pi on B both advertise owner O;
/// the pi_envelope crosses and arrives verbatim as pi_envelope_in.
#[tokio::test]
async fn pi_envelope_owner_intersection_forwards_cross_relay() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;

    let shared_owner = fresh_epk();
    let sender_sk = SigningKey::generate(&mut rand::thread_rng());
    let target_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut sender, sender_epk) = connect_and_auth_with_key(relay_a.port, &sender_sk).await;
    let (mut target, target_epk) = connect_and_auth_with_key(relay_b.port, &target_sk).await;

    // Both machines' SIGNED sets name the SAME owner — the §3 intersection.
    push_signed_pairing(
        &sender_sk,
        &sender_epk,
        vec![shared_owner.clone()],
        1,
        &relay_a.state.pairing,
    );
    push_signed_pairing(
        &target_sk,
        &target_epk,
        vec![shared_owner],
        1,
        &relay_b.state.pairing,
    );

    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    start_peering_on(&relay_a);

    // Strict gate: A must know the TARGET's advertised set before deciding.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if relay_a
            .state
            .federated
            .machine_owners(&target_epk)
            .await
            .is_some()
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "relay A never learned the target's advertised owner set"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let envelope = send_pi_envelope(
        &mut sender,
        &target_epk,
        "00000000-0000-4000-8000-0000000000f1",
    )
    .await;
    let frame = next_matching(&mut target, "pi_envelope_in at the target", |v| {
        (v["type"] == "pi_envelope_in" && v["from_pc"] == json!(sender_epk)).then(|| v.clone())
    })
    .await;
    assert_eq!(
        frame["envelope"], envelope,
        "envelope must round-trip verbatim"
    );
}

/// AGENT PLANE — cross-owner refusal: the sender machine's owner set and the
/// target's advertised set are DISJOINT ⇒ refused AT THE SOURCE with
/// not_authorized (the old federated branch authorized any local member).
#[tokio::test]
async fn pi_envelope_cross_owner_refused_at_source() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;

    let sender_sk = SigningKey::generate(&mut rand::thread_rng());
    let target_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut sender, sender_epk) = connect_and_auth_with_key(relay_a.port, &sender_sk).await;
    let (mut target, target_epk) = connect_and_auth_with_key(relay_b.port, &target_sk).await;

    // DISJOINT signed sets: sender belongs to owner S, target to owner T.
    push_signed_pairing(
        &sender_sk,
        &sender_epk,
        vec![fresh_epk()],
        1,
        &relay_a.state.pairing,
    );
    push_signed_pairing(
        &target_sk,
        &target_epk,
        vec![fresh_epk()],
        1,
        &relay_b.state.pairing,
    );

    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    start_peering_on(&relay_a);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if relay_a
            .state
            .federated
            .machine_owners(&target_epk)
            .await
            .is_some()
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "relay A never learned the target's advertised owner set"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    send_pi_envelope(
        &mut sender,
        &target_epk,
        "00000000-0000-4000-8000-0000000000f2",
    )
    .await;
    let err = next_matching(&mut sender, "not_authorized transport error", |v| {
        (v["type"] == "pi_envelope_in" && v["envelope"]["body"]["reason"] == "not_authorized")
            .then(|| v.clone())
    })
    .await;
    assert_eq!(err["from_pc"], "_relay");
    assert_eq!(
        err["envelope"]["re"],
        "00000000-0000-4000-8000-0000000000f2"
    );
    // The target hears nothing.
    assert_never_matches(&mut target, "cross-owner pi_envelope", |v| {
        v["type"] == "pi_envelope_in" && v["from_pc"] == json!(sender_epk)
    })
    .await;
}

/// AGENT PLANE — strict-unknown: the target's owner set was never exchanged
/// (target machine pushed NO pairing_set) ⇒ refused, even though the sender
/// is a fully valid local machine with its own signed set.
#[tokio::test]
async fn pi_envelope_strict_unknown_target_refused() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;

    let sender_sk = SigningKey::generate(&mut rand::thread_rng());
    let target_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut sender, _sender_epk) = connect_and_auth_with_key(relay_a.port, &sender_sk).await;
    let (mut target, target_epk) = connect_and_auth_with_key(relay_b.port, &target_sk).await;

    // Sender has a KNOWN signed owner set; the target advertises NOTHING.
    push_signed_pairing(
        &sender_sk,
        &_sender_epk,
        vec![fresh_epk()],
        1,
        &relay_a.state.pairing,
    );

    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    start_peering_on(&relay_a);

    // The target's ROOM is announced (it is a federated target), but its
    // owner set never lands — the strict-unknown state.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if !relay_a
            .state
            .federated
            .rooms_for_epk(&target_epk)
            .await
            .is_empty()
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "relay A never learned the target's room"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        relay_a
            .state
            .federated
            .machine_owners(&target_epk)
            .await
            .is_none(),
        "rig setup error: the target's owner set IS known"
    );

    send_pi_envelope(
        &mut sender,
        &target_epk,
        "00000000-0000-4000-8000-0000000000f3",
    )
    .await;
    let err = next_matching(
        &mut sender,
        "not_authorized transport error (strict-unknown)",
        |v| {
            (v["type"] == "pi_envelope_in" && v["envelope"]["body"]["reason"] == "not_authorized")
                .then(|| v.clone())
        },
    )
    .await;
    assert_eq!(
        err["envelope"]["re"],
        "00000000-0000-4000-8000-0000000000f3"
    );
    assert_never_matches(&mut target, "strict-unknown pi_envelope", |v| {
        v["type"] == "pi_envelope_in"
    })
    .await;
}

/// OUTER PLANE — strict-unknown refuses ALL senders: a dest whose owner set
/// was never exchanged is refused for an owner-device app AND for a machine
/// sender (the retired machine exemption), each with a routed unknown_peer.
#[tokio::test]
async fn outer_unknown_dest_owner_set_refused_for_all_senders() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;

    let target_sk = SigningKey::generate(&mut rand::thread_rng());
    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut target, target_epk) = connect_and_auth_with_key(relay_b.port, &target_sk).await;
    let (mut machine, machine_epk) = connect_and_auth_with_key(relay_a.port, &machine_sk).await;
    let (mut app, _app_epk) = connect_and_auth_with_key(relay_a.port, &app_sk).await;

    // The target machine advertises NOTHING (strict-unknown); the sender
    // machine has its own signed set — no exemption.
    push_signed_pairing(
        &machine_sk,
        &machine_epk,
        vec![fresh_epk()],
        1,
        &relay_a.state.pairing,
    );

    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    start_peering_on(&relay_a);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if !relay_a
            .state
            .federated
            .rooms_for_epk(&target_epk)
            .await
            .is_empty()
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "relay A never learned the target's room"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "x"}});

    // Owner-device app sender: routed refusal.
    app.send(Message::text(outer_frame(&target_epk, "main", &payload)))
        .await
        .unwrap();
    let err = next_matching(&mut app, "app routed refusal", |v| {
        (v["type"] == "error" && v["code"] == "unknown_peer").then(|| v.clone())
    })
    .await;
    assert_eq!(err["peer"], json!(target_epk));

    // MACHINE sender: same routed refusal — the exemption is gone.
    machine
        .send(Message::text(outer_frame(&target_epk, "main", &payload)))
        .await
        .unwrap();
    let err = next_matching(&mut machine, "machine sender routed refusal", |v| {
        (v["type"] == "error" && v["code"] == "unknown_peer").then(|| v.clone())
    })
    .await;
    assert_eq!(err["peer"], json!(target_epk));

    assert_never_matches(&mut target, "strict-unknown outer frame", |v| {
        // Handshake/control frames are permitted: federated_peer_list (control),
        // routed refusals (error), and identity_ack (P7 post-auth handshake —
        // every device connection receives one BEFORE any routing exists).
        let t = v["type"].as_str().unwrap_or("");
        t != "federated_peer_list" && t != "error" && t != "identity_ack"
    })
    .await;
}

/// OUTER PLANE — owner-device send: in-set ⇒ forwarded, out-of-set ⇒ routed
/// refusal. The out-of-set app is a KNOWN owner device (another machine's
/// signed set names it) — the old gate forwarded it optimistically; §3
/// requires the dest machine's own advertised set to name it.
#[tokio::test]
async fn owner_device_outer_send_in_set_vs_out_of_set() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;

    // Machine M on B advertises [app_a] ONLY.
    let m_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_a_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_b_sk = SigningKey::generate(&mut rand::thread_rng());
    let n_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut m_ws, m_epk) = connect_and_auth_with_key(relay_b.port, &m_sk).await;
    let (mut app_a, app_a_epk) = connect_and_auth_with_key(relay_a.port, &app_a_sk).await;
    let (mut app_b, app_b_epk) = connect_and_auth_with_key(relay_a.port, &app_b_sk).await;
    let (mut _n_ws, n_epk) = connect_and_auth_with_key(relay_a.port, &n_sk).await;

    // M's signed set names app_a; N's signed set names app_b (so app_b is a
    // KNOWN owner pubkey on relay A — the sharpest contrast with the old
    // optimistic forward).
    push_signed_pairing(
        &m_sk,
        &m_epk,
        vec![app_a_epk.clone()],
        1,
        &relay_b.state.pairing,
    );
    push_signed_pairing(
        &n_sk,
        &n_epk,
        vec![app_b_epk.clone()],
        1,
        &relay_a.state.pairing,
    );

    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    start_peering_on(&relay_a);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if relay_a
            .state
            .federated
            .machine_owners(&m_epk)
            .await
            .is_some_and(|o| o.contains(&app_a_epk))
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "relay A never learned M's advertised owner set"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "in-set"}});

    // IN-SET: app_a is named in M's advertised set ⇒ forwarded.
    app_a
        .send(Message::text(outer_frame(&m_epk, "main", &payload)))
        .await
        .unwrap();
    let got = next_matching(&mut m_ws, "in-set forward at M", |v| {
        (v.get("type").is_none() && v["peer"] == json!(app_a_epk)).then(|| v.clone())
    })
    .await;
    assert_eq!(inner_of(&got.to_string()), payload);

    // OUT-OF-SET: app_b (a KNOWN owner device) is NOT in M's advertised set
    // ⇒ routed refusal at the source; M hears nothing.
    let bad = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "out-of-set"}});
    app_b
        .send(Message::text(outer_frame(&m_epk, "main", &bad)))
        .await
        .unwrap();
    let err = next_matching(&mut app_b, "out-of-set routed refusal", |v| {
        (v["type"] == "error" && v["code"] == "unknown_peer").then(|| v.clone())
    })
    .await;
    assert_eq!(err["peer"], json!(m_epk));
    assert_never_matches(&mut m_ws, "out-of-set outer frame", |v| {
        v.get("type").is_none() && v["peer"] == json!(app_b_epk)
    })
    .await;
}

// ── Pairing bootstrap through federation (SRC-gate pair exemption) ────────

/// A device NOT in the dest machine's owner set can still send PAIRING
/// frames to a federated machine — the SRC gate exempts them (the same
/// exemption the local content gate has): without it, a device could never
/// pair with a federated machine it isn't already in (chicken-and-egg).
/// The MACHINE gates the pair_request itself (token check). The exemption
/// is NARROW: a non-pairing frame from the same sender is still refused.
#[tokio::test]
async fn pair_frames_exempt_from_src_gate() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;
    let owner = SigningKey::generate(&mut rand::thread_rng());

    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_sk = SigningKey::generate(&mut rand::thread_rng());
    let stranger_sk = SigningKey::generate(&mut rand::thread_rng());
    let (mut machine, machine_epk) = connect_and_auth_with_key(relay_b.port, &machine_sk).await;
    let (_app, app_epk) = connect_and_auth_with_key(relay_a.port, &app_sk).await;
    let (mut stranger, _stranger_epk) = connect_and_auth_with_key(relay_a.port, &stranger_sk).await;

    publish_shared_owner(
        &owner,
        &[machine_epk.clone(), app_epk.clone()],
        &format!("http://127.0.0.1:{}", relay_a.port),
        &format!("http://127.0.0.1:{}", relay_b.port),
    )
    .await;

    // Machine declares its pairing on relay B: owners = [app] ONLY — the
    // stranger is NOT in the set (the SRC gate would refuse it).
    {
        let mkey = machine_sk.verifying_key().to_bytes();
        let owners = vec![app_epk.clone()];
        let blob = json!({
            "machine_pk": B64.encode(mkey),
            "owners": owners,
            "version": 1,
            "issued_at": 1_700_000_000_000u64,
        });
        let blob_bytes = serde_json::to_vec(&blob).unwrap();
        let sig = machine_sk.sign(&blob_bytes);
        relay_b
            .state
            .pairing
            .set_signed(
                machine_epk.clone(),
                vec![app_epk.clone()],
                1,
                &blob_bytes,
                &sig.to_bytes(),
            )
            .expect("machine pairing set (v1)");
    }

    // Peering: A out to B, pinned (strict link gate).
    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    relay::peering::start_peering(
        relay_a.state.mesh.clone(),
        relay_a.state.registry.clone(),
        relay_a.state.pairing.clone(),
        relay_a.state.federated.clone(),
    );

    // Wait for the handshake exchange: A knows the machine's owner set.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if tokio::time::Instant::now() >= deadline {
            panic!("handshake exchange never completed");
        }
        if let Some(owners) = relay_a.state.federated.machine_owners(&machine_epk).await
            && owners.contains(&app_epk)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // The stranger's PAIR_REQUEST reaches the machine through the SRC-gate
    // exemption (the machine gates the token itself).
    let pair_payload = json!({
        "type": "pair_request",
        "token": "pair-token",
        "device_name": "laptop",
    });
    stranger
        .send(Message::text(outer_frame(
            &machine_epk,
            "main",
            &pair_payload,
        )))
        .await
        .unwrap();
    let got = next_text(&mut machine)
        .await
        .expect("pair_request must reach the machine (SRC-gate pair exemption)");
    assert_eq!(inner_of(&got), pair_payload);

    // The exemption is NARROW: the same stranger's non-pairing frame is
    // still refused AT THE SOURCE.
    stranger
        .send(Message::text(outer_frame(
            &machine_epk,
            "main",
            &json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "bad"}}),
        )))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut err: Option<Value> = None;
    while tokio::time::Instant::now() < deadline {
        let Some(text) = next_any_text(&mut stranger).await else {
            break;
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if v["type"] == "error" {
            err = Some(v);
            break;
        }
    }
    let err = err.expect("stranger's non-pair frame must STILL be refused");
    assert_eq!(err["code"], "unknown_peer");
}

// ── Incremental pairing propagation (relay_pairings_update) ────────────────

/// A device's pairing_set pushed to relay A AFTER the peering handshake must
/// reach B's federated gate view WITHOUT any re-handshake — the incremental
/// `relay_pairings_update` push is the only carrier at that point. The live
/// first-convo latency was exactly this path underperforming: replies were
/// refused at B until a link flap re-ran the handshake snapshot. End-to-end:
/// once propagated, the machine's reply to the device clears B's strict SRC
/// gate.
#[tokio::test]
async fn pairing_set_push_propagates_incrementally() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;
    let owner = SigningKey::generate(&mut rand::thread_rng());

    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_sk = SigningKey::generate(&mut rand::thread_rng());
    let app_epk = B64.encode(app_sk.verifying_key().to_bytes());
    let (mut machine, machine_epk) = connect_and_auth_with_key(relay_b.port, &machine_sk).await;

    publish_shared_owner(
        &owner,
        &[machine_epk.clone(), app_epk.clone()],
        &format!("http://127.0.0.1:{}", relay_a.port),
        &format!("http://127.0.0.1:{}", relay_b.port),
    )
    .await;

    // Machine declares its pairing on relay B BEFORE the handshake (rides
    // the handshake snapshot): owners = [app].
    {
        let mkey = machine_sk.verifying_key().to_bytes();
        let owners = vec![app_epk.clone()];
        let blob = json!({
            "machine_pk": B64.encode(mkey),
            "owners": owners,
            "version": 1,
            "issued_at": 1_700_000_000_000u64,
        });
        let blob_bytes = serde_json::to_vec(&blob).unwrap();
        let sig = machine_sk.sign(&blob_bytes);
        relay_b
            .state
            .pairing
            .set_signed(
                machine_epk.clone(),
                vec![app_epk.clone()],
                1,
                &blob_bytes,
                &sig.to_bytes(),
            )
            .expect("machine pairing set (v1)");
    }

    // Peering handshake FIRST — the exchange completes before the app's
    // push, so the INCREMENTAL push is the only carrier for the app's set.
    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    relay::peering::start_peering(
        relay_a.state.mesh.clone(),
        relay_a.state.registry.clone(),
        relay_a.state.pairing.clone(),
        relay_a.state.federated.clone(),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if tokio::time::Instant::now() >= deadline {
            panic!("handshake exchange never completed");
        }
        if let Some(owners) = relay_a.state.federated.machine_owners(&machine_epk).await
            && owners.contains(&app_epk)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // NOW the app connects to A and pushes its own pairing_set VIA THE WIRE
    // (a real control frame, like the phone app / CLI do on connect).
    let (mut app, app_epk_live) = connect_and_auth_with_key(relay_a.port, &app_sk).await;
    assert_eq!(app_epk_live, app_epk, "epk derivation mismatch");
    let app_blob = json!({
        "machine_pk": B64.encode(app_sk.verifying_key().to_bytes()),
        "owners": [app_epk.clone()],
        "version": 2,
        "issued_at": 1_700_000_000_001u64,
    });
    let app_blob_bytes = serde_json::to_vec(&app_blob).unwrap();
    let app_sig = app_sk.sign(&app_blob_bytes);
    app.send(Message::text(
        json!({
            "type": "pairing_set",
            "blob": B64.encode(&app_blob_bytes),
            "sig": B64.encode(app_sig.to_bytes()),
        })
        .to_string(),
    ))
    .await
    .unwrap();

    // THE ASSERT: B's federated view of the app's owner set arrives without
    // any re-handshake. If this fails, only the handshake snapshot carries
    // pairing state — the live first-convo latency, reproduced as a red test.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let learned = loop {
        if tokio::time::Instant::now() >= deadline {
            break false;
        }
        if let Some(owners) = relay_b.state.federated.machine_owners(&app_epk).await
            && owners.contains(&app_epk)
        {
            break true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(
        learned,
        "incremental relay_pairings_update never reached relay B — the app's \
         owner set is only carried by handshake snapshots (first-convo latency)"
    );

    // End-to-end: request (route learn) + reply through B's SRC gate, which
    // now decides on the incrementally-propagated view.
    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "s1"}});
    app.send(Message::text(outer_frame(&machine_epk, "main", &payload)))
        .await
        .unwrap();
    let got = next_text(&mut machine).await.expect("app request blocked");
    assert_eq!(inner_of(&got), payload);
    let reply = json!({"type": "ub", "ub": {"t": "hello_back"}});
    machine
        .send(Message::text(outer_frame(&app_epk, "main", &reply)))
        .await
        .unwrap();
    let got = next_text(&mut app)
        .await
        .expect("machine reply blocked — B's SRC gate refused it");
    assert_eq!(inner_of(&got), reply);
}

// ── rooms_check for a federated peer: full parity with the app's read path ──

/// Live regression (2026-10-15): a session launched AFTER the peering
/// handshake reached cascade's federated `sessions` map — the app's
/// federated_peer_list push served it — but `unbien connect --list`
/// (rooms_check) showed ONLY the handshake-snapshot session. Root cause:
/// the rooms_check federated branch sent ONE `rooms` FRAME PER ROOM and the
/// CLI resolves a rooms_check on the FIRST matching frame (client.ts
/// listRooms), so every room after the first was invisible. The fix groups
/// the federated rooms per epk (shared grouping with federated_peer_list)
/// into ONE frame. This test pins the invariant: every room in the
/// federated state — including an INCREMENTAL relay_peer_update add —
/// appears in BOTH the federated_peer_list broadcast and the rooms_check
/// response for the epk, in one frame.
#[tokio::test]
async fn rooms_check_serves_incrementally_added_federated_room() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", state_dir.path());
    }
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;

    // The machine on B with ONE room live BEFORE the handshake — this room
    // rides the relay_peer_list snapshot exchange (like the pre-launch
    // session Bbcc in the live incident).
    let machine_sk = SigningKey::generate(&mut rand::thread_rng());
    let (_machine_old, machine_epk) =
        connect_and_auth_with_room(relay_b.port, &machine_sk, "snapshot-room").await;

    // Peer A → B (pinned; A dials — the cascade→droplet topology).
    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    state_dir_setup(&format!("http://127.0.0.1:{}", relay_b.port), &pinned_pk);
    start_peering_on(&relay_a);

    // Wait for the snapshot: A must know the handshake room.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let known: Vec<String> = relay_a
            .state
            .federated
            .rooms_for_epk(&machine_epk)
            .await
            .into_iter()
            .map(|(_, r)| r.room_id)
            .collect();
        if known.iter().any(|r| r == "snapshot-room") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "relay A never learned the snapshot room"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // A SECOND session of the SAME machine, announced AFTER the handshake —
    // this room rides the incremental relay_peer_update add (the XXYYZZ
    // launch in the live incident).
    let (_machine_new, _) =
        connect_and_auth_with_room(relay_b.port, &machine_sk, "incremental-room").await;

    // Wait for the incremental add to land in A's federated state (the app's
    // read path — this is the fact the live app proved).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let known: Vec<String> = relay_a
            .state
            .federated
            .rooms_for_epk(&machine_epk)
            .await
            .into_iter()
            .map(|(_, r)| r.room_id)
            .collect();
        if known.iter().any(|r| r == "incremental-room") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "incremental relay_peer_update add never reached relay A"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // PARITY HALF 1: the federated_peer_list broadcast serves BOTH rooms.
    let fed_list: Value =
        serde_json::from_str(&relay_a.state.federated.federated_peer_list_json().await).unwrap();
    let entry = fed_list["peers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["epk"] == json!(machine_epk))
        .expect("machine missing from federated_peer_list");
    let fed_room_ids: Vec<String> = entry["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["room_id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        fed_room_ids.contains(&"snapshot-room".to_string())
            && fed_room_ids.contains(&"incremental-room".to_string()),
        "federated_peer_list must serve both rooms, got: {fed_room_ids:?}"
    );

    // PARITY HALF 2: rooms_check (an UNPAIRED app client on A — the exact
    // path `unbien connect --list` drives) must answer with BOTH rooms, in
    // ONE `rooms` frame — the CLI resolves on the FIRST matching frame and
    // drops any follow-up.
    let (mut app, _app_epk) = connect_and_auth(relay_a.port).await;
    app.send(Message::text(
        json!({"type": "rooms_check", "peers": [&machine_epk]}).to_string(),
    ))
    .await
    .unwrap();
    let frame = next_matching(&mut app, "federated rooms frame", |v| {
        (v["type"] == "rooms" && v["peer"] == json!(machine_epk)).then(|| v.clone())
    })
    .await;
    let room_ids: Vec<String> = frame["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["room_id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        room_ids.contains(&"snapshot-room".to_string())
            && room_ids.contains(&"incremental-room".to_string()),
        "rooms_check must serve BOTH the snapshot and the incrementally-added \
         room in its response — got only: {room_ids:?}"
    );
    assert_eq!(
        frame["peerRelay"],
        json!("relay-b"),
        "the federated rooms frame names the origin relay"
    );

    // One frame per epk: no SECOND rooms frame for the same peer follows
    // (the pre-fix shape — one frame per room — failed here AND dropped the
    // second room on the CLI's first-frame resolve).
    assert_never_matches(&mut app, "a second rooms frame for the same epk", |v| {
        v["type"] == "rooms" && v["peer"] == json!(machine_epk)
    })
    .await;
}
