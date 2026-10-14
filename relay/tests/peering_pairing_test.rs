//! Federation v2 slice 1 — the explicit-pairing link gate, pinned down:
//!
//! (i)  an UNPINNED inbound presenter is declined with a named reason
//!      (`unpinned_peer`) — the shared-owner intersection no longer saves it;
//! (ii) the one-pair secret path: a hello with a valid pending secret
//!      AUTO-ADDS the presenter (config file gains the pinned entry, pending
//!      consumed) and the token is SINGLE-USE — a second presentation
//!      declines;
//! (iii) the outbound loop REFUSES to dial an unpinned configured peer, and
//!      picks the pin up (no restart) once the CLI writes it;
//! (iv) a shared-owner MISMATCH no longer prevents federation when the peer
//!      is pinned — pairing is the gate, the owner intersection is logged
//!      for observability only.
//!
//! UNBIEN_STATE_DIR is process-global (relay-peers.json + the relay identity
//! keypair resolve through it), so every test here serializes on STATE_LOCK.
//! The guard is DELIBERATELY held across every await in a test — that is
//! the serialization — so the pedantic await-holding-lock lint is off.
#![allow(clippy::await_holding_lock)]

mod common;

use common::{WsStream, connect_and_auth, spawn_relay_named};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay::AppState;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

static STATE_LOCK: Mutex<()> = Mutex::new(());

/// Point UNBIEN_STATE_DIR at a fresh tempdir (caller must hold STATE_LOCK)
/// and return it (the TempDir must outlive the test).
fn hermetic_state_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("UNBIEN_STATE_DIR", dir.path());
    }
    dir
}

fn peers_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("UNBIEN_STATE_DIR").unwrap()).join("relay-peers.json")
}

fn write_peers_doc(doc: Value) {
    std::fs::write(peers_path(), doc.to_string()).unwrap();
}

fn read_peers_doc() -> Value {
    serde_json::from_str(&std::fs::read_to_string(peers_path()).unwrap()).unwrap()
}

/// A relay-identity-compatible signed hello: same nonce|pubkey|name|url
/// signing string the relay uses, signed with a caller-supplied key so each
/// test presents exactly the identity it intends.
fn signed_hello(sk: &SigningKey, name: &str, url: &str, pair_secret: Option<&str>) -> String {
    let nonce = B64.encode(rand::random::<[u8; 32]>());
    let pk = B64.encode(sk.verifying_key().to_bytes());
    let msg = format!("{nonce}|{pk}|{name}|{url}");
    let sig = B64.encode(sk.sign(msg.as_bytes()).to_bytes());
    let mut hello = json!({
        "type": "relay_hello",
        "owners": [],
        "relay_pubkey": pk,
        "relay_name": name,
        "relay_url": url,
        "nonce": nonce,
        "sig": sig,
    });
    if let Some(secret) = pair_secret {
        hello["pair_secret"] = json!(secret);
    }
    hello.to_string()
}

async fn connect_relay_peer(port: u16) -> WsStream {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/relay-peer"))
        .await
        .unwrap();
    ws
}

/// Send a hello, read the relay_hello_ack back.
async fn hello_and_ack(ws: &mut WsStream, hello: &str) -> Value {
    ws.send(Message::text(hello.to_string())).await.unwrap();
    read_ack(ws).await
}

/// Read the next frame and parse it as the relay_hello_ack JSON.
async fn read_ack(ws: &mut WsStream) -> Value {
    let ack = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("no relay_hello_ack (timeout)")
        .expect("ws error")
        .expect("relay closed before ack");
    let text = ack.into_text().unwrap();
    serde_json::from_str(text.as_str()).unwrap()
}

/// A random 32-byte secret, base64 — the same shape the CLI mints.
fn mint_secret() -> String {
    B64.encode(rand::random::<[u8; 32]>())
}

// ── (i) unpinned inbound declines ─────────────────────────────────────────

#[tokio::test]
async fn unpinned_inbound_presenter_is_declined() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _dir = hermetic_state_dir();
    // Federation on (legacy flag), NO peers configured → nobody is pinned.
    write_peers_doc(json!({"federation": {"enabled": true}, "peers": []}));
    let relay_b = spawn_relay_named("relay-b").await;

    // A fully valid identity hello (signed, all fields) but the key is not
    // pinned — and there is no pairing secret to bootstrap one.
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk, "relay-x", "http://127.0.0.1:9", None),
    )
    .await;
    assert_eq!(ack["type"], "relay_hello_ack", "must ack, not drop: {ack}");
    assert_eq!(
        ack["federate"], false,
        "unpinned presenter must be declined"
    );
    assert_eq!(
        ack["reason"], "unpinned_peer",
        "the decline is named: {ack}"
    );

    // A hello with NO presented pubkey at all: same explicit refusal.
    let mut ws = connect_relay_peer(relay_b.port).await;
    ws.send(Message::text(
        json!({"type": "relay_hello", "owners": []}).to_string(),
    ))
    .await
    .unwrap();
    let ack = read_ack(&mut ws).await;
    assert_eq!(ack["federate"], false);
    assert_eq!(ack["reason"], "unpinned_peer");

    // PIN MISMATCH: pin SOME OTHER key — the presenter still declines.
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [{"name": "relay-y", "url": "http://127.0.0.1:9", "pubkey": B64.encode([1u8; 32])}]
    }));
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk, "relay-x", "http://127.0.0.1:9", None),
    )
    .await;
    assert_eq!(ack["federate"], false, "pin mismatch must decline");
    assert_eq!(
        ack["reason"], "unpinned_peer",
        "presenter is simply not pinned: {ack}"
    );

    // CONTROL: the SAME presenter with its key pinned federates — proving
    // the declines above are the pin gate, not something else.
    let pk = B64.encode(sk.verifying_key().to_bytes());
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [{"name": "relay-x", "url": "http://127.0.0.1:9", "pubkey": pk}]
    }));
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk, "relay-x", "http://127.0.0.1:9", None),
    )
    .await;
    assert_eq!(
        ack["federate"], true,
        "pinned presenter must federate: {ack}"
    );
    assert!(ack.get("reason").map(Value::is_null).unwrap_or(true));
}

// ── (ii) the one-pair secret: auto-add + single-use ────────────────────────

#[tokio::test]
async fn pairing_secret_auto_adds_peer_and_is_single_use() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _dir = hermetic_state_dir();
    let secret = mint_secret();
    // The ISSUER's file: a pending entry, no peers yet.
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [],
        "pending": [
            {"secret": secret, "name": "relay-b", "url": "http://127.0.0.1:2", "at": "2026-10-14T00:00:00Z"}
        ]
    }));
    let relay_b = spawn_relay_named("relay-b").await;

    // The PRESENTER: fresh identity (signed hello), valid pending secret.
    // The auto-add must record the PRESENTER's fields, not the pending
    // entry's issuer fields.
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let pk = B64.encode(sk.verifying_key().to_bytes());
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk, "relay-a", "http://127.0.0.1:1234", Some(&secret)),
    )
    .await;
    assert_eq!(
        ack["federate"], true,
        "valid pending secret must federate: {ack}"
    );

    // The config file gained the pinned entry (from the PRESENTER's hello
    // fields) and the pending entry was consumed; the federation flag and
    // any other fields survive the atomic write.
    let doc = read_peers_doc();
    assert_eq!(doc["federation"]["enabled"], json!(true), "flag preserved");
    assert_eq!(
        doc["peers"],
        json!([{"name": "relay-a", "url": "http://127.0.0.1:1234", "pubkey": pk}]),
        "auto-add uses the presented name/url/pubkey: {doc}"
    );
    assert_eq!(doc["pending"], json!([]), "pending entry consumed");

    // SINGLE-USE token, but NOT a dead connection: the SAME presenter (now
    // PINNED via the first use's auto-add) re-presents its stored, spent
    // secret on every reconnect — the pin gate decides and it FEDERATES.
    // (Declining here killed live links after their first disconnect:
    // the link worked exactly once per relay restart — the "entire relay
    // went" after an upgrade.)
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk, "relay-a", "http://127.0.0.1:1234", Some(&secret)),
    )
    .await;
    assert_eq!(
        ack["federate"], true,
        "spent secret from a PINNED presenter must federate via the pin gate: {ack}"
    );

    // A spent/WRONG secret from an UNPINNED key still declines — the
    // fall-through lands in the pin gate, so the reason is ITS named one.
    let sk2 = SigningKey::generate(&mut rand::thread_rng());
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk2, "relay-z", "http://127.0.0.1:5", Some(&secret)),
    )
    .await;
    assert_eq!(
        ack["federate"], false,
        "spent secret from an unpinned key must decline"
    );
    assert_eq!(ack["reason"], "unpinned_peer", "named decline: {ack}");

    // A WRONG secret (never minted) declines the same way.
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk2, "relay-z", "http://127.0.0.1:5", Some(&mint_secret())),
    )
    .await;
    assert_eq!(ack["federate"], false);
    assert_eq!(ack["reason"], "unpinned_peer");
}

// ── (iii) outbound refuses to dial unpinned; picks the pin up later ───────

#[tokio::test]
async fn outbound_loop_skips_unpinned_peer_until_pin_appears() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _dir = hermetic_state_dir();
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;
    // A machine on B, so B has a room to advertise once federation is up.
    let (_machine, machine_epk) = connect_and_auth(relay_b.port).await;

    // The shared in-process identity keypair (both relays resolve it from
    // the state dir) — its pubkey is the pin.
    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();

    // Configured peer WITHOUT a pin: must NOT be dialed.
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [{"name": "relay-b", "url": format!("http://127.0.0.1:{}", relay_b.port)}]
    }));
    relay::peering::start_peering(
        relay_a.state.mesh.clone(),
        relay_a.state.registry.clone(),
        relay_a.state.pairing.clone(),
        relay_a.state.federated.clone(),
    );

    // Long enough for a dial cycle to have happened were it not skipped.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(
        !relay_a.state.federated.has_federated_sessions().await,
        "unpinned configured peer must NOT be dialed"
    );

    // The CLI writes the pin later (fswatch semantics: the loop re-reads
    // the config) — the dial starts without a restart.
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [{
            "name": "relay-b",
            "url": format!("http://127.0.0.1:{}", relay_b.port),
            "pubkey": pinned_pk
        }]
    }));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let federated = loop {
        if relay_a.state.federated.has_federated_sessions().await {
            break true;
        }
        if tokio::time::Instant::now() >= deadline {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert!(federated, "pinning the peer later must start the dial");
    assert!(
        !relay_a
            .state
            .federated
            .rooms_for_epk(&machine_epk)
            .await
            .is_empty(),
        "A must learn B's rooms after the pin lands"
    );
}

// ── (iv) shared-owner mismatch no longer prevents federation ─────────────

#[tokio::test]
async fn no_common_owner_still_federates_when_pinned() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _dir = hermetic_state_dir();
    let relay_a = spawn_relay_named("relay-a").await;
    let relay_b = spawn_relay_named("relay-b").await;
    let (_machine, machine_epk) = connect_and_auth(relay_b.port).await;

    // NO owner mesh blob is published and NO pairing_set is pushed: both
    // relays' trust-root sets are EMPTY — the intersection is empty. Under
    // the retired shared-owner gate this is an instant decline; under the
    // v2 pin gate it must federate (the intersection is only logged).
    let pinned_pk = relay::relay_keypair::load_or_generate(None).pubkey_b64();
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [{
            "name": "relay-b",
            "url": format!("http://127.0.0.1:{}", relay_b.port),
            "pubkey": pinned_pk
        }]
    }));
    relay::peering::start_peering(
        relay_a.state.mesh.clone(),
        relay_a.state.registry.clone(),
        relay_a.state.pairing.clone(),
        relay_a.state.federated.clone(),
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let federated = loop {
        if relay_a.state.federated.has_federated_sessions().await {
            break true;
        }
        if tokio::time::Instant::now() >= deadline {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert!(
        federated,
        "empty owner intersection must NOT prevent federation when pinned"
    );
    assert!(
        !relay_a
            .state
            .federated
            .rooms_for_epk(&machine_epk)
            .await
            .is_empty(),
        "rooms exchange must complete without any shared owner"
    );
}

/// Compile-time: the shared state type is the same one the handler uses.
#[allow(dead_code)]
fn _uses_app_state(state: &AppState) -> Arc<relay::FederatedSessions> {
    state.federated.clone()
}

// ── (ii-b) the auto-add tolerates a presenter without UNBIEN_RELAY_URL ────

/// A re-pairing presenter whose process lost UNBIEN_RELAY_URL (empty
/// relay_url in the hello) must NOT be declined: it federates via the valid
/// secret, and the auto-add INHERITS the existing entry's url instead of
/// clobbering it. An empty NAME still declines — the entry is keyed by name.
#[tokio::test]
async fn pairing_secret_with_missing_url_inherits_existing_entry() {
    let _state = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _dir = hermetic_state_dir();
    let secret = mint_secret();
    // The ISSUER's file: a pending entry AND an already-pinned presenter
    // entry carrying a GOOD url (the pre-restart pairing's record).
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [{"name": "relay-a", "url": "http://good:1234", "pubkey": "pk-stale"}],
        "pending": [
            {"secret": secret, "name": "relay-a", "url": "http://x:2", "at": "2026-10-14T00:00:00Z"}
        ]
    }));
    let relay_b = spawn_relay_named("relay-b").await;

    let sk = SigningKey::generate(&mut rand::thread_rng());
    let pk = B64.encode(sk.verifying_key().to_bytes());
    // EMPTY url in the hello — must federate, and the entry must KEEP the
    // good url (no clobber).
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(&mut ws, &signed_hello(&sk, "relay-a", "", Some(&secret))).await;
    assert_eq!(
        ack["federate"], true,
        "url-less presenter with a valid secret must federate: {ack}"
    );
    let doc = read_peers_doc();
    assert_eq!(
        doc["peers"],
        json!([{"name": "relay-a", "url": "http://good:1234", "pubkey": pk}]),
        "entry keeps the existing url; pubkey refreshed: {doc}"
    );
    assert_eq!(doc["pending"], json!([]), "pending consumed");

    // An empty NAME still declines (the entry is keyed by name).
    let sk2 = SigningKey::generate(&mut rand::thread_rng());
    let secret2 = mint_secret();
    write_peers_doc(json!({
        "federation": {"enabled": true},
        "peers": [],
        "pending": [
            {"secret": secret2, "name": "relay-z", "url": "http://x:2", "at": "2026-10-14T00:00:00Z"}
        ]
    }));
    let mut ws = connect_relay_peer(relay_b.port).await;
    let ack = hello_and_ack(
        &mut ws,
        &signed_hello(&sk2, "", "http://127.0.0.1:5", Some(&secret2)),
    )
    .await;
    assert_eq!(ack["federate"], false, "nameless presenter must decline");
    assert_eq!(ack["reason"], "pairing_missing_name_or_url");
}
