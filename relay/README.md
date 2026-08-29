> **Derived from [remote-pi](https://github.com/jacobaraujo7/remote_pi)** by Jacob
> Moura, used under the MIT License. This tree is part of the
> [un-bien](../README.md) monorepo (Cargo package `un-bien-relay`).

# un-bien — Relay

A lightweight WebSocket relay server that connects the **un-bien** mobile app to
un-bien **extension** processes running on your machine. It handles peer routing,
presence, authorized Pi-to-Pi forwarding, and signed membership metadata.

For a full overview of the project, see the
[root README](../README.md).

---

## Protocol & Security

For wire format, identity model, ACK protocol, cross-PC routing, mesh
membership, trust model, and failure modes, see
[rpc-envelope](../docs/rpc-envelope.md) at the repo root. It is the canonical reference
for everything the relay enforces on the wire.

---

## How it works

Every device authenticates with an Ed25519 keypair during the WebSocket handshake
(challenge-response). The Relay then applies these content boundaries:

- For App↔Pi traffic, the outer `ct` remains opaque and is never decoded.
- Pi→Pi `pi_envelope` frames and signed membership blobs are parsed in memory only
  as needed for routing and authorization.
- No envelope body, key material, or signature is logged or persisted as a message
  payload. SQLite persistence is limited to Owner-signed membership authorization
  metadata, not message traffic.
- A route is eligible when any correctly signed Owner blob directly lists both
  canonical Pi keys. This does not prove that the Owner paired with or controls
  either Pi, and is not a stronger trust guarantee. Membership is not transitive
  across overlapping Owner blobs.
- The positive authorization cache can retain a revoked permission for at most
  60 seconds. Negative sender misses are cached for 1 second, and the cache is
  bounded.

### App↔Pi routing: rooms

App↔Pi frames are outer envelopes `{ peer, room, ct }` (`ct` opaque).
Connections are registered by `(peer_id, room_id)`, and delivery is **always
room-specific**: `forward(peer, room)` reaches only the exact `(peer, room)`
connection(s). This is the whole App↔Pi path — transcript, panels, commands, and
the pairing handshake — so a frame for one chat can never reach another. There
is **no** App→Pi broadcast: to reach every chat of a machine, the app addresses
each session room it learned from `room_announced`. Content isolation is guarded
by the registry test `forward_is_room_specific_no_bleed`; bleed or data loss
across chats is a hard failure, not a tuning knob.

(`forward_to_peer`, a pubkey fan-out, exists only for the internal Pi↔Pi mesh
plane — it is never used for App↔Pi frames.)

---

## No public relay — self-host

**un-bien ships with no default relay and runs no shared infrastructure.** You
host your own (below), which keeps the relay operator role in your hands. The
extension reports its relay as `unset` and refuses to connect until you point it
at one with `/unbien set-relay <url>`.

### Security considerations

Messages are protected in two ways:

- **TLS (SSL)** — the WebSocket connection is encrypted in transit.
- **Ed25519 connection key** — challenge-response authenticates possession of the
  announced connection key. It does not itself prove App pairing or authorize every
  route.

App↔Pi pairing and room addressing are client protocol responsibilities. Pi→Pi
forwarding has separate Relay route eligibility: any correctly signed Owner blob
must directly list both Pi keys. This does not prove that the Owner paired with
or controls either Pi, and is not a stronger trust guarantee.

The shipped Relay never decodes the outer `ct` and does not log or persist message
traffic. That implementation behavior is not an end-to-end trust boundary: the
relay operator controls the TLS endpoint, executable, and host, and a compromised
or malicious operator could replace or instrument the service to inspect or retain
traffic. Pi→Pi envelope content is also parsed transiently in the Relay process for
routing and authorization.

**If you handle sensitive work — private code, credentials, proprietary data — we
strongly recommend running your own relay.**

---

## Self-hosted relay (recommended for privacy)

Running your own relay removes the shared Relay operator from the trust path and
places the TLS endpoint, executable, and storage under infrastructure you control.

### Docker (quickest)

```bash
# Build the image from this crate, then run it:
docker build -t un-bien-relay .
docker run -d \
  --name un-bien-relay \
  -p 3000:3000 \
  -v un-bien-data:/data \
  --restart unless-stopped \
  un-bien-relay
```

The relay listens on a **single port** (`3000` by default) and serves three
surfaces at once:

- `GET /` — WebSocket upgrade (the peer protocol)
- `GET /health` — health check (returns `200 OK`)
- `GET / POST /mesh/<owner_pk_hash>` — signed membership versions

Point your app and extension to `ws://<your-server-ip>:3000` (or `wss://`
if you put it behind a TLS-terminating reverse proxy such as Caddy or nginx).

**`/data` volume**: the relay stores its SQLite database (signed membership
versions) at `/data/mesh.db` inside the container. Mount a named volume (as in
the example above) or a host directory (`-v /srv/un-bien:/data`) so the state
survives `docker rm` and image upgrades. Without a mount, the database is
recreated empty each time the container starts and clients re-publish their
state at the next mutation.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `UNBIEN_RELAY_PORT` | `3000` | TCP port that serves the WebSocket upgrade, `/health`, and `/mesh/*` (all on the same port) |
| `UNBIEN_MESH_DB_PATH` | `/data/mesh.db` in Docker · `data/mesh.db` (cwd-relative) for bare-metal builds | Path to the SQLite database that stores signed membership versions. The parent directory is created automatically on first boot. The Docker image presets this to `/data/mesh.db` and declares `/data` as a volume — see the volume note above |
| `RUST_LOG` | *(none)* | Log level filter — e.g. `info`, `debug`, `warn` |

Example with a custom port and logging (volume mount is the same):

```bash
docker run -d \
  --name un-bien-relay \
  -p 8080:8080 \
  -v un-bien-data:/data \
  -e UNBIEN_RELAY_PORT=8080 \
  -e RUST_LOG=info \
  --restart unless-stopped \
  un-bien-relay
```

### Mesh membership endpoint

The `/mesh/<owner_pk_hash>` endpoint stores **Owner-signed** lists of Pi keys,
keyed by `sha256(owner_pk)` in lowercase hex. It enables an app on a new device
(same Apple ID / Google account) to recover its peer list automatically after
restoring the Owner Ed25519 key from iCloud Keychain / Block Store.

The relay verifies every `POST` against the embedded `owner_pk` using Ed25519
and only accepts versions strictly greater than the current one (monotonic).
Bodies are capped at 500 KB. The relay does not create membership: it stores the
Owner-signed authorization metadata and treats Pi A↔B as route-eligible when any
correctly signed Owner blob directly lists both keys, without transitive
authorization across blobs. This does not prove that the Owner paired with or
controls either Pi, and is not a stronger trust guarantee. The shipped POST
endpoint prevents an unprivileged caller from modifying a particular Owner slot
without that Owner private key. This is not protection against Relay/operator
compromise: an operator controls the executable and SQLite authorization state.
A positive authorization cache entry can delay a revocation for at most 60
seconds; negative sender misses are cached for 1 second, and the cache is bounded.

**Self-hosting note**: the SQLite database at `UNBIEN_MESH_DB_PATH`
(`/data/mesh.db` inside the official Docker image) is your operational
responsibility — make sure `/data` is on a persistent volume and back it up
alongside any other server state. If you lose it, clients re-publish their
current view at their next mutation.

**Storage layout**: SQLite runs in the default rollback-journal mode (NOT
WAL), so only `mesh.db` persists. During a write transaction a transient
`mesh.db-journal` may appear in the same directory and is deleted on commit.
Both files live under `UNBIEN_MESH_DB_PATH`'s parent directory — typically
`/data/` in Docker or `data/` next to the binary on bare metal. The directory
is created automatically on first boot. This database contains membership
authorization metadata only, never message traffic.

For upgrades, deploy Relay 0.3 first: old Extensions can consume its UUID
errors. Then coordinate the Extension 0.6 rollout and minimize mixed old/new
Extensions because mixed wire-label interoperability is deferred. Extension
0.6's old-Relay error shim is for an old Relay or Relay rollback, not the reason
Relay-first is safe. The centralized rollout gates are in
Plan 51.

### Behind a reverse proxy (HTTPS/WSS)

For production use, put the relay behind a TLS-terminating proxy. Example Caddy config:

```
relay.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Then set your app and extension relay URL to `wss://relay.yourdomain.com`.

---

## Building from source

```bash
cargo build --release
./target/release/un-bien-relay
```

```bash
UNBIEN_RELAY_PORT=8080 RUST_LOG=info ./target/release/un-bien-relay
```

## Running tests

```bash
cargo test
cargo clippy -- -D warnings
```
