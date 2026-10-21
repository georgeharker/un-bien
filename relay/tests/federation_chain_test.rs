//! Three-relay CHAIN harness with REAL relay processes: A ↔ B ↔ C chain,
//! app on A, machine on C. Full e2e including INDIRECT routing.
//!
//! Why subprocesses: the chain needs per-relay `UNBIEN_STATE_DIR`/peer
//! configs (A peers B; B peers A+C; C peers B) and the env var is
//! process-global — in-process rigs cannot isolate it. Each test spawns
//! real `unbien-relay` binaries (same mechanism as production), connects
//! synthetic app/machine conns over real WS, publishes a real owner mesh
//! blob to all relays, then asserts the legs:
//!
//! 1. transit announcement — A's `federated_peer_list` learns the machine's
//!    room THROUGH B
//! 2. request — app→machine crosses two hops (A→B→C)
//! 3. reply — machine→app crosses back (C→B→A) on learned routes
//! 4. live deltas both ways across the chain
//! 5. dead room through the chain = silent drop (contract)
//!
//! Legs 1–5 are the slice-3 acceptance spec (federation v2 §4 — transitive
//! exchange + directed hops), now LIVE:
//!   (1) transit announcements: the advertisement is ONE SEGMENT PER
//!       ORIGIN — B re-announces rooms + pairings learned from C so A
//!       learns "machine-epk is hosted at origin relay-c, reachable via
//!       link relay-b" without any A–C pairing.
//!   (2) onward hop: a transit relay (B) re-signs an inbound relay_forward
//!       (visited + own name) and forwards it per its own route table;
//!       the ack returns along the recorded id→backlink chain, verbatim.

mod common;

use common::{WsStream, connect_and_auth_with_key};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;

/// A real relay binary with its own hermetic state dir + peer config.
struct RelayProc {
    _name: String,
    _port: u16,
    _dir: tempfile::TempDir,
    child: Child,
}

impl Drop for RelayProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Preserve the child's relay.log: the file layer writes there, and
        // the TempDir would delete it on test teardown.
        if let Ok(log) = std::fs::read(self._dir.path().join("relay.log")) {
            let out = std::env::temp_dir().join(format!(
                "unbien-rig-{}-{}.relay.log",
                self._name, self._port
            ));
            let _ = std::fs::write(out, log);
        }
    }
}

fn pick_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Pre-generate the relay's identity keypair file in its (not-yet-spawned)
/// state dir and return the pubkey to PIN on the other relays. Same format
/// the relay's `relay_keypair.rs` reads (CLI-compatible: private_key is the
/// 32-byte seed).
fn pregen_keypair(dir: &std::path::Path) -> String {
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let pk = B64.encode(sk.verifying_key().to_bytes());
    std::fs::write(
        dir.join("relay-keypair.json"),
        json!({
            "public_key": pk,
            "private_key": B64.encode(sk.to_bytes()),
        })
        .to_string(),
    )
    .unwrap();
    pk
}

/// A peer entry in the chain definition: (name, url, pinned pubkey b64).
/// The PIN is the link gate (federation v2 §1) — without it the outbound
/// loop refuses to dial.
struct PeerPin {
    name: String,
    url: String,
    pubkey: String,
}

fn spawn_relay_proc(name: &str, port: u16, dir: tempfile::TempDir, peers: &[PeerPin]) -> RelayProc {
    // Per-relay peer config (the CHAIN definition itself, pinned).
    let list: Vec<Value> = peers
        .iter()
        .map(|p| json!({"name": p.name, "url": p.url, "pubkey": p.pubkey}))
        .collect();
    std::fs::write(
        dir.path().join("relay-peers.json"),
        json!({"federation": {"enabled": true}, "peers": list}).to_string(),
    )
    .unwrap();

    println!(
        "[rig] relay {name}: state dir {} (logs in relay.log)",
        dir.path().display()
    );
    let child = Command::new(env!("CARGO_BIN_EXE_unbien-relay"))
        .env("UNBIEN_STATE_DIR", dir.path())
        .env("UNBIEN_RELAY_NAME", name)
        .env("UNBIEN_RELAY_PORT", port.to_string())
        // Scrub ambient heredity: everything state-ish lives in the rig dir.
        .env("XDG_CONFIG_HOME", dir.path().join("xdg-config"))
        .env("XDG_STATE_HOME", dir.path().join("xdg-state"))
        // A developer shell with a REAL relay's env exported (e.g. a bad
        // UNBIEN_RELAY_BIND from a device pass) must never reach the rig:
        // the relay fails loud boot on an unresolvable bind and the test
        // dies with "never started listening" — poisoned by ambient env,
        // not by the code under test.
        .env_remove("UNBIEN_RELAY_BIND")
        .env_remove("UNBIEN_RELAY_URL")
        .env("RUST_LOG", "relay=debug")
        .stdout({
            let f = std::fs::File::create(
                std::env::temp_dir().join(format!("unbien-rig-{name}-{port}.out.log")),
            )
            .unwrap();
            Stdio::from(f)
        })
        .stderr({
            let f = std::fs::File::create(
                std::env::temp_dir().join(format!("unbien-rig-{name}-{port}.err.log")),
            )
            .unwrap();
            Stdio::from(f)
        })
        .spawn()
        .expect("spawn unbien-relay binary");

    // Wait for the WS port to accept.
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return RelayProc {
                _name: name.to_string(),
                _port: port,
                _dir: dir,
                child,
            };
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut child = child; // ensure the failed spawn is reaped, not leaked
    let _ = child.kill();
    let _ = child.wait();
    let mut child = child;
    let _ = child.kill();
    let _ = child.wait();
    panic!("relay {name} never started listening (logs: /tmp/unbien-rig-{name}-{port}.*.log)");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

/// Publishes the SAME owner mesh blob (shared owner = peering trust root)
/// to every relay via /mesh/<sha256(pk)> (HTTP — note http:// bases).
async fn publish_shared_owner_n(
    owner: &SigningKey,
    member_epks: &[String],
    http_bases: &[String],
) -> String {
    let owner_pk_b64 = B64.encode(owner.verifying_key().to_bytes());
    let members: Vec<Value> = member_epks
        .iter()
        .map(|epk| {
            json!({
                "remote_epk": epk,
                "relay_url": http_bases[0],
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
    let envelope = json!({
        "blob": B64.encode(&blob_bytes),
        "sig": B64.encode(owner.sign(&blob_bytes).to_bytes()),
    });
    let hash = hex(&Sha256::digest(owner.verifying_key().as_bytes()));
    let client = reqwest::Client::new();
    for base in http_bases {
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

fn outer_frame(peer: &str, room: &str, inner: &Value) -> String {
    json!({
        "peer": peer,
        "room": room,
        "ct": B64.encode(serde_json::to_vec(inner).unwrap()),
    })
    .to_string()
}

/// Next text frame INCLUDING typed control frames (federated_peer_list
/// observation), skipping only pong/ping noise.
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

/// Next UNtyped (routed-envelope) text frame.
async fn next_text(ws: &mut WsStream) -> Option<String> {
    while let Ok(Some(m)) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
        let t = match m.ok()? {
            Message::Text(t) => t,
            Message::Pong(_) | Message::Ping(_) => continue,
            _ => return None,
        };
        let wire: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
        if wire.get("type").is_some() {
            continue;
        }
        return Some(t.to_string());
    }
    None
}

fn inner_of(outer_wire: &str) -> Value {
    let outer: Value = serde_json::from_str(outer_wire).unwrap();
    serde_json::from_slice(&B64.decode(outer["ct"].as_str().unwrap()).unwrap()).unwrap()
}

/// THE indirect-routing end-to-end across a 3-relay chain (A↔B↔C).
#[tokio::test]
async fn app_machine_request_reply_stream_across_three_relay_chain() {
    let port_b = pick_port();
    let port_a = pick_port();
    let port_c = pick_port();
    // Each subprocess relay gets its OWN identity keypair (pre-generated in
    // its hermetic state dir) — the pubkey is what the other relays pin.
    let dir_a = tempfile::tempdir().unwrap();
    let pk_a = pregen_keypair(dir_a.path());
    let dir_b = tempfile::tempdir().unwrap();
    let pk_b = pregen_keypair(dir_b.path());
    let dir_c = tempfile::tempdir().unwrap();
    let pk_c = pregen_keypair(dir_c.path());
    let a = spawn_relay_proc(
        "relay-a",
        port_a,
        dir_a,
        &[PeerPin {
            name: "relay-b".into(),
            url: format!("ws://127.0.0.1:{port_b}"),
            pubkey: pk_b.clone(),
        }],
    );
    let b = spawn_relay_proc(
        "relay-b",
        port_b,
        dir_b,
        &[
            PeerPin {
                name: "relay-a".into(),
                url: format!("ws://127.0.0.1:{port_a}"),
                pubkey: pk_a.clone(),
            },
            PeerPin {
                name: "relay-c".into(),
                url: format!("ws://127.0.0.1:{port_c}"),
                pubkey: pk_c.clone(),
            },
        ],
    );
    let c = spawn_relay_proc(
        "relay-c",
        port_c,
        dir_c,
        &[PeerPin {
            name: "relay-b".into(),
            url: format!("ws://127.0.0.1:{port_b}"),
            pubkey: pk_b.clone(),
        }],
    );
    let _ = (&a, &b, &c);

    let base = |p: u16| format!("http://127.0.0.1:{p}");
    let machine_sk = SigningKey::generate(&mut rand::rngs::OsRng);
    let app_sk = SigningKey::generate(&mut rand::rngs::OsRng);
    let (mut machine, machine_epk) = connect_and_auth_with_key(port_c, &machine_sk).await;
    let (mut app, app_epk) = connect_and_auth_with_key(port_a, &app_sk).await;

    let owner_pk = publish_shared_owner_n(
        &SigningKey::generate(&mut rand::rngs::OsRng),
        &[machine_epk.clone(), app_epk.clone()],
        &[base(port_a), base(port_b), base(port_c)],
    )
    .await;

    // Signed pairing_sets, BEFORE any traffic (the slice-1/2 rig pattern):
    // the machine's set names the app device + the shared owner; the app's
    // set names the owner it belongs to (the slice-2 production follow-up —
    // machine→APP replies need the app's advertised owner set at the
    // deciding relay too). Both advertise transitively: C→B→A and A→B→C
    // via the pairing re-advertisement (slice 3 (2)).
    {
        let doc = json!({
            "machine_pk": B64.encode(machine_sk.verifying_key().to_bytes()),
            "owners": [app_epk, owner_pk],
            "version": 1,
            "issued_at": 1_700_000_000_000_u64,
        });
        let doc_bytes = serde_json::to_vec(&doc).unwrap();
        machine
            .send(Message::text(
                json!({
                    "type": "pairing_set",
                    "blob": B64.encode(&doc_bytes),
                    "sig": B64.encode(machine_sk.sign(&doc_bytes).to_bytes()),
                })
                .to_string(),
            ))
            .await
            .unwrap();
    }
    {
        let doc = json!({
            "machine_pk": B64.encode(app_sk.verifying_key().to_bytes()),
            "owners": [owner_pk],
            "version": 1,
            "issued_at": 1_700_000_000_000_u64,
        });
        let doc_bytes = serde_json::to_vec(&doc).unwrap();
        app.send(Message::text(
            json!({
                "type": "pairing_set",
                "blob": B64.encode(&doc_bytes),
                "sig": B64.encode(app_sk.sign(&doc_bytes).to_bytes()),
            })
            .to_string(),
        ))
        .await
        .unwrap();
    }

    // Leg 1: A must learn the machine's room THROUGH B (transit announcement).
    // Budget 30s: two peering hops with handshake retries/backoff on a slow
    // CI runner can outrun a 10s budget (observed flake: the same commit
    // red on one runner, green on rerun) — the assertion is EVENTUAL
    // learning, not latency.
    let mut learned = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        if let Some(txt) = next_any_text(&mut app).await {
            let v: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
            let rooms = v["peers"]
                .as_array()
                .and_then(|ps| ps.iter().find(|p| p["epk"] == machine_epk))
                .and_then(|p| p["rooms"].as_array())
                .map(|r| !r.is_empty());
            if rooms == Some(true) {
                learned = true;
                break;
            }
        }
    }
    assert!(learned, "A never learned the machine's room via transit B");

    // Leg 2: request crosses A→B→C. The §3 gate at the SOURCE relay (A) is
    // strict unknown-refuse, and the machine's owner set propagates
    // C→B→A as an incremental update — so the first send can be refused
    // while the advertisement settles. Retry (as the direct-hop smoke
    // does), then drain duplicate deliveries before the stream legs.
    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "s1"}});
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut delivered = None;
    while tokio::time::Instant::now() < deadline {
        app.send(Message::text(outer_frame(&machine_epk, "main", &payload)))
            .await
            .unwrap();
        if let Ok(Some(got)) =
            tokio::time::timeout(Duration::from_millis(400), next_text(&mut machine)).await
        {
            delivered = Some(got);
            break;
        }
    }
    let got = delivered.expect("machine never got request (logs: /tmp/unbien-rig-*)");
    assert_eq!(inner_of(&got), payload);
    // Drain any duplicate retries + the app's typed refusal frames before
    // the reply/stream legs.
    while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(100), machine.next()).await {
    }
    while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(100), app.next()).await {}

    // Leg 3: reply crosses back C→B→A.
    let reply = json!({"type": "ub", "t": "session_sync_data", "frames": []});
    machine
        .send(Message::text(outer_frame(&app_epk, "main", &reply)))
        .await
        .unwrap();
    let got = next_text(&mut app).await.expect("app never got reply");
    assert_eq!(inner_of(&got), reply);

    // Leg 4: live deltas across the chain.
    for i in 0..3 {
        let delta = json!({"type": "ub", "delta": i});
        app.send(Message::text(outer_frame(&machine_epk, "main", &delta)))
            .await
            .unwrap();
        let got = next_text(&mut machine)
            .await
            .expect("machine lost the stream");
        assert_eq!(inner_of(&got)["delta"], json!(i));
    }

    // Leg 5: dead room through the chain = silent drop, conn alive. Control
    // frames (federated_peer_list broadcasts fire on late handshakes) are
    // legitimate traffic — the CONTRACT is that no routed envelope and no
    // error frame comes back for the dead-room attach.
    app.send(Message::text(outer_frame(
        &machine_epk,
        "dead-room-xyz",
        &json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "dead"}}),
    )))
    .await
    .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(300), app.next()).await {
            // Nothing at all within the window — silent, done.
            Err(_) => break,
            Ok(Some(Ok(Message::Text(t)))) => {
                let wire: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                if wire.get("type").is_some() {
                    // Typed control frame — allowed, EXCEPT errors (a
                    // dead-room refusal would surface as unknown_peer).
                    assert_ne!(
                        wire["type"].as_str(),
                        Some("error"),
                        "dead-room attach must be dropped silently, got error: {t}"
                    );
                    continue;
                }
                panic!("dead-room attach must be dropped silently, got {t}");
            }
            other => panic!("dead-room drop must be silent, got {other:?}"),
        }
    }
}

/// Harness self-check that PASSES today: the direct A↔B hop inside the
/// same subprocess rig (validates the rig itself — spawn, mesh, announce,
/// routing — independent of the not-yet-built legs).
#[tokio::test]
async fn chain_rig_smoke_direct_hop() {
    let port_b = pick_port();
    let port_a = pick_port();
    // Per-relay identity keypairs, mutually pinned (federation v2: the pin
    // is the link gate — the smoke hop dials both directions).
    let dir_a = tempfile::tempdir().unwrap();
    let pk_a = pregen_keypair(dir_a.path());
    let dir_b = tempfile::tempdir().unwrap();
    let pk_b = pregen_keypair(dir_b.path());
    let a = spawn_relay_proc(
        "relay-a",
        port_a,
        dir_a,
        &[PeerPin {
            name: "relay-b".into(),
            url: format!("ws://127.0.0.1:{port_b}"),
            pubkey: pk_b.clone(),
        }],
    );
    let b = spawn_relay_proc(
        "relay-b",
        port_b,
        dir_b,
        &[PeerPin {
            name: "relay-a".into(),
            url: format!("ws://127.0.0.1:{port_a}"),
            pubkey: pk_a.clone(),
        }],
    );
    let _ = (&a, &b);

    let machine_sk = SigningKey::generate(&mut rand::rngs::OsRng);
    let app_sk = SigningKey::generate(&mut rand::rngs::OsRng);
    let (mut machine, machine_epk) = connect_and_auth_with_key(port_b, &machine_sk).await;
    let (mut app, app_epk) = connect_and_auth_with_key(port_a, &app_sk).await;

    publish_shared_owner_n(
        &SigningKey::generate(&mut rand::rngs::OsRng),
        &[machine_epk.clone(), app_epk.clone()],
        &[
            format!("http://127.0.0.1:{port_a}"),
            format!("http://127.0.0.1:{port_b}"),
        ],
    )
    .await;

    // The machine's MACHINE-SIGNED pairing_set (its owner set = the app) —
    // the source relay's check-before-forward needs the dest machine's
    // advertised owner set before it forwards app→machine traffic. The rig
    // pushes REAL pairing state, as the production extension does on
    // connect (same push the 3-relay spec below performs).
    let doc = json!({
        "machine_pk": B64.encode(machine_sk.verifying_key().to_bytes()),
        "owners": [app_epk],
        "version": 1,
        "issued_at": 1_700_000_000_000_u64,
    });
    let doc_bytes = serde_json::to_vec(&doc).unwrap();
    machine
        .send(Message::text(
            json!({
                "type": "pairing_set",
                "blob": B64.encode(&doc_bytes),
                "sig": B64.encode(machine_sk.sign(&doc_bytes).to_bytes()),
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "s1"}});
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut delivered = None;
    while tokio::time::Instant::now() < deadline {
        app.send(Message::text(outer_frame(&machine_epk, "main", &payload)))
            .await
            .unwrap();
        if let Ok(Some(got)) =
            tokio::time::timeout(Duration::from_millis(400), next_text(&mut machine)).await
        {
            delivered = Some(got);
            break;
        }
    }
    assert_eq!(
        inner_of(&delivered.expect("direct hop never delivered (logs: /tmp/unbien-rig-*)")),
        payload
    );
}
