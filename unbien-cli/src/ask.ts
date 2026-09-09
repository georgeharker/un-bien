/**
 * pi-ask flows and the `extension_ui_request` surface.
 *
 * A flow arrives as ONE request whose `id` IS the flowId, carrying an `ask`
 * envelope with the full question set. The reply echoes that id plus an `ask`
 * enrichment so multi-select, custom text and notes survive the round trip.
 */

export type AskQuestionType = "single" | "multi" | "preview"

export interface AskOption {
  value: string
  label: string
  description?: string
  preview?: string
  /**
   * pi-ask's "the user should type an answer" marker. It appears as exactly
   * ONE option, never mixed with real choices, and wants `customText` with no
   * `values` — submitting the literal option value would answer with the token
   * "freeform" instead of what was typed.
   */
  freeform?: boolean
  /** Presentation metadata only; it never changes the submitted value. */
  recommended?: boolean
}

export interface AskQuestion {
  id: string
  label?: string
  prompt: string
  type: AskQuestionType
  required?: boolean
  /** The type actually presented, after any host-side policy/toggle. */
  presentedType?: AskQuestionType
  options: AskOption[]
}

export interface AskEnrichment {
  flow_id: string
  tool_call_id?: string | null
  source?: string
  title?: string
  questions: AskQuestion[]
}

/** A live `extension_ui_request` awaiting an answer. */
export interface AskPrompt {
  id: string
  method: string
  title?: string
  placeholder?: string
  options?: string[]
  ask?: AskEnrichment
}

export interface AskAnswer {
  values?: string[]
  customText?: string
  note?: string
  optionNotes?: Record<string, string>
}

export const effectiveType = (q: AskQuestion): AskQuestionType =>
  q.presentedType ?? q.type

/**
 * How a `notify` relates to the open prompts.
 *
 * A notify is NOT prompt content. The bridge emits one with `id === flowId`
 * when a flow resolves, so treating every notify as a transcript row both
 * spams the log and (if stored as a prompt) re-presents a resolved ask.
 * Design 01M1CF5FYMWHAGVZX3RDM50E34.
 */
export type NotifyRouting =
  | { kind: "dismiss"; id: string }
  | { kind: "notice"; level: string; text: string }
  | { kind: "drop" }

export function routeNotify(
  frame: { id?: unknown; notifyType?: unknown; message?: unknown },
  isOpen: (id: string) => boolean,
): NotifyRouting {
  const id = typeof frame.id === "string" ? frame.id : undefined
  const level = String(frame.notifyType ?? "info")
  const text = String(frame.message ?? "")

  // A warning is actionable (answer rejected, flow expired): show it inline and
  // leave any open ask standing as the retry surface.
  if (level === "warning" || level === "error") {
    return { kind: "notice", level, text }
  }
  // Resolution of an ask we are showing: retract it, render nothing.
  if (id && isOpen(id)) return { kind: "dismiss", id }
  // A resolution ack for a flow we never showed (someone else answered).
  if (id) return { kind: "drop" }
  return { kind: "notice", level, text }
}

/**
 * Which shown flows are stale after a reconciliation window closes.
 *
 * The host replays only flows still awaiting an answer (`pendingRequests()`
 * maps `activeFlows`, which the `completed` event deletes), so a replayed ask
 * is provably unanswered and one we show that was NOT replayed has provably
 * resolved. `replayed === null` means no window was in flight: fail open and
 * retire nothing, so a dropped terminator can't clear a live prompt.
 */
export function staleFlows(
  shown: Iterable<string>,
  replayed: ReadonlySet<string> | null,
): string[] {
  if (!replayed) return []
  return [...shown].filter((id) => !replayed.has(id))
}

/** The reply for a completed flow. `value` keeps degraded clients working. */
export function answerResponse(
  prompt: AskPrompt,
  answers: Record<string, AskAnswer>,
): Record<string, unknown> {
  const flowId = prompt.ask?.flow_id ?? prompt.id
  const first = prompt.ask?.questions[0]
  const firstAnswer = first ? answers[first.id] : undefined
  // `value` is the label-shaped scalar a strict client would have sent; the
  // `ask` envelope carries the structured truth.
  const value = firstAnswer?.customText ?? firstAnswer?.values?.join(", ") ?? ""

  return {
    type: "extension_ui_response",
    id: prompt.id,
    value,
    ask: { flow_id: flowId, kind: "answer", mode: "submit", answers },
  }
}

export function cancelResponse(prompt: AskPrompt): Record<string, unknown> {
  const flowId = prompt.ask?.flow_id ?? prompt.id
  return {
    type: "extension_ui_response",
    id: prompt.id,
    cancelled: true,
    ask: { flow_id: flowId, kind: "cancel" },
  }
}

/** Confirm/select/input without a pi-ask envelope — pi's own dialog surface. */
export function plainResponse(
  prompt: AskPrompt,
  picked: string | boolean,
): Record<string, unknown> {
  if (typeof picked === "boolean") {
    return { type: "extension_ui_response", id: prompt.id, confirmed: picked }
  }
  return { type: "extension_ui_response", id: prompt.id, value: picked }
}
