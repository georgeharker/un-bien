// App -> extension inbound: interpret an envelope-carried pi `RpcCommand` and drive
// the SDK, then answer with a `{ rpc: { type:"response", ... } }` envelope back
// to the sender. This is the NEW-protocol-native inbound path — it does NOT go
// through the stock `ClientMessage` / `_routeClientMessageFrom` switch (that,
// with its `error`/`cancelled`/`pong` ServerMessage replies, is old protocol,
// retired). The SDK primitives the handlers wrap (sendUserMessage/_wakeAgent,
// ctx.abort) are pi itself, not old protocol.
//
// Command shapes: pi.dev/docs/latest/rpc. v1 surface = prompt / steer /
// follow_up / abort / set_model / set_thinking_level. get_state / get_entries /
// compact / bash follow (they need the fuller ctx.sessionManager).

import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import type { EnvelopeMessage } from "./rpc_envelope.js"

/** Native pi `get_entries` result — the shape is PI-FAITHFUL by decision
 *  (rpc plane matches pi as directly as possible): `{entries, leafId}` with NO
 *  extra fields. One budget-bounded PAGE of the entry log per reply; the app
 *  keeps refetching with `since: leafId` until an empty page (pi's own
 *  since-cursor semantics — works against any faithful peer). See design:
 *  get_entries backfill paging. */
export interface GetEntriesResult {
  entries: SessionEntry[]
  leafId: string | null
}

/** Page budget for get_entries replies (design: get_entries backfill paging;
 *  raised 256 KiB → 1 MiB → 2 MiB after device testing, 2026-09-10).
 *  2 MiB of entry JSON per page — 8× fewer round trips than the original,
 *  still wide margin under every cap: body ≈ 2 MiB + envelope overhead →
 *  ≈ 2.7 MiB base64 wire → decoded estimate ≈ 2 MiB, ~1.9 MiB UNDER the
 *  relay's 4 MiB ct cap (RELAY_MAX_CT_MIB) < the app's 8 MiB WS receive.
 *  A page carrying one MAX_ENTRY_JSON_BYTES (2 MiB) fitted entry alone also
 *  fits with the same margin. (The 500 KiB POST /mesh cap does NOT apply —
 *  pages ride the peer WS plane, not mesh.) Fold cost: the reader folds a
 *  page on its main actor; 2 MiB parses in ~5-10 ms — device-verified smooth.
 *  If refusals (payload_too_large) ever appear in logs, dial this back toward
 *  1 MiB — the refusal frames make that visible now. This is chunking
 *  BEHAVIOR, not protocol — frames stay byte-faithful to pi's rpc
 *  (`success(id, "get_entries", { entries, leafId })`). */
export const GET_ENTRIES_PAGE_BUDGET_BYTES = 2 * 1024 * 1024

/** Hard ceiling for a SINGLE entry's JSON (design: transport-fit paging). The
 *  at-least-one-entry progress rule means an entry beyond the relay's ct cap
 *  would ride alone, get refused payload_too_large, and stall the reader's
 *  walk on the same cursor FOREVER — one giant entry (a multi-MB tool result)
 *  poisoned the whole session's backfill. Fitted entries deep-truncate long
 *  strings (suffix marker) so shape + ids survive and the walk always crosses.
 *  2 MiB JSON → ≈2.7 MiB base64 ≈ 2.7 MiB decoded estimate — half the relay
 *  cap, deliberately, so a page carrying one fitted entry still has margin. */
export const MAX_ENTRY_JSON_BYTES = 2 * 1024 * 1024

const truncationMarker = (cut: number, total: number) =>
  `…[transport-truncated ${total - cut}/${total} bytes]`

/** JSON value tree with every over-cap string LEAF shortened (marker suffix).
 *  Same keys/structure — only string leaves change — so callers can safely
 *  treat the result as the same shape they passed in. */
type JsonTree =
  string | number | boolean | null | JsonTree[] | { [key: string]: JsonTree }

function truncateStringsDeep(value: JsonTree, cap: number): JsonTree {
  if (typeof value === "string") {
    return value.length > cap
      ? value.slice(0, cap) + truncationMarker(cap, value.length)
      : value
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateStringsDeep(v, cap))
  }
  if (value && typeof value === "object") {
    const out: Record<string, JsonTree> = {}
    for (const [k, v] of Object.entries(value as Record<string, JsonTree>)) {
      out[k] = truncateStringsDeep(v, cap)
    }
    return out
  }
  return value
}

/** Fit one entry for transport: unchanged when small enough; string-truncated
 *  (shrinking per-string caps across passes) when oversized; ultimate fallback
 *  is a minimal content-elided stub so the walk ALWAYS crosses this entry. */
export function fitEntryForTransport(entry: SessionEntry): SessionEntry {
  if (JSON.stringify(entry).length <= MAX_ENTRY_JSON_BYTES) return entry
  for (const cap of [64 * 1024, 8 * 1024, 256]) {
    // SAFETY: SessionEntry serializes to a JSON tree; the cast only moves it
    // into the walker's domain type.
    const fitted = truncateStringsDeep(entry as unknown as JsonTree, cap)
    // SAFETY: the deep walk only replaces string LEAVES (same keys, same
    // structure), so the result keeps SessionEntry's shape — TS can't prove
    // that through the JsonTree round-trip.
    const candidate = fitted as unknown as SessionEntry
    if (JSON.stringify(candidate).length <= MAX_ENTRY_JSON_BYTES)
      return candidate
  }
  // SAFETY: hand-built to the message-entry shape; the cast papers over the
  // pi union's narrower content typing.
  return {
    type: "message",
    id: entry.id,
    parentId: entry.parentId,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[entry ${entry.id} exceeds the transport ceiling — content elided]`,
        },
      ],
    },
  } as unknown as SessionEntry
}

/** Slice the entry log into one budget-bounded page starting AFTER `since`
 *  (undefined = from the start). Handlers pre-validate `since` pi-faithfully
 *  (unknown id → `Entry not found` error); this helper stays tolerant (an
 *  unknown id restarts from index 0) for direct/test use. Always includes at
 *  least one entry when any remain, so a single oversized entry (a giant tool
 *  result) still makes progress on its own. `leafId` is the session's current
 *  leaf cursor, returned when the page completes the log; a partial page
 *  returns its last INCLUDED entry's id as the resume cursor. */
export function pageEntries(
  all: SessionEntry[],
  since: string | undefined,
  leafId: string | null,
  budgetBytes: number = GET_ENTRIES_PAGE_BUDGET_BYTES,
): GetEntriesResult {
  const start =
    typeof since === "string"
      ? (() => {
          const i = all.findIndex((e) => e.id === since)
          return i === -1 ? 0 : i + 1
        })()
      : 0
  const remaining = all.slice(start)
  if (remaining.length === 0) return { entries: [], leafId }
  const page: SessionEntry[] = []
  let used = 0
  for (const e of remaining) {
    // Transport-fit FIRST: an oversized entry must never ride raw (it would be
    // refused and stall the walk); budget accounting uses the FITTED size.
    const fitted = fitEntryForTransport(e)
    page.push(fitted)
    used += JSON.stringify(fitted).length
    if (used >= budgetBytes) break
  }
  const complete = page.length === remaining.length
  return {
    entries: page,
    leafId: complete ? leafId : (page[page.length - 1]?.id ?? leafId),
  }
}

/** Build a `{ rpc: response }` envelope. Correlates by the command's `id`. */
export function rpcResponse(
  command: string,
  id: string | undefined,
  result: { success: boolean; data?: unknown; error?: string },
): EnvelopeMessage {
  const frame: Record<string, unknown> = {
    type: "response",
    command,
    success: result.success,
  }
  if (id !== undefined) frame.id = id
  if (result.data !== undefined) frame.data = result.data
  if (result.error !== undefined) frame.error = result.error
  return { rpc: frame }
}

/** SDK-facing operations the dispatcher needs; wired to extension primitives. */
export interface RpcCommandHandlers {
  prompt(
    message: string,
    opts: { id?: string; images?: unknown; streamingBehavior?: string },
  ): Promise<void>
  steer(message: string, opts: { images?: unknown }): Promise<void>
  followUp(message: string, opts: { images?: unknown }): Promise<void>
  abort(): Promise<void>
  /** Switch the live model; resolves to the wire Model object for the response. */
  setModel(provider: string, modelId: string): Promise<unknown>
  /** Set the thinking (reasoning-effort) level. */
  setThinkingLevel(level: string): Promise<void>
  /** List configured models (pi `get_available_models`); resolves to Model[].
   *  Optional while the surface is being wired — an unset handler falls through
   *  to the transitional stock path (returns null from dispatch). */
  getAvailableModels?(): Promise<unknown>
  /** Manually compact context (pi `compact`); resolves to the CompactionResult. */
  compact?(customInstructions?: string): Promise<unknown>
  /** Start a fresh session (pi `new_session`); resolves to {cancelled}. */
  newSession?(parentSession?: string): Promise<unknown>
  /** Clear the steering/follow-up queue (pi `clear_queue`); resolves to the
   *  removed {steering, followUp} text. */
  clearQueue?(): Promise<unknown>
  /** Return ONE budget-bounded page of the session ENTRY log (pi
   *  `get_entries`); resolves to the pi-faithful `{ entries, leafId }` — no
   *  extra fields. `since` slices to entries AFTER that entry id (the native
   *  delta cursor / page resume). The app refetches with `since: leafId` until
   *  an empty page (design: get_entries backfill paging). This is the
   *  transcript source — the app reduces the raw entries itself; the extension
   *  does NOT replay them. An unknown `since` must throw `Entry not found:`
   *  (pi-faithful error semantics, not a silent restart). */
  getEntries?(since?: string): Promise<GetEntriesResult>
  /** Native pi set_session_name (remote rename): sets the session display
   *  name — pi fires session_info_changed, which index.ts forwards to the
   *  app; the standard rpc reply is the app's success signal. */
  setSessionName?(name: string): Promise<void>
  /** Native pi get_state: session/model snapshot. THE authoritative busy
   *  signal (isStreaming) the app reconciles against on every reconstruction —
   *  an open local stream while isStreaming=false means missed terminal events
   *  (design: get_state reconcile). Resolves to
   *  {model,provider,thinkingLevel,isStreaming,sessionId,messageCount}. */
  getState?(): Promise<unknown>
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * Map an inbound rpc command frame to an SDK call and produce the response
 * envelope. Returns `null` for commands we don't handle yet (ignored —
 * forward-compatible). A handler throw becomes `success:false` with the message.
 */
export async function dispatchRpcCommand(
  frame: Record<string, unknown>,
  handlers: RpcCommandHandlers,
): Promise<EnvelopeMessage | null> {
  const command = typeof frame.type === "string" ? frame.type : undefined
  if (!command) return null
  const id = typeof frame.id === "string" ? frame.id : undefined
  try {
    switch (command) {
      case "prompt":
        await handlers.prompt(str(frame.message), {
          id,
          images: frame.images,
          streamingBehavior:
            typeof frame.streamingBehavior === "string"
              ? frame.streamingBehavior
              : undefined,
        })
        return rpcResponse("prompt", id, { success: true })
      case "steer":
        await handlers.steer(str(frame.message), {
          images: frame.images,
        })
        return rpcResponse("steer", id, { success: true })
      case "follow_up":
        await handlers.followUp(str(frame.message), {
          images: frame.images,
        })
        return rpcResponse("follow_up", id, { success: true })
      case "abort":
        await handlers.abort()
        return rpcResponse("abort", id, { success: true })
      case "set_model": {
        const data = await handlers.setModel(
          str(frame.provider),
          str(frame.modelId),
        )
        return rpcResponse("set_model", id, {
          success: true,
          data,
        })
      }
      case "set_thinking_level":
        await handlers.setThinkingLevel(str(frame.level))
        return rpcResponse("set_thinking_level", id, {
          success: true,
        })
      case "get_available_models": {
        if (!handlers.getAvailableModels) return null
        const data = await handlers.getAvailableModels()
        return rpcResponse("get_available_models", id, {
          success: true,
          data,
        })
      }
      case "compact": {
        if (!handlers.compact) return null
        const data = await handlers.compact(
          typeof frame.customInstructions === "string"
            ? frame.customInstructions
            : undefined,
        )
        return rpcResponse("compact", id, {
          success: true,
          data,
        })
      }
      case "new_session": {
        if (!handlers.newSession) return null
        const data = await handlers.newSession(
          typeof frame.parentSession === "string"
            ? frame.parentSession
            : undefined,
        )
        return rpcResponse("new_session", id, {
          success: true,
          data,
        })
      }
      case "clear_queue": {
        if (!handlers.clearQueue) return null
        const data = await handlers.clearQueue()
        return rpcResponse("clear_queue", id, {
          success: true,
          data,
        })
      }
      case "set_session_name": {
        // Native pi rpc (remote rename, pre-release 2026-09-18): pi replies on
        // the standard response plane; the extension's session_info_changed
        // forward (index.ts) confirms the new name to the app live.
        if (!handlers.setSessionName) return null
        await handlers.setSessionName(str(frame.name))
        return rpcResponse("set_session_name", id, { success: true })
      }
      case "get_state": {
        if (!handlers.getState) return null
        const data = await handlers.getState()
        return rpcResponse("get_state", id, { success: true, data })
      }
      case "get_entries": {
        if (!handlers.getEntries) return null
        const data = await handlers.getEntries(
          typeof frame.since === "string" ? frame.since : undefined,
        )
        return rpcResponse("get_entries", id, {
          success: true,
          data,
        })
      }
      default:
        return null // unhandled command: ignore (forward-compat)
    }
  } catch (err) {
    return rpcResponse(command, id, {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
