# un-bien environment variables

All knobs, one page. Status marks: **live** = honored by the running code,
**landing** = part of an in-flight change (design noted).

## State & location

### `UNBIEN_STATE_DIR` _(landing — design 01M1CB6Q)_

The state root for everything that is **not config**: the extension's logs
(`envelope-debug.log`, `panel-bridge.log`), locks, sessions dir, deployed
skills, `peers.json` (pairing trust — survives migration deliberately), and
the relay's `mesh.db` + `relay.log` (the relay honors this same root).

Resolution order (first match wins):

```
UNBIEN_STATE_DIR > UNBIEN_DIR > UNBIEN_HOME > ${XDG_STATE_HOME:-~/.local/state}/un-bien
```

Config is intentionally NOT here — it stays at
`<PI_CODING_AGENT_DIR>/extensions/un-bien.json` (see `PI_CODING_AGENT_DIR`
below). A one-time migration moves old `~/.pi/un-bien` contents into the
resolved root (move-old-if-new-absent; never throws; `peers.json` carried).

### `UNBIEN_DIR` _(live, legacy)_

Absolute override of the state dir itself (pre-`UNBIEN_STATE_DIR` knob, kept
for the test suites). Lower precedence than `UNBIEN_STATE_DIR`.

### `UNBIEN_HOME` _(live, legacy)_

Stand-in `$HOME`; state lives at `<UNBIEN_HOME>/.pi/un-bien`. Long-standing
test/override knob; lowest precedence of the three.

## Relay

### `UNBIEN_MESH_DB_PATH` _(live)_

Direct override for the relay's room-state database path — wins over
everything, including the state-root derivation. Before the state-dir change
the default was **CWD-relative** `data/mesh.db` (the relay's DB location was
an accident of its launch directory — three stray `mesh.db` files existed on
disk because of it); the new default derives from the state root.

### `UNBIEN_RELAY_PORT` _(live)_

Relay listen port. Default: `3000`.

### `RELAY_MAX_CT_MIB` _(live)_

Outer-envelope ciphertext cap, in MiB, enforced by the relay on WS frames.
Default: `4`. Raise only with reason — it is the transport's frame ceiling
(see also the get_entries paging budget, which keeps replies well under it).

### `UNBIEN_RELAY` _(live)_

Relay URL override for the extension (highest precedence over the config
file's `relay` field; used for dev and network moves — e.g. pointing at a
tailscale address).

## Extension mode flags

### `UNBIEN_DAEMON` _(live)_

`1` = headless init: the extension always auto-inits (used by detached
processes like the launcher; interactive sessions gate auto-init on a local
config already existing).

### `UNBIEN_DIRECT_CONFIG` _(live)_

Inline per-cwd config — the env var's value IS the JSON (used instead of a
`<cwd>/.pi/un-bien/config.json` file; useful for detached/headless processes).

## Adopted from pi

### `PI_CODING_AGENT_DIR` _(pi's own)_

Determines the config tree; un-bien's config lives at
`<PI_CODING_AGENT_DIR>/extensions/un-bien.json`. Un-bien does not move config
into the state root by design.

## Dev / test only — do not export in production shells

- `UNBIEN_IDENTITY_SEED` — deterministic identity in tests.
- `UNBIEN_MCP_CWD`, `UNBIEN_MCP_NAME` — mesh MCP server context injection.
- `UNBIEN_RECEIVED_IMAGE_TYPE` — received-image type tag plumbing.
- `RELAY_ID_RE`, `RELAY_RECONNECT_BACKOFFS_MS` — relay test fixtures.
- `UNBIEN_ALLOW_FILE_IDENTITY` — ❌ **REMOVED from un-bien** (see
  `docs/identity.md`): the fail-loud identity-resolver redesign deleted it;
  nothing reads it. Its old silent fallback to a file identity caused the
  2026-08-29 phantom-identity incident (transient Keychain lock → new machine
  identity minted → stale pairing + connection flaps). The headless use case
  it served is now config: `"identity": { "storage": "file" }` in
  `un-bien.json`. If you find it exported anywhere, delete it.

## Related designs

- `01M1CB6Q` — config/state split (`UNBIEN_STATE_DIR`, relay state root).
- `01M1CAW0` — announce-after-sid (the phantom-parent fix; unrelated to env
  vars but contemporaneous).
