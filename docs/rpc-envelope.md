# rpc-envelope protocol (inner session channel)

The Un Bien ↔ fork wire wraps pi's rpc log inside the mesh/relay/multisession
envelope. The **outer** envelope (mesh) owns pairing, owner-key auth, session
routing, lifecycle, remote launch, multi-relay — **out of scope here**. This
doc specifies the **inner per-session-channel payload** as built in the fork
(`extension/src/…`) and app (`app/Sources/UnBien…`).

pi-unbien is **not** a compatibility project: the envelope is the ONLY session
wire — there is no stock `ServerMessage`/`ClientMessage` session protocol. The
one non-envelope frame is the pre-attach `pair_request` (before any plane
exists), plus the outer relay/transport control (auth, rooms, keepalive).

Governing decisions: *envelope tx is tagged `{rpc | evt | ub}`* · *Un Bien = pi's
first-class rpc surface + a thin mesh/display layer on top (never replace pi
primitives)* · *transcript = native `get_entries`; `session_sync` = panels + ui
only* · *queue display is app-owned (pi does not deliver `queue_update` to
extensions)* · *aux display sidecar rides alongside rpc* · *arbitration = relay
whole-frame ordering* · *cross-language conformance harness*.

## Message

Each relay message on a session channel carries exactly **one** `EnvelopeMessage`
(base64(JSON) inside the relay's opaque `ct`). One message = one whole frame —
the relay delivers whole messages in order, so command frames never
byte-interleave at the child (that *is* the arbitration).

```ts
interface EnvelopeMessage {
  /** Protocol-NAMESPACE / who-handles discriminator (NOT direction), stamped at
   *  the outbound choke. Names the handler + the top-level payload field to read:
   *    "rpc" — the `.rpc` plane: a byte-faithful pi rpc frame, handled by the rpc
   *            handler on the RECEIVING side (fork → pi/SDK ACTS; app → RENDERS).
   *    "evt" — the `.evt` plane: an ephemeral forwarded pi bus event (fork→app).
   *    "ub"  — the `.ub` plane: Un Bien's OWN protocol (both directions); the
   *            inner `.type` (hello / session_sync / session_launch / …) picks
   *            the handler + direction.
   *  Direction is NOT encoded here — the receiver knows its own role, and the
   *  inner frame's `.type` carries command-vs-response / which-end-acts. Legacy
   *  "env" is still ACCEPTED on read for one transition, never stamped. */
  type?: string;
  /** Epoch ms, stamped at send (ordering / dedup / debug). Cross-cutting. */
  ts?: number;
  /** Envelope / pi-rpc protocol version for decode-guarding. Cross-cutting
   *  (meaningful on any frame), so it stays top-level. */
  protocolVersion?: number;
  /** A VERBATIM pi rpc frame, forwarded opaquely. The app parses only what it
   *  renders and IGNORES unknown types (forward-compatible). Byte-faithful to
   *  pi — its own `.type` (message_update/response/…) is a DIFFERENT object
   *  level from the wrapper `type` and never clashes. */
  rpc?: RpcFrame;
  /** An ephemeral, NON-persisted forwarded in-process bus event (the {evt}
   *  plane): plan/subagents/… The fork produces these; they never appear on
   *  `pi --mode rpc` stdout. */
  evt?: Evt;
  /** Un Bien's OWN protocol plane. The inner `.type` discriminates: hello
   *  (fork→app handshake), session_sync (app→fork), session_sync_end (fork→app),
   *  session_launch (app→fork). Handshake caps/sessionId nest in the `hello`
   *  inner frame, NOT at the envelope top level. */
  ub?: UbFrame;
  /** OPTIONAL Un Bien display sidecar riding ALONGSIDE `rpc` in the same
   *  envelope (the `rpc` frame stays byte-faithful). Sole tenant: best-effort
   *  LIVE input-Edit diff `hunks` on a `tool_execution_start` frame. OUTPUT is
   *  classified app-side from the persisted result (no `aux.output` on the
   *  wire) — design 01M177AF. */
  aux?: { hunks?: unknown[] };
}

type UbFrame =
  | { type: "hello"; caps: string[]; sessionId?: string }          // fork→app
  | { type: "session_sync"; id?: string; limit?: number }          // app→fork
  | { type: "session_sync_end"; in_reply_to?: string;              // fork→app
      session_started_at?: number }
  | { type: "session_launch"; id?: string; mode: string;           // app→fork
      cwd?: string; name?: string };

interface Evt { channel: string; data: unknown; }  // channel: "panel" | …
```

Exactly one of `rpc` / `evt` / `ub` is the payload; `aux` (when present) rides
alongside `rpc`.

## Planes: who-handles, and why direction is NOT in `type`

`type` = the protocol NAMESPACE / who-handles, never direction:

- **`rpc`** — pi's rpc protocol. The rpc handler on the RECEIVING side acts:
  fork→ **pi/SDK acts** (commands); app→ **renders** (responses + events +
  `extension_ui_request`). **Both directions.**
- **`evt`** — pi's in-process bus events, forwarded to the app view plane.
  **fork→app only.**
- **`ub`** — Un Bien's OWN protocol (handshake, reconstruction request, mesh
  launch). **Both directions**; the inner `.type` + receiver decide who acts.

Direction is recovered from the inner frame's `.type` + receiver role, the same
rule pi's own rpc uses (a `prompt` is only app→pi, a `response` only pi→app —
disjoint inner types). A wrapper direction tag would be warranted only if some
inner type occurred in both directions with different handling; none does, so it
would be pure redundancy. This is exactly why an earlier `ext`(app→fork) +
`app`(fork→app) split collapsed into the single bidirectional `ub` plane. Escape
hatch: if a genuinely bidirectional same-type frame ever appears, add a direction
tag *then*.

## Stamping (the wrapper)

`type` + `ts` are stamped at the single outbound choke on each side
(`PlainPeerChannel.sendEnvelope` / `RelayConnection.sendEnvelope`). Each plane
stamps its REAL type — `rpc`→`"rpc"`, `evt`→`"evt"`, `ub`→`"ub"` (constants
`RPC_KIND`/`EVT_KIND`/`UB_KIND`). Legacy `"env"` is no longer stamped but is
still accepted on read for one transition. The inbound guard on each side accepts
a real-typed wrapper (or legacy `"env"`) OR a bare `rpc`/`evt`/`ub` body
(field-presence), routing it to the envelope dispatcher rather than any stock
path. The inner `.rpc` frame keeps its own `.type` at a different object level.

## rpc plane — `RpcFrame` (verbatim pi rpc)

Sourced from pi's rpc log: `pi.on()` events reconstructed in-process (fork→app)
or `RpcCommand` (app→fork). The fork never parses these — it forwards bytes,
and reconstructs the live plane via `createRpcEnvelope` over `RPC_EVENT_NAMES`
(`rpc_envelope.ts`). Shapes (pi 0.84.3):

- **Command responses** `{ type:"response", command, success, data?, error?, id? }`
- **Streamed events** `{ type }` ∈ `message_start` · `message_update`
  (`text_*` / `thinking_*` / `toolcall_*`) · `message_end` · `turn_start` ·
  `turn_end` · `agent_start` · `agent_end` · `agent_settled` ·
  `tool_execution_start` · `tool_execution_update` (`partialResult` ACCUMULATES) ·
  `tool_execution_end` · `compaction_end` (remapped from `session_compact`) ·
  `auto_retry_start/end` · `bash_execution_update`
- **Extension UI** `{ type:"extension_ui_request", id, method, … }` —
  fire-and-forget `notify` / `setStatus` / `setWidget` / `setTitle` (empty
  text/lines = CLEAR; `statusText` may carry ANSI SGR — strip it) + dialogs
  `select` / `confirm` / `input` / `editor` (app replies `extension_ui_response`).
- **App→fork commands** — see *command taxonomy* below.

The app folds every `{rpc}` frame — live OR reconstructed — through the SAME
`SessionState.applyRPC` / `applyEntries` reducers. There is no separate "history"
decoder, which is why tool cards and interleaving survive a resume.

## evt plane — `Evt` (in-process bus, NOT on rpc stdout)

The fork's panel bridge subscribes to the plan/subagents bus and forwards each
aggregated update as `{evt:{channel:"panel", data:<panel_update>}}`. Underlying
bus channels: `plan:snapshot` · `plan:update` · `subagents:ready/started/steered/
compacted/completed/failed`. Observed payloads:

- `subagents:started`   `{ id, type, description }`
- `subagents:completed` `{ id, type, description, result, error? }`
- `plan:snapshot`       `{ op, ns, seq, project, items }`

A subagent surfaces three ways and the reducer renders each once: the `Agent`
**tool_execution** is the transcript card (`{rpc}`); `subagents:*` **evt** drives
the live panel; `subagents:record` **entry_appended** is the persist/reconstruct
copy (picked up by `get_entries`). Panels are **evt-only** — Un Bien keeps no
parallel panel buffer beyond the bridge's `pendingPanels()` replay.

## ub plane — Un Bien's own protocol

| inner `.type` | direction | payload | purpose |
| --- | --- | --- | --- |
| `hello` | fork→app | `{ caps: string[], sessionId? }` | capability handshake on attach |
| `session_sync` | app→fork | `{ id?, limit? }` | request panels + pending-ui reconstruction |
| `session_sync_end` | fork→app | `{ in_reply_to?, session_started_at? }` | reconstruction terminator + session clock |
| `session_launch` | app→fork | `{ mode, cwd?, name? }` | mesh remote-launch of a SEPARATE pi process |

`hello` and `session_sync_end` are folded by the app the same way as an rpc
frame (`session_sync_end`'s inner `.type` drives `applyRPC`). `session_launch` is
app-custom because it spawns a separate pi process (mesh) — pi's `new_session`
(rpc) is same-process.

## aux — display sidecar

`aux` carries Un Bien display elaboration ALONGSIDE a byte-faithful `{rpc}` frame
in the same envelope, so the rpc plane stays pi-faithful while the app still gets
richer rendering. Sole tenant now: Edit-family `tool_execution_start` frames
carry `aux.hunks` (pre-computed input diff hunks) next to the raw tool args.
Absent on most frames; decode tolerates its absence.

**`aux.hunks` is BEST-EFFORT LIVE (design 01M177AF).** The extension computes
the input Edit diff while the file is still fresh (it needs the pre-edit file on
disk, which the app can't reach and which the edit destroys). It is NOT
persisted and NOT reconstructable after the fact — a `get_entries` replay simply
has no `aux.hunks`, and the card degrades to its Content view (the new text from
the persisted args, shown as a code block). A diff cannot be reconstructed later,
so there is no app-side floor for it; only capture-or-lose.

**OUTPUT classification is APP-SIDE — there is NO `aux.output` on the wire.**
Because a tool `result` PERSISTS in the session log, the app classifies it in its
own reducer (`ToolOutputClassifier` in `fillToolCard`), which runs identically
for a live `tool_execution_end` frame AND a `get_entries` replay entry (the
reducer synthesizes the end frame from the `toolResult`). So replay is enriched
by construction, from one implementation, with the extension out of the loop.
The produced container matches the shape the card renders:

```ts
card.output = { v: 1, blocks: OutputBlock[], truncated?: boolean }
type OutputBlock =
  | { kind: "diff"; hunks: { lines: DiffLine[] }[] }  // result already IS a diff
  | { kind: "code"; text: string; lang?: string }     // bash/read-family output
```

`code` carries plain output text the app SYNTAX-HIGHLIGHTS (shared HighlightEngine
/ highlight.js, cached + theme-matched); ANSI is stripped, not parsed. Emitted
for code-ish tools only: bash-family (`lang:"shell"`) and read-family (`lang`
from the file extension in `args.path`); unknown language is OMITTED so the
highlighter auto-detects. A `diff` block is produced only when the RESULT already
embeds a unified diff (re-reading persisted text, never reconstructing). The
classifier NEVER throws, returns nil when nothing is recognised (most tools → raw
`rpc.result` JSON), skips unknown kinds per-block, and caps block count /
bytes-per-block / total bytes, setting `truncated:true` rather than an unbounded
payload.

DEFERRED escape hatch (not built): if input-diff replay fidelity is ever wanted,
the extension could `addEntry` a SIBLING aux-wrapper entry into the ledger
(keeping the tool entry pi-faithful) that rides the ledger's own persistence and
`get_entries` delivery — pending a check that pi's ledger accepts an Un Bien-typed
entry it ignores and returns.

## App→fork command taxonomy (who acts)

Rule: if pi provides a command **first-class**, the app issues that pi rpc verb
on `.rpc` and **pi acts** — no invented extension hop. Un Bien's two own concerns
(app **display** and multi-owner **fan-out**) layer on top of pi's native events,
never replacing them. A frame rides `.ub` only when it is Un Bien's own protocol.

The app encodes a stock-shaped `ClientMessage` and maps it to the wire at ONE
seam (`RelayConnection.mapToWire`); app call sites stay unchanged. Field renames
match pi's rpc contract (`text`→`message`, `model_id`→`modelId`,
`streaming_behavior`→`streamingBehavior`).

| app intent | wire | payload |
| --- | --- | --- |
| send a message | `{rpc}` `prompt` | `message`, `images?`, `streamingBehavior?` |
| steer mid-turn | `{rpc}` `steer` | `message`, `images?` |
| follow-up after turn | `{rpc}` `follow_up` | `message`, `images?` |
| stop | `{rpc}` `abort` | — |
| switch model | `{rpc}` `set_model` | `provider`, `modelId` (data = Model) |
| set thinking | `{rpc}` `set_thinking_level` | `level` |
| list models | `{rpc}` `get_available_models` | — (data = Model[]) |
| compact | `{rpc}` `compact` | `customInstructions?` |
| new session | `{rpc}` `new_session` | — (daemon: fresh-restart via supervisor) |
| transcript / delta | `{rpc}` `get_entries` | `since?` (leafId cursor) → `{entries, leafId}` |
| answer a dialog | `{rpc}` `extension_ui_response` | `id`, `value`/`confirmed`/`cancelled` |
| reconstruct panels+ui | `{ub}` `session_sync` | `id`, `limit?` |
| remote launch | `{ub}` `session_launch` | `mode`, `cwd?`, `name?` |

Each pi-native command carries an optional `id`; the fork replies
`{rpc:{type:"response", command, success, data?, error?, id}}` to the SENDER,
correlated by `id`. `session_sync` / `session_launch` (ub plane) have their own
replies (`session_sync_end` / none). `pair_request` is a bare pre-attach frame.

### Queue = pi's native queue, display = app-owned

Un Bien keeps **no** parallel queue buffer. Queuing IS pi's native mechanism: a
`prompt` with `streamingBehavior:"followUp"` queues after the turn,
`streamingBehavior:"steer"` interrupts mid-turn; the app decides the verb
(idle→prompt, busy Send→steer, Queue→followUp) and the fork passes it straight to
pi's `deliverAs` (no fork-side inference beyond a mechanical busy-safety net).

**pi does NOT deliver `queue_update` to extensions** — it is routed only to the
host `subscribe` stream that `pi --mode rpc` consumes; the `ExtensionAPI` exposes
just `hasPendingMessages():boolean`. So the fork CANNOT forward a queue snapshot,
and the queued/steer **display is APP-OWNED**: an optimistic pending chip on
submit (grey = steer, blue = followUp), cleared when the MODEL CONSUMES it (the
message runs and echoes back as a user `message_end`, correlated by text, one
chip per consumption), with a long backstop timer for the never-consumed case.
Gap (accepted): another device can't see this device's still-pending text.

## Reconstruction / resume

Split into two INDEPENDENT app-issued requests, on BOTH open and reconnect:

1. **Transcript = native pi `get_entries` (rpc, app-direct).** The app sends
   `{rpc:{type:"get_entries", since?}}` where `since` = the reducer's last
   `leafId` (delta cursor). The fork replies `{rpc:{type:"response",
   command:"get_entries", data:{entries, leafId}}}` — the FULL session log
   (compaction appears in-log as a `CompactionEntry`, no hole). The app reduces
   raw pi `SessionEntry`s through the SAME identify/message_end/tool_execution
   path as the live stream (`SessionState.applyEntries`), so live == replay and
   dedup is by message-intrinsic id (`responseId`, else a stable content hash) —
   re-opening never double-fills.

2. **Panels + pending UI = `{ub}` `session_sync`.** The app sends
   `{ub:{type:"session_sync", id, limit?}}`. The fork answers, **to that sender
   only**, with: any pending `extension_ui` requests (so a late peer re-opens an
   open dialog), the panel bridge's `pendingPanels()` as `{evt:{channel:"panel"}}`
   frames, then the `{ub}` `session_sync_end` terminator carrying
   `session_started_at` (the session clock — lets the app detect a pi restart).
   `session_sync` carries **no** transcript replay and **no** queued-state buffer
   (both retired): the transcript is `get_entries`, the queue is app-owned.

Per-sender: a sync from peer A never lands on peer B's wire. A reconnect just
re-issues both requests; `get_entries{since=leafId}` pulls only the delta.

## extension_ui (envelope-only, both directions)

The fork's `extension_ui_bridge` translates pi-ask's in-process flow events into
the SDK's `extension_ui_request/response` shapes, then emits them on the envelope
(`_uiBroadcast` wraps `extension_ui_request` as `{rpc}`; the bridge itself is a
translator, not a stock producer). fork→app:
`{rpc:{type:"extension_ui_request", id, method, …}}` (`select`/`confirm`/`input`/
`editor` dialogs + `notify`/`setStatus`/`setWidget`/`setTitle`). app→fork:
`{rpc:{type:"extension_ui_response", id, …}}`, routed to the bridge's `respond`.
Pending requests replay on `session_sync`. Inert when pi-ask is absent.

## Panels (fork → app, `{evt}`)

`_panelBroadcast` forwards each aggregated `panel_update` as
`{evt:{channel:"panel", data}}`. Panels flow on two occasions — **live** whenever
the bus emits, and on **`session_sync`** (the bridge's `pendingPanels()` replayed
to the joining peer) — both using the identical `{evt}` shape, so a late attach
shows the current plan/subagents without waiting for the next bus tick.

## Handshake (fork → app, on attach)

```json
{ "type":"ub", "protocolVersion":1,
  "ub":{ "type":"hello", "caps":["thinking","models",…,"rpc_envelope"],
         "sessionId":"abc123" } }
```

Sent from `_attachOwner` (pairing + reconnect) FIRST, before any content, so the
app turns on the envelope route and the capability-gated UI (thinking/models/
panels) immediately. Handshake-only fields (`caps`, `sessionId`) nest INSIDE the
`hello` inner frame, never at the envelope top level. `protocolVersion` + `ts`
stay top-level. The app reads `hello.caps` (not a stock `session_history`). A new
`sessionId` for a stable room means a different session reused it → the app resets
transcript/panels/prompt so the prior session doesn't leak in.

## End-to-end flow

1. **App opens a session.** After pairing/reconnect the app has `(epk, roomId)`,
   subscribes on the relay, and issues reconstruction: `{rpc}` `get_entries{since}`
   (transcript) + `{ub}` `session_sync` (panels/ui). Nothing about history is
   assumed from pairing frames.
2. **Fork attaches and greets.** `_attachOwner` sends the `{ub}` `hello` FIRST
   (caps + `sessionId`), before content. Attach does NOT proactively dump
   history; reconstruction is request-driven.
3. **Reconstruction.** The fork answers `get_entries` with the full log
   (`{entries, leafId}`) and `session_sync` with pending-ui + panels + the `{ub}`
   `session_sync_end` — all to the requesting channel ONLY. The app reduces
   entries via `applyEntries`, sets `session_started_at`, renders panels.
4. **Live streaming.** The fork forwards pi events as `{rpc}` frames (+ `aux`
   where applicable); the app folds them with the same reducer. No history/live
   distinction in the app.
5. **Panels.** Live `{evt}` on every bus event; replayed on `session_sync`.
6. **Commands / dialogs.** App→fork commands + `extension_ui_response` ride
   `{rpc}` (or `{ub}` for `session_sync`/`session_launch`) to `(epk, room)`; the
   fork replies `{rpc:{type:"response", id, …}}` to the sender. Fork-raised
   dialogs arrive as `extension_ui_request`, replayed on sync if still pending.

## Versioning

The `{ub}` `hello` advertises `caps` + `protocolVersion`. The app decode-guards
and ignores unknown frame/evt/ub-inner types, so a pi that adds rpc frames needs
no fork change (the fork forwards opaquely) and an older app degrades gracefully
(`default: break`).

## Outer control (unchanged, mesh/transport layer)

Pairing/auth, relay routing, `room_meta` (model/thinking display), rooms
subscribe, ping/keepalive — the mesh/relay/transport layer BELOW the session
envelope, out of scope here. They stay stock because they establish and route the
channel that carries the envelope.

## Room disambiguation, pairing, and content routing

Two identities, deliberately **different**:

- **Machine identity = the Pi's persisted Ed25519 pubkey (`epk`).** Resolved by
  `getOrCreateEd25519Keypair()` from the OS keychain (or
  `~/.pi/un-bien/identity.json`, `0o600`), stable across restarts, unique per
  machine. Pairing trust is recorded against it (`PairedMachine` keyed by `epk`),
  and it is the relay's routing key.
- **Chat-session identity = a room id derived from the Pi session id**
  (`sessionManager.getSessionId()` → `base64url(sha256(id))[:12]`). The session
  id is durable across resume (it lives in the session-file header, reused when
  reopened; a fresh session mints a new id), so the room is stable across
  reconnect and unique per chat. Two chats with the same NAME are distinct
  (different session ids → different rooms); the tile displays the mutable
  `room_meta.name`, but identity is the key, not the label.

The app keys all per-session state — transcript, capabilities, panels — under
`relayID:peer:roomId`, where `roomId` is learned live from `room_announced`.
Identity is established from the announce, never re-keyed from a late frame.

### Pairing: room-scoped handshake, machine-level trust

The QR token is issued by ONE session (`qrSession` is per Pi process):

- The QR carries `epk` and `rm` = the issuing session's room (`_myRoomId`).
- The app sends `pair_request` room-specifically to `(epk, rm)`; the relay
  delivers it via `forward(peer, room)` to exactly that session, which alone
  answers (`qrSession.consumeToken` → `pair_ok`). No fan-out, no cross-session
  race.
- **Trust lands on the machine:** `pair_ok` persists a `PairedMachine` keyed by
  `epk`. The app then `subscribe`s and discovers ALL the machine's chats via
  `room_announced`, grouped under the one `epk` — "pair once, see every chat"
  with no app→machine broadcast.

### Content is room-specific (anti-bleed)

Every app→Pi frame — `pair_request`, `{rpc}`/`{ub}` commands, transcript, panels
— is addressed to a specific `(epk, room)` and delivered by the relay's
`forward(peer, room)` to that exact connection only. A frame for chat A can never
surface in chat B; there is no app→Pi broadcast (reaching "all of a machine's
chats" is done by addressing each announced room in turn). Guarded by the relay
test `forward_is_room_specific_no_bleed`. **Bleed or data loss is a hard no.**
