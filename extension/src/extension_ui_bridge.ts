// Plan/57 — Bridge @eko24ive/pi-ask clarification flows to the paired app over
// the extension_ui_request/response contract.
//
// pi-ask (when installed) runs ask_user in the Pi TUI on the desktop AND emits
// a same-process event contract on `pi.events` (docs/remote-events.md):
//
//   @eko24ive/pi-ask:started      { flowId, toolCallId?, source, title?, questions[] }
//   @eko24ive/pi-ask:submit       { requestId, flowId, response }   // we emit this
//   @eko24ive/pi-ask:submit-result{ requestId, flowId, ok, error? } // pi-ask emits
//   @eko24ive/pi-ask:completed    { flowId, result }
//
// This module subscribes to those events and translates them into the SDK's
// extension_ui_request/response wire shapes (mirrored from
// `pi --mode rpc`'s RpcExtensionUIRequest/Response) so the mobile app renders
// ask_user natively. pi-ask's richer schema rides in an optional `ask` envelope.
//
// Inert when pi-ask is absent: no events fire, nothing breaks. ask_user without
// pi-ask doesn't exist, so this bridge is strictly opt-in.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { PlainPeerChannel } from "./transport/peer_channel.js"
import { randomUUID } from "node:crypto"
import type {
  AskAnswerWire,
  AskEnrichmentWire,
  AskOptionWire,
  AskQuestionWire,
  AskQuestionWireType,
  AskResponseEnrichmentWire,
  ExtensionUiRequestWire,
  ExtensionUiResponseWire,
  ServerMessage,
} from "./protocol/types.js"

const PI_ASK_STARTED = "@eko24ive/pi-ask:started"
const PI_ASK_COMPLETED = "@eko24ive/pi-ask:completed"
const PI_ASK_SUBMIT = "@eko24ive/pi-ask:submit"
const PI_ASK_SUBMIT_RESULT = "@eko24ive/pi-ask:submit-result"

/** Drop a flow from `activeFlows` if pi-ask never resolves it (e.g. a flow
 *  disposed on session_shutdown — pi-ask does not emit `completed` for those).
 *  Bounds memory; generous vs. a human answer time. */
const FLOW_TTL_MS = 10 * 60 * 1000

/** Minimal view of `pi.events` this bridge needs. */
type EventBus = ExtensionAPI["events"]

/** One ask_user flow we've surfaced to the app and are awaiting an answer for. */
interface ActiveFlow {
  flowId: string
  toolCallId: string | null
  source: string
  title: string | null
  questions: AskQuestionWire[]
}

// ── Stock ctx.ui dialogs (no pi-ask) ─────────────────────────────────────────
// pi-ask is optional. Stock `ctx.ui.select/confirm/input/editor` from ANY
// extension (including this one's wizard) must also reach the paired app, with
// first-responder-wins semantics: the local TUI and the remote app both render,
// whichever answers first resolves the dialog and dismisses the other. pi emits
// `ui_prompt_start/end` for these but those events carry only {kind,title} — no
// options and no correlation id — so the bridge drives off the ctx.ui wrap
// (wrapStockUi), not the events. Id space is crypto.randomUUID(), disjoint
// from pi-ask flowIds, so inbound responses route unambiguously.
const STOCK_TTL_MS = 10 * 60 * 1000

/** One stock ctx.ui dialog awaiting an answer from either the local TUI or the
 *  remote app. `request` is replayed on session_sync so a peer attaching mid-
 *  dialog sees it. */
interface StockPending {
  id: string
  request: ExtensionUiRequestWire
  resolve: (value: unknown) => void
}

/** Build the wire frame for a stock dialog. */
type StockRequestInput =
  | { method: "select"; title: string; options: string[] }
  | { method: "confirm"; title: string; message: string }
  | { method: "input"; title: string; placeholder?: string }
  | { method: "editor"; title: string; prefill?: string }

export interface ExtensionUiBridge {
  /** Route an inbound `extension_ui_response` from a peer back to pi-ask. */
  respond(msg: ExtensionUiResponseWire): void
  /**
   * Requests for flows still awaiting an answer, for `session_sync` to replay.
   *
   * The `started` broadcast fires exactly once. A peer that connects *after*
   * a flow opened never saw it: history replayed, but the interactive frame
   * did not, so the phone showed the ask_user tool call as plain text while
   * the desktop sat blocked on the TUI dialog. Replaying on sync closes that
   * hole — the common real-world case is the agent asking while the app is
   * closed.
   */
  pendingRequests(): ServerMessage[]
  /** Cancel EVERY pending flow (slash-command feedback: /stop). Emits a
   *  cancelled response per flow, resolving the awaiting extension side and
   *  dropping it from activeFlows. Returns the count cancelled. TUI-rendered
   *  raw ctx.ui.select dialogs are NOT reachable (they never entered the
   *  bridge) — those remain host-side awaits. */
  cancelAllPending(): number
  /** Drop all subscriptions + state (best-effort teardown). */
  dispose(): void
  // ── Stock ctx.ui (no pi-ask) ─────────────────────────────────────────────
  /** Open a stock ctx.ui dialog to the app. Broadcasts an `extension_ui_request`
   *  and returns a Promise that resolves when the app answers (via `respond`)
   *  or the TTL fires (undefined), plus the id (for `dismissStock`). */
  openStock(input: StockRequestInput): { promise: Promise<unknown>; id: string }
  /** Local TUI (or /stop) won the race: drop the pending entry and notify the
   *  app to close its modal. No-op if the app already answered. */
  dismissStock(id: string): void
}

/**
 * Wire pi-ask's event contract to the relay's extension_ui_request/response
 * frames. Returns `null` only if the SDK exposes no usable `events` bus (defensive
 * — modern Pi always has one); callers stay null-safe.
 */
export function createExtensionUiBridge(
  pi: ExtensionAPI,
  broadcast: (msg: ServerMessage) => void,
): ExtensionUiBridge | null {
  const eventsRaw = (pi as { events?: EventBus }).events
  if (
    !eventsRaw ||
    typeof eventsRaw.on !== "function" ||
    typeof eventsRaw.emit !== "function"
  ) {
    return null
  }
  // Assign to a freshly-typed const so the narrowed (non-undefined) type is
  // preserved inside nested closures below (TS re-widens the raw capture).
  const events: EventBus = eventsRaw

  // flowId → flow. Kept so a label-only (degraded) response can map back to the
  // option value, and so completed/submit-result can be tolerated if they arrive
  // after the app already answered.
  const activeFlows = new Map<string, ActiveFlow>()
  // Per-flow TTL timers (FLOW_TTL_MS). pi-ask disposes flows on session_shutdown
  // WITHOUT emitting `completed`, so without this the `activeFlows` map would
  // leak one entry per abandoned flow. Bounded, defensive.
  const flowTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function clearFlowTtl(flowId: string): void {
    const t = flowTimers.get(flowId)
    if (t !== undefined) {
      clearTimeout(t)
      flowTimers.delete(flowId)
    }
  }
  function armFlowTtl(flowId: string): void {
    clearFlowTtl(flowId)
    flowTimers.set(
      flowId,
      setTimeout(() => {
        if (!activeFlows.delete(flowId)) return // already resolved
        flowTimers.delete(flowId)
        // Tell the app the bridge forgot this flow instead of stranding its
        // modal silently: a matching WARNING notify keeps the modal open with
        // a retry hint. Rich clients can still retry (the response carries
        // flow_id and pi-ask's flow may still be pending on the desktop);
        // degraded clients at least get closure.
        broadcast({
          type: "extension_ui_request",
          id: flowId,
          method: "notify",
          message:
            "Clarification expired on the bridge — retry or answer on desktop.",
          notify_type: "warning",
        })
      }, FLOW_TTL_MS),
    )
  }

  // Stock ctx.ui dialogs awaiting an answer from the local TUI OR the app.
  // Disjoint id space (crypto.randomUUID) from pi-ask flowIds.
  const stockPending = new Map<string, StockPending>()
  const stockTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function clearStockTtl(id: string): void {
    const t = stockTimers.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      stockTimers.delete(id)
    }
  }
  function armStockTtl(id: string): void {
    clearStockTtl(id)
    stockTimers.set(
      id,
      setTimeout(() => {
        if (!stockPending.delete(id)) return // already resolved
        stockTimers.delete(id)
        // Resolve the racing wrap with undefined (the caller treats it as
        // cancelled) and tell the app to drop its modal — same dismiss-notify
        // shape pi-ask uses, so no new app-side contract.
        broadcast({
          type: "extension_ui_request",
          id,
          method: "notify",
          message: "Dialog expired — retry or answer on desktop.",
          notify_type: "warning",
        })
      }, STOCK_TTL_MS),
    )
  }

  // Open a stock ctx.ui dialog to the app. Broadcasts the request and returns a
  // Promise that resolves when the app answers (via respond) OR when the TTL
  // fires (undefined). The wrap (wrapStockUi) races this against the local TUI.
  function openStock(
    input: StockRequestInput,
  ): { promise: Promise<unknown>; id: string } {
    const id = randomUUID()
    const request = buildStockRequest(id, input)
    const promise = new Promise<unknown>((resolve) => {
      stockPending.set(id, { id, request, resolve })
      armStockTtl(id)
    })
    broadcast(request)
    return { promise, id }
  }

  // Local TUI won the race (or /stop / teardown): drop the pending entry and
  // tell the app to close its modal. No-op if the app already answered (the
  // entry is gone), so a late local answer after a remote answer is harmless.
  function dismissStock(id: string): void {
    if (!stockPending.delete(id)) return
    clearStockTtl(id)
    broadcast({
      type: "extension_ui_request",
      id,
      method: "notify",
      message: "Resolved.",
    })
  }

  // Map an inbound response to the value the stock ctx.ui call should resolve
  // with: select/input/editor -> value; confirm -> confirmed; cancelled -> undefined.
  function stockValueOf(msg: ExtensionUiResponseWire): string | boolean | undefined {
    if ("cancelled" in msg && msg.cancelled) return undefined
    if ("value" in msg) return msg.value
    if ("confirmed" in msg) return msg.confirmed
    return undefined // ask-envelope rich response: not sent for stock dialogs
  }

  const unsubStarted = events.on(PI_ASK_STARTED, (raw: unknown) => {
    const event = parseStartedEvent(raw)
    if (!event) return
    const flow: ActiveFlow = {
      flowId: event.flowId,
      toolCallId: event.toolCallId ?? null,
      source: event.source ?? "tool",
      title: event.title ?? null,
      questions: event.questions,
    }
    activeFlows.set(flow.flowId, flow)
    armFlowTtl(flow.flowId)
    broadcast(requestForFlow(flow))
  })

  const unsubCompleted = events.on(PI_ASK_COMPLETED, (raw: unknown) => {
    const e = raw as { version?: number; flowId?: unknown } | null
    if (!e || e.version !== 1 || typeof e.flowId !== "string") return
    const flowId = e.flowId
    clearFlowTtl(flowId)
    activeFlows.delete(flowId)
    // Same id as the originating request (the flowId). The app treats a `notify`
    // whose id matches an open interactive request as "that flow resolved —
    // dismiss it". Covers the non-submitting owner in a multi-owner setup.
    broadcast({
      type: "extension_ui_request",
      id: flowId,
      method: "notify",
      message: "Clarification resolved.",
    })
  })

  // submit-result is per-request feedback. On error (invalid answer / flow
  // gone) surface a warning so the submitting owner can retry. The notify reuses
  // the flowId as its id (same as the originating request) so the app correlates
  // it to its open modal; notify_type "warning" distinguishes it from the
  // `completed` dismiss (same id, absent/other notify_type). Success is covered
  // by `completed`, so ok is a no-op here.
  const unsubResult = events.on(PI_ASK_SUBMIT_RESULT, (raw: unknown) => {
    const e = raw as {
      version?: number
      requestId?: unknown
      flowId?: unknown
      ok?: unknown
      error?: unknown
      message?: unknown
    } | null
    if (!e || e.version !== 1 || e.ok === true) return
    const message =
      typeof e.message === "string"
        ? e.message
        : typeof e.error === "string"
          ? e.error
          : "Clarification answer was not accepted."
    const flowId =
      typeof e.flowId === "string"
        ? e.flowId
        : activeFlows.size === 1
          ? // Defensive: pi-ask always carries flowId. If it's ever absent, an
            // unambiguous single active flow is a safe attribution; with zero or
            // several, the warning is uncorrelatable and the app ignores
            // unmatched notifies — drop it instead of broadcasting a random id
            // no client can act on.
            activeFlows.keys().next().value
          : undefined
    if (!flowId) return
    broadcast({
      type: "extension_ui_request",
      id: flowId,
      method: "notify",
      message,
      notify_type: "warning",
    })
  })

  function respond(msg: ExtensionUiResponseWire): void {
    // Stock ctx.ui dialog: id in stockPending -> the app answered. Resolve the
    // racing wrap (which aborts the local TUI dialog). The app is the responder,
    // so no dismiss-notify back to it. A late local answer is a no-op (entry gone).
    const stock = stockPending.get(msg.id)
    if (stock) {
      stockPending.delete(msg.id)
      clearStockTtl(msg.id)
      stock.resolve(stockValueOf(msg))
      return
    }
    const ask = msg.ask

    // Explicit cancel — with or without the ask envelope. A strict client
    // (no envelope) only carries the request id, which IS the flowId by this
    // bridge's contract; confirm via activeFlows before trusting it.
    if (
      ("cancelled" in msg && msg.cancelled === true) ||
      (ask !== undefined && ask.kind === "cancel")
    ) {
      const flowId = ask?.flow_id ?? (activeFlows.has(msg.id) ? msg.id : null)
      if (!flowId) return
      emitSubmit(msg.id, flowId, { kind: "cancel" })
      return
    }

    // Rich path: the ask envelope carries the structured answer (option values).
    if (ask !== undefined && ask.kind === "answer") {
      emitSubmit(msg.id, ask.flow_id, {
        kind: "answer",
        mode: ask.mode,
        answers: ask.answers,
      })
      return
    }

    // Degraded path: a response without the ask envelope (e.g. a generic client
    // that rendered only the SDK `select`). Map the chosen label back to the
    // option value for the flow's first question.
    const flow = activeFlows.get(msg.id)
    if (!flow || flow.questions.length === 0) return
    const question = flow.questions[0]
    if (!question) return
    const label = "value" in msg ? String(msg.value) : ""
    // NB: pi-ask's schema doesn't forbid duplicate labels — on a collision the
    // first match wins. Inherent ambiguity of a label-only (degraded) client.
    const match = question.options.find((o) => o.label === label)
    const answers: Record<string, AskAnswerWire> = {
      [question.id]: match
        ? { values: [match.value] }
        : label
          ? { customText: label }
          : {},
    }
    emitSubmit(msg.id, flow.flowId, {
      kind: "answer",
      mode: "submit",
      answers,
    })
  }

  function emitSubmit(
    requestId: string,
    flowId: string,
    response:
      | {
          kind: "answer"
          mode?: "submit" | "elaborate"
          answers: Record<string, AskAnswerWire>
        }
      | { kind: "cancel" },
  ): void {
    try {
      events.emit(PI_ASK_SUBMIT, {
        version: 1,
        requestId,
        flowId,
        response,
      })
    } catch {
      // pi-ask not installed or bus gone — nothing useful to do; the flow will
      // either resolve locally (desktop TUI) or time out on its own.
    }
  }

  return {
    respond,
    openStock,
    dismissStock,
    // Insertion order = the order the flows opened, so a client replaying more
    // than one renders them oldest-first. pi-ask resolves one flow at a time in
    // practice, so this is a defensive detail rather than a live case. Stock
    // ctx.ui dialogs ride along so a peer attaching mid-dialog sees them.
    pendingRequests: () =>
      [...activeFlows.values()]
        .map(requestForFlow)
        .concat([...stockPending.values()].map((p) => p.request)),

    /** Cancel EVERY pending flow/dialog (slash-command feedback: /stop). Emits
     *  a cancelled response per pi-ask flow (resolves the extension side) and
     *  resolves each stock dialog with undefined + a dismiss-notify (closes the
     *  app modal; the wrap's race then aborts the local TUI dialog). Returns the
     *  count cancelled. */
    cancelAllPending(): number {
      let n = 0
      for (const flowId of [...activeFlows.keys()]) {
        try {
          respond({ type: "extension_ui_response", cancelled: true, id: flowId })
          n++
        } catch {
          /* best-effort per flow */
        }
      }
      for (const id of [...stockPending.keys()]) {
        const stock = stockPending.get(id)
        if (!stock) continue
        stockPending.delete(id)
        clearStockTtl(id)
        stock.resolve(undefined)
        broadcast({
          type: "extension_ui_request",
          id,
          method: "notify",
          message: "Resolved.",
        })
        n++
      }
      return n
    },
    dispose() {
      unsubStarted()
      unsubCompleted()
      unsubResult()
      for (const t of flowTimers.values()) clearTimeout(t)
      flowTimers.clear()
      activeFlows.clear()
      for (const t of stockTimers.values()) clearTimeout(t)
      stockTimers.clear()
      // Unblock stock callers on teardown so the wrap's race doesn't dangle.
      for (const s of stockPending.values()) s.resolve(undefined)
      stockPending.clear()
    },
  }
}

/** Build the wire frame for a stock ctx.ui dialog (no pi-ask envelope). */
function buildStockRequest(
  id: string,
  input: StockRequestInput,
): ExtensionUiRequestWire {
  switch (input.method) {
    case "select":
      return {
        type: "extension_ui_request",
        id,
        method: "select",
        title: input.title,
        options: input.options,
      }
    case "confirm":
      return {
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: input.title,
        message: input.message,
      }
    case "input":
      return {
        type: "extension_ui_request",
        id,
        method: "input",
        title: input.title,
        placeholder: input.placeholder,
      }
    case "editor":
      return {
        type: "extension_ui_request",
        id,
        method: "editor",
        title: input.title,
        prefill: input.prefill,
      }
  }
}

/** Build the single extension_ui_request that represents a whole ask flow. */
function requestForFlow(flow: ActiveFlow): ServerMessage {
  const first = flow.questions[0]
  const title = flow.title ?? first?.prompt ?? "Clarification"
  const options = first ? first.options.map((o) => o.label) : []
  const ask: AskEnrichmentWire = {
    flow_id: flow.flowId,
    tool_call_id: flow.toolCallId,
    source: flow.source,
    title: flow.title,
    questions: flow.questions,
  }
  // A pure-text question (pi-ask allows an empty options array) degrades to
  // `input` — a strict client renders a text field instead of an empty select.
  if (options.length === 0) {
    return {
      type: "extension_ui_request",
      // One request per flow → reuse the flowId as the correlation id. The
      // app's response carries the same id (and ask.flow_id) for routing.
      id: flow.flowId,
      method: "input",
      title,
      placeholder: first?.prompt,
      ask,
    }
  }
  return {
    type: "extension_ui_request",
    // One request per flow → reuse the flowId as the correlation id. The app's
    // response carries the same id (and ask.flow_id) so the bridge can route.
    id: flow.flowId,
    method: "select",
    title,
    options,
    ask,
  }
}

// ── pi-ask event parsing (defensive — shapes come from a third-party package) ──

interface StartedEvent {
  flowId: string
  toolCallId?: string
  source?: string
  title?: string
  questions: AskQuestionWire[]
}

function parseStartedEvent(raw: unknown): StartedEvent | null {
  if (!isRecord(raw)) return null
  if (raw.version !== 1) return null
  if (typeof raw.flowId !== "string") return null
  if (!Array.isArray(raw.questions)) return null
  const questions: AskQuestionWire[] = []
  for (const q of raw.questions) {
    const parsed = parseQuestion(q)
    if (!parsed) return null
    questions.push(parsed)
  }
  if (questions.length === 0) return null
  return {
    flowId: raw.flowId,
    toolCallId: asString(raw.toolCallId),
    source: asString(raw.source),
    title: asString(raw.title),
    questions,
  }
}

function parseQuestion(value: unknown): AskQuestionWire | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== "string" || typeof value.prompt !== "string")
    return null
  if (!Array.isArray(value.options)) return null
  const options: AskOptionWire[] = []
  for (const o of value.options) {
    const opt = parseOption(o)
    if (!opt) return null
    options.push(opt)
  }
  // Empty options is valid: pi-ask's schema has no minItems — a question can be
  // pure text (custom answer only). The request degrades to `input` upstream.
  return {
    id: value.id,
    label: typeof value.label === "string" ? value.label : value.prompt,
    prompt: value.prompt,
    type: asQuestionType(value.type) ?? "single",
    required: value.required === true,
    presentedType: asQuestionType(value.presentedType),
    requestedType: asQuestionType(value.requestedType),
    options,
  }
}

function parseOption(value: unknown): AskOptionWire | null {
  if (!isRecord(value)) return null
  // pi-ask's schema marks value/label Optional on input, but a started event
  // always carries resolved values. Be lenient: fall back label→value.
  const val =
    typeof value.value === "string" ? value.value : asString(value.label)
  const label = typeof value.label === "string" ? value.label : val
  if (!val || !label) return null
  return {
    value: val,
    label,
    description: asString(value.description),
    preview: asString(value.preview),
    freeform: value.freeform === true ? true : undefined,
  }
}

function asQuestionType(value: unknown): AskQuestionWireType | undefined {
  return value === "single" || value === "multi" || value === "preview"
    ? value
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// Re-exported so callers (and tests) can build responses without re-deriving the
// pi-ask response shape.
export type { AskResponseEnrichmentWire, ExtensionUiResponseWire }

// ── Stock ctx.ui wrap (first-responder-wins) ───────────────────────────────
// pi-ask is optional; stock `ctx.ui.select/confirm/input/editor` from ANY
// extension must also reach the paired app. pi's ExtensionRunner wraps the
// uiContext once and shares it across extensions (`getUIContext()`), so wrapping
// `ctx.ui` in our session_start reaches every extension's dialogs. pi still emits
// `ui_prompt_start/end` under us (our wrap sits outside pi's), so the TUI status
// indicator is unaffected.
//
// Semantics mirror pi-ask: the local TUI and the remote app BOTH render; whichever
// answers first resolves the dialog and dismisses the other:
//   - local wins  -> bridge.dismissStock(id) sends a notify (id-matched) so the
//                    app closes its modal (same contract pi-ask's `completed` uses).
//   - remote wins -> ac.abort() fires pi's `opts.signal` abort -> pi's
//                    showExtensionSelector/Confirm/Input resolve undefined + hide.
// A late loser answer is a no-op: dismissStock and respond both check the pending
// entry is gone before acting.
const STOCK_WRAPPED = Symbol("un-bien.stockUiWrapped")

/** Structural view of the ExtensionUIContext methods we wrap. */
interface StockUiContext {
  select: (
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<string | undefined>
  confirm: (
    title: string,
    message: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<boolean>
  input: (
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<string | undefined>
  editor?: (
    title: string,
    prefill?: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<string | undefined>
}

/** Wrap the shared `ctx.ui` so stock dialogs bridge to the paired app with
 *  first-responder-wins semantics. Idempotent (a symbol guard prevents double-
 *  wrapping across session replacements on a module-reuse host). No-op when no
 *  peer is attached — the call falls through to the original (local TUI), so the
 *  first-run wizard and headless prompts work unchanged. */
export function wrapStockUi(
  ui: StockUiContext | undefined,
  bridge: ExtensionUiBridge,
  hasPeer: () => boolean,
): void {
  if (!ui || typeof ui.select !== "function") return
  const marked = ui as StockUiContext & { [STOCK_WRAPPED]?: true }
  if (marked[STOCK_WRAPPED]) return
  marked[STOCK_WRAPPED] = true

  const orig = {
    select: ui.select.bind(ui),
    confirm: ui.confirm.bind(ui),
    input: ui.input.bind(ui),
    editor: ui.editor?.bind(ui),
  }

  function race(
    localP: Promise<unknown>,
    open: () => { promise: Promise<unknown>; id: string },
    abortLocal: () => void,
  ): Promise<unknown> {
    const { promise: remoteP, id } = open()
    return new Promise<unknown>((resolve) => {
      localP.then((v) => {
        bridge.dismissStock(id)
        resolve(v)
      })
      remoteP.then((v) => {
        abortLocal()
        resolve(v)
      })
    })
  }

  function chainSignal(opts: { signal?: AbortSignal } | undefined): AbortController {
    const ac = new AbortController()
    if (opts?.signal) opts.signal.addEventListener("abort", () => ac.abort(), { once: true })
    return ac
  }

  ui.select = ((title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => {
    if (!hasPeer()) return orig.select(title, options, opts)
    const ac = chainSignal(opts)
    return race(
      orig.select(title, options, { ...opts, signal: ac.signal }),
      () => bridge.openStock({ method: "select", title, options }),
      () => ac.abort(),
    ) as Promise<string | undefined>
  }) as StockUiContext["select"]

  ui.confirm = ((title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) => {
    if (!hasPeer()) return orig.confirm(title, message, opts)
    const ac = chainSignal(opts)
    return race(
      orig.confirm(title, message, { ...opts, signal: ac.signal }),
      () => bridge.openStock({ method: "confirm", title, message }),
      () => ac.abort(),
    ) as Promise<boolean>
  }) as StockUiContext["confirm"]

  ui.input = ((title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) => {
    if (!hasPeer()) return orig.input(title, placeholder, opts)
    const ac = chainSignal(opts)
    return race(
      orig.input(title, placeholder, { ...opts, signal: ac.signal }),
      () => bridge.openStock({ method: "input", title, placeholder }),
      () => ac.abort(),
    ) as Promise<string | undefined>
  }) as StockUiContext["input"]

  if (orig.editor) {
    const origEditor = orig.editor
    ui.editor = ((title: string, prefill?: string, opts?: { signal?: AbortSignal; timeout?: number }) => {
      if (!hasPeer()) return origEditor(title, prefill, opts)
      const ac = chainSignal(opts)
      return race(
        origEditor(title, prefill, { ...opts, signal: ac.signal }),
        () => bridge.openStock({ method: "editor", title, prefill }),
        () => ac.abort(),
      ) as Promise<string | undefined>
    }) as NonNullable<StockUiContext["editor"]>
  }
}
