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
//! Legs 1–5 are `#[ignore]` until the relay implements the two pieces the
//! chain requires (the harness is the spec; each is small):
//!   (1) transit announcements: `relay_peer_list` payloads carry only the
//!       sender's OWN registry rooms; B must also announce rooms learned
//!       from C so A learns "machine-epk reachable via B".
//!   (2) onward hop: the inbound `relay_forward` handler delivers only
//!       LOCALLY (miss → `unknown_peer` ack); a transit relay must append
//!       its own name to `visited`, re-sign, and forward onward per its
//!       own `epk_to_relays`, chaining the ack hop-by-hop (same request_
//!       id; `visited` growth is the loop guard).

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
    }
}

fn pick_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn spawn_relay_proc(name: &str, port: u16, peers: &[(&str, String)]) -> RelayProc {
    let dir = tempfile::tempdir().unwrap();
    // Per-relay peer config (the CHAIN definition itself).
    let list: Vec<Value> = peers
        .iter()
        .map(|(n, url)| json!({"name": n, "url": url}))
        .collect();
    std::fs::write(
        dir.path().join("relay-peers.json"),
        json!({"federation": {"enabled": true}, "peers": list}).to_string(),
    )
    .unwrap();

    let child = Command::new(env!("CARGO_BIN_EXE_unbien-relay"))
        .env("UNBIEN_STATE_DIR", dir.path())
        .env("UNBIEN_RELAY_NAME", name)
        .env("UNBIEN_RELAY_PORT", port.to_string())
        // Scrub ambient heredity: everything state-ish lives in the rig dir.
        .env("XDG_CONFIG_HOME", dir.path().join("xdg-config"))
        .env("XDG_STATE_HOME", dir.path().join("xdg-state"))
        .env("RUST_LOG", "relay=debug")
        .stdout({
            let f = std::fs::File::create(std::env::temp_dir().join(format!(
                "unbien-rig-{name}-{port}.out.log"
            )))
            .unwrap();
            Stdio::from(f)
        })
        .stderr({
            let f = std::fs::File::create(std::env::temp_dir().join(format!(
                "unbien-rig-{name}-{port}.err.log"
            )))
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
    panic!(
        "relay {name} never started listening (logs: /tmp/unbien-rig-{name}-{port}.*.log)"
    );
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
#[ignore = "needs transit announcements (1) + onward hop (2) — see file header"]
async fn app_machine_request_reply_stream_across_three_relay_chain() {
    let port_b = pick_port();
    let port_a = pick_port();
    let port_c = pick_port();
    let a = spawn_relay_proc(
        "relay-a",
        port_a,
        &[("relay-b", format!("ws://127.0.0.1:{port_b}"))],
    );
    let b = spawn_relay_proc(
        "relay-b",
        port_b,
        &[
            ("relay-a", format!("ws://127.0.0.1:{port_a}")),
            ("relay-c", format!("ws://127.0.0.1:{port_c}")),
        ],
    );
    let c = spawn_relay_proc(
        "relay-c",
        port_c,
        &[("relay-b", format!("ws://127.0.0.1:{port_b}"))],
    );
    let _ = (&a, &b, &c);

    let base = |p: u16| format!("http://127.0.0.1:{p}");
    let machine_sk = SigningKey::generate(&mut rand::rngs::OsRng);
    let app_sk = SigningKey::generate(&mut rand::rngs::OsRng);
    let (mut machine, machine_epk) = connect_and_auth_with_key(port_c, &machine_sk).await;
    let (mut app, app_epk) = connect_and_auth_with_key(port_a, &app_sk).await;

    publish_shared_owner_n(
        &SigningKey::generate(&mut rand::rngs::OsRng),
        &[machine_epk.clone(), app_epk.clone()],
        &[base(port_a), base(port_b), base(port_c)],
    )
    .await;

    // Leg 1: A must learn the machine's room THROUGH B (transit announcement).
    let mut learned = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
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

    // Strict pairing gate: the machine pushes its MACHINE-SIGNED pairing_set
    // (its owner set = the app's epk) before app→machine traffic can forward.
    let doc = json!({
        "machine_pk": B64.encode(machine_sk.verifying_key().to_bytes()),
        "owners": [app_epk],
        "version": 1,
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

    // Leg 2: request crosses A→B→C.
    let payload = json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "s1"}});
    app.send(Message::text(outer_frame(&machine_epk, "main", &payload)))
        .await
        .unwrap();
    let got = next_text(&mut machine)
        .await
        .expect("machine never got request");
    assert_eq!(inner_of(&got), payload);

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

    // Leg 5: dead room through the chain = silent drop, conn alive.
    app.send(Message::text(outer_frame(
        &machine_epk,
        "dead-room-xyz",
        &json!({"type": "ub", "ub": {"t": "session_sync", "session_id": "dead"}}),
    )))
    .await
    .unwrap();
    let r = tokio::time::timeout(Duration::from_millis(1500), app.next()).await;
    assert!(r.is_err(), "dead-room drop must be silent, got {r:?}");
}

/// Harness self-check that PASSES today: the direct A↔B hop inside the
/// same subprocess rig (validates the rig itself — spawn, mesh, announce,
/// routing — independent of the not-yet-built legs).
#[tokio::test]
async fn chain_rig_smoke_direct_hop() {
    let port_b = pick_port();
    let port_a = pick_port();
    let a = spawn_relay_proc(
        "relay-a",
        port_a,
        &[("relay-b", format!("ws://127.0.0.1:{port_b}"))],
    );
    let b = spawn_relay_proc(
        "relay-b",
        port_b,
        &[("relay-a", format!("ws://127.0.0.1:{port_a}"))],
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
