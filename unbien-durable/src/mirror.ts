/**
 * Synchronous view of the durable transcript, in pi's `SessionEntry` wire
 * shapes, so the app's entry replay (get_entries) renders a durable
 * conversation exactly as it renders a pi session.
 *
 * Fed by the ConversationViewSource with every entry the conversation's
 * ConversationTranscript holds (the watch window plus the pages loaded
 * before it), in entry-id order; `ingest` ignores ids it already has, so
 * the whole held transcript can be offered on every view value.
 *
 * Mapping (durable EntryRecord → pi entry):
 *   pi.user / pi.assistant / pi.tool-result (and any kind carrying model
 *     messages) → one `message` entry per model message, unchanged: pi-ai
 *     messages are pi's own, so thinking, toolCall, image, and toolResult
 *     blocks (with `details`, `isError`) keep their types. The first message
 *     keeps the entry id; later ones are `<id>.<n>`.
 *   pi.compaction → `compaction` {summary, firstKeptEntryId, tokensBefore}:
 *     the summary unwrapped from its `<summary>` user message.
 *   pi.reset → `custom_message` customType `un-bien:durable-reset`
 *     (display), carrying the handoff text when there is one.
 *   un-bien.app → `custom_message` with the app entry's customType,
 *     content, display, and details.
 *   anything else (pi.system, extension bookkeeping) → a typed stub
 *     `{type: kind}`, which the app skips like pi entry types it doesn't
 *     render.
 *
 * Wire ids are stringified durable ids (the app keys entries by string and
 * pages with `since: <id>`); `entryIdOf` parses one back, suffix and all.
 * Timestamps come from the entry's first model message; entries without one
 * take the time this process first saw them.
 */
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable"
import type { EntriesPage, EntryRange, PortEntry } from "@geohar/un-bien/core"

/** The app-entry kind the bridge commits custom entries under. */
export const UN_BIEN_APP_KIND = "un-bien.app"
/** customType of a context reset in the app's transcript. */
export const RESET_CUSTOM_TYPE = "un-bien:durable-reset"

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
const SUMMARY_SUFFIX = "\n</summary>"

/** The durable entry id a wire id names (`"12"` and `"12.1"` → 12). */
export function entryIdOf(wireId: string): EntryId | undefined {
  const match = /^(\d+)(?:\.\d+)?$/.exec(wireId)
  return match ? (Number(match[1]) as EntryId) : undefined
}

export class DurableTranscriptMirror {
  private readonly wire: PortEntry[] = []
  private newest: number | undefined

  /** Add the records newer than every held one; returns those added. */
  ingest(records: readonly EntryRecord[]): EntryRecord[] {
    const added: EntryRecord[] = []
    for (const record of records) {
      if (this.newest !== undefined && record.id <= this.newest) continue
      this.newest = record.id
      added.push(record)
      for (const entry of toWire(record)) {
        const parentId = this.wire.at(-1)?.id ?? null
        this.wire.push({ ...entry, parentId } as PortEntry)
      }
    }
    return added
  }

  /** The current leaf id (the newest wire entry). */
  get leafId(): string | null {
    return this.wire.at(-1)?.id ?? null
  }

  page(range?: EntryRange): EntriesPage {
    if (range?.since !== undefined) {
      const at = this.wire.findIndex((e) => e.id === range.since)
      if (at === -1) throw new Error(`Entry not found: ${range.since}`)
      return { entries: this.wire.slice(at + 1), leafId: this.leafId }
    }
    return { entries: [...this.wire], leafId: this.leafId }
  }
}

type WireEntry = { id: string; type: string; timestamp: string } & Record<
  string,
  unknown
>

const firstSeen = new Map<number, string>()

function timestampOf(record: EntryRecord): string {
  const ms = (record.model?.[0] as { timestamp?: unknown } | undefined)
    ?.timestamp
  if (typeof ms === "number" && Number.isFinite(ms)) {
    return new Date(ms).toISOString()
  }
  let seen = firstSeen.get(record.id)
  if (seen === undefined) {
    seen = new Date().toISOString()
    firstSeen.set(record.id, seen)
  }
  return seen
}

/** The text of a message's content: a string, or its text blocks joined. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: unknown })?.type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
}

/** Map one durable entry to its pi wire entries (without parentId). */
export function toWire(record: EntryRecord): WireEntry[] {
  const id = String(record.id)
  const timestamp = timestampOf(record)
  switch (record.kind) {
    case "pi.compaction": {
      let summary = textOf(record.model?.[0])
      if (summary.startsWith(SUMMARY_PREFIX) && summary.endsWith(SUMMARY_SUFFIX)) {
        summary = summary.slice(
          SUMMARY_PREFIX.length,
          summary.length - SUMMARY_SUFFIX.length,
        )
      }
      return [
        {
          type: "compaction",
          id,
          timestamp,
          summary,
          firstKeptEntryId: record.head !== undefined ? String(record.head) : id,
          tokensBefore: 0,
        },
      ]
    }
    case "pi.reset": {
      const handoff = textOf(record.model?.[0])
      return [
        {
          type: "custom_message",
          id,
          timestamp,
          customType: RESET_CUSTOM_TYPE,
          content: handoff
            ? `Context reset. Handoff:\n\n${handoff}`
            : "Context reset",
          display: true,
        },
      ]
    }
    case UN_BIEN_APP_KIND: {
      const data = (record.data ?? {}) as {
        customType?: unknown
        content?: unknown
        display?: unknown
        details?: unknown
      }
      return [
        {
          type: "custom_message",
          id,
          timestamp,
          customType: typeof data.customType === "string" ? data.customType : "",
          content: typeof data.content === "string" ? data.content : "",
          display: data.display !== false,
          ...(data.details !== undefined ? { details: data.details } : {}),
        },
      ]
    }
    default:
      break
  }
  const messages = (record.model ?? []).filter(
    (m) => typeof (m as { role?: unknown }).role === "string" &&
      (m as { role: string }).role !== "system",
  )
  if (messages.length === 0) {
    return [{ type: record.kind, id, timestamp, kind: record.kind }]
  }
  return messages.map((message, n) => ({
    type: "message",
    id: n === 0 ? id : `${id}.${n}`,
    timestamp,
    message,
  }))
}
