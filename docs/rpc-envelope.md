# rpc-envelope protocol (inner session channel)

The un-bien ↔ fork wire wraps pi's rpc log inside the mesh/relay/multisession
envelope. The **outer** envelope (mesh) owns pairing, owner-key auth, session
routing, lifecycle, remote launch, multi-relay — **out of scope here**. This
doc specifies the **inner per-session-channel payload**.

Decisions: `un-bien↔fork = pi rpc log forwarded opaquely` · `tagged {rpc|evt}`
· `arbitration = relay whole-frame ordering` · `conformance harness`.

## Message

Each relay message on a session channel carries exactly **one** `EnvelopeMessage`
(JSON). One message = one whole frame — the relay delivers whole messages in
order, so command frames never byte-interleave at the child (that *is* the
arbitration).

```ts
interface EnvelopeMessage {
  /** WHO-HANDLES / plane discriminator (NOT direction), stamped at the outbound
   *  choke. Names the handler + the top-level field to read:
   *    "rpc" — the `.rpc` plane: a byte-faithful pi rpc frame handled by the rpc
   *            handler on the RECEIVING side (fork → pi/SDK ACTS; app → RENDERS).
   *    "evt" — the `.evt` plane: an ephemeral forwarded bus event (fork→app).
   *    "cmd" — the `.cmd` plane: an app-custom command with NO pi first-class
   *            verb, handled by the EXTENSION (app→fork).
   *    "hello" — the capability handshake (see below).
   *  Direction is NOT encoded here (a receiver knows its own role, and the inner
   *  `.rpc` frame's own `.type` carries command-vs-response). Also satisfies the
   *  channel's inbound guard (a frame without a top-level `type` is dropped).
   *  NOTE: the wire currently still stamps "env" for the rpc/evt plane
   *  (transitional); the rpc/evt/cmd split is the target. */
  type?: string;
  /** Epoch ms, stamped at send (ordering / dedup / debug). Cross-cutting. */
  ts?: number;
  /** Envelope / pi-rpc protocol version for decode-guarding. Cross-cutting
   *  (meaningful on any frame), so it stays top-level — unlike handshake data. */
  protocolVersion?: number;
  /** A VERBATIM pi rpc frame, forwarded opaquely. The app parses only what it
   *  renders and IGNORES unknown types (forward-compatible). Byte-faithful to
   *  pi — its own `.type` (message_update/response/...) is a DIFFERENT level
   *  from the wrapper `type` above and never clashes. */
  rpc?: RpcFrame;
  /** An ephemeral, NON-persisted forwarded in-process bus event (the {evt}
   *  plane): plan/subagents/... The fork produces these; they never appear on
   *  `pi --mode rpc` stdout. */
  evt?: Evt;
  /** An APP-CUSTOM command (the {cmd} plane, app→fork only) — a command with no
   *  pi first-class rpc verb, so the EXTENSION acts on it, not pi's rpc dispatch.
   *  Its own `.type` names the command (e.g. "session_launch"). */
  cmd?: Cmd;
  /** The capability handshake payload (the {hello} plane, fork→app on attach).
   *  Handshake-only fields nest HERE, not at top level — a session-plane
   *  (rpc/evt/cmd) message must not carry handshake keys. */
  hello?: Hello;
}
interface Cmd { type: string; id?: string; /* command-specific fields */ }
interface Hello {
  caps: string[];       // advertised capabilities the app gates UI on
  sessionId?: string;   // stable pi session id (app keys sessions by it)
}
interface Evt {
  channel: string;   // "plan:snapshot" | "subagents:started" | ...
  data: unknown;     // the raw bus payload
}
```

At least one of `rpc` / `evt` is present; the common case is exactly one. Both
MAY appear in one message (allowed, not required).

## rpc plane — `RpcFrame` (verbatim pi rpc)

Sourced from `pi --mode rpc` stdout (fork→app) or `RpcCommand` (app→fork).
The fork never parses these; it forwards bytes. Shapes (pi 0.84.3):

- **Command responses** `{ type:"response", command, success, data?, error?, id? }`
- **Streamed events** `{ type }` ∈ `message_start` · `message_update`
  (`assistantMessageEvent`: `text_*` / `thinking_*` / `toolcall_*`) ·
  `message_end` · `turn_start` · `turn_end` · `agent_start` · `agent_end` ·
  `agent_settled` · `tool_execution_start` · `tool_execution_update`
  (`partialResult` ACCUMULATES) · `tool_execution_end` · `entry_appended` ·
  `compaction_start/end` · `auto_retry_start/end` · `bash_execution_update`
- **Extension UI** `{ type:"extension_ui_request", id, method, ... }` —
  fire-and-forget `notify` / `setStatus` / `setWidget` / `setTitle`
  (empty text/lines = CLEAR; `statusText` may carry ANSI SGR — strip it) +
  dialogs `select` / `confirm` / `input` / `editor` (app replies
  `extension_ui_response{id,...}`)
- **App→fork commands** `RpcCommand` — `prompt` (needs `streamingBehavior`
  steer|followUp while `isStreaming`) · `steer` · `follow_up` · `abort` ·
  `set_model` · `set_thinking_level` · `compact` · `bash` · `get_state` ·
  `get_entries{since}` · `get_tree` · `get_commands` · ...

## evt plane — `Evt` (in-process bus, NOT on rpc stdout)

`channel` ∈ `plan:snapshot` · `plan:update` · `subagents:ready` · `:started`
· `:steered` · `:compacted` · `:ready` · `:completed` · `:failed`.
Observed payloads (real capture):

- `subagents:started`   `{ id, type, description }`
- `subagents:completed` `{ id, type, description, result, error? }`
- `plan:snapshot`       `{ op, ns, seq, project, items }`  (pi-cribsheet)

A subagent surfaces **three times** and the reducer renders each once: the
`Agent` **tool_execution** is the transcript card; `subagents:*` **evt** drives
the live panel; `subagents:record` **entry_appended** is the persist/reconstruct
copy. Plan for us is **evt only** (pi-acp uses `appendEntry` because its ACP
host is an *external* rpc consumer that can't see the bus).

## Direction & who-handles

`type` encodes WHO HANDLES / which plane — NOT direction. Direction is carried by
(a) which side receives and (b) the inner `rpc.type` (`prompt`/`abort` up;
`response`/`message_update` down). Encoding direction in `type` would be
redundant and would force parallel up/down values, so we don't.

- **`type:"rpc"`** — the rpc handler on the RECEIVING side. fork→ **pi/SDK acts**
  (commands); app→ **renders** (responses + events + `extension_ui_request`).
- **`type:"evt"`** — app view plane. **fork→app only**.
- **`type:"cmd"`** — extension app-command handler. **app→fork only** (the
  extension acts, not pi).

## App→fork command taxonomy (who acts)

Governing rule (decision *"un-bien = pi's first-class rpc surface + a thin layer
on top"*): if pi provides a command **first-class**, the app issues that pi rpc
verb on the `.rpc` plane and **pi acts** — no invented extension hop. un-bien's
two own concerns — **app display** and **who-else-sees-it** (multi-owner
fan-out) — are layered **on top** of pi's native events, never replacing them. A
command rides `.cmd` (extension acts) **only** when pi has no first-class verb.

All pi-native commands carry an optional `id`; the fork replies
`{rpc:{type:"response", command, success, data?, error?, id}}` to the sender.
Command shapes are pi's own (pi.dev/docs/latest/rpc):

| app intent | pi rpc verb (`.rpc`, pi acts) | payload |
| --- | --- | --- |
| send a message | `prompt` | `message`, `images?`, `streamingBehavior?` |
| steer mid-turn | `steer` | `message`, `images?` |
| follow-up after turn | `follow_up` | `message`, `images?` |
| clear the queue | `clear_queue` | — (data = removed text) |
| stop | `abort` | — |
| switch model | `set_model` | `provider`, `modelId` (data = Model) |
| set thinking | `set_thinking_level` | `level` |
| list models | `get_available_models` | — (data = Model[]) |
| compact | `compact` | `customInstructions?` |
| new session | `new_session` | `parentSession?` |

Two `.rpc`-plane frames are un-bien protocol the **fork** handles (not pi's SDK
dispatch), kept on `.rpc` for now: `session_sync` (reconstruction — see below)
and `extension_ui_response` (answers a fork dialog; routed to the ui bridge).

**Queue = pi's native queue.** un-bien does NOT keep a parallel queue buffer:
queuing is `steer`/`follow_up`, clearing is `clear_queue`, and the multi-owner
display ("who else sees it") is pi's native `queue_update` event fanned by the
fork to all owners — the on-top layer, not a replacement.

**`.cmd` plane (extension acts, app→fork only).** The lone member today:

| app intent | `.cmd` frame | why app-custom |
| --- | --- | --- |
| remote launch | `session_launch` `{mode, cwd?, name?}` | spawns a SEPARATE pi process (mesh); pi's `new_session` is same-process |

Status: the app→fork wire is converging onto this taxonomy — the transitional
stock fallback is being removed and the `.cmd`/`type=cmd` plane added; pairing
(`pair_request`) stays a bare pre-attach frame (before any plane exists).

## Versioning

The capability handshake (outer) advertises `protocol_version` + a pi-rpc schema
version. The app decode-guards and ignores unknown frame/evt types, so a pi that
adds rpc frames needs no fork change (the fork forwards opaquely).

---

## pi-unbien envelope protocol (as built)

pi-unbien is **not** a compatibility project: the envelope is the ONLY wire
(no stock `ServerMessage`/`ClientMessage` session protocol). This section is the
canonical description of the surface as implemented in the fork
(`remote_pi/pi-extension`) and app (`un-bien`).

### Wrapper

Every message is `{ type, ts?, ...payload }`, base64(JSON) inside the relay's
opaque `ct`. `type` = WHO-HANDLES / plane (see *Direction & who-handles*):
`"rpc"` / `"evt"` / `"cmd"`, plus `"hello"` (handshake). Stamped at the single
outbound choke on each side (`PlainPeerChannel.sendEnvelope` /
`RelayConnection.sendEnvelope`). `ts` = epoch ms. The inner `.rpc` frame keeps
its own `.type` (a different object level). NOTE: the rpc/evt plane is still
stamped `"env"` on the wire today (transitional); the rpc/evt/cmd split + the
`.cmd` plane are the target this section is converging to.

### Handshake (fork → app, on attach)

```json
{ "type":"hello", "protocolVersion":1,
  "hello":{ "caps":["thinking","models",...,"rpc_envelope"], "sessionId":"abc123" } }
```

Sent from `_attachOwner` (pairing + reconnect), **before** any session content.
Handshake-only fields (`caps`, `sessionId`) nest in the **`hello`** payload — NOT
at the envelope top level, so a session-plane message never carries handshake
keys. `protocolVersion` + `ts` are cross-cutting and stay top-level. The app
reads `hello.caps` (not a stock `session_history`) and enables the envelope
route. (Current code still carries `caps`/`sessionId` top-level; nesting them is
part of the envelope-cleanup pass.)

### Live plane (fork → app, `{rpc}`)

pi's `--mode rpc` event frames, reconstructed in-process from `pi.on()` via a
ported `toJsonEvent` (see `rpc-on-event-map.md`): `message_start/update/end`,
`tool_execution_start/update/end`, `turn_start/end`, `agent_start/end/settled`,
`compaction_end` (remapped from `session_compact`). Folded by
`SessionState.applyRPC`.

One fork-synthesized frame rides the same plane and is NOT a pi event:
`session_sync_end` (below) — the terminator that closes a `session_sync` replay
and carries its metadata. `applyRPC` handles it like any other frame; older app
builds ignore it (unknown type → `default: break`).

### Command surface (app → fork, `{rpc}`)

Each carries an optional `id`; the fork replies `{rpc:{type:"response",command,
success,data?,error?,id}}` to the **sender**, correlated by `id`.

| command | fields | effect |
| --- | --- | --- |
| `prompt` | `message`, `images?`, `streamingBehavior?` | new user turn |
| `steer` / `follow_up` | `message`, `images?` | queue mid-run / after-run |
| `abort` | — | abort current turn |
| `set_model` | `provider`, `modelId` | switch model (data = Model) |
| `set_thinking_level` | `level` | set reasoning effort |
| `extension_ui_response` | `id`, `value`/`confirmed`/`cancelled` | answer a dialog (routed to the ui bridge, no `response`) |
| `session_sync` | `limit?` | request reconstruction (see below; no `response`) |

The FULL target command set + who-acts is the *App→fork command taxonomy* table
above: app intents map to pi's first-class verbs (`prompt`/`steer`/`follow_up`/
`clear_queue`/`abort`/`set_model`/`set_thinking_level`/`get_available_models`/
`compact`/`new_session`) on `.rpc` (pi acts). Queued messages use pi's NATIVE
queue (`steer`/`follow_up`/`clear_queue` + `queue_update` fanned to owners), not
a parallel buffer. The only `.cmd` (extension-acts) command is `session_launch`
(mesh remote-launch of a separate pi process).

### Reconstruction / resume

Request-driven and envelope-native. App `openSession` sends
`{rpc:{type:"session_sync", id, limit?}}`. The fork answers, **to that sender
only**, with this ordered sequence:

1. **Queued-message state** — `_sendQueuedState`, the app's editable queue.
2. **Transcript replay** — the last-N history events as `{rpc}` **live frames**
   (`message_end` for user/assistant, `tool_execution_start/end` for tool cards,
   `compaction_end`), folded by the SAME `applyRPC` as the live stream. No
   separate history reducer; tool cards survive.
3. **Terminator** — `{rpc:{type:"session_sync_end", in_reply_to, session_started_at,
   truncated}}`. Its ARRIVAL is the end-of-stream signal (no `eos` flag).
   `session_started_at` is the session clock; `truncated` = older history exists
   beyond the returned window. Always sent, even for empty history, so the app
   reliably learns the clock on a fresh session.
4. **Pending `extension_ui`** — any in-flight dialog awaiting an answer, so a
   late-joining peer re-opens the modal over a synced chat.
5. **Panels** — current plan/subagents side-panels replayed as
   `{evt:{channel:"panel",...}}` (see below).

**Limit is server-clamped:** the returned window is `min(client limit ?? server
default, server default)` — a client can never pull more than `UNBIEN_SYNC_LIMIT`
allows. `slice = events.slice(-limit)` (the newest N), recomputed on every sync,
so a reconnect re-pulls the whole current window. There is no stock
`session_history` on this wire.

### extension_ui (envelope-only, both directions)

fork → app: `{rpc:{type:"extension_ui_request", id, method, ...}}` (the SDK rpc
contract 1:1 — `select`/`confirm`/`input`/`editor` dialogs +
`notify`/`setStatus`/`setWidget`/`setTitle`). app → fork:
`{rpc:{type:"extension_ui_response", id, ...}}`.

### Panels (fork → app, `{evt}`)

The plan/subagents bus, aggregated by the fork's panel bridge, is forwarded as
`{evt:{channel:"panel", data:<panel_update>}}`. The app decodes `data` and folds
it into its panel store. Panels flow on **two** occasions: **live**, whenever the
bus emits (`plan:snapshot`/`plan:update`/`subagents:*`), and on **`session_sync`**,
where the bridge's `pendingPanels()` are replayed to the requesting peer — so a
peer that attaches AFTER a panel was produced still sees it, instead of waiting
for the next bus event. Both use the identical `{evt}` shape.

### End-to-end flow (both sides)

The lifecycle of one chat, naming the fork (`extension/src/index.ts`) and app
(`UnBienCore`/`UnBienApp`) touchpoints:

1. **App starts / opens a session.** After pairing (or on reconnect), the app
   has an `(epk, roomId)` for the chat and calls `openSession` — it subscribes
   on the relay and sends `{rpc:{type:"session_sync", id, limit?}}` addressed to
   that `(epk, room)`. Nothing about history is assumed from the pairing frames.

2. **Fork attaches and greets.** When a peer attaches (`_attachOwner`), the fork
   sends the `hello` envelope FIRST — `caps` + the pi `sessionId` — before any
   content, so the app turns on the envelope route and the capability-gated UI
   (thinking/models/panels) immediately. Attach does NOT proactively dump
   history; reconstruction is request-driven.

3. **Connection gets history.** The fork's `_routeRpcCommandFrom` sees the
   `{rpc}` `session_sync` and runs the reconstruction sequence above — queued
   state, transcript replay frames, `session_sync_end` terminator, pending
   `extension_ui`, panels — all `sendEnvelope`'d to the requesting channel ONLY
   (per-sender; a sync from peer A never lands on peer B's wire). The app folds
   every replay frame through `SessionState.applyRPC` (the same reducer as live),
   and `session_sync_end` sets `sessionStartedAt`. A reconnect just re-issues
   `session_sync` and re-pulls the current window.

4. **Live streaming.** From then on the fork forwards pi events as `{rpc}`
   frames as they happen; the app folds them with the same `applyRPC`. There is
   no distinction in the app between "history" and "live" — both are the same
   frames through the same reducer, which is why tool cards and interleaving
   survive a resume.

5. **Panels.** The fork's panel bridge subscribes to the plan/subagents bus and
   emits `{evt:{channel:"panel", ...}}` live on every bus event. On a
   `session_sync` it ALSO replays `pendingPanels()` to the joining peer. The app
   routes any `{evt channel:"panel"}` — live or replayed, identical shape —
   through its stock panel decoder into `PanelState`, so a late attach shows the
   current plan/subagents without waiting for the next bus tick.

6. **Commands / dialogs.** App→fork commands (`prompt`/`steer`/`abort`/
   `set_model`/…) and `extension_ui_response` all ride `{rpc}` to `(epk, room)`;
   the fork replies `{rpc:{type:"response", id, …}}` to the sender. Dialogs the
   fork raises come as `extension_ui_request` and are replayed on sync if still
   pending.

### Outer control (unchanged, mesh layer)

Pairing/auth, relay routing, `room_meta` (model/thinking display),
ping/liveness — these are the mesh/relay layer, not session content, and are
out of scope for this envelope.

## Room disambiguation, pairing, and content routing

Two identities, deliberately **different**:

- **Machine identity = the Pi's persisted Ed25519 pubkey (`epk`).** Resolved by
  `getOrCreateEd25519Keypair()` from the OS keychain (or
  `~/.pi/un-bien/identity.json`, `0o600`), so it is **stable across restarts**
  and unique per machine. Pairing trust is recorded against it (`PairedMachine`
  keyed by `epk`), and it is the relay's routing key.
- **Chat-session identity = a room id derived from the Pi session id**
  (`sessionManager.getSessionId()` → `roomIdForSession` = `base64url(sha256(id))[:12]`).
  The session id is **durable across resume** (it lives in the session-file
  header and is reused when the file is reopened; a fresh session mints a new
  id), so the room is stable across reconnect and unique per chat. Two chats
  with the **same name** are distinct (different session ids → different rooms).
  The tile still **displays the session's title/name** (`room_meta.name`, which
  may change freely) — identity is the key, not the label.

The app keys **all** per-session state — transcript, capabilities, panels —
under `relayID:peer:roomId`, where `roomId` is the session room learned live from
`room_announced`. Identity is established from the announce, **never** re-keyed
from a late-arriving frame.

### Pairing: room-scoped handshake, machine-level trust

The QR token is issued by ONE session (`qrSession` is per Pi process), so the
handshake belongs to that session:

- The QR carries `epk` and `rm` = the **issuing session's** room
  (session-id-derived `_myRoomId`).
- The app sends `pair_request` room-specifically to `(epk, rm)`; the relay
  delivers it via `forward(peer, room)` to **exactly** that session. Only the
  token-issuing session receives and answers (`qrSession.consumeToken` →
  `pair_ok`) — no fan-out, no cross-session race.
- **Trust lands on the machine:** `pair_ok` persists a `PairedMachine` keyed by
  `epk`. The app then `subscribe`s to the peer and discovers **all** the
  machine's chats via `room_announced`, grouping them under the one `epk`. So
  "pair once, see every chat" holds **without** any app→machine broadcast.

### Content is room-specific (anti-bleed)

Every app→Pi frame — the `pair_request`, transcript `{rpc}`, panel `{evt}`,
commands — is addressed to a specific `(epk, room)` and delivered by the relay's
`forward(peer, room)` to that **exact** connection only. A frame for chat A can
never surface in chat B. There is **no** app→Pi broadcast path: reaching "all of
a machine's chats" is done by addressing each announced session room in turn, so
the `epk` + `room_announced` discovery covers every case. Guarded by the relay
test `forward_is_room_specific_no_bleed`. **Bleed or data loss is a hard no.**
