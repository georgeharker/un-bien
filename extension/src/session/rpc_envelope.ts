// Reconstruct pi's `--mode rpc` EVENT PLANE in-process from `pi.on()` and
// broadcast each frame as an rpc-envelope `{ rpc }` message.
//
// `pi --mode rpc` builds its event stream by subscribing to the session and
// piping every `AgentSessionEvent` through `toJsonEvent` (pi
// modes/rpc/rpc-mode.ts:355 `session.subscribe(e => output(toJsonEvent(e)))`).
// An in-process extension can't call `session.subscribe` (host-only), but
// `pi.on()` delivers the same underlying events — so we source them from the
// bus instead and emit byte-faithful rpc frames. The only streamed frame
// `pi.on()` can't give is `entry_appended` (subscribe-only); that's the
// getEntries reconstruction path, deferred. See docs/rpc-on-event-map.md.
//
// Note: extension `on()` payloads are a SUPERSET of the rpc/AgentEvent frame
// (e.g. `turn_start` carries `turnIndex`/`timestamp` the rpc frame lacks), so
// each builder selects exactly the rpc fields rather than passing the payload
// through.
//
// ⚠️ DRIFT HAZARD — THE FRAME SHAPES BELOW MUST MATCH pi's `--mode rpc` OUTPUT.
// These builders + `toJsonEvent` reproduce what pi writes to rpc stdout
// (pi modes/json-event.ts `toJsonEvent` + modes/rpc/rpc-mode.ts `output(...)`,
// pi 0.84.3). We CANNOT call pi's own function: `@earendil-works/pi-coding-agent`
// ships an `exports` map that exposes ONLY `.` (dist/index.js), there is no
// `json-event` module in `dist`, and the `toJsonEvent` symbol appears nowhere
// in the published package (inlined away) — so it is neither importable nor
// deep-importable. This is therefore a HAND-KEPT MIRROR. If pi changes a wire
// frame, this drifts silently. The guard is CONFORMANCE against the captured
// real `pi --mode rpc` corpus (un-bien Tests/Fixtures/rpc-stream/*, the actual
// pi bytes; see docs/rpc-on-event-map.md + the cross-repo corpus plan item):
// replay those and assert our output matches. Update BOTH this file and the
// fixtures together when bumping the pinned pi version.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * One mesh-envelope wrapper message (docs/rpc-envelope.md). `type` is the
 * PROTOCOL-NAMESPACE discriminator (NOT direction) and names the payload field:
 *   "rpc" -> `.rpc` — byte-faithful pi rpc frame (pi's rpc handler acts).
 *   "evt" -> `.evt` — forwarded pi bus event (app view plane).
 *   "un"  -> `.un`  — un-bien's OWN protocol; inner `.type` = hello /
 *                     session_sync / session_launch / ...; the inner type +
 *                     receiver role decide who acts and which direction.
 * Direction is carried by the inner frame `.type` + receiver role, never `type`.
 * `ts` (epoch ms) and `protocolVersion` (decode-guard) are cross-cutting and stay
 * top-level. NOTE: legacy `"env"` is still ACCEPTED on read + stamped for the
 * rpc/evt plane during the transition; the explicit rpc/evt split is a later wave.
 */
export interface EnvelopeMessage {
  type?: string;
  ts?: number;
  /** Envelope/pi-rpc protocol version for client decode-guarding. Cross-cutting. */
  protocolVersion?: number;
  rpc?: unknown;
  /** un-bien display sidecar riding ALONGSIDE `rpc` in the same envelope. For
   *  edit-family `tool_execution_start` frames it carries `{ hunks }` display
   *  diff data; the `rpc` frame itself stays byte-faithful (raw args). */
  aux?: { hunks?: unknown[] } & Record<string, unknown>;
  evt?: { channel: string; data: unknown };
  /** un-bien's own protocol plane (`type:"un"`). The inner frame is one of
   *  ``UnFrame`` — handshake fields (caps, sessionId) nest in the `hello`
   *  variant, NOT at the envelope top level. */
  un?: UnFrame;
}

/**
 * The un-bien plane's inner frames — un-bien's OWN protocol (we own these, so
 * they are typed, unlike the opaque byte-faithful pi `rpc` frame). The inner
 * `.type` + receiver role decide who acts and which direction it flows.
 */
export type UnFrame =
  | { type: "hello"; caps: string[]; sessionId?: string } // ext->app: app acts
  | { type: "session_sync"; id?: string; limit?: number } // app->ext: reconstruction request
  | {
      type: "session_sync_end"; // ext->app: reconstruction terminator
      in_reply_to?: string;
      session_started_at?: number;
      truncated?: boolean;
    }
  | {
      type: "session_launch"; // app->ext: mesh remote-launch (extension acts)
      id?: string;
      mode: string;
      cwd?: string;
      name?: string;
    };

/** Legacy wrapper marker for the rpc/evt plane — still stamped + accepted during
 *  the transition (the explicit rpc/evt namespace split is a later wave). */
export const ENVELOPE_KIND = "env";
/** un-bien-owned plane wrapper marker. */
export const UN_KIND = "un";
/** un-bien-plane INNER frame type for the capability handshake. */
export const HELLO_KIND = "hello";

/**
 * Build the capability handshake sent to a peer on attach — the envelope-native
 * replacement for the stock `session_history.capabilities`. Rides the un-bien
 * plane (`type:"un"`) as a `hello` inner frame the APP handles; caps + sessionId
 * nest inside it, protocolVersion stays top-level.
 */
export function helloEnvelope(
  caps: string[],
  sessionId?: string,
  protocolVersion = 1,
): EnvelopeMessage {
  const hello: UnFrame = sessionId
    ? { type: "hello", caps, sessionId }
    : { type: "hello", caps };
  return { type: UN_KIND, protocolVersion, un: hello };
}

type Frame = Record<string, unknown>;
type Payload = Record<string, unknown>;

// ── toJsonEvent (ported from pi modes/json-event.ts) ─────────────────────────

interface AssistantMessageEventLike {
  type?: string;
  contentIndex?: number;
  partial?: { content?: Array<{ id?: string; name?: string; type?: string }> };
  [k: string]: unknown;
}

/**
 * Drop the cumulative `partial` snapshot from a streaming assistant delta so
 * wire size stays linear; a `toolcall_start` keeps the constant-sized `id` +
 * `toolName`. Defensive (no throws) — this runs inside an SDK event callback.
 *
 * ⚠️ MUST MATCH pi `modes/json-event.ts` `toJsonAssistantMessageEvent` byte for
 * byte (unexported — see the module header). Verified against the real
 * `pi --mode rpc` capture; keep the conformance fixtures in lockstep.
 */
function stripPartial(ame: AssistantMessageEventLike): Frame {
  if (ame.type === "toolcall_start") {
    const toolCall = ame.partial?.content?.[ame.contentIndex ?? -1];
    const { partial: _p, ...rest } = ame;
    return { ...rest, id: toolCall?.id, toolName: toolCall?.name };
  }
  if (!("partial" in ame)) return { ...ame };
  const { partial: _p, ...rest } = ame;
  return rest;
}

// ── Frame builders: one per streamed rpc event ───────────────────────────────

type Builder = (p: Payload) => Frame;

const BUILDERS: Record<string, Builder> = {
  agent_start: () => ({ type: "agent_start" }),
  agent_end: (p) => ({
    type: "agent_end",
    messages: p.messages,
    willRetry: p.willRetry ?? false,
  }),
  agent_settled: () => ({ type: "agent_settled" }),
  turn_start: () => ({ type: "turn_start" }),
  turn_end: (p) => ({
    type: "turn_end",
    message: p.message,
    toolResults: p.toolResults ?? [],
  }),
  message_start: (p) => ({ type: "message_start", message: p.message }),
  message_update: (p) => ({
    type: "message_update",
    usage: (p.message as { usage?: unknown } | undefined)?.usage,
    assistantMessageEvent: stripPartial(
      (p.assistantMessageEvent ?? {}) as AssistantMessageEventLike,
    ),
  }),
  message_end: (p) => ({ type: "message_end", message: p.message }),
  tool_execution_start: (p) => ({
    type: "tool_execution_start",
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    args: p.args,
  }),
  tool_execution_update: (p) => ({
    type: "tool_execution_update",
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    args: p.args,
    partialResult: p.partialResult,
  }),
  tool_execution_end: (p) => ({
    type: "tool_execution_end",
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    result: p.result,
    isError: p.isError ?? false,
  }),
  // DEAD ON THE LIVE PLANE — pi does NOT deliver queue_update to extensions.
  // AgentSession._emitQueueUpdate() (pi agent-session.ts) calls only this._emit()
  // (the host `subscribe` stream that `pi --mode rpc` consumes) and NEVER
  // this._extensionRunner.emit(), so pi.on("queue_update") registered from
  // RPC_EVENT_NAMES NEVER FIRES. (Every other event we forward IS fanned to
  // extensions via _emitExtensionEvent(); queue_update is the lone exception, and
  // the ExtensionAPI exposes only hasPendingMessages():boolean — no queue text,
  // no subscribe.) So the fork CANNOT send a queue snapshot; the queued display
  // is APP-OWNED (optimistic chip cleared on model-consumption). Kept only to
  // document the frame shape the app's (now dead) handler once consumed. See
  // design 01M158S7.
  queue_update: (p) => ({
    type: "queue_update",
    steering: p.steering ?? [],
    followUp: p.followUp ?? [],
  }),
};

// The extension fires `session_compact` (not the subscribe-only `compaction_end`)
// with the persisted `compactionEntry`. Remap to the rpc `compaction_end` frame
// the consumer renders. See docs/rpc-on-event-map.md table A.
function compactionEndFrame(p: Payload): Frame {
  const entry = p.compactionEntry as
    | { summary?: unknown; tokensBefore?: unknown }
    | undefined;
  return {
    type: "compaction_end",
    reason: p.reason,
    result: entry
      ? { summary: entry.summary, tokensBefore: entry.tokensBefore }
      : null,
    aborted: false,
    willRetry: p.willRetry ?? false,
  };
}

/** Event names we register a `pi.on()` cue for (the live plane). */
export const RPC_EVENT_NAMES: readonly string[] = [
  ...Object.keys(BUILDERS),
  "session_compact",
];

/**
 * Pure map: a `pi.on()` event (name + payload) → its rpc-envelope `{ rpc }`
 * message, or `null` when the event carries no streamed frame. Exported for
 * conformance tests against the captured `pi --mode rpc` corpus.
 */
export function envelopeForEvent(
  name: string,
  payload: Payload,
): EnvelopeMessage | null {
  if (name === "session_compact") return { rpc: compactionEndFrame(payload) };
  const build = BUILDERS[name];
  return build ? { rpc: build(payload) } : null;
}

/**
 * Register the live-plane `pi.on()` handlers; each fires `broadcast` with the
 * rpc-envelope frame. Returns a handle whose `dispose()` stops broadcasting
 * (pi.on has no unregister, so we gate on a disposed flag).
 */
export function createRpcEnvelope(
  pi: ExtensionAPI,
  broadcast: (env: EnvelopeMessage) => void,
  opts?: {
    enrichArgs?: (tool: string, args: unknown) => { hunks: unknown[] } | null;
    classifyOutput?: (
      toolName: string,
      result: unknown,
    ) => { kind: string; [k: string]: unknown } | null;
  },
): { dispose(): void } {
  let disposed = false;
  // SAFETY: pi.on's public typing is a narrower event-name union; the live
  // plane subscribes by string name, which is valid at runtime for every
  // RPC_EVENT_NAMES entry (they are real AgentSessionEvent names).
  const on = pi.on as unknown as (
    event: string,
    handler: (payload: unknown) => void,
  ) => void;
  for (const name of RPC_EVENT_NAMES) {
    on(name, (payload: unknown) => {
      if (disposed) return;
      const p = (payload ?? {}) as Payload;
      let env = envelopeForEvent(name, p);
      if (!env) return;
      if (name === "tool_execution_start" && opts?.enrichArgs) {
        const enriched = opts.enrichArgs(p.toolName as string, p.args);
        if (enriched && Array.isArray(enriched.hunks)) {
          env = { ...env, aux: { hunks: enriched.hunks } };
        }
      }
      if (name === "tool_execution_end" && opts?.classifyOutput) {
        const out = opts.classifyOutput(p.toolName as string, p.result);
        if (out) {
          env = { ...env, aux: { ...(env.aux ?? {}), output: out } };
        }
      }
      try {
        broadcast(env);
      } catch {
        /* best-effort: never let a broadcast error escape into the SDK callback */
      }
    });
  }
  return {
    dispose() {
      disposed = true;
    },
  };
}
