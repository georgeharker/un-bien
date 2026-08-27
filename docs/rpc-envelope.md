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
  /** Wrapper-kind discriminator, stamped at the outbound choke. `"env"` = the
   *  session {rpc|evt} plane (today). OPEN string — other values are reserved
   *  for future handshake/control envelopes on the same bidirectional wire.
   *  Also satisfies the relay-peer channel's inbound guard (a frame without a
   *  top-level `type` string is dropped) and lets each end tell this route from
   *  the stock protocol without probing. */
  type?: string;   // "env"
  /** Epoch ms, stamped at send (ordering / dedup / debug). */
  ts?: number;
  /** A VERBATIM pi rpc frame, forwarded opaquely. The app parses only what it
   *  renders and IGNORES unknown types (forward-compatible). Byte-faithful to
   *  pi — its own `.type` (message_update/response/...) is a DIFFERENT level
   *  from the wrapper `type` above and never clashes. */
  rpc?: RpcFrame;
  /** An ephemeral, NON-persisted forwarded in-process bus event (the {evt}
   *  plane): plan/subagents/... The fork produces these; they never appear on
   *  `pi --mode rpc` stdout. */
  evt?: Evt;
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

## Direction

- **fork→app**: `rpc` (responses/events/extension_ui_request) + `evt`.
- **app→fork**: `rpc` (RpcCommand / extension_ui_response). No `evt` app→fork.

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
opaque `ct`. `type` = wrapper kind: `"env"` (session `{rpc|evt}` plane) or
`"hello"` (handshake). Stamped at the single outbound choke on each side
(`PlainPeerChannel.sendEnvelope` / `RelayConnection.sendEnvelope`). `ts` = epoch
ms. The inner `.rpc` frame keeps its own `.type` (a different object level).

### Handshake (fork → app, on attach)

```json
{ "type":"hello", "caps":["thinking","models",...,"rpc_envelope"], "protocolVersion":1 }
```

Sent from `_attachOwner` (pairing + reconnect), **before** any session content.
The app reads `caps` here (not from a stock `session_history`) and enables the
envelope route.

### Live plane (fork → app, `{rpc}`)

pi's `--mode rpc` event frames, reconstructed in-process from `pi.on()` via a
ported `toJsonEvent` (see `rpc-on-event-map.md`): `message_start/update/end`,
`tool_execution_start/update/end`, `turn_start/end`, `agent_start/end/settled`,
`compaction_end` (remapped from `session_compact`). Folded by
`SessionState.applyRPC`.

### Command surface (app → fork, `{rpc}`)

Each carries an optional `id`; the fork replies `{rpc:{type:"response",command,
success,data?,error?,id}}` to the **sender**, correlated by `id`.

| command | fields | effect |
|---|---|---|
| `prompt` | `message`, `images?`, `streamingBehavior?` | new user turn |
| `steer` / `follow_up` | `message`, `images?` | queue mid-run / after-run |
| `abort` | — | abort current turn |
| `set_model` | `provider`, `modelId` | switch model (data = Model) |
| `set_thinking_level` | `level` | set reasoning effort |
| `extension_ui_response` | `id`, `value`/`confirmed`/`cancelled` | answer a dialog (routed to the ui bridge, no `response`) |
| `session_sync` | `limit?` | request reconstruction (see below; no `response`) |

(`get_state`/`get_entries`/`compact`/`bash` — reserved, not yet wired.)

### Reconstruction / resume

Request-driven and envelope-native. App `openSession` sends
`{rpc:{type:"session_sync", limit}}`. The fork replays the last `limit` history
events as a sequence of `{rpc}` **live frames** (`message_end` for user/assistant,
`tool_execution_start/end` for tool cards, `compaction_end`), which the app folds
via the SAME `applyRPC` as the live stream — so no separate history reducer, and
tool cards survive. There is no stock `session_history` on this wire.

### extension_ui (envelope-only, both directions)

fork → app: `{rpc:{type:"extension_ui_request", id, method, ...}}` (the SDK rpc
contract 1:1 — `select`/`confirm`/`input`/`editor` dialogs +
`notify`/`setStatus`/`setWidget`/`setTitle`). app → fork:
`{rpc:{type:"extension_ui_response", id, ...}}`.

### Panels (fork → app, `{evt}`)

The plan/subagents bus, aggregated by the fork's panel bridge, is forwarded as
`{evt:{channel:"panel", data:<panel_update>}}`. The app decodes `data` and folds
it into its panel store.

### Outer control (unchanged, mesh layer)

Pairing/auth, relay routing, `room_meta` (model/thinking display),
ping/liveness — these are the mesh/relay layer, not session content, and are
out of scope for this envelope.
