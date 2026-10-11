# Relay Peering — Cross-Relay Federation

**Status:** implemented (relay 0.7.5+, Phases 3a–3c + Phase 4).  
**Use case:** "ship work to another machine" — an agent on host A (relay A)
can `agent_send` to an agent on host B (relay B), where A and B each run
their own relay. Same owner (same opk), different machines (different epks).

## Architecture

```
  Host A                    Host B
  ┌─────────────┐           ┌─────────────┐
  │ Pi A (epk_A) │           │ Pi B (epk_B) │
  │   ↓           │           │   ↓           │
  │ Relay A       │←─ WS ─→│ Relay B       │
  │  (100.x:3000) │  peering │  (100.y:3000) │
  │  /relay-peer  │  (port   │  /relay-peer  │
  └─────────────┘   3100+)  └─────────────┘
        ↑                           ↑
        └───── app (opk) ──────────┘
         (paired with both, publishes
          mesh_versions to both)
```

Each relay runs its own instance. The relays connect to each other over
WebSocket at the `/relay-peer` endpoint, verify shared ownership, exchange
session lists, and forward pi envelopes cross-relay. The app pairs with
each machine independently; the federation is transparent to the app for
transcript access and to the extension for agent-level mesh sends.

## Setup

### 1. Pair two relays (pairing URL)

Each relay has its own Ed25519 identity (generated on first run, stored in
`~/.local/state/un-bien/relay-keypair.json`). To pair two relays, one issues
a pairing URL + the other consumes it:

```sh
# On host A — issue a pairing URL
unbien relay pair ws://100.x.x.x:3000 --name hostA
# → Relay pairing URL:
# →   relay-pair://eyJ1cmwiOiJ3czovLzEwMC54...
#
# Copy this URL + run on the peer relay:
#   unbien relay peer add relay-pair://eyJ1cmwiOiJ3czovLzEwMC54...

# On host B — consume the pairing URL (pins hostA's pubkey)
unbien relay peer add relay-pair://eyJ1cmwiOiJ3czovLzEwMC54...
# → peer added: hostA -> ws://100.x.x.x:3000 (pubkey pinned)
# → Restart the relay to connect.
```

The pairing URL is a base64 blob: `{url, name, pubkey}`. The consuming
relay stores the peer's pubkey in `relay-peers.json` for pinning. On
connect, the relay verifies the peer's identity (pubkey matches + signature
valid) in addition to the shared-owner check.

**Legacy (no pinning):** `unbien relay peer add <url> <name>` still works
— the relay connects with shared-owner verification only (no pubkey
pinning). Use the pairing URL for the stronger identity verification.

### 2. Set the relay's own name + URL (for the pairing URL exchange)

The relay's own name + URL are used in `relay_hello` (so the peer can
connect back for symmetric peering) + in the pairing URL:

```sh
UNBIEN_RELAY_NAME=hostA UNBIEN_RELAY_URL=ws://100.x.x.x:3000 unbien-relay
```

### 3. Ensure shared owner identity

Both relays need the same owner's `mesh_versions` blob (listing all the
owner's machines' epks). This happens automatically if the app is paired
with machines on both relays — the app publishes `mesh_versions` to each
relay it's connected to.

For **non-keychain owner identity sync** (same opk on multiple devices):

- `identity.storage: "file"` → sync `~/.local/state/un-bien/identity.json`
  across devices (iCloud Drive, Syncthing, rsync).
- `identity.storage: "keychain"` → use iCloud Keychain to sync the
  keychain entry across devices.
- If not syncing: each device has its own opk → different owners →
  cross-relay sends are `not_authorized` (correct — they're different
  owners).

## Wire protocol

All frames are JSON text messages over the relay-to-relay WebSocket
connection at `/relay-peer`.

### Federation handshake

```
A → B:  {"type":"relay_hello","owners":[...],"relay_pubkey":"base64","relay_name":"hostA","relay_url":"ws://...","nonce":"base64","sig":"base64"}
B → A:  {"type":"relay_hello_ack","federate":true,"owners":[...],"relay_pubkey":"base64","relay_name":"hostB","relay_url":"ws://...","nonce":"base64","sig":"base64"}
```

Two layers of auth:

1. **Shared-owner verification** — both relays exchange their known owner
   public-key hashes (SHA-256 of the owner's opk, from `mesh_versions`). If
   the hash sets intersect (shared owner), `federate: true`. If no common
   owner, `federate: false` + disconnect. **The opk is the trust basis** —
   no shared secret, no token.
2. **Relay identity verification** — each relay includes its Ed25519 public
   key + a signature (over `nonce|pubkey|name|url`) proving possession of
   the private key. If the peer's pubkey is pinned in the config (from the
   pairing URL), the relay verifies it matches + the signature is valid.
   If not pinned, the signature is still verified (proof of possession).

The `relay_url` field enables the URL exchange — the peer relay learns the
connecting relay's URL + can connect back for symmetric peering.

### Session list exchange

```
A → B:  {"type":"relay_peer_list","relay_name":"hostA","rooms_by_epk":{"<epk_A>":[{room_id,...},...]}}
B → A:  {"type":"relay_peer_list","relay_name":"hostB","rooms_by_epk":{"<epk_B>":[{room_id,...},...]}}
```

Each relay sends its **local** rooms (pis connected to that relay), keyed
by epk. Only local rooms are advertised — no transitive knowledge (relay
C does not re-advertise relay B's peers to relay A). This means each epk
appears from exactly one relay (unless a pi is multi-homed — connected to
multiple relays).

### Incremental updates

```
A → B:  {"type":"relay_peer_update","relay_name":"hostA","action":"add","epk":"<epk>","room":{<RoomMeta>}}
A → B:  {"type":"relay_peer_update","relay_name":"hostA","action":"remove","epk":"<epk>","room":{"room_id":"..."}}
```

Sent when a local pi connects (`add`) or disconnects (`remove`). The
receiving relay updates its `FederatedSessions` + broadcasts the updated
`federated_peer_list` to all connected WS clients (apps/extensions).

### Cross-relay forwarding

```
A → B:  {"type":"relay_forward","request_id":"<id>","from_epk":"<epk_A>","target_epk":"<epk_B>","envelope":{...},"visited":["hostA"],"relay_pubkey":"base64","relay_sig":"base64"}
B → A:  {"type":"relay_forward_ack","request_id":"<id>","status":"forwarded"}  // or "unknown_peer"
```

**Authenticated forwarding** — the forwarding relay signs
`(request_id|from_epk|target_epk|visited)` with its Ed25519 keypair. The
receiving relay verifies the signature. Unsigned or invalid-signature
forwards are rejected with `unknown_peer`. No unauthenticated forwarding
is accepted.

When a pi on relay A sends a `pi_envelope` targeting a peer on relay B:

1. Relay A checks `FederatedSessions.relays_for_epk(target)` → finds
   relay B.
2. Relay A sends a `relay_forward` frame with `from_epk`, `target_epk`,
   the verbatim envelope, a `visited` list containing relay A's own name,
   - a signature over the forward's key fields.
3. Relay B receives the forward, verifies the relay signature, checks the
   `visited` list (loop prevention — drops if its own name is present),
   delivers to the local
   pi via `registry.forward_to_peer`, + sends a `relay_forward_ack`.
4. Relay A awaits the ack (5s timeout). `forwarded` → success.
   `unknown_peer` or timeout → `TransportError::UnknownPeer` back to the
   sender.

### Federated peer list push (Phase 4)

```
Relay → all WS clients:  {"type":"federated_peer_list","peers":[{"epk":"<epk>","relay_name":"hostB","rooms":[{<RoomMeta>},...]}]}
```

Broadcast to all connected WS clients (apps/extensions) whenever
federated sessions change. The extension's `bridge.ts` listens for this
frame + calls `BrokerRemote.setFederatedPeers()`, which populates the
`federatedPeers` map so agents can discover + route to cross-relay peers
via `list_peers` + `agent_send`.

Rooms are deduplicated by `room_id` across relays (multi-homed pi case).
The extension deduplicates infos by `(cwd, name)`.

## How it works (end-to-end)

### Discovery

1. Agent A calls `list_peers` → the extension's `BrokerRemote` returns
   local peers + cross-PC siblings + **federated peers** (from the
   `federated_peer_list` push). Federated peers appear as
   `<relayName>:<cwd>@<name>`.
2. Agent A sees Agent B as `hostB:/path/to/cwd@name`.

### Sending

1. Agent A calls `agent_send` with `to: "hostB:/path/to/cwd@name"`.
2. The extension's `BrokerRemote.tryRouteOutbound` parses the address →
   `pcLabel = "hostB"`, `peerName = "/path/to/cwd@name"`.
3. `_routeToFederated` finds the federated epk that has this peer, strips
   the `hostB:` prefix (the target pi's broker routes by the local
   address), + sends via `pi.sendEnvelopeToPi(epk, env)`.
4. Relay A receives the `pi_envelope` with `to_pc = epk_B`. The target
   isn't local → `FederatedSessions.forward_to_federated` tries each
   relay that has epk_B (multi-route fallback) → sends a `relay_forward`
   to relay B.
5. Relay B receives the forward → delivers `pi_envelope_in` to Pi B.
6. Pi B's `BrokerRemote.handleIncoming` → `_handleFederatedIncoming`
   (accepts the sender as a federated peer, addresses are already local)
   → injects into the local broker → Agent B receives the message.

### Same-owner validation

The owner's `mesh_versions` blob lists all the owner's machines (epks).
The app publishes it to **both** relays. So relay A has the full
membership (epk_A + epk_B), and relay B has the same. The
`is_authorized_canonical` check on relay A: sender epk_A + target epk_B
are in the same owner's membership → authorized → forward. Cross-owner →
`not_authorized` → refused.

## Multi-route hardening

| Concern                          | Solution                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Duplicate rooms in peer list** | `federated_peer_list_json` deduplicates rooms by `room_id` across relays. The extension's `setFederatedPeers` deduplicates infos by `(cwd, name)`.                    |
| **Multi-route fallback**         | `epk_to_relays` is `HashMap<epk, Vec<relay_name>>` (not single relay per epk). `forward_to_federated` tries each relay's alive senders in order until one succeeds.   |
| **Loop prevention**              | `RelayForward.visited: Vec<String>`. The sending relay adds its own name. A relay that finds its name in the visited list drops the forward + replies `unknown_peer`. |

### Multi-homed pis

A pi connected to both relay B and relay C appears from both relays in
relay A's `FederatedSessions`. The `federated_peer_list` groups by epk
(one entry per epk) + deduplicates rooms by `room_id`. The extension sees
one entry per epk. For forwarding, the relay tries each relay's alive
senders (multi-route fallback). This is intentional — the peer IS
reachable via multiple relays, + the relay picks the best available route.

### No transitive knowledge

The `relay_peer_list` exchange only sends **local** rooms. Relay C does
not re-advertise relay B's peers to relay A. This means:

- Each epk appears from exactly one relay (unless multi-homed).
- No transitive forwarding (A → C → B) in the current design.
- The `visited` list is a safety net for when transitive forwarding is
  added in the future.

## App considerations

Federation changes what the app sees. `rooms_check` on relay A includes
sessions from peer relay B — sessions the app didn't add a relay for.

1. **Per-relay deduplication; cross-relay multiplicity.** On one relay, a
   session appears once (deduplicated by epk + room_id). Across relays,
   the same session may appear once per relay (if the app is connected to
   both). The `peerRelay` field in the `rooms_check` response indicates
   which peer relay the session came from.

2. **Session provenance field.** The app's `LiveSession` gains a
   `peerRelay` field (the peer relay's name, e.g. "hostB") when the
   session is federated. Absent/null = direct. Present = federated
   (indirectly reachable via the directly-connected relay's peering). The
   app renders an indicator + host name from this field.

3. **Forward-compatible.** The current app (without the `peerRelay`
   indicator) treats federated sessions as normal tiles — the
   `peerRelay` field rides along silently (Swift Codable ignores unknown
   keys). No breakage.

4. **No double-add required.** The user does NOT need to add relay B to
   see federated sessions. They appear via relay A's `rooms_check` +
   `federated_peer_list` push.

## Config reference

| Setting              | Location                                    | Default                  | Description                                                                                                                        |
| -------------------- | ------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `relay-peers.json`   | `~/.local/state/un-bien/relay-peers.json`   | empty                    | Per-machine peering config (`{peers: [{url, name, pubkey?}]}`). Managed by `unbien relay peer add/remove/list` or the pairing URL. |
| `relay-keypair.json` | `~/.local/state/un-bien/relay-keypair.json` | auto-generated           | The relay's Ed25519 identity keypair. Generated on first run.                                                                      |
| `UNBIEN_RELAY_NAME`  | env                                         | hostname                 | The relay's own name (for `relay_hello`, `relay_peer_list`, `federated_peer_list` frames).                                         |
| `UNBIEN_RELAY_URL`   | env                                         | empty                    | The relay's own WebSocket URL (for the pairing URL exchange in `relay_hello`).                                                     |
| `UNBIEN_RELAY_PORT`  | env                                         | 3000                     | The relay's listen port.                                                                                                           |
| `UNBIEN_STATE_DIR`   | env                                         | `~/.local/state/un-bien` | State root (mesh.db, relay-peers.json, relay-keypair.json).                                                                        |

## Challenges

- **NAT/firewall:** relay A and relay B need to reach each other. If both
  are on Tailscale, direct (MagicDNS). If not, one needs a public endpoint
  or a DERP-like relay-of-relays.
- **Partial connectivity:** if relay A can reach relay B but not vice
  versa (one-directional NAT), the peering is half-duplex. The outbound
  peering loop reconnects with exponential backoff (1s → 60s).
- **Reconnect:** the outbound peering loop reconnects automatically on
  disconnect. The `Vec<UnboundedSender>` per relay name ensures both
  connections (outbound + inbound) coexist in symmetric peering —
  disconnecting one doesn't kill the other's sender.
