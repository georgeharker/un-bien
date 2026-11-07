/**
 * Translate successive durable conversation-view states into pi's event
 * plane: the event names and payloads `pi.on()` delivers, which the shared
 * rpc-envelope producer turns into `pi --mode rpc` frames. The app therefore
 * sees the same traffic from a durable conversation as from a pi session.
 *
 * pi-durable publishes state, not events: each view value holds the entries
 * appended since the last one and the `pi.live` document (run control, the
 * streaming answer, the tool round). `feed()` diffs that against what it has
 * already emitted:
 *
 *   pi.live.run appears / disappears     → agent_start / agent_end + agent_settled
 *   first message of a turn              → turn_start
 *   pi.user entry                        → message_start + message_end
 *   pi.live.generation.message           → message_start, then message_update per
 *                                          block: text/thinking start, delta, end;
 *                                          toolcall_start, toolcall_end
 *   pi.assistant entry                   → remaining block deltas and ends, then
 *                                          message_end; with no tool calls, turn_end
 *   pi.live.tools slot running           → tool_execution_start
 *   slot output/details change           → tool_execution_update {content, details}
 *   pi.tool-result entry                 → tool_execution_end {content, details} with
 *                                          the message's isError, then message_start +
 *                                          message_end; the round's last → turn_end
 *   slot done without an entry (faulted) → tool_execution_end, isError
 *   pi.compaction entry                  → session_compact (the summary)
 *   un-bien.app entry, display           → message_start + message_end, role custom
 *   pi.live.runFailure (new)             → onRunFailure (the bridge records it as an
 *                                          app entry, which then arrives as above)
 *
 * No toolcall_delta: the view holds a call's parsed arguments, not pi's raw
 * argument text, and the app builds tool cards from tool_execution_start.
 */
import type {
  EntryRecord,
  JsonObject,
  LiveState,
  RunFailure,
} from "@earendil-works/pi-durable"
import { UN_BIEN_APP_KIND, toWire } from "./mirror.js"

type Emit = (name: string, payload: Record<string, unknown>) => void

type Block = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: JsonObject
}

type Message = {
  role?: string
  content?: unknown
  toolCallId?: string
  toolName?: string
  details?: unknown
  isError?: boolean
  usage?: unknown
}

export interface ViewTranslatorOptions {
  emit: Emit
  onBusyChange?(busy: boolean): void
  onRunFailure?(failure: RunFailure): void
}

export class ViewTranslator {
  private busy = false
  private inTurn = false
  /** Blocks of the streaming answer already emitted, and which are closed. */
  private stream: { blocks: Block[]; ended: Set<number> } | null = null
  private lastAssistant: Message | null = null
  private pendingCalls = new Set<string>()
  private turnResults: Message[] = []
  private readonly toolsStarted = new Set<string>()
  private readonly toolsEnded = new Set<string>()
  private readonly toolProgress = new Map<string, string>()
  private runFailureTask: number | undefined

  constructor(private readonly opts: ViewTranslatorOptions) {}

  /**
   * Take the state at attachment without emitting: a run in flight sets the
   * busy flag, and a run failure already recorded is not reported again.
   */
  prime(live: LiveState | undefined): void {
    this.busy = live?.run !== undefined
    this.inTurn = this.busy
    this.runFailureTask = live?.runFailure?.taskId
    for (const slot of live?.tools ?? []) {
      if (slot.status !== "pending") this.toolsStarted.add(slot.callId)
      if (slot.status === "done") this.toolsEnded.add(slot.callId)
    }
    this.opts.onBusyChange?.(this.busy)
  }

  /** Emit what changed: `added` are the entries new since the last call. */
  feed(added: readonly EntryRecord[], live: LiveState | undefined): void {
    if (!this.busy && live?.run !== undefined) {
      this.busy = true
      this.opts.onBusyChange?.(true)
      this.opts.emit("agent_start", { type: "agent_start" })
    }
    for (const record of added) this.entry(record)
    const partial = live?.generation?.message as Message | undefined
    if (partial !== undefined) this.streaming(partial)
    for (const slot of live?.tools ?? []) this.slot(slot)
    const failure = live?.runFailure
    if (failure !== undefined && failure.taskId !== this.runFailureTask) {
      this.runFailureTask = failure.taskId
      this.opts.onRunFailure?.(failure)
    }
    if (this.busy && live?.run === undefined) this.endRun()
  }

  // ── entries ──────────────────────────────────────────────────────────────

  private entry(record: EntryRecord): void {
    const message = record.model?.[0] as Message | undefined
    switch (record.kind) {
      case "pi.user":
        if (message) this.whole(message)
        return
      case "pi.assistant":
        if (message) this.assistant(message)
        return
      case "pi.tool-result":
        if (message) this.toolResult(message)
        return
      case "pi.compaction": {
        const wire = toWire(record)[0] as { summary?: unknown }
        this.opts.emit("session_compact", {
          type: "session_compact",
          compactionEntry: { summary: wire.summary ?? "", tokensBefore: 0 },
        })
        return
      }
      case UN_BIEN_APP_KIND: {
        const wire = toWire(record)[0] as {
          customType?: unknown
          content?: unknown
          display?: unknown
          details?: unknown
        }
        if (wire.display === false) return
        this.whole({
          role: "custom",
          customType: wire.customType,
          content: wire.content,
          display: true,
          ...(wire.details !== undefined ? { details: wire.details } : {}),
          timestamp: Date.now(),
        } as Message)
        return
      }
      default:
        return
    }
  }

  /** A message that arrives complete: start and end in one go. */
  private whole(message: Message): void {
    this.beginTurn()
    this.opts.emit("message_start", { type: "message_start", message })
    this.opts.emit("message_end", { type: "message_end", message })
  }

  private assistant(message: Message): void {
    this.beginTurn()
    if (this.stream === null) {
      this.opts.emit("message_start", { type: "message_start", message })
      this.stream = { blocks: [], ended: new Set() }
    }
    // Whatever the throttled partial didn't show, then every block's end.
    this.diffBlocks(blocksOf(message), message.usage, true)
    this.stream = null
    this.opts.emit("message_end", { type: "message_end", message })
    this.lastAssistant = message
    this.turnResults = []
    this.pendingCalls = new Set(
      blocksOf(message)
        .filter((b) => b.type === "toolCall" && typeof b.id === "string")
        .map((b) => b.id as string),
    )
    if (this.pendingCalls.size === 0) this.endTurn()
  }

  private toolResult(message: Message): void {
    const callId = message.toolCallId ?? ""
    this.startTool(callId, message.toolName ?? "")
    if (!this.toolsEnded.has(callId)) {
      this.toolsEnded.add(callId)
      this.opts.emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: callId,
        toolName: message.toolName,
        result: {
          content: message.content ?? [],
          ...(message.details !== undefined ? { details: message.details } : {}),
        },
        isError: message.isError === true,
      })
    }
    this.whole(message)
    this.turnResults.push(message)
    this.pendingCalls.delete(callId)
    if (this.pendingCalls.size === 0 && this.inTurn) this.endTurn()
  }

  // ── the streaming answer ─────────────────────────────────────────────────

  private streaming(partial: Message): void {
    this.beginTurn()
    if (this.stream === null) {
      this.opts.emit("message_start", { type: "message_start", message: partial })
      this.stream = { blocks: [], ended: new Set() }
    }
    this.diffBlocks(blocksOf(partial), partial.usage, false)
  }

  /**
   * Emit the block events that take the emitted blocks to `blocks`. A block
   * ends when a later one starts, or, with `final`, at the message's end.
   */
  private diffBlocks(blocks: Block[], usage: unknown, final: boolean): void {
    const stream = this.stream
    if (stream === null) return
    const update = (event: Record<string, unknown>) =>
      this.opts.emit("message_update", {
        type: "message_update",
        message: { usage },
        assistantMessageEvent: event,
      })
    blocks.forEach((block, index) => {
      const before = stream.blocks[index]
      if (before === undefined) {
        for (let open = 0; open < index; open++) this.endBlock(open, blocks, update)
        update(startEvent(block, index))
      }
      const field = textField(block)
      if (field !== undefined) {
        const was = before ? (before[field] ?? "") : ""
        const now = block[field] ?? ""
        if (now.length > was.length && now.startsWith(was)) {
          update({
            type: field === "text" ? "text_delta" : "thinking_delta",
            contentIndex: index,
            delta: now.slice(was.length),
          })
        }
      }
      stream.blocks[index] = { ...block }
    })
    if (final) blocks.forEach((_, index) => this.endBlock(index, blocks, update))
  }

  private endBlock(
    index: number,
    blocks: Block[],
    update: (event: Record<string, unknown>) => void,
  ): void {
    const stream = this.stream
    if (stream === null || stream.ended.has(index)) return
    const block = blocks[index] ?? stream.blocks[index]
    if (block === undefined) return
    stream.ended.add(index)
    if (block.type === "toolCall") {
      update({ type: "toolcall_end", contentIndex: index, toolCall: block })
    } else if (block.type === "text" || block.type === "thinking") {
      update({
        type: `${block.type}_end`,
        contentIndex: index,
        content: block.type === "text" ? (block.text ?? "") : (block.thinking ?? ""),
      })
    }
  }

  // ── the tool round ───────────────────────────────────────────────────────

  private slot(slot: NonNullable<LiveState["tools"]>[number]): void {
    if (slot.status === "pending") return
    this.startTool(slot.callId, slot.name)
    if (this.toolsEnded.has(slot.callId)) return
    if (slot.status === "done") {
      // A done slot with an entry ends through that entry; without one the
      // tool task faulted or was orphaned.
      if (slot.entry !== undefined) return
      this.toolsEnded.add(slot.callId)
      this.opts.emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: slot.callId,
        toolName: slot.name,
        result: { content: [{ type: "text", text: "Tool produced no result" }] },
        isError: true,
      })
      this.pendingCalls.delete(slot.callId)
      return
    }
    const key = JSON.stringify([slot.output ?? "", slot.details ?? null])
    if (this.toolProgress.get(slot.callId) === key) return
    this.toolProgress.set(slot.callId, key)
    if (slot.output === undefined && slot.details === undefined) return
    this.opts.emit("tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: slot.callId,
      toolName: slot.name,
      args: this.argsOf(slot.callId),
      partialResult: {
        content: [{ type: "text", text: slot.output ?? "" }],
        ...(slot.details !== undefined ? { details: slot.details } : {}),
      },
    })
  }

  private startTool(callId: string, toolName: string): void {
    if (this.toolsStarted.has(callId)) return
    this.toolsStarted.add(callId)
    this.opts.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: callId,
      toolName,
      args: this.argsOf(callId),
    })
  }

  private argsOf(callId: string): JsonObject {
    const call = blocksOf(this.lastAssistant ?? {}).find(
      (b) => b.type === "toolCall" && b.id === callId,
    )
    return call?.arguments ?? {}
  }

  // ── turns and runs ───────────────────────────────────────────────────────

  private beginTurn(): void {
    if (this.inTurn) return
    this.inTurn = true
    this.opts.emit("turn_start", { type: "turn_start" })
  }

  private endTurn(): void {
    if (!this.inTurn) return
    this.inTurn = false
    this.opts.emit("turn_end", {
      type: "turn_end",
      message: this.lastAssistant,
      toolResults: this.turnResults,
    })
  }

  private endRun(): void {
    this.stream = null
    this.pendingCalls.clear()
    this.endTurn()
    this.toolsStarted.clear()
    this.toolsEnded.clear()
    this.toolProgress.clear()
    this.busy = false
    this.opts.onBusyChange?.(false)
    this.opts.emit("agent_end", { type: "agent_end", messages: [], willRetry: false })
    this.opts.emit("agent_settled", { type: "agent_settled" })
  }
}

function blocksOf(message: Message): Block[] {
  return Array.isArray(message.content) ? (message.content as Block[]) : []
}

function textField(block: Block): "text" | "thinking" | undefined {
  if (block.type === "text") return "text"
  if (block.type === "thinking") return "thinking"
  return undefined
}

function startEvent(block: Block, index: number): Record<string, unknown> {
  if (block.type === "toolCall") {
    // The producer's stripPartial lifts id + toolName from
    // partial.content[contentIndex]: give it a sparse array holding the call.
    const content: Block[] = []
    content[index] = { id: block.id, name: block.name }
    return { type: "toolcall_start", contentIndex: index, partial: { content } }
  }
  return { type: `${block.type ?? "text"}_start`, contentIndex: index }
}
