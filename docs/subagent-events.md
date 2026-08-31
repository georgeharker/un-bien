# Subagent & plan bus events (the format un-bien expects)

un-bien treats a **subagent** as a child session it can **detect**, **track the
status of**, and **interact with** (steer / abort / etc.) — and, secondarily,
render in a fleet panel. All of it is fed from in-process `pi.events` bus
channels, so any extension can participate by emitting the shapes below. There is
no coupling to a specific subagents implementation; unknown events and fields are
ignored.

The hard case this contract exists for: **a subagent an extension launches in a
different process.** un-bien's extension is loaded in the _parent_ process, so it
sees in-process children automatically but is **blind to an out-of-process
child** unless that child (or its launcher) tells us. The rule:

> **If a child marker is given, we respect it. We also auto-detect the
> in-process case. If your extension launches subagents in a different process,
> include the child id.**

Two subagent implementations emit the same `subagents:*` family today, and a
third-party extension may too:

| Source        | Package                   | Lineage                               | Notes                                                                                 |
| ------------- | ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| **tintinweb** | `@tintinweb/pi-subagents` | upstream, batteries-included          | scheduling, cross-ext RPC, model-scope, tool denylist                                 |
| **gotgenes**  | `@gotgenes/pi-subagents`  | hard fork of tintinweb (Chris Lasher) | minimal core + typed `SubagentsService`; **adds an authoritative child-marker event** |

Both run subagents **in-process** (a child Pi session in the parent's process).
The plan bus is defined by `@geohar/pi-plan`, a generic consumer.

> **Scope — near-term vs later.** Near-term targets: **event-asserted child
> detection** (accept a launched child when its id is supplied in an event —
> §3B/§4) and **event-based status** (§5). **Interaction** (§6,
> `unbien:subagent:control`) is designed for but not built yet; the contract is
> shaped so it can be added without reshaping detection or status.

---

## 1. `subagents:*` lifecycle events

Emitted via `pi.events.emit(channel, payload)`. Fields un-bien **reads today**
are ✅; fields it currently ignores (display/telemetry) are ⚪.

| Channel                                                                                                                           | When                                                                                              | Fields                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents:created`                                                                                                               | background agent registered (Agent-tool spawn / detached resume; **not** RPC/scheduler/`@handle`) | ✅`id` ✅`type` ✅`description` ⚪`isBackground`                                                                                                                            |
| `subagents:started`                                                                                                               | agent transitions to running (incl. queued→running)                                               | ✅`id` ✅`type` ✅`description`                                                                                                                                             |
| `subagents:completed`                                                                                                             | finished successfully                                                                             | ✅`id` ✅`type` ⚪`description` ✅`status` ⚪`durationMs` ⚪`tokens{input,output,total}` ⚪`usage` (pi `Usage`, incl. `cost.total`; tintinweb only) ⚪`toolUses` ✅`result` |
| `subagents:failed`                                                                                                                | errored / stopped / aborted                                                                       | same shape as `completed`; ✅`error` and ✅`status` populated (may be empty)                                                                                                |
| `subagents:resumed`                                                                                                               | **gotgenes only** — a resumed run reached a terminal state                                        | same as `completed` + `error`/`status` (discriminate on `status`)                                                                                                           |
| `subagents:steered`                                                                                                               | steering message accepted (incl. queued steer)                                                    | ✅`id` ⚪`message`                                                                                                                                                          |
| `subagents:compacted`                                                                                                             | child session compacted                                                                           | ✅`id` ✅`type` ✅`description` ⚪`reason` (`manual`\|`threshold`\|`overflow`) ⚪`tokensBefore` ⚪`compactionCount`                                                         |
| `subagents:settings_loaded` / `subagents:settings_changed`                                                                        | settings lifecycle                                                                                | ⚪ ignored                                                                                                                                                                  |
| `subagents:scheduled`, `subagents:ready`, `subagents:scheduler_ready`, `subagents:rpc:*`, `subagents:record`, `subagents:manager` | **tintinweb only** — scheduling / cross-ext RPC / internal                                        | ⚪ ignored (but `subagents:rpc:*` is a control surface — see §5)                                                                                                            |

**Two properties that shape the design:**

1. **No `sessionId` — and the `id` these events carry is not one.** Every
   `subagents:*` lifecycle event carries the manager's **record `id`** — a
   per-run bookkeeping key for the subagent instance — never the child Pi
   `sessionId` (the session identity un-bien tracks and routes by, which
   appears only on `subagents:child:session-created`/`disposed` and the child's
   own `session_start`). The two id spaces are deliberately separate; un-bien
   correlates a record to its session to stamp status (how, and what would make
   it exact, in §5). In-process, the session id is recovered from the child's
   `session_start`; **out-of-process, it must be supplied** (§3).
2. **Top-level only.** The core lifecycle events fire for top-level agents only;
   nested/workflow children emit nothing. So the event stream is not a complete
   census — authoritative existence is the child-marker signal (§3), not these.

### Status vocabulary

`queued` · `running` · `completed` · `steered` · `aborted` · `stopped` · `error`

Display rank: `pending(0) < in_progress(1) < terminal(2)`. The **channel** sets a
coarse status; a later terminal `status` field refines it (`failed` +
`status:"stopped"` renders distinctly from `error`).

un-bien tracks the **full vocabulary** (incl. `created`, `queued`, `steered`,
`compacted`, `aborted`, `stopped`) on the extension's per-subagent state — not a
coarse 3-state — and **forwards it to the app**, so the app can render the richer
states rather than collapsing to done/failed/in-progress. The `created` event is
the earliest signal and is tracked as such.

---

## 2. tintinweb vs gotgenes — how they differ

For the fields un-bien reads (`id`/`type`/`description`/`status`/`result`/
`error`) they are **compatible** — same channel names, same shapes. Differences:

|                                                     | tintinweb                                | gotgenes                                               |
| --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| core lifecycle                                      | ✔                                        | ✔ (compatible fields)                                  |
| `subagents:resumed`                                 | ✖                                        | ✔                                                      |
| `usage` (billed pi `Usage`)                         | ✔                                        | ✖ (`tokens` only)                                      |
| scheduling / RPC / `ready`                          | ✔                                        | ✖ (delegated to consumers)                             |
| **authoritative child-marker event**                | ✖                                        | ✔ `subagents:child:session-created`                    |
| in-process child `session_start`/`session_shutdown` | ✔                                        | ✔ (documented; shutdown awaited pre-dispose)           |
| control surface for other extensions                | `subagents:rpc:spawn/stop/consume` (bus) | typed `SubagentsService` (`spawn`/`steer`/`getRecord`) |

The decisive difference: gotgenes publishes **`subagents:child:session-created`
before `bindExtensions()`**, so a consumer learns the child synchronously and
authoritatively; tintinweb makes you infer it from `session_start`.

---

## 3. Detection & authority (who is a child, and whose child)

Establishing _this session is a child, and its parent is X_ is the **authority**
question. Two regimes, and the rule above resolves both:

### Regime A — in-process child → **auto-detected**

The child fires its own `session_start` with a `sessionId` ≠ the root's;
un-bien's `_isNonRootSid` claim is the **authoritative** signal and needs nothing
from `subagents:*` (the record only enriches labels/status). Parent comes from
the SDK session header (`parentSession`), falling back to root, so a _nested_
child nests under its true spawner. Works for tintinweb and gotgenes today.

### Regime B — out-of-process child → **must be asserted, with the child id**

An extension that launches a subagent in a **different process** (subprocess,
container, remote `pi --mode rpc`) fires **no in-process `session_start`** un-bien
can see. It **must assert** the child by emitting a marker that **includes the
child id** (+ parent link) — the exact facts Regime A would have detected. Two
accepted markers:

1. **gotgenes `subagents:child:session-created`** — consumed as authoritative
   when present (also removes the arrival-order guess in Regime A). **Confirmed
   payload** (gotgenes decision 0012 / CHANGELOG): `{ sessionId, parentSessionId? }`,
   emitted **synchronously before `bindExtensions()`**. Paired disposal event:
   **`subagents:child:disposed` = `{ sessionId }`** (fired in the run's `finally`,
   success and error alike) — un-bien consumes it to release the keeper and drop
   the child from the panel.
2. **`unbien:subagent:child`** (§4) — un-bien's own implementation-neutral marker,
   mirroring that shape, so any launcher can assert a child without depending on a
   subagents package.

**The “subagent adapter convention”** (gotgenes' name for this contract): an
implementation's whole obligation is the announcement —

- **in-process:** emit `subagents:child:session-created` `{ sessionId,
parentSessionId? }` synchronously before `bindExtensions()`, and
  `subagents:child:disposed` `{ sessionId }` in the `finally`;
- **out-of-process:** gotgenes' own convention sets env
  `PI_SUBAGENT_PARENT_SESSION` in the spawned child — **un-bien does not consume
  that env**. un-bien's out-of-process requirement is the rule above: a
  parent-side marker **with the child id** (`subagents:child:session-created` /
  `unbien:subagent:child`, emitted once the child id is known). The pre-created
  keeper does the nesting; without a child-id marker an out-of-process child is
  undetectable — no keeper, no parentage, no panel row.

### Parentage model: parent-stamped keeper (chosen)

Nesting has ONE model: **the child's room is pre-created with `room_meta.parent`
(+ `parentSessionId`) already stamped**, on the child's deterministic room
(`roomIdForSession(childSessionId)`). In-process, the room is built at the
child's `session_start` with the parent link in its connect `room_meta`; when a
child MARKER arrives first (gotgenes / `unbien:subagent:child`), the room exists
even earlier — as a **passive keeper** — and the later `session_start` attaches
the producer to that same room. Out-of-process, the parent-side marker
pre-creates that same passive keeper (parent already stamped); the child
process — un-bien-aware — later joins the SAME deterministic room as the serving
producer (same machine ⇒ same keypair ⇒ the same `(peer, room)` key). The
deterministic `roomId` is where the two ends meet without coordinating;
precedence is **set-once, parent-authoritative** (`update_room_meta` merges
`parent`/`parentSessionId` into `extra` only if absent, so a later write — or the
child's own connect — can never clobber or unstamp a pre-set parent). The marker
events still feed the parent's fleet/panel/status; nesting rides the room's
`room_meta.parent`, stamped at pre-creation. Creation is **upsert**
(create-or-enrich) keyed on the **child sessionId** (the deterministic roomId's
key): the marker, `session_start`, and any re-arrival converge on one room/entry
— enrich if it exists, never duplicate or double-bind.

**Parent-held keeper + no reap.** The parent ALWAYS holds the child room open
via the passive keeper — it announces parentage and answers NO owner RPCs (the
serving side — in-process attach, or the out-of-process child's own connection —
is the only responder, so a room hosting both conns never double-answers).
Children linger for the parent's lifetime (transcripts stay visible): a
`*:child:disposed` marker only STAMPS terminal status — releasing the keeper for
keeper-only children — and rooms close wholesale at parent `session_shutdown` —
so there is nothing to reap.

**Out-of-process footprint.** For an out-of-process child, the keeper is
un-bien's ONLY footprint on that room: the child owns its own serving
connection, and disposal (§4) closes only the keeper — the child's connection
(if still up) keeps the room open until it leaves. Parent-side awareness rides
the marker events (fleet/panel/status); nesting rides the keeper-stamped
`room_meta`.

### Advertising the parent — early vs late (the exact flow)

`parentId`/`parentSessionId` ride the child room's `room_meta`, and **when they
land depends on when parentage is known** — but _both_ funnel through the same
idempotent `ensureChildRoom`, and the room is **never rebuilt/disposed** to change
it.

- **EARLY — gotgenes + out-of-process** (parent known at _creation_). The child
  marker (`subagents:child:session-created` / `unbien:subagent:child`) carries
  `{ sessionId, parentSessionId }` — **`parentSessionId` is REQUIRED for
  nesting** (design 01M1CAW0): a marker without it creates the room **without
  a parent** (a top-level orphan + a loud `marker without parent — not
guessing` log), awaiting a parent-bearing re-marker. The previous
  receiver-root fallback ("the parent link falls back to the root's session id
  when omitted") is **REMOVED** — it silently bound children to whatever
  process received the marker, which was the phantom-parent vector. A spawner
  that learns the parent LATE must re-emit the marker with `parentSessionId`
  (it funnels through the same idempotent `ensureChildRoom` → `setParent`).
  When the marker carries it, the room is **created with the parent-child
  relationship already set** in its connect `room_meta` → `room_announced`
  (first-conn) carries it → the app nests immediately.
- **LATE — tintinweb / in-process** (no marker → no room until attach). tintinweb
  gives no early child id, so the room first exists at the child's `session_start`;
  the parent link stamped there is the ROOT's session id (`getParentSessionId()`)
  — **not** the SDK header: `SessionHeader.parentSession` is a FILE PATH
  (`…/<ts>_<id>.jsonl`), never an id, and is deliberately not read. Because
  `room_announced` fires **first-conn only**, any parentage landing after the room
  is open — queued during the async build (`pendingParent`), or learned after
  creation — is advertised via a **`room_meta_update`** on the already-open room
  (`ChildRoom.setParent` → `RelayClient.sendControl`), **not** a re-announce and
  **never** a dispose/rebuild (that would kill an already-set parent).

**Relay = set-once.** `update_room_meta` merges the `parent`/`parentSessionId`
into `extra` **only if absent** (never overrides an existing parent), then fans
out `room_meta_updated` carrying them.

**App = last-info-wins + re-nest.** The `room_meta_updated` handler updates
`LiveSession.parentSessionID`/`parentRoomID` **present-only (never clears)** and
reassigns `sessions[k]`, which re-derives HomeView's top/kids grouping so the row
**moves in the hierarchy** live.

**Race-safe.** If parentage arrives while the room is still building (async
connect), `ensureChildRoom` queues it (`pendingParent`) and applies it on build
completion — create can occur late.

### The rule, restated

- **Marker given → respected** (authoritative; supersedes arrival-order
  correlation; the only signal for out-of-process children). A parent-less
  marker is a deliberate top-level orphan until a parent-bearing re-marker
  (design 01M1CAW0 — never guessed).
- **In-process → auto-detected** (Regime A stays the default, no cooperation
  needed).
- **Different process → include the child id** in the marker, or un-bien cannot
  detect, track, or interact with it.

---

## 4. `unbien:subagent:child` — the child-marker event we define

Emit **once**, as early as the child identity is known (mirror gotgenes'
pre-`bindExtensions` timing):

```ts
pi.events.emit("unbien:subagent:child", {
  sessionId: string,          // REQUIRED — the child Pi session id (the join/route key)
  parentSessionId: string,    // REQUIRED — the spawning session's id (nesting link)
  manager?: string,           // authority for control/status (§5,§6) — the launching
                              //   extension's id; defaults to the emitter
  id?: string,                // record id, to correlate subagents:* status by id
  type?: string,              // agent type/label
  description?: string,       // short label
  status?: string,            // initial status; refined by later events
  cwd?: string,               // child working dir, if distinct
});
```

- `sessionId` + `parentSessionId` are load-bearing — exactly what Regime A
  recovers from `session_start` + the header, supplied explicitly.
- `manager` names the **authority** (§5, §6): who un-bien pushes control to and
  reads status from for this child. Defaults to the emitting extension.
- When both this event and an in-process `session_start` occur for the same
  `sessionId`, they reconcile on `sessionId` — no double room.
- Additive: absent → Regime A unchanged; present → deterministic + covers
  out-of-process.

**Disposal counterpart.** Emit **`unbien:subagent:disposed`** `{ sessionId }` when
the child session ends (mirroring gotgenes' `subagents:child:disposed`, which
fires in the run's `finally` on success AND error). Disposal is a **terminal
status stamp, not a removal** (§5): the panel row STAYS, stamped with the
correlated terminal record status (fallback `stopped`). Then it splits on
locality — an **in-process** child LINGERS: its room keeps serving the finished
transcript until parent teardown (the entries stay readable in the captured
session manager; the room captured it while the ctx was active, so the child
session's own dispose cannot poison it). A **keeper-only** child (out-of-process,
or one that died before attaching) has its keeper released — an out-of-process
child's own connection (if still up) keeps the room until it leaves — and a
build still connecting when the marker lands is disposed on completion instead
of registering (tombstone), so no zombie room can appear.

---

## 5. Status tracking is event-based _(near-term target)_

This section is the piece to support **now** (interaction in §6 is later). It is
largely how un-bien already works — the extension derives status from the
`subagents:*` events — so "support now" means making status **purely
event-sourced** and able to accept status **pushed** for a child we didn't detect
in-process.

Detection only says a child exists; its lifecycle status is a **separate,
event-driven stream** — the same for in-process and out-of-process children.
**Status is pushed as events; un-bien never expects to poll a child.**

The emitter's contract, uniformly:

> **Emit status as events** — the `subagents:*` lifecycle channels carrying the
> record `id`, or a re-emitted `unbien:subagent:child` with an updated `status`.
> un-bien folds each event into the child's tracked status (matched by `id`,
> then `sessionId`).

un-bien is a pure consumer of this stream. There is no "query the child" path in
the contract — an out-of-process authority that goes silent leaves the child
running-with-last-known-status until a terminal event arrives.

**Correlation — how a record finds its session (and what would make it exact).**
The status stamp needs the record `id` bound to the child `sessionId`; no event
carries both, so un-bien prefers whatever is exact, in this order:

1. **A `sessionId` on the record event.** Neither tintinweb nor gotgenes emits
   this today — but if your implementation can add the child `sessionId` to
   `subagents:started`, un-bien binds directly, with zero ordering assumptions.
   This is the one-field fix that makes correlation exact; adding it is the most
   useful thing an implementation can do here.
2. **A record `id` on the child marker** (`subagents:child:session-created` /
   `unbien:subagent:child`) — same exactness from the other side; un-bien binds
   at the marker.
3. **gotgenes' published service** — probed structurally (`getRecord(id)`
   `.outputFile`, the child's session file, matched against the file captured at
   the child's `session_start`) when present. No package coupling; silent when
   absent. The `outputFile` pointer survives the child session's release, so the
   match stays valid for the whole record lifetime.
4. **Partitioned arrival order** — the base layer for tintinweb: sessions only
   queue (in-process-tagged at `session_start`); `started`/`resumed` pop tagged
   entries. Modes are partitioned so concurrent foreground/background spawns
   cannot cross-bind, and out-of-process entries are never stolen.

**Failure is a status stamp, not a removal.** A launch/agent failure arrives as
`subagents:failed` (or the marker's `status`) and is simply _stamped_ onto the
child (`failed`/`error`/`aborted`/`stopped`); the child is **kept** — it lingers
showing that terminal status (and its transcript, if it produced one) until
parent teardown. That is why no reap is needed: nothing is removed on failure.

> Internal detail (not an emitter concern): because bus events are ephemeral and
> don't replay on app relaunch, un-bien's extension keeps the **event-derived**
> status per child and re-serves it to the app on (re)connect via
> `get_session_info`. That app↔extension resync is transport for the same
> event-sourced state — the source of truth is always the events.

---

## 6. Interaction (routed through the authority, keyed by record id)

un-bien does **not** attach to the child's process to steer/abort it. Control
routes to the child's **authority** — the extension that owns the process. un-bien
is the remote UI; the manager applies the action. This is what "respect the
subagent authority" means: the marker names the authority, and control flows back
to it.

**The managers do not share one control mechanism**, so `unbien:subagent:control`
is un-bien's neutral surface and a small **per-manager adapter** applies it:

- **tintinweb** exposes a **bus RPC** — `subagents:rpc:spawn/stop/consume` — so
  the adapter re-emits onto that channel.
- **gotgenes** has **no cross-extension bus RPC** (a deliberate non-goal — it
  lives in upstream). Its control surface is the **in-process typed
  `SubagentsService`** (`getSubagentsService()` → `spawn`/`steer`/`getRecord`),
  callable only by a co-loaded extension. So the adapter for gotgenes is an
  **in-process import-and-call**, not a bus message — it cannot be driven purely
  over the event bus.

So `unbien:subagent:control` is authoritative as _un-bien's_ request; reaching a
specific manager is an adapter concern, and not every manager is reachable by bus
alone.

- **(A) Manager-routed control — primary, universal.** un-bien emits a control
  request the authority answers, keyed by record `id` (and/or `sessionId`):

  ```ts
  pi.events.emit("unbien:subagent:control", {
    id?: string,            // record id (preferred) …
    sessionId?: string,     //   … or the child session id
    action: "steer" | "abort" | "consume" | string,
    payload?: unknown,      // e.g. { message } for steer
    replyTo?: string,       // correlation id for the ack/result
  });
  ```

  The authority (its `manager`) receives it — via its bus RPC, or an in-process
  adapter that calls its typed service — applies it to its child (in- or
  out-of-process), and pushes the outcome + new status back via §5. Covers opaque
  cross-process children uniformly at the _un-bien_ layer; the last hop is
  per-manager.

- **(B) Direct mesh room — fast-path.** Only when the child is itself un-bien-aware
  (a real Pi process running our extension): it stands up its own room and un-bien
  interacts directly, like any launched session; the marker event just links
  parentage.

Note: in-process children are **view-only today** (`subagent_rooms.makeHandlers`
returns read-only), so interaction is net-new regardless of locality — a reason
to build the **one** manager-routed path (A) rather than two.

---

## 7. `plan:*` bus events (`@geohar/pi-plan`)

State is kept **per source namespace (`ns`)**, so multiple sources coexist.

### `plan:snapshot` — replace all items for a namespace

```ts
{ ns: string, seq: number, project?: string, items: PlanItem[] }
```

### `plan:update` — patch a namespace part-by-part

```ts
{ ns: string, seq: number, upsert: PlanItem[], remove: string[] /* ids */ }
```

### `PlanItem`

```ts
{
  id: string,                 // stable, unique within ns (crib "<kind>:<slug>"; agents "agent:<id>")
  kind: string,               // "plan" | "design" | "note" | "agent" (verbatim)
  name: string,               // display text  (README's PlanItem calls this `title`)
  status: string | null,      // "done" sinks; "in-progress"/"active" highlighted
  deps: string[],             // must-precede ids in the same ns
  tainted?: boolean,          // design-kind only: blocks dependents while true
  meta?: Record<string, unknown>,  // e.g. { agentType, startedAt, sessionId } for agent rows
}
```

### Semantics

- **`ns`** attributes the source; `snapshot` replaces the per-`ns` map, `update`
  upserts by `id` and deletes `remove` ids (`source` is a legacy alias for `ns`).
- **`seq`** (monotonic per `ns`) drops out-of-order deliveries.
- **Dep satisfaction is kind-aware**: `note` never blocks; `design` blocks while
  `tainted`; `plan` blocks until `status` is done.
- **Wave** = longest chain of unsatisfied deps above an item; wave 0 is
  actionable now.
- `pi-plan` also reads `subagents:*` and renders the fleet as an **Agents** group
  (`kind:"agent"`, `id:"agent:<id>"`); un-bien keeps the subagents panel and the
  plan panel distinct but shares that id/kind convention.

---

## Summary — what un-bien requires of an emitter

| To…                              | in-process                                                  | out-of-process                                                                                |
| -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **appear** as a subagent         | nothing (non-root `session_start` auto-detected)            | emit `unbien:subagent:child` / `subagents:child:session-created` **with the child id** (§3–4) |
| show **live status**             | **emit** `subagents:*` (by `id`) — event-based (§5)         | **emit** `subagents:*` (by `id`) or re-emit marker `status` — event-based (§5)                |
| be **interactive** (steer/abort) | via the authority (§6A); direct room if un-bien-aware (§6B) | via the authority (§6A) — `unbien:subagent:control` keyed by `id`                             |
| drive the **plan panel**         | `plan:snapshot` / `plan:update` under your `ns` (§7)        | same                                                                                          |
