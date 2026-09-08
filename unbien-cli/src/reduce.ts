/**
 * The consumer-side reducer the harness is missing: an rpc-envelope stream in,
 * an ordered transcript out. Mirrors the Swift `SessionState.applyRPC` role, so
 * the same fixture corpus can be replayed through both.
 */

// One wire type, shared with the extension — a local restatement would drift
// silently from the thing actually on the wire.
import type { EnvelopeMessage } from "@geohar/un-bien/client"
export type { EnvelopeMessage }

type Frame = Record<string, unknown>

function asFrame(value: unknown): Frame | null {
  return typeof value === "object" && value !== null ? (value as Frame) : null
}

export interface ContentBlock {
  type: string
  text?: string | null
  name?: string | null
  id?: string | null
}

export interface WireMessage {
  role: "user" | "assistant" | "toolResult" | string
  content: ContentBlock[]
}

export type TranscriptItem =
  | { kind: "message"; message: WireMessage }
  | {
      kind: "tool"
      toolCallId: string
      toolName: string
      args: unknown
      result?: { content: ContentBlock[]; details?: unknown; isError: boolean }
    }
  | { kind: "notice"; level: string; text: string }

/**
 * Replay `get_entries` history as the SAME synthetic frames the live stream
 * produces, so history and live fold through one reducer rather than two.
 * Mirrors the Swift `applyEntries`, which emits only message_end /
 * tool_execution_* for exactly this reason.
 */
export function entriesToEnvelopes(entries: readonly unknown[]) {
  const out: EnvelopeMessage[] = []
  for (const raw of entries) {
    const entry = asFrame(raw)
    if (!entry || entry.type !== "message") continue
    const message = asFrame(entry.message)
    if (!message) continue

    if (message.role === "toolResult") {
      out.push({
        rpc: {
          type: "tool_execution_end",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          result: { content: message.content, details: message.details },
          isError: message.isError === true,
        },
      })
      continue
    }

    out.push({ rpc: { type: "message_end", message } })

    // An assistant turn carries its tool calls inline; the card is born from
    // the start frame, exactly as in the live stream.
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue
    for (const block of message.content) {
      const call = asFrame(block)
      if (!call || call.type !== "toolCall") continue
      out.push({
        rpc: {
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        },
      })
    }
  }
  return out
}

/** Normalize a raw fixture line: bare rpc frames and wrapped envelopes both occur. */
export function toEnvelope(line: unknown): EnvelopeMessage | null {
  const obj = asFrame(line)
  if (!obj) return null
  if ("rpc" in obj || "evt" in obj || "ub" in obj) return obj as EnvelopeMessage
  if (typeof obj.type === "string") return { rpc: obj }
  return null
}

export function reduce(
  envelopes: readonly EnvelopeMessage[],
): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const toolsById = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>()

  for (const env of envelopes) {
    const rpc = asFrame(env.rpc)
    if (!rpc) continue

    switch (rpc.type) {
      case "message_end": {
        const message = rpc.message as WireMessage | undefined
        // A toolResult message duplicates the tool card's own result frame.
        if (!message || message.role === "toolResult") break
        items.push({ kind: "message", message })
        break
      }

      case "tool_execution_start": {
        const card: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          toolCallId: String(rpc.toolCallId),
          toolName: String(rpc.toolName),
          args: rpc.args,
        }
        toolsById.set(card.toolCallId, card)
        items.push(card)
        break
      }

      case "tool_execution_end": {
        const card = toolsById.get(String(rpc.toolCallId))
        if (!card) break
        // `details` carries each tool's typed payload — the edit diff among
        // them — so pi's own result renderers draw natively from the wire.
        const result = rpc.result as
          { content?: ContentBlock[]; details?: unknown } | undefined
        card.result = {
          content: result?.content ?? [],
          details: result?.details,
          isError: rpc.isError === true,
        }
        break
      }

      case "extension_ui_request": {
        if (rpc.method !== "notify") break
        items.push({
          kind: "notice",
          level: String(rpc.notifyType ?? "info"),
          text: String(rpc.message ?? ""),
        })
        break
      }
    }
  }

  return items
}
