# `pi.on()` ↔ rpc/json frame map (producer reference)

How the in-process extension producer reconstructs pi's `--mode rpc` stream from the
extension `pi.on()` catalog. Companion to [`rpc-envelope.md`](./rpc-envelope.md).

**Sources.** rpc/json stream = `JsonAgentSessionEvent` (= `AgentSessionEvent`
with `message_update` partials stripped) — pi.dev/docs/latest/json,
`packages/coding-agent/src/modes/json-event.ts`, `core/agent-session.ts:143-185`.
`pi.on()` catalog = `extensions/types.ts:1257-1301`. rpc command/response +
`extension_ui` + `get_entries{since}` = pi.dev/docs/latest/rpc. Verified vs pi
0.84.3 (`~/Development/pi/pi`).

**Timing (validated, `agent-session.ts:623` `_handleAgentEvent`).** Per event:
`await _emitExtensionEvent` (pi.on, L647) → `_emit` (subscribe/rpc, L650) →
**persist** (L652-669, only on `message_end`: `appendMessage`, synchronous). So
the entry is NOT in `getEntries()` when its own `on()` cue fires; `turn_end` is
the first cue that sees the turn's committed entries.

---

## A. Session-content frames the consumer renders — all available via `pi.on()`

The Un Bien consumer (`SessionState.applyRPC`, SessionState.swift:237) renders
exactly these. Every one is deliverable from a `pi.on()` payload (± a known
transform).

| rpc/json frame | `pi.on()` event | payload delta vs rpc frame | transform to emit |
| --- | --- | --- | --- |
| `agent_start` | `agent_start` | identical `{}` | passthrough |
| `agent_end` | `agent_end` | `on` = `{messages}`; rpc adds `willRetry` | add `willRetry` (compute via `_willRetryAfterAgentEnd`, or default `false`) |
| `agent_settled` | `agent_settled` (types.ts:1285) | identical `{}` | passthrough — **consumer closes the turn on this** |
| `turn_start` | `turn_start` | `on` is a superset (`turnIndex`,`timestamp`); rpc = `{}` | passthrough (extra fields harmless) |
| `turn_end` | `turn_end` | `on` superset (`turnIndex`); rpc = `{message,toolResults}` | passthrough |
| `message_start` | `message_start` | identical `{message}` | passthrough |
| `message_update` | `message_update` | `on` = `{message, assistantMessageEvent}` (cumulative + `partial`); rpc = `{usage, assistantMessageEvent}` partial-stripped | **`toJsonEvent`**: drop `message` + `assistantMessageEvent.partial`, set `usage = message.usage`; `toolcall_start` keeps `id`+`toolName` |
| `message_end` | `message_end` | identical `{message}` | passthrough |
| `tool_execution_start` | `tool_execution_start` | identical `{toolCallId,toolName,args}` | passthrough |
| `tool_execution_update` | `tool_execution_update` | identical `{toolCallId,toolName,args,partialResult}` (`partialResult` = accumulated, not delta) | passthrough |
| `tool_execution_end` | `tool_execution_end` | identical `{toolCallId,toolName,result,isError}` | passthrough |
| `compaction_end` | `session_compact` | **different event**: `on` = `{compactionEntry,fromExtension,reason,willRetry}`; rpc `compaction_end` = `{reason,result{summary,tokensBefore,…},aborted,willRetry,errorMessage?}` | **remap**: `compaction_end.result` ← `session_compact.compactionEntry` (`summary`,`tokensBefore`) |

---

## B. In the rpc stream but NOT deliverable via `pi.on()` — the true gap

| rpc/json frame | consumer uses it? | producer source |
| --- | --- | --- |
| `entry_appended` | **no** (`applyRPC` → `default: break`) | **`getEntries()` / `get_entries{since}`** — reconstruction spine only (attach/resume + out-of-band) |
| `queue_update` | no (v1) | — skip |
| `compaction_start` | no (v1) | — (`compaction_end` covers the render) |
| `auto_retry_start` / `auto_retry_end` | no (v1) | — skip |
| `summarization_retry_scheduled` / `_attempt_start` / `_finished` | no | — skip |
| `bash_execution_update` | no (v1; direct-rpc-`bash` only) | — skip |
| `extension_error` | no | — skip |

`get_entries{since:<entryId>}` is a durable id-cursor: returns entries strictly
after the id (across restarts), includes pre-compaction history + abandoned
branches, response `{entries:[{type,id,parentId,timestamp,message}], leafId}`.
This is the reconstruction/resume path — delivered as the `get_state`/
`get_entries` **response** the reducer already handles, NOT per-frame
`entry_appended`, so the one-cue persist lag is irrelevant.

---

## C. `pi.on()`-only — never in the rpc stream (extension control plane)

Lifecycle hooks, interceptors, and metadata discovery. Drive the extension's own
logic (pairing/auth/mutation/gating); NOT session-content frames.

`project_trust`, `resources_discover`, `session_start`, `session_info_changed`,
`session_before_switch`, `session_before_fork`, `session_before_compact`,
`session_compact_failed`, `session_shutdown`, `session_before_tree`,
`session_tree`, `context`, `before_provider_request`, `before_provider_headers`,
`after_provider_response`, `before_agent_start`, `ui_prompt_start`,
`ui_prompt_end`, `model_select`, `thinking_level_select`, `tool_call`,
`tool_result`, `user_bash`, `input`.

(`model_select` / `thinking_level_select` change state but are not stream frames;
the change surfaces as a `model_change` / `thinking_level_change` **entry** via
`getEntries`, i.e. path B.)

---

## Conclusion — the split

- **Live plane** = `pi.on()` **payloads** → live-plane `{rpc}` frames (table A:
  `toJsonEvent` for `message_update`; remap `session_compact`→`compaction_end`;
  rest passthrough). Right timing (fire as they happen), matches the built +
  tested consumer, preserves streaming + tool-cards-by-`toolCallId`.
- **getEntries / get_state** = attach/resume snapshot + out-of-band entries
  (model/thinking/compaction/`pi.appendEntry`). Path B; lag-immune (whole-log
  read at attach).

`entry_appended` is the ONLY frame `pi.on()` can't produce, and the consumer
doesn't render it — so getEntries' role is reconstruction, not live content.
Pumping live content from `getEntries` instead of `on()` payloads would both
**lag** (persist-after-cue) and **mismatch** (SessionEntry ≠ live frame) the
consumer for no benefit.
