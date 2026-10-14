# Log-cursor split: one content-derived cursor, two invoke points

Design decision (2026-10-14) for the missing-backfill family. Grounded in the
code as committed (`EnvelopeReducer.applyRpc` derive-only rule, `SessionState`
tree model, `handleGetEntriesPaging`, `requestReconstruction`).

## Problem

The app's transcript correctness depended on two fragile things:

1. **A machine-echoed cursor.** `requestReconstruction` resumed delta fetches
   from `envelopeReducers[key]?.leafId` — and on the _terminal_ (empty) page
   the machine reports its **global tail** (`sm.getLeafId()`), not the position
   of the last entry the app holds. After a lost-reply window (app backgrounded,
   socket dead), the next complete page lets the cursor leap over content the
   app never received — "moved, but not as far" — and every later delta starts
   past the hole. Permanently.
2. **Event-triggered repair.** The `message_end` → delta walk is the only
   correctness-relevant fetch for in-flight turns, and the app's `on()` hook
   cannot observe "entry appended with id" (pi emits `message_end` before
   `sessionManager.appendMessage`; the append is synchronous with the handler's
   _return_, so the walk-vs-append race is not the current bug — see the
   ordering analysis — but the _repair trigger_ being a transient event is the
   structural weakness).

## The design: split beacon from frontier

Two values, one store each, never conflated:

- **Beacon** (rendering authority): the machine-reported leaf, exactly as
  today. Drives `derivePath`/re-derivation (authoritative semantics, TUI
  edit-resubmit / /tree divergence handling). Unchanged.
- **Folded frontier** (`AppModel.foldedFrontier`): the last entry id _actually
  folded_ from a non-empty page of the CURRENT walk. Written ONLY in
  `handleGetEntriesPaging` (`entries.last`), never by terminal pages, never by
  the machine-reported tail. `requestReconstruction` resumes
  `get_entries(since:)` from the folded frontier (fallbacks: rendering beacon,
  then the cache).

Invariant: **the cursor advances only over content the app holds.** A gap makes
it stop, which makes the next reconcile re-serve the gap. Holes become
self-healing by construction instead of permanently skippable.

## Answers to the five design questions (worked through, 2026-10-14)

The app's transcript is a **fork tree**, not a log — `SessionState` retains
every entry in `entriesById`/`entryParent` and renders a _derived active path_.
This changes several early assumptions:

1. **Pendings never advance the frontier** — already structural: live-streamed
   fragments are render rows; `entriesById` is fed exclusively by folded
   pages. Streaming is cosmetic for correctness. Nothing to change.
2. **Out-of-order arrival** — irrelevant in a tree: entries are nodes,
   off-path ones retained silently, `derivePath` tolerates any arrival order,
   truncated ancestry defers (`pendingRepathLeaf`) and re-derives when the
   missing pieces land. Holes in ancestry already self-heal — _provided
   something re-fetches them_ (the frontier + foreground reconcile below).
3. **Settle boundaries** — the extend rule already encodes it (in-flight
   message has no log entry until streaming ends; a beacon extend adds only
   settled ancestry). Keep.
4. **Full-walk reset** — authoritative beacons govern; frontier resets with
   the reset (first page of an authoritative walk rebuilds both).
5. **One place advances the frontier** — the paging fold for the current walk.
   Superseded/straggler chain pages fold (idempotent) but never move it.

## Invoke points

Two remain, deliberately: `message_end` sync (latency) and foreground/re-open
(correctness). Both are the same call: `requestReconstruction` from the folded
frontier.

- **Foreground reconciliation** (`reconcileForeground`, wired to
  `scenePhase → active` in RootView): heals the bg-after-typing case even when
  the socket _looks_ healthy — the existing `healConnectionsOnForeground` only
  re-runs reconstruction for relays that had to reconnect. With the frontier,
  the healthy-socket re-ask is trustworthy: it fetches exactly what's missing,
  nothing more.
- **message_end sync**: unchanged as a latency optimization; the frontier makes
  it non-authoritative for correctness.

## Not needed today / future

- No protocol change; no relay change; extension unchanged.
- Mid-entry slicing (rpc_inbound) stays parked for pathological >budget
  entries; the 5 MiB page budget (relay 16 MiB ct) makes the truncation ladder
  a rarity in practice.
- If pi ships a post-append hook, the extension can stream durable entries on
  the live plane (unifying backfill and live transport) — at that point
  `message_end`-triggered walks become purely latency work.
