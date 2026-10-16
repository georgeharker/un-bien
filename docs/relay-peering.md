# Relay Peering — Cross-Relay Federation

**Status:** implemented as federation v2 (relay 0.7.40-dev.20261015, the
current dev line). The wire + CLI described here are the as-built v2:
explicit pinned pairing (the one-pair secret flow), machine-signed owner
sets, full transitive host knowledge, and directed hops. The design
rationale is the last section of this document; the implementation
history (slices, as-built decisions, sequencing) lives in the git log
(relay 0.7.35 through 0.7.40).

**Use case:** "ship work to another machine" — an agent on host A (relay
A) can `agent_send` to an agent on host B (relay B), where A and B each
run their own relay. Federation is explicit: two relays talk only after a
human pairs them, and every cross-relay send is owner-checked against
machine-signed data at the source relay.

## Architecture

```text
  Host A                      Host B
  +-------------+             +-------------+
  | Pi A (epk_A)|             | Pi B (epk_B)|
  |   |         |             |   |         |
  | Relay A     | <-- WS -->  | Relay B     |
  | /relay-peer |   pairing   | /relay-peer |
  +-------------+  (pinned   +-------------+
        ^           pubkeys)        ^
        |                           |
        +------- app (owner) ------+
          (paired with machines on both relays;
           sees federated rooms)
```

Each machine runs its own relay. Paired relays connect to each other over
WebSocket at `/relay-peer`, verify pinned Ed25519 identities, exchange
session lists (including everything they learned from other paired
relays), and forward envelopes cross-relay. The app pairs with each
machine independently; federation is transparent to the app for
transcript access and to the extension for agent-level mesh sends.

## Prerequisites

### Install (on each machine)

```sh
# Extension + launcher + CLI (npm dev channel)
npm i -g @geohar/un-bien@dev @geohar/un-bien-launcher@dev @geohar/unbien-cli@dev

# Relay (crates.io dev line — note: un-bien-relay, with hyphens)
cargo install un-bien-relay --version 0.7.40-dev.20261015 --locked
```

Or: `unbien-admin install all` — installs/updates the launcher daemon
service **and its npm package** (the package is otherwise never updated;
the service runs whatever is on disk), the CLI, and the relay (picking
the channel from the extension build), then re-kicks both services.

### Set `UNBIEN_RELAY_URL` — required for federated relays

The relay's **externally-reachable** WebSocket URL. The relay typically
binds `0.0.0.0` (all interfaces), which makes the reachable address
underivable from the socket — so it must be told. The URL is
**load-bearing** for federation v2:

- `relay_hello` advertises it so the peer relay can dial back for
  symmetric peering,
- the one-pair auto-add records the presenter's advertised URL for
  dial-back (`peers_config.rs`).

Canonical example (Tailscale MagicDNS FQDN):

```xml
<!-- ~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist,
     inside <EnvironmentVariables> -->
<key>UNBIEN_RELAY_URL</key>
<string>ws://hostA.tailnet.ts.net:3000</string>
```

The relay's _name_ is auto-computed from the system hostname (override
with `UNBIEN_RELAY_NAME`).

**What happens if you skip it.** `unbien relay pair` has a CLI fallback
(explicit arg > `UNBIEN_RELAY_URL` > `UNBIEN_RELAY`, with
`0.0.0.0`/`localhost` rewritten to the hostname and `http://` to `ws://`,
then the first remembered relay), so the _pairing URL_ still mints a
dialable address. But the fallback covers the CLI mint only — the
relay's own `relay_hello` advertisement reads `UNBIEN_RELAY_URL` alone
(`relay_own_url()`, peering.rs). The failure signature in the issuer's
relay log:

- **relay < 0.7.39:** repeated `pairing_missing_name_or_url` declines —
  the pairing could not complete at all.
- **relay >= 0.7.39:** a warn ("pairing hello has no relay_url
  (UNBIEN_RELAY_URL unset on the presenter)") and the auto-add **inherits
  the existing entry's URL** — the pairing lands, but dial-back for that
  peer is degraded until the presenter's env is fixed and it re-appears
  with a URL.

**Reachability:** the URL must be reachable from the other machine
(Tailscale MagicDNS, LAN, or public). NAT/firewall concerns are the same
as for any relay-to-relay connection; both directions dial, so one-way
reachability yields half-duplex peering with reconnect backoff (1s-60s).

After editing the plist, restart the relay once:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist
```

## Enable federation

Federation is **opt-in per relay**. The gate is `federation.enabled` in
the relay's config (`~/.config/un-bien/relay.json`; legacy fallback: the
same flag in `relay-peers.json`). While disabled the relay refuses
`/relay-peer` with an explicit HTTP 403 and never starts its outbound
peering loops.

```sh
unbien relay peer federation on    # on|off|status — flips relay.json, live
```

The relay re-reads the flag fresh on every use — no restart needed.
`unbien relay peer add` auto-enables it. This is the _perimeter_ gate;
the content gates below are enforced inside, per send, once peers are up.

## Pair two relays (the one-pair flow)

Each relay has its own Ed25519 identity (generated on first run, stored in
`~/.local/state/un-bien/relay-keypair.json`). One pairing action
configures **both directions**:

```sh
# On host A — mint a pairing URL (alias: unbien relay peer pair)
unbien relay pair
# -> Relay pairing URL:
#      relay-pair://eyJ1cmwiOiJ3czovL2hvc3RBLi4u
#
# The URL is a base64 blob: {url, name, pubkey, secret} — the issuer's
# identity plus a random 32-byte one-time secret, held as a pending
# entry in relay-peers.json. (Also on stdout — pipe to pbcopy.)

# On host B — consume it
unbien relay peer add relay-pair://eyJ1cmwiOiJ3czovL2hvc3RBLi4u
# -> peer added: hostA -> ws://hostA:3000 (pubkey pinned, pairing
#    secret held). The relay connects within ~5s — no restart needed.
```

What happens on the wire (`peers_config.rs`, `peering.rs`):

1. Host B's relay dials host A and presents the `pair_secret` in its
   `relay_hello`, with an identity signature proving possession of its
   own key.
2. Host A matches the secret against an outstanding pending entry
   (SHA-256 compare, **single-use**), verifies the presenter's identity
   signature, and **auto-adds the presenter** — pinned to the presented
   key, keyed by the presented name, URL taken from the presenter's
   advertisement — consuming the pending entry in one atomic config
   write.
3. The fswatch loop sees the new pinned peer and dials it. Both
   directions are now live and mutually pinned.

Reconnects survive: the secret is spent after the first pairing, and a
paired peer re-presents it on every reconnect — a spent/unknown secret
simply falls through to the pin gate (`federate` decided by the pinned
pubkey), so the link stays up across relay restarts.

### Pending invitations: single-use, 24h TTL

- A pending invitation is **single-use**: the first successful
  presentation consumes it.
- It **expires after 24h**; expired entries are swept from
  `relay-peers.json`. `unbien relay peer list` marks them
  (`[EXPIRED — re-mint with unbien relay pair]`) and never prints
  secrets.
- **Re-minting replaces**: `unbien relay pair` again for the same name
  upserts the pending entry — the old secret dies with it. Re-issuing IS
  revocation.

### Dual-direction manual pairing (alternative)

The one-pair flow is the default UX, not a constraint. To pair manually
in both directions, mint a URL on **each** relay and consume the _other's_
on each. A secret-less pairing URL (e.g. hand-stripped, or minted by an
older CLI) still pins the pubkey — the pin is the durable trust; the
secret only bootstraps the auto-add.

**Legacy command refused:** `unbien relay peer add <url> <name>` no longer
works — pinned pairing is mandatory and the pin comes from the pairing
URL. The CLI points you at the pairing-URL flow.

## Per-machine participation (extension)

The relay's `federation.enabled` is the master opt-in; each machine can
additionally refuse to participate via the extension config
(`~/.config/pi/agent/extensions/un-bien.json`):

```json
{ "mesh": { "federation": false } }
```

Tools on + federation off = local/same-relay mesh only (no cross-relay
discovery, routing, or inbound). Default true. Both gates are required
end-to-end: relay gate off = no relays federate; machine gate off = that
machine's agents neither see nor accept federated peers. Restart pi on a
flip.

## Verify federation

```sh
# Gate state + peers + pending invitations
unbien relay peer list

# The relay logs (both machines) should show:
#   "federated with peer relay (explicitly paired: pinned key verified)"
#   "PAIRING: valid pending secret — peer AUTO-ADDED (pinned) ..."
tail -20 ~/.local/state/un-bien/relay.log | grep -i federat

# From a pi session on host A:
#   list_peers  -> host B's agents appear as hostB:<cwd>@<name>
#   agent_send  -> reaches agents on host B
```

## How it works end-to-end

### Discovery

1. Each relay advertises, on every paired link, its own rooms and
   machines **plus everything it learned from other paired relays** —
   origin-tagged, never back to the arrival link, self-origin filtered
   (`advertisement_segments`, peering.rs). With relay >= 0.7.35 this is
   full transitive host knowledge: A-B-C chained relays all know every
   host in the paired network.
2. The relay pushes the merged view to all connected WS clients as
   `federated_peer_list` (`peers` keyed by epk with the ORIGIN relay's
   name in `relay_name`; rooms deduplicated by `room_id` across
   relays).
3. The extension's relay listener populates `federatedPeers`, so agents
   see remote machines as `<relayName>:<cwd>@<name>` in `list_peers`.

### Sending

1. Agent A calls `agent_send` with `to: "hostB:/path/to/cwd@name"`; the
   extension routes it to the federated epk (strips the `hostB:`
   prefix) and sends a `pi_envelope` with `to_pc = epk_B`.
2. Relay A authorizes at the SOURCE (content gates below), then sends a
   signed `relay_forward` — directly to relay B, or onward via the
   advertisement-implied route if B is only reachable through another
   paired relay. Each hop re-signs; the `visited` list is the loop
   guard.
3. Relay B delivers `pi_envelope_in` to Pi B and acks
   `relay_forward_ack` — acks return verbatim along the delivery path
   (a bounded request_id-to-backlink map at each hop). 5s timeout,
   `unknown_peer` back to the sender on refusal or timeout.

### The app

`rooms_check` on relay A includes sessions from peer relays, one `rooms`
frame per epk with all its federated rooms plus a `peerRelay` field
naming the origin relay — the app renders its federated-session
indicator from this. The user does NOT need to add relay B in the app:
federated sessions appear through any directly-connected relay.

## Wire protocol

All frames are JSON text over the relay-to-relay WebSocket at
`/relay-peer`. Protocol version 2 (`fed_proto: 2`, relay >= 0.7.35):
segmented transitive advertisement + onward hops. Absent `fed_proto` = 1
(old peers: single local-only `relay_peer_list` frame, direct hops) —
the exchange degrades cleanly in both directions.

### Handshake and the link gate

```text
A -> B: {"type":"relay_hello","owners":[...],"relay_pubkey":"b64",
         "relay_name":"hostA","relay_url":"ws://...","nonce":"b64",
         "sig":"b64","pair_secret":"b64?","fed_proto":2}
B -> A: {"type":"relay_hello_ack","federate":true,"owners":[...],
         "relay_pubkey":"b64","relay_name":"hostB","relay_url":"ws://...",
         "nonce":"b64","sig":"b64","fed_proto":2}
```

- **The link gate is explicit pairing — pinned pubkeys, strict.** A peer
  federates only when (a) it presents a valid single-use pairing secret
  held in the issuer's `relay-peers.json` `pending` list (the one-pair
  auto-add, which pins exactly the presented key), or (b) its presented
  pubkey is already pinned in the receiver's `peers` list. Identity
  signatures (over `nonce|pubkey|name|url`) are mandatory on both paths
  — unverifiable possession never passes. Pin matching is by PUBKEY, not
  name (a renamed peer still matches its pin).
- **Shared-owner intersection is observability only.** The `owners`
  fields (SHA-256 hashes of owner pubkeys from `mesh_versions` +
  `pairing_set` pushes) stay on the wire and are logged, but pairing
  decides the link.
- Outbound, a configured peer without a pinned pubkey is not dialed (one
  loud warn per peer); inbound, an unpinned presenter is declined with a
  **named reason** on the ack:

| `reason`                      | Meaning                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unpinned_peer`               | Presenter's key is not pinned (and no valid pairing secret matched).                                                                                        |
| `pairing_secret_unknown`      | (Legacy decline for a wrong/unknown secret — pre-0.7.38; a SPENT secret now falls through to the pin gate, so this fires only for a genuinely wrong token.) |
| `pairing_identity_missing`    | Pairing hello without identity fields (pubkey/nonce/sig).                                                                                                   |
| `pairing_identity_invalid`    | Pairing hello identity signature failed verification.                                                                                                       |
| `identity_missing`            | Pinned-peer hello missing the identity signature.                                                                                                           |
| `identity_invalid`            | Identity signature invalid.                                                                                                                                 |
| `pairing_missing_name_or_url` | Presenter had no relay_name (hard decline) — pre-0.7.39 this also fired for a missing URL; >= 0.7.39 a missing URL is a warn + URL inheritance instead.     |

### Advertisement: per-origin segments

```text
A -> B: {"type":"relay_peer_list","relay_name":"<origin>","rooms_by_epk":{...},
         "machine_pairings":[{machine,version,blob,sig},...],"done":false}
A -> B: ... one segment per origin ...
A -> B: {...,"done":true}     <- last segment
```

- The **self segment is always first** (own local rooms + own machines'
  machine-signed pairing sets + the sender's signed peer-pairing doc);
  older peers that read exactly one frame get exactly the old behavior.
- Then one segment per known origin — everything learned from other
  peers, origin-tagged, never the peer its own data back, never back to
  the link it arrived on. Self-origin advertisements are ignored by a
  relay that is named in them (propagation terminates).
- A `done: true` marker ends the sequence; absent marker = single-frame
  advertisement (protocol 1).

### Incremental updates

```text
{"type":"relay_peer_update","relay_name":"<origin>","action":"add"|"remove",
 "epk":"<epk>","room":{<RoomMeta> | {"room_id":"..."}}}

{"kind":"relay_pairings_update","origin":"<origin>","machine":"<epk>",
 "version":<n>,"blob":"b64","sig":"b64"}
```

Sent when a local pi connects/disconnects or a machine pushes a new
`pairing_set`. Origin-tagged; re-advertised onward minus the arrival
link. The pairing exchange is **machine-signed** — transit advertisement
cannot forge owner sets (the blob+sig are re-advertised verbatim; only
the machine can sign).

### Forwarding

```text
A -> B: {"type":"relay_forward","request_id":"<id>","from_epk":"...",
         "target_epk":"...","envelope":{...},"visited":["hostA"],
         "relay_pubkey":"b64","relay_sig":"b64"}
   (outer-envelope form: room + ct instead of envelope)
B -> A: {"type":"relay_forward_ack","request_id":"<id>","status":"forwarded"|"unknown_peer"}
```

- **Authenticated forwarding:** the immediate sender signs
  `(request_id + from_epk + target_epk + visited)` with its Ed25519
  keypair; the receiver verifies per hop. Unsigned or bad-signature
  forwards are refused (`unknown_peer`).
- **Loop guard:** a relay that finds its own name in `visited` drops the
  forward.
- **Onward hops:** a target that is not local is forwarded on the
  advertisement-implied route (target epk -> origin -> via link),
  re-signed by this relay, `visited` + own name. The dest's ack returns
  verbatim along the delivery path via a bounded request_id-to-backlink
  map. A route miss is refused and logged loudly — never fanned out.
- Verified inbound forwards also teach the reply route for app epks
  (`learn_route`, purged with the link).
- Multi-route fallback: an epk reachable via several relays is tried in
  order until one acks.

### Federated peer list push

```text
Relay -> all WS clients: {"type":"federated_peer_list","peers":[
  {"epk":"...","relay_name":"<origin>","rooms":[{...},...]}]}
```

Broadcast to all connected apps/extensions on every federated-session
change. Rooms are deduplicated by `room_id` across relays; the extension
deduplicates infos by `(cwd, name)`. Multi-homed pis (connected to two
relays) appear once per epk with the rooms merged.

## Trust model and content gates

Two planes, one rule, decided at the **source** relay with
**machine-signed owner sets**, strict on unknown:

**sender's owner set INTERSECT target's owner set != empty**

- **Owner sets** are the `pairing_set` pushes each machine makes to its
  relay — a machine-signed envelope `{machine_pk, owners, version}`
  (`pairing.rs`), verified by the relay, version-monotonic, fail-closed
  (an unconfigured machine permits no one). The extension pushes on
  connect and on every pairing change; the app pushes a self-signed set
  naming the owner its device belongs to (federated replies to the app
  are refused until it has).
- **Agent plane (pi -> pi):** `authorize_send`'s federated branch
  (membership.rs) intersects the sender's local machine-signed owner set
  with the target's advertised machine-signed owner set (exchanged at
  handshake + incremental pushes). Either side unknown/empty => refuse
  (`not_authorized`). No machine exemptions — a machine IS its owner
  set.
- **Outer plane (app -> machine):** the check-before-forward SRC gate
  (handlers/peer.rs) applies the same matrix: dest owner set unknown =>
  refuse for all senders; known => the sender is an owner device listed
  in the dest's set, or a machine whose owner set intersects it. Pairing
  frames are exempt so a device can bootstrap trust with a federated
  machine.
- The deciding relay is ALWAYS the source; the dest relay never
  re-refuses on its own (possibly stale) view. A known federated machine
  with a dead room still drops silently; an entirely unknown dest gets a
  routed `unknown_peer` refusal.

A cross-owner send surfaces to the sender as a transport error
(`not_authorized` / `unknown_peer`), and gate refusals log at warn in the
source relay's log — the #1 live-debugging signal.

## Config reference

| Setting              | Location                                    | Default                  | Description                                                                                                                                                    |
| -------------------- | ------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.json`         | `~/.config/un-bien/relay.json`              | absent                   | Relay settings: `federation.enabled` (the gate). Written by `unbien relay peer federation on\|off`. Legacy fallback: the flag in `relay-peers.json`.           |
| `relay-peers.json`   | `~/.local/state/un-bien/relay-peers.json`   | empty                    | Per-machine peering state: `peers` (pinned: url, name, pubkey, pair_secret?), `pending` (outstanding invitations). Managed by the CLI + the one-pair auto-add. |
| `relay-keypair.json` | `~/.local/state/un-bien/relay-keypair.json` | auto-generated           | The relay's Ed25519 identity keypair.                                                                                                                          |
| `UNBIEN_RELAY_NAME`  | env                                         | hostname                 | The relay's own name (handshake, advertisement origins, `federated_peer_list`).                                                                                |
| `UNBIEN_RELAY_URL`   | env                                         | empty                    | The relay's own externally-reachable URL. **Required for federation** — advertised in `relay_hello` + recorded by the pairing auto-add.                        |
| `UNBIEN_RELAY_PORT`  | env                                         | 3000                     | The relay's listen port.                                                                                                                                       |
| `UNBIEN_STATE_DIR`   | env                                         | `~/.local/state/un-bien` | State root (mesh.db, relay-peers.json, relay-keypair.json).                                                                                                    |

## Troubleshooting

### Peering declines (named reasons in the dialing relay's log)

- **`unpinned_peer`** — the presenter's key is not pinned and carried no
  valid pairing secret. Pair it properly: mint on the peer
  (`unbien relay pair`), consume here
  (`unbien relay peer add relay-pair://...`). Legacy
  `peer add <url> <name>` is refused by design.
- **`pairing_missing_name_or_url` (repeated, pre-0.7.39)** /
  **"pairing hello has no relay_url" warn (>= 0.7.39)** — the presenter
  lost/never had `UNBIEN_RELAY_URL`. See Prerequisites: set it in the
  relay's plist and restart the relay.
- **`identity_invalid` / `pairing_identity_invalid`** — the presenter's
  relay identity signature failed. That is either a version mismatch
  (upgrade both relays) or a genuinely different key claiming the name —
  re-pair.
- **403 on `/relay-peer`** — federation is disabled on the answering
  relay (`federation.enabled` false/absent).
  `unbien relay peer federation on`.

### Content-gate refusals (sender sees `not_authorized` / `unknown_peer`)

Check the SOURCE relay's log for `SRC gate REFUSED` / authorization
warnings. The usual causes: the target machine's owner set has not been
exchanged yet (a pi session must be running on the target machine so its
extension pushes `pairing_set` — the set then propagates at the next
handshake/pairing push), or the sender and target genuinely share no
owner. The app's federated replies need the app's own pairing_set push —
reconnect the app if replies to it are refused.

### Installed but still running old code (package != process)

launchd keeps the OLD image loaded until restarted. After a manual
`cargo install` / `npm i -g`, kick the services:

```sh
launchctl kickstart -k gui/$(id -u)/com.georgeharker.unbien.relay
launchctl kickstart -k gui/$(id -u)/com.georgeharker.unbien.launcher
```

`unbien-admin install [all|relay|launcher|cli]` does this for you (it
re-kicks BOTH services on every install, and updates the launcher npm
package too).

### Rooms appearing late / only the first room of a federated machine

Fixed in relay 0.7.40: `rooms_check` previously emitted one `rooms` frame
PER ROOM for federated machines, and the CLI resolves on the FIRST
matching frame and drops the rest — so `connect --list` and remote-launch
handoffs only ever saw a federated machine's first room while the app
(whose `federated_peer_list` push was grouped correctly) saw them all.
0.7.40 serves ONE frame per epk with all grouped rooms. Symptom gone =
upgrade; if it recurs, check the relay version (`unbien-relay --version`)
and that the running service matches it (kickstart above).

### Remote sessions launch with an empty environment

The launcher daemon runs under launchd, which strips the login-shell
environment. The shell remote launches run through resolves as:
config `launch.shell` -> `$SHELL` -> the OS login shell (`dscl ... -read
.../Users/$USER UserShell`; launchd strips `$SHELL` too, so the OS is the
only reliable source) -> `zsh`. If a user's dotfiles only load under a
non-default shell, set `launch.shell` in the extension config.

### NAT / partial connectivity

Both relays dial each other, so one-directional reachability yields
half-duplex peering: the outbound loops reconnect with exponential
backoff (1s-60s). Tailscale (MagicDNS) is the canonical answer; otherwise
one relay needs a public endpoint. Disconnecting one direction of a
symmetric pair does not kill the other's sender — the two connections
coexist per relay name.

## Design rationale

Why v2 replaced the original federation model (relay 0.7.5 through
0.7.34-dev). The shipped protocol answers each of three posts the
original model rested on, none of which matched the intent "all relay
comms via an explicitly paired machine key, or a paired mesh + explicit
pairing on that mesh, transitively":

1. **Shared-owner hash intersection could not authenticate anything.**
   Owner pubkey hashes are public, client-assertable material — any
   authenticated key can push a self-consistent `pairing_set` naming
   arbitrary owner pubkeys, injecting hashes into the relay's trust
   roots. A pinned relay key is proof an operator ran `relay pair` on
   that machine; an owner hash is proof of nothing. Hence: pinning is
   the link gate, the owner binding moves to the machine-signed content
   layer, and the `owners` handshake fields stay for observability only.
   Cross-owner relay pairing is possible when the machines' owner sets
   intersect — the model the mesh already speaks.

2. **Federated sends must check the target, at the source.** The old
   gate asked only "is the sender a valid local member" — nothing
   decided whether the TARGET machine trusts the sender's owner. The
   one-pair secret is a one-time token (not a key — the
   relay-holds-no-private-keys invariant holds); dual-direction manual
   pairing remains available.

3. **Content gates are one rule over machine-signed sets, both planes,
   decided at the source.** Sender-owner intersect target-owner,
   non-empty, strict on unknown; no machine exemptions (a machine IS
   its owner set). The deciding relay is always the SOURCE using
   freshly exchanged sets — the dest never re-refuses on its own stale
   view (the 9779b88 lesson).

4. **Transitive knowledge, directed frames.** All hosts become
   transitively known: metadata gossips (origin-tagged, never back to
   the arrival link, self-origin filtered), frames route directed
   (advertisement implies route; onward hops re-sign per hop and
   return acks along the delivery path via id→backlink; `visited` is
   the loop guard). A route miss is refused and logged loudly — never
   fanned out: with a complete route table, directed forwarding has no
   steady-state misses, so the flood fallback the design once floated
   proved unnecessary.

Kept from the original: per-hop forward signatures, the `visited` loop
guard, the machine-signed pairing exchange (now load-bearing
authorization data), the peer-doc protocol (observability), and the
`federated_peer_list` discovery push.
