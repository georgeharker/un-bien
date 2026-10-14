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

use common::{WsStream, connect_and_auth_with_key, spawn_relay_named};
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
    // to relay B (owners = [app]) — the handshake then exchanges it and the
    // source relay's check-before-forward forwards the app's requests.
    {
        let machine_pk = B64.encode(machine_sk.verifying_key().to_bytes());
        let owners = vec![app_epk.clone()];
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
