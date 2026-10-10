# Relay Peering — Cross-Relay Session Access (Design Sketch)

**Status:** sketch, not under development.  
**Use case:** "ship work to another machine" — an agent on host A (relay A)
can `agent_send` to an agent on host B (relay B), where A and B each run
their own relay. Same owner (same opk), different machines (different epks).

## Today

- Each machine runs its own relay (`unbien-relay` on :3000).
- The app pairs with multiple machines (by epk) across multiple relays.
- Cross-machine mesh (`BrokerRemote` + `PiForwardClient`) works **within
  one relay** — two machines on the SAME relay can `agent_send` to each
  other.
- Two machines on **different relays** cannot mesh — there's no
  cross-relay forwarding.
- The app can see sessions on all relays (it connects to each +
  `rooms_check`). But the **agents** (pi sessions) can't talk
  cross-relay.

## The gap

Agent A (on host A, relay A) wants to send a message to Agent B (on host
B, relay B). Today this is impossible — relay A doesn't know about relay
B's peers, and there's no relay-to-relay forwarding path.

## Proposed: relay-to-relay peering (federation)

Two relays connect to each other (WebSocket, shared-owner verification) and forward pi
envelopes across — an SMTP-style federation. Each relay advertises its
peers to the other, so `list_peers` on relay A includes relay B's peers
(prefixed `<hostB>:`), and vice versa.

```
  Host A                    Host B
  ┌─────────────┐           ┌─────────────┐
  │ Pi A (epk_A) │           │ Pi B (epk_B) │
  │   ↓           │           │   ↓           │
  │ Relay A       │←─ WS ─→│ Relay B       │
  │  (100.x:3000) │  peering │  (100.y:3000) │
  └─────────────┘           └─────────────┘
        ↑                           ↑
        └───── app (opk) ──────────┘
         (paired with both, publishes
          mesh_versions to both)
```

### How it works

1. **Peering config — separate per-machine file, managed by the CLI.**
   The peering config is NOT in the shared `un-bien.json` (which goes in
   dotfiles + is machine-agnostic). It lives in a **separate per-machine
   file** at `~/.local/state/un-bien/relay-peers.json` (state dir, not
   synced):

   ```json
   [
     { "url": "http://100.y.y.y:3000", "name": "hostB" },
     { "url": "http://100.z.z.z:3000", "name": "hostC" }
   ]
   ```

   The CLI manages it:
   - `unbien relay peer add <url> <name>` — add a peer relay.
   - `unbien relay peer remove <name>` — remove a peer relay.
   - `unbien relay peer list` — list configured peers.

   The relay reads this on startup. On add/remove, the CLI writes the file
   - signals the relay (SIGHUP or restart) to pick up the change.

   Each machine has its OWN peer list — host A peers with B, host B peers
   with A + C, host C peers with B only. Asymmetric peering is fine.

2. **Relay-to-relay auth: shared-owner verification.** Both relays
   already have the owner's opk (from the signed `mesh_versions` the app
   published on pairing). On connect, they exchange their known owner
   public keys — if they share a common owner (same opk), they federate.
   If no common owner, they refuse. **The opk IS the trust basis** — no
   shared secret, no Ed25519 pinning, no token to configure. The user
   just adds the peer relay URL; the shared-owner check is automatic.

3. **Peer discovery exchange.** On connect, relay A and relay B exchange
   their peer lists (addresses + cwds + names). Relay A's `list_peers`
   includes relay B's peers, prefixed `<hostB>:`. Relay B's includes
   relay A's, prefixed `<hostA>:`. The prefix is the peer relay's
   `name` from the peering config.

4. **Cross-relay forwarding.** When Pi A sends to `<hostB>:<peer@B>`:
   - Relay A sees the `<hostB>:` prefix → routes to the peer relay B
     (via the relay-to-relay WS).
   - Relay B receives the envelope → routes to the target Pi B.
   - ACK back: Pi B → relay B → relay A → Pi A.
   - The `BrokerRemote` on Pi A already handles cross-PC routing
     (`tryRouteOutbound`); the relay-to-relay path extends this to
     cross-relay.

5. **Same-owner validation.** The owner's `mesh_versions` blob lists all
   the owner's machines (epks). The app publishes it to **both** relays
   (it's connected to both). So relay A has the full membership
   (epk_A + epk_B), and relay B has the same. The `is_authorized_canonical`
   check on relay A: sender epk_A + target epk_B are in the same owner's
   membership → authorized → forward. Relay B checks again on receipt.
   Cross-owner → `not_authorized` → refused.

6. **Loop prevention.** Each cross-relay envelope carries a
   `visited_relays` list (or a TTL counter). A relay that's already in
   the list drops the envelope. Prevents relay A → relay B → relay A
   loops.

### App considerations

Federation changes what the app sees. Today the app directly adds each
relay + sees only that relay's sessions. With federation, `rooms_check`
on relay A includes sessions from peer relay B — sessions the app didn't
add a relay for. This raises app-side questions:

1. **Desired UX: indirectly reachable sessions show with an indicator +
   host. Per-relay deduplication; cross-relay multiplicity.**
   - **On one relay: a session appears ONCE**, even if multiple
     federated routes exist (e.g. relay A peers with both B and C, and
     both can reach the same session). The relay deduplicates within its
     `rooms_check` (by epk + sessionID) — the app sees one entry per
     session per relay, not one per federated route.
   - **Across relays: the same session MAY appear on another relay too.**
     If the app is connected to relay A (federated with B) AND relay B
     (direct), the session appears once on relay A (with indicator +
     "hostB") AND once on relay B (direct, no indicator). That's two
     entries total — one per relay — not a duplicate within a relay.
   - **The relay picks the route.** If multiple federated peers can
     reach the same session, the relay selects one (the best/first to
     advertise) + records it in the `peerRelay` field. The app doesn't
     see multiple entries for the same session on the same relay.

2. **Session provenance field.** The app's `LiveSession` gains a
   `peerRelay` field (the peer relay's name, e.g. "hostB") when the
   session is federated (arrived via a peer relay's `rooms_check`).
   Absent/null = direct (the session is on a relay the app added
   directly). Present = federated (indirectly reachable via the
   directly-connected relay's peering). The app renders the indicator
   - host name from this field.

3. **Relay list display.** The app's relay list shows the relays the
   user directly added. Federated peer relays aren't in the list — but
   the app could show them under the directly-connected relay as
   "peered relays" (greyed out, with the host name), so the user
   understands the topology + can see which hosts are reachable via
   federation.

4. **Routing transparency.** The relay handles cross-relay forwarding
   transparently for transcript messages (the app addresses the session
   by its room_id on relay A; relay A forwards to relay B). The app
   doesn't need to know about the peering for transcript access. For
   agent-level mesh sends, the `<hostB>:` prefix is needed (the
   extension's `BrokerRemote` handles this).

5. **No double-add required.** The user does NOT need to add relay B to
   see federated sessions. They appear via relay A's `rooms_check`. The
   app could offer "add relay B directly" as a convenience (direct access,
   lower latency, fallback if relay A is down), but it's not required.

**Net: the app needs changes** — the `peerRelay` provenance field, the
indicator + host display for federated sessions, and the "may appear more
than once" multi-path model (don't merge). The relay handles cross-relay
forwarding transparently; the app just shows the provenance. This is an
app change, not just relay/extension.

### Owner identity + non-keychain sync

The **owner** (the paired app) has an owner public key (opk). The app
publishes `mesh_versions` (listing its machines' epks) to each relay it's
connected to. For cross-relay peering to work, **both relays need the
same `mesh_versions`** (with all the owner's machines). This happens
automatically if the app is connected to both relays (it publishes to
each).

The **machine identity** (epk) is per-machine (each machine has its own
Ed25519 keypair). No sync needed — the machines have DIFFERENT epks, and
the mesh_versions lists all of them under the same owner.

**Non-keychain sync (if the user wants the same owner key on multiple
devices):**

- `identity.storage: "file"` → the owner identity is in
  `~/.local/state/un-bien/identity.json`. Sync this file across devices
  (iCloud Drive, Syncthing, rsync) so both devices have the same opk.
- `identity.storage: "keychain"` → the keychain is per-device. Use iCloud
  Keychain to sync the keychain entry across devices (macOS + iOS).
- If not syncing: each device has its own opk → different owners →
  cross-relay sends between their machines would be `not_authorized`.
  That's correct (they're different owners).

### What changes are needed

| Component           | Change                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Relay (Rust)**    | Relay-to-relay WS connection + auth + peer-list exchange + cross-relay forwarding + loop prevention. The biggest piece.                                                                                                                                          |
| **Extension (TS)**  | `BrokerRemote` / `PiForwardClient` — the cross-relay routing prefix (`<hostB>:`) is already the cross-PC pattern; the extension routes to the peer relay via the local relay's forwarding. Minimal change (the prefix is already handled by `tryRouteOutbound`). |
| **App (iOS/macOS)** | Publish `mesh_versions` to all connected relays (may already do this). No other change — the app already connects to multiple relays + sees sessions on each.                                                                                                    |
| **Config**          | `relay.peers` setting in `un-bien.json` (or the relay's env/config).                                                                                                                                                                                             |
| **Docs**            | Setup guide: configure peering, sync owner identity (non-keychain), verify same-owner.                                                                                                                                                                           |

### Challenges

- **NAT/firewall:** relay A and relay B need to reach each other. If both
  are on Tailscale, direct. If not, one needs a public endpoint OR a
  DERP-like relay-of-relays.
- **Auth:** the relay-to-relay connection needs authentication (so a
  random relay can't connect + harvest peer lists). Shared-owner verification — both relays exchange opks; if no common owner, refuse. No shared secret or pinning needed. (was: the
  See step 2 above.)
- **Loop prevention:** a `visited_relays` list or TTL on cross-relay
  envelopes. Critical if more than two relays are peered (A → B → C → A).
- **Partial connectivity:** if relay A can reach relay B but not vice
  versa (one-directional NAT), the peering is half-duplex. The relays
  need to detect this + report it.
- **Peer list freshness:** relay A's view of relay B's peers goes stale
  if a peer on B joins/leaves. Exchange on connect + periodic refresh
  (or push on peer_joined/left).

### Alternative: one relay, all machines

The simplest approach (today's architecture): run ONE relay on a
Tailscale-accessible machine, and all machines connect to it. Cross-machine
mesh already works within one relay. No relay changes needed.

**Downside:** single point of failure (if the relay machine is down, all
mesh is down). The user explicitly runs a relay per host (for resilience

- locality), so consolidating to one relay defeats that.

### Alternative: the app as a bridge

The app (connected to both relays) bridges messages between them. The app
receives a message from machine A on relay A → forwards to machine B on
relay B.

**Downside:** the app must be online + it's a viewer, not a router. Not
designed for forwarding. And it's a bottleneck (all cross-relay traffic
flows through the phone).

## Recommendation

**Relay-to-relay peering (Option A)** is the right design for the user's
use case (ship work to another machine, relay per host, optional
connection). It extends the existing cross-machine mesh to cross-relay,
preserves the per-host resilience, and the same-owner validation already
works (the app publishes mesh_versions to both relays).

The relay Rust change is the biggest piece (relay-to-relay WS + auth +
peer exchange + forwarding + loop prevention). The extension change is
minimal (the cross-PC routing prefix pattern already handles the
`<host>:` prefix). The app change is minimal (publish mesh_versions to
all relays — may already work).

The non-keychain sync docs: if the owner uses file-based identity, sync
`identity.json` across devices so the same opk is on both. If keychain,
use iCloud Keychain. If not syncing, different devices = different owners
= cross-relay sends refused (correct).
