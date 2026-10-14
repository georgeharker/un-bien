# Federation v2: explicit pairing, one-pair, owner-set content gates, transitive hops

Design decision (2026-10-14). Grounded in the code as committed: `peering.rs`
(shared-owner gate, `learn_machine_pairings`, `peer_doc`), `membership.rs`
(`authorize_send`, `verify_relay_forward`), `handlers/peer.rs` (content gate +
SRC check-before-forward), `peers/pairing.rs` (machine-signed blobs).

## Problem

The shipped federation trust model (relay 0.7.5–0.7.34-dev) rests on three
posts that do not match the intent "all relay comms via an explicitly paired
machine key or a paired mesh + explicit pairing on that mesh, transitively":

1. **The relay↔relay gate is shared-owner hash intersection** — owner pubkey
   hashes are public, client-assertable material (any authenticated key can
   push a self-consistent `pairing_set` naming arbitrary owner pubkeys,
   thereby injecting hashes into `trust_root_hashes`). Mandatory pinning was
   tried and reverted ("shared-owner IS pairing"). The peer-doc protocol was
   built for explicit mutual naming but ships warn-only.
2. **Federated sends check only the sender's side.** `authorize_send`'s
   federated branch requires "sender is a valid local member" and nothing
   checks the target; the dest-side owner re-check was dropped (9779b88 —
   stale pushed sets broke launches). The machine-signed owner sets the
   peering exchange already carries are exactly the data needed to check
   the target at the source.
3. **No transitive federation.** `relay_peer_list` advertises only local
   rooms; the 3-relay chain spec is `#[ignore]`d. The `visited` loop-guard
   was designed for transitive forwarding but nothing hops.

## The design

### 1. The link gate is explicit pairing — pinned pubkeys, strict now

A peer relay federates **only when its Ed25519 public key is pinned** in
`relay-peers.json` (written by the pairing URL flow). The shared-owner
intersection RETIRES as a link gate: the owner binding moves to the content
layer (machine-signed owner sets, below). Consequences:

- Cross-owner relay pairing becomes possible when the machines' owner sets
  explicitly include each other — the model the mesh already speaks.
- No compat window: federation is pre-release and operator-owned; unpinned
  same-owner peers stop federating with a loud, named decline (the 403-style
  explicit refusal the `/relay-peer` gate already uses for disabled
  federation).
- Outbound: a configured peer without a pinned pubkey is not dialed (warn).
- The `relay_hello`/`ack` `owners` fields stay on the wire (logging + future
  use) but no longer decide federation.

### 2. One-pair: a one-time secret auto-adds the reverse

`unbien relay pair` mints a random 32-byte secret. The pairing URL carries
`{url, name, pubkey, secret}`, and the issuing relay holds the pending entry
in `relay-peers.json` under `pending` (the fswatch pattern already watches
this file — no new admin HTTP surface).

The consuming relay's `relay_hello` presents `pair_secret`. The issuing relay:

1. verifies the secret against an outstanding pending entry (b64 string
   compare of the fixed-shape token; single-use),
2. verifies the presenter's relay identity signature (possession of the
   presented pubkey) — the auto-added entry pins THAT key,
3. auto-adds the peer: `{url: <presented relay_url>, name: <presented
relay_name>, pubkey: <presented>}` and consumes the pending entry,
4. proceeds to federate. The fswatch loop sees the new peer and dials it —
   both directions live, both directions pinned.

One pairing action ⇒ mutual config. Dual-direction manual pairing stays
available (`peer pair` both ways) — the one-pair flow is the default UX, not
a constraint. The secret is a one-time token, not a key: the
relay-holds-no-private-keys invariant is untouched (the relay's own Ed25519
identity keypair predates this).

### 3. Content gates: owner sets, machine-signed, both sides, strict

Two planes, one rule — **sender-owner ∩ target-owner ≠ ∅ over machine-signed
sets**:

- **Agent plane (pi→pi)**: `authorize_send`'s federated branch requires the
  sender's owner set (local `PairingRegistry`, machine-signed `pairing_set`)
  to intersect the target's advertised owner set (federated
  `machine_pairings`, machine-signed, exchanged at handshake + incremental
  pushes). Either side unknown ⇒ refuse. No machine exemptions — a machine
  IS its owner set.
- **Outer plane (app→machine)**: the existing strict SRC gate stays and
  becomes the same rule: an owner device's pubkey must appear in the dest
  machine's machine-signed advertised set; unknown set ⇒ refuse.

This is what makes "explicit pairing on that mesh, transitively" literal:
the pairing exchange (already machine-signed, version-monotonic, purged with
the link) is the authorization data. The 9779b88 lesson is preserved — the
DECIDING relay is always the SOURCE, using fresh exchanged sets; the dest
relay never re-refuses on its own stale view.

### 4. Transitive A→B→C: full host knowledge across the paired network; frames always directed

**SETTLED (2026-10-14): all hosts become transitively known to the entire
paired network.** Metadata gossips; frames route. This dissolves the
directed-vs-flood fork: with a complete route table, directed forwarding has
no misses in steady state and the flood fallback is unnecessary (a route
miss is refused + logged loudly, not fanned out).

- **Metadata gossip (the inventory)**: each relay advertises, on every
  paired link, its LOCAL rooms + machine pairings AND everything it learned
  from other peers — origin-tagged, never back to the arrival link,
  self-origin filtered (propagation terminates). A relay that IS an origin
  ignores advertisements naming itself. Same frame shape as today, one
  `relay_peer_list` per origin (the receiving side already keys rooms by
  origin relay_name); incremental `relay_peer_update` / `relay_pairings_update`
  re-advertised onward with their origin names. Machine pairings are
  machine-signed — transit advertisement cannot forge owner sets.
- **Routing**: advertisement implies route — target epk → origin O → via the
  link O's advertisement arrived on. App epks (no rooms) keep
  provenance-derived reverse routes (`learn_route` per hop, from verified
  inbound forwards). Multi-route candidates tried in order; entries purged
  with their link.
- **Frames**: always directed relay→dest (the wire model is unchanged — a
  `relay_forward` is to a KNOWN target, acked by the holder). An onward hop
  re-signs (per-hop provenance) and remembers `request_id → arrival channel`
  (id→backlink) so acks return along the delivery path without id rewriting.
  `visited` stays as the loop guard.
- **The app**: `federated_peer_list` now carries the whole network's hosts
  through the one relay the app is connected to; `peerRelay` names the ORIGIN
  relay. The `#[ignore]`d 3-relay chain spec becomes the acceptance test.
- **Trust per hop**: every link is an explicitly paired pinned link (§1);
  content authorization is end-to-end (§3).

Sequencing note: the launch bug is DIRECT-path (A→B, no transit involved) —
slices 1–2 land with today's direct-only forwarding, the launch/B-pump fix
lands next on that healthy path, and slice 3 turns on transitive knowledge
with the chain rig as acceptance.

## What stays as-is

- `verify_relay_forward` per-hop signature + `visited` loop guard.
- Machine-signed pairing exchange (`learn_machine_pairings`) — now the
  load-bearing authorization data for §3.
- The peer-doc protocol — stays exchanged + verified as
  logging/observability; pinning supersedes it as the gate (the doc's
  mutual-naming intent is satisfied by mutual config).
- `federated_peer_list` push / discovery frames (transport-level, unchanged).
- The known launch bug is FIXED UNDER this design, not before it: the strict
  source gate's "unknown owner set ⇒ refuse" is only correct once the
  machine-pairing exchange reliably lands (the B-pump mystery) and the rigs
  push real pairing state.

## Implementation slices

1. **Pairing** (relay + CLI): pending-secret mint/hold/consume, `pair_secret`
   in hello, strict pinned gate both directions, shared-owner gate removal,
   CLI `pair`/`peer add` secret flow. Tests: pin-required declines, auto-add
   single-use, unpinned outbound refuses to dial.
2. **Owner-set content gates** (relay): `authorize_send` federated branch +
   SRC gate unified on §3; strict unknown-refuse. Tests: cross-owner
   refusal, transitive owner intersection, strict-unknown.
3. **Transitive exchange + hop** (relay): segments advertisement, via-routing,
   onward hop + ack relay, un-ignore the chain spec. Tests: the 3-relay rig.
4. **Launch bug** (relay + rig): fix the rig to push pairing state; chase the
   B-pump frame mystery with the §3 gates in place.

## As built — slice 2 decisions (2026-10-14)

- `authorize_send` threads `target_owners: Option<&HashSet<String>>` in
  (computed at the `handle_pi_envelope` call site from
  `federated.machine_owners`) — membership.rs stays testable without
  FederatedSessions. Sender owners come from the LOCAL PairingRegistry only
  (no mesh-store union): both sides of the intersection are then
  machine-signed, matching the target side's provenance.
- The outer-plane SRC gate implements the same matrix: dest set unknown ⇒
  refuse for ALL senders; known ⇒ owner-device (`dest set contains peer_id`)
  OR machine (`sender-owners ∩ dest-owners ≠ ∅`). Machine exemption gone —
  a machine IS its owner set. Routed `unknown_peer` refusal preserved; no
  dest-side re-checks (9779b88 preserved).
- Contract change: a dest the source relay cannot authorize AT ALL (no local
  session, no federated route, no exchanged owner set) now gets the routed
  refusal instead of a silent drop. The silent-drop contract survives where
  intended: a KNOWN federated machine with a dead room still drops silently.
- **Follow-up for slice 4 (production gap, flagged)**: machine→APP replies
  over federation now require the reply DEST (the app device's key) to have
  an advertised owner set — i.e. the app pushes a self-signed pairing_set
  (`{machine_pk: <app key>, owners: [<owner opk>]}`) on connect, "a device
  advertises the owner it belongs to". The extension's real pairing_set
  push already carries `[app, owner]` for machines; the Swift app does NOT
  push one today, so federated transcript replies/launch acks will be
  refused at the machine's relay until the app adds this push.
- Rigs: both federation rigs now have the app push its signed owner set
  (modelling the production follow-up); the chain smoke direct-hop passes —
  the B-pump mystery did not bite there.

## As built — slice 1 decisions (2026-10-14)

- Declines are NAMED: `relay_hello_ack` gains a `reason` field
  (`unpinned_peer`, `pairing_secret_unknown`, `pairing_identity_missing`,
  `identity_invalid`, …) so the dialing relay's logs show why — the 403-style
  explicit-refusal spirit, on the wire.
- Outbound: a pinned peer's ack MUST present identity (possession of the
  pinned key) — unverifiable possession never passes.
- Pin matching is by PUBKEY, not name (a renamed configured peer still
  matches its pin).
- Auto-add upserts by name — a re-pair under an existing name replaces the
  entry (same semantics as CLI `peer add`).
- The peering loop re-reads the config each cycle: pins/urls/removals apply
  without restart (the fswatch spawner only spawns NEW names); a peer removed
  from config idles rather than dies, so re-add works.
- Legacy `peer add <url> <name>` REFUSES with a pointer to the pairing-URL
  flow; a secret-less old-format pairing URL still pins (dual-direction
  manual pairing stays possible).
- The pending secret compares by SHA-256 of the b64 token; consumption and
  auto-add are one atomic config write (temp + rename — one clean fswatch
  event) that preserves every other field, including the legacy
  `federation.enabled` flag.
- Shared-owner intersection is computed and logged on every handshake —
  observability only; pairing decides.
