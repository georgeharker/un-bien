# Un Bien — Relay (Rust)

WebSocket server that authenticates connections by `peer_id`, routes App↔Pi
traffic, authorizes and forwards Pi→Pi envelopes, and keeps Owner-signed
membership metadata in SQLite.

## Stack

- Rust 1.94+ (2024 edition)
- Runtime: `tokio` (full features)
- WebSocket: `tokio-tungstenite`
- Serialization: `serde` + `serde_json`
- Logging: `tracing` + `tracing-subscriber` (do NOT use `println!`)

## Commands

- `cargo build` — dev build
- `cargo build --release` — optimized build
- `cargo run` — run locally
- `RUST_LOG=info cargo run` — with visible logs
- `cargo clippy -- -D warnings` — strict lint (must pass before commit)
- `cargo fmt` — format
- `cargo test` — tests

## Conventions

- **Errors**: `anyhow::Result<()>` in `main`, `thiserror::Error` in internal libs
- **Async**: everything via `tokio::spawn` / `tokio::select!`, no `std::thread`
- **Logging**: spans with `tracing::info_span!` in handlers, `info!`/`warn!`/`error!`
- **No `unwrap()`** in production code. Use `?` and propagate
- **No unnecessary `clone()`** — pass `&` where possible

## Security & content policy

- In App↔Pi traffic, the outer `ct` stays opaque and is never decoded.
- Pi→Pi `pi_envelope` and signed membership are parsed in memory only as needed
  for routing and authorization.
- No envelope body, key material, or signature may be logged or persisted as a
  message payload.
- SQLite persistence is limited to Owner-signed membership authorization
  metadata; message traffic is never persisted.
- A route is eligible when any correctly Owner-signed blob directly lists both
  canonical Pi keys. This does not prove the Owner paired or controls any Pi,
  nor does it offer a stronger trust guarantee. There is no transitivity across
  overlapping blobs.
- The positive authorization cache may retain a revoked permission for at most
  60 seconds; negative sender misses are cached for 1 second and the cache is
  bounded.
- Rate limit per `peer_id` and per source IP.

## Upgrade

- Deploy Relay 0.3 first: old Extensions consume its UUID errors. Then
  coordinate Extension 0.6 and minimize mixed Extensions, since mixed wire
  labels remain deferred. The 0.6 shim covers an old Relay or a rollback — it is
  not the reason Relay-first is safe.
- Rollout procedures are centralized in Plan 51.

## Don't

- Don't use `println!` (use `tracing`)
- Don't use `.unwrap()` or `.expect()` in production paths
- Don't log message content, full keys, or signatures
- Don't add traffic/payload persistence; only Owner-signed membership metadata
  belongs in SQLite
- Don't commit `target/` (already in the root `.gitignore`)

## Orchestrated mode

If you receive a prompt starting with `[ORCH:<task-id>]`, read
`../.orchestration/INSTRUCTIONS.md` before doing anything else — another agent
is coordinating and has specific rules (where to write results, not committing,
etc).
