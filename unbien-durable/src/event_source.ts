/**
 * Durable binding's EventSource: adapts the durable `watchEvents()` stream to
 * the pi-shaped event names/payloads the rpc-envelope producer consumes, so
 * the frames out are the SAME traffic the app sees from a pi session.
 *
 * Translation table (durable AgentEvent → pi event name + payload):
 *   run_start        → agent_start {}
 *   run_end          → agent_end {messages: [], willRetry: false}
 *                      then agent_settled {} (pi fires both; the app's turn
 *                      completion rides the envelope agent_settled)
 *   turn_start       → turn_start {}
 *   turn_end         → turn_end {message: <last assistant message>, toolResults: []}
 *   message_start    → message_start {message}
 *   message_update   → message_update {message: {usage}, assistantMessageEvent:
 *                      synthesized from each MessageChange — deltas pass
 *                      through, toolcall_start gets a synthetic `partial`
 *                      sparse-array carrying {id, name} (the producer's
 *                      stripPartial lifts exactly those), block/message
 *                      replacements have no pi live-plane analog and are
 *                      skipped}
 *   message_end      → message_end {message: entry.model[0]}
 *   tool_execution_start → tool_execution_start {toolCallId, toolName, args}
 *   tool_execution_update → tool_execution_update {toolCallId, toolName,
 *                      partialResult: <retained output buffer>} — the durable
 *                      trim/append/set ops fold into one text buffer
 *   tool_execution_end   → tool_execution_end {toolCallId, toolName,
 *                      result: <rendered tool-result text>, isError}
 *   compaction_start → (no pi live-plane frame; skipped)
 *   compaction_end   → session_compact {compactionEntry} — the producer maps
 *                      session_compact to the rpc compaction_end frame; the
 *                      summary entry itself arrives via its own entry events
 *   snapshot         → seeds the transcript mirror (no frame)
 *   entry_appended   → grows the transcript mirror (no frame)
 *
 * Skipped in v1 (no pi live-plane analog): inbox_update, submission,
 * auto_retry_*, deferred_poll, task_failed, agent_changed, usage_changed.
 * `run_start`/`run_end` also drive the host's busy flag (the port's
 * `streaming`), maintained here.
 */
import type { AgentEvent, AgentEventStream } from "@earendil-works/pi-durable"
import type { EventSource } from "@geohar/un-bien/core"
import type { DurableTranscriptMirror } from "./port.js"

interface WatchEventsSourceOptions {
  /** Transcript mirror — seeded by snapshot, grown by entry_appended. */
  mirror: DurableTranscriptMirror
  /** Busy-flag callback: run_start → true, run_end → false. */
  onBusyChange?(busy: boolean): void
}

export class WatchEventsSource implements EventSource {
  private readonly handlers = new Map<
    string,
    Set<(payload: unknown) => void>
  >()
  private readonly toolOutput = new Map<string, string>()
  private lastAssistant: unknown = null

  constructor(
    private readonly stream: AgentEventStream,
    private readonly opts: WatchEventsSourceOptions,
  ) {
    // The snapshot at attachment is the mirror's initial seed — the app's
    // transcript reconstruction happens through get_entries on top of it.
    this.opts.mirror.seed(this.stream.snapshot.entries)
  }

  /** Start consuming the stream. One batch per commit. */
  start(): void {
    void this.stream.start(async (events) => {
      for (const event of events) this.handle(event)
    })
  }

  async stop(): Promise<void> {
    try {
      await this.stream.stop()
    } catch {
      /* best-effort — a closed stream is fine */
    }
  }

  on(event: string, handler: (payload: unknown) => void): void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
  }

  /** Wildcard subscribers (the port's subscribeEvents fanout). */
  onAny(
    handler: (event: string, payload: unknown) => void,
  ): () => void {
    this.wildcards.add(handler)
    return () => {
      this.wildcards.delete(handler)
    }
  }

  private readonly wildcards = new Set<
    (event: string, payload: unknown) => void
  >()

  private dispatch(name: string, payload: unknown): void {
    for (const handler of this.wildcards) {
      try {
        handler(name, payload)
      } catch {
        /* never let one consumer break the batch */
      }
    }
    const set = this.handlers.get(name)
    if (!set) return
    for (const handler of set) {
      try {
        handler(payload)
      } catch {
        /* never let one consumer break the batch */
      }
    }
  }

  private handle(event: AgentEvent): void {
    switch (event.type) {
      case "snapshot":
        this.opts.mirror.seed(event.entries)
        return
      case "entry_appended":
        this.opts.mirror.append(event.entry)
        return
      case "run_start":
        this.opts.onBusyChange?.(true)
        this.dispatch("agent_start", { type: "agent_start" })
        return
      case "run_end":
        this.opts.onBusyChange?.(false)
        this.dispatch("agent_end", {
          type: "agent_end",
          messages: [],
          willRetry: false,
        })
        this.dispatch("agent_settled", { type: "agent_settled" })
        return
      case "turn_start":
        this.dispatch("turn_start", { type: "turn_start" })
        return
      case "turn_end":
        this.dispatch("turn_end", {
          type: "turn_end",
          message: this.lastAssistant,
          toolResults: [],
        })
        return
      case "message_start":
        this.dispatch("message_start", {
          type: "message_start",
          message: event.message,
        })
        return
      case "message_update":
        this.handleMessageUpdate(event.usage, event.changes)
        return
      case "message_end": {
        const message = (event.entry.model?.[0] ?? null) as unknown
        this.lastAssistant = message
        this.dispatch("message_end", {
          type: "message_end",
          message,
        })
        return
      }
      case "tool_execution_start":
        this.toolOutput.set(event.toolCallId, "")
        this.dispatch("tool_execution_start", {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        })
        return
      case "tool_execution_update":
        this.handleToolUpdate(event)
        return
      case "tool_execution_end": {
        const buffer = this.toolOutput.get(event.toolCallId) ?? ""
        this.toolOutput.delete(event.toolCallId)
        const result = this.renderToolResult(event, buffer)
        this.dispatch("tool_execution_end", {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result,
          isError: result.startsWith("[error]"),
        })
        return
      }
      case "compaction_start":
        // No pi live-plane frame for compaction_start (the working indicator
        // rides room_meta); skipped.
        return
      case "compaction_end":
        // The producer maps session_compact → the rpc compaction_end frame.
        // Durable's compaction_end carries no summary — the summary ENTRY
        // arrives via its own entry events and rides get_entries.
        this.dispatch("session_compact", {
          type: "session_compact",
          reason: event.reason,
          compactionEntry: { summary: "", tokensBefore: 0 },
        })
        return
      default:
        // inbox_update / submission / auto_retry_* / deferred_poll /
        // task_failed / agent_changed / usage_changed: no pi live-plane
        // analog in v1.
        return
    }
  }

  private handleMessageUpdate(
    usage: unknown,
    changes: readonly unknown[],
  ): void {
    for (const change of changes) {
      const c = change as {
        type?: string
        contentIndex?: number
        delta?: string
        block?: { id?: string; name?: string }
      }
      if (
        c.type === "text_delta" ||
        c.type === "thinking_delta" ||
        c.type === "text_start" ||
        c.type === "thinking_start"
      ) {
        this.dispatch("message_update", {
          type: "message_update",
          message: { usage },
          assistantMessageEvent: {
            type: c.type,
            contentIndex: c.contentIndex,
            ...(c.delta !== undefined ? { delta: c.delta } : {}),
          },
        })
      } else if (c.type === "toolcall_start" && c.block) {
        // stripPartial lifts id + toolName from partial.content[contentIndex]
        // — build the sparse array it expects.
        const partial: { content: unknown[] } = { content: [] }
        partial.content[c.contentIndex ?? 0] = {
          id: c.block.id,
          name: c.block.name,
        }
        this.dispatch("message_update", {
          type: "message_update",
          message: { usage },
          assistantMessageEvent: {
            type: "toolcall_start",
            contentIndex: c.contentIndex,
            partial,
          },
        })
      } else if (c.type === "toolcall_delta") {
        this.dispatch("message_update", {
          type: "message_update",
          message: { usage },
          assistantMessageEvent: {
            type: "toolcall_delta",
            contentIndex: c.contentIndex,
            delta: c.delta,
          },
        })
      }
      // "block"/"message" replacements: no pi live-plane analog; skipped.
    }
  }

  private handleToolUpdate(event: {
    toolCallId: string
    toolName: string
    output?: { trimStart?: number; append?: string } | { set: string }
  }): void {
    const current = this.toolOutput.get(event.toolCallId) ?? ""
    let next = current
    const output = event.output
    if (output !== undefined) {
      if ("set" in output) {
        next = output.set
      } else {
        next =
          (output.trimStart !== undefined
            ? current.slice(output.trimStart)
            : current) + (output.append ?? "")
      }
    }
    this.toolOutput.set(event.toolCallId, next)
    this.dispatch("tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: next,
    })
  }

  private renderToolResult(
    event: { entry?: { model?: readonly unknown[] } },
    buffer: string,
  ): string {
    const message = event.entry?.model?.[0] as
      | { content?: Array<{ type?: string; text?: string; isError?: boolean }> }
      | undefined
    if (message?.content) {
      const text = message.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
      if (text.length > 0) return text
    }
    // No persisted result (faulted/orphaned tool task): the retained output
    // buffer is the best available text.
    return buffer.length > 0 ? buffer : "[error] tool produced no result"
  }
}