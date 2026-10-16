# Federation v2 — Design Record

Design decision (2026-10-14), grounded in the code as committed:
`peering.rs`, `membership.rs`, `handlers/peer.rs`, `handlers/pi_forward.rs`,
`peers/pairing.rs`, `peers/peers_config.rs`.

**This is the rationale, not the manual.** The as-built protocol, CLI, and
operator walkthrough live in [relay-peering.md](relay-peering.md); the
implementation history (slices, as-built decisions, sequencing) lives in
the git log (relay 0.7.35 through 0.7.40).

## Problem

The shipped federation trust model (relay 0.7.5 through 0.7.34-dev) rested
on three posts that did not match the intent "all relay comms via an
explicitly paired machine key or a paired mesh + explicit pairing on that
mesh, transitively":

1. **The relay-to-relay gate was shared-owner hash intersection.** Owner
   pubkey hashes are public, client-assertable material (any authenticated
   key can push a self-consistent `pairing_set` naming arbitrary owner
   pubkeys, thereby injecting hashes into `trust_root_hashes`). Mandatory
   pinning had been tried and reverted under a "shared-owner IS pairing"
   reading; the peer-doc protocol was built for explicit mutual naming but
   shipped warn-only.
2. **Federated sends checked only the sender's side.** `authorize_send`'s
   federated branch required "sender is a valid local member" and nothing
   checked the target; the dest-side owner re-check had been dropped
   (9779b88 — stale pushed sets broke launches). The machine-signed owner
   sets the peering exchange already carried were exactly the data needed
   to check the target at the source.
3. **No transitive federation.** `relay_peer_list` advertised only local
   rooms; the `visited` loop-guard was designed for transitive forwarding
   but nothing hopped.

## The design

### 1. The link gate is explicit pairing — pinned pubkeys, strict

A peer relay federates only when its Ed25519 public key is pinned in
`relay-peers.json` (written by the pairing URL flow). The shared-owner
intersection retires as a link gate: the owner binding moves to the
content layer (machine-signed owner sets, below). The `owners` fields
stay on the wire for observability but no longer decide federation.
Rationale: owner-hash material is assertable by any paired key, so it can
authenticate nothing; a pinned relay key is proof an operator ran
`relay pair` on that machine. Pin matching is by pubkey, not name.
Cross-owner relay pairing becomes possible when the machines' owner sets
intersect — the model the mesh already speaks.

### 2. One-pair: a one-time secret auto-adds the reverse

`unbien relay pair` mints a random 32-byte secret carried in the pairing
URL; the issuing relay holds it as a pending entry in `relay-peers.json`
(the fswatch pattern already watches the file — no new admin surface).
The consuming relay presents the secret in `relay_hello`; the issuer
verifies the presenter's identity signature, auto-adds the presenter
pinned to the presented key, and consumes the entry. One pairing action
yields mutual config. The secret is a one-time token, not a key: the
relay-holds-no-private-keys invariant is untouched. Dual-direction manual
pairing stays available — the one-pair flow is the default UX, not a
constraint.

### 3. Content gates: owner sets, machine-signed, both sides, strict

Two planes, one rule — **sender-owner intersect target-owner is
non-empty, over machine-signed sets**, decided at the SOURCE relay:

- **Agent plane (pi-to-pi):** the sender's owner set (local
  `PairingRegistry`, machine-signed `pairing_set`) must intersect the
  target's advertised owner set (exchanged at handshake + incremental
  pushes, machine-signed). Either side unknown means refuse. No machine
  exemptions — a machine IS its owner set.
- **Outer plane (app-to-machine):** the same matrix on the outer
  envelope — an owner device's pubkey must appear in the dest machine's
  machine-signed advertised set, or the sender machine's owner set
  intersects it.

This makes "explicit pairing on that mesh, transitively" literal: the
pairing exchange (machine-signed, version-monotonic, purged with the
link) is the authorization data. The 9779b88 lesson is preserved — the
deciding relay is always the SOURCE, using freshly exchanged sets; the
dest relay never re-refuses on its own stale view.

### 4. Transitive knowledge; frames always directed

All hosts become transitively known to the entire paired network:
metadata gossips, frames route. Each relay advertises, on every paired
link, its local rooms + machine pairings AND everything it learned from
other peers — origin-tagged, never back to the arrival link, self-origin
filtered (propagation terminates). Advertisement implies route (target
epk -> origin -> via link). A forward is always directed relay-to-dest:
an onward hop re-signs (per-hop provenance) and remembers
request-id -> arrival channel so acks return along the delivery path;
`visited` stays as the loop guard. A route miss is refused and logged
loudly, never fanned out — with a complete route table, directed
forwarding has no misses in steady state, so the flood fallback the
design floated was unnecessary. Trust per hop is the pinned link gate
(section 1); content authorization is end-to-end (section 3).

## What the design keeps as-is

- `verify_relay_forward` per-hop signature + the `visited` loop guard.
- The machine-signed pairing exchange (`learn_machine_pairings`) — now
  the load-bearing authorization data for the content gates.
- The peer-doc protocol — exchanged and verified as observability;
  pinning supersedes it as the gate (its mutual-naming intent is
  satisfied by mutual config).
- `federated_peer_list` push / discovery frames (transport-level).
