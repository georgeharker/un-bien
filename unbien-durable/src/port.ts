/**
 * Durable binding's AgentSessionPort + SessionControlPort implementations.
 *
 * A durable Conversation already has everything the port promises, with ONE
 * structural difference from pi: its transcript and busy state are read
 * asynchronously (Chord commits), while the port is synchronous (inbound rpc
 * dispatch must not await the store). The bridge closes that gap with a
 * TRANSCRIPT MIRROR kept in sync by the watchEvents stream: the snapshot
 * seeds it, `entry_appended` grows it. Because durable conversation IDs are
 * stable across restarts, there is NO session-replacement machinery here —
 * no generations, no disposal re-arm, no stale-ctx juggling. A replacement
 * is just a new conversation handle retargeted into a fresh port.
 *
 * ID mapping (documented v1 contract): durable ids are Seq-orderable
 * branded numbers; the app's wire protocol (pi `SessionEntry` shape) keys
 * entries by STRING ids and resumes paging with `since: <string leafId>`.
 * The mirror therefore stringifies every entry id (`String(id)`) and the
 * session-control verbs parse the app's string ids back (`Number(id)`) —
 * both sides of that round-trip live in this module.
 */
import type { Context } from "@earendil-works/chord"
import type {
  Conversation,
  EntryId,
  EntryRecord,
  InputSubmissionDraft,
} from "@earendil-works/pi-durable"
import type {
  AgentSessionPort,
  EntriesPage,
  EntryRange,
  NotifyLevel,
  PortEntry,
  SessionControlPort,
  SubmitContent,
  SubmitOptions,
  SubmitResult,
} from "@geohar/un-bien/core"

// ── Transcript mirror ───────────────────────────────────────────────────────

/**
 * Synchronous view of the durable transcript, in the pi `SessionEntry` wire
 * shape. Fed exclusively by the WatchEventsSource (snapshot → replace,
 * entry_appended → append); the port's `getEntries` reads it without touching
 * the store.
 *
 * Mapping (documented v1 contract): each durable EntryRecord with a model
 * message becomes a pi `message` entry (`{type:"message", id, parentId,
 * timestamp, message}`); bookkeeping kinds (pi.system and friends without a
 * renderable model message) become typed stubs carrying the durable `kind`,
 * which the app ignores gracefully the same way it ignores pi entry types it
 * doesn't know. Durable EntryRecords carry no wall-clock timestamp — the
 * mirror stamps each entry id with the Date.now() of its first observation
 * (restarts re-stamp from the snapshot in order).
 */
export class DurableTranscriptMirror {
  private entries: PortEntry[] = []
  private readonly seenAt = new Map<string, string>()
  private lastId: string | null = null

  /** Replace the whole mirror from a watch snapshot. */
  seed(records: readonly EntryRecord[]): void {
    this.entries = records.map((record, i) =>
      this.toWire(record, i > 0 ? String(records[i - 1]!.id) : null),
    )
  }

  /** Append one entry (entry_appended). */
  append(record: EntryRecord): void {
    this.entries.push(this.toWire(record, this.lastId))
  }

  /** The current leaf id (the newest entry, stringified). */
  get leafId(): string | null {
    return this.lastId
  }

  page(range?: EntryRange): EntriesPage {
    const all = this.entries
    if (range?.since !== undefined) {
      const at = all.findIndex((e) => e.id === range.since)
      if (at === -1) throw new Error(`Entry not found: ${range.since}`)
      return { entries: all.slice(at + 1), leafId: this.lastId }
    }
    return { entries: all, leafId: this.lastId }
  }

  private toWire(record: EntryRecord, parentId: string | null): PortEntry {
    const id = String(record.id)
    this.lastId = id
    let timestamp = this.seenAt.get(id)
    if (timestamp === undefined) {
      timestamp = new Date().toISOString()
      this.seenAt.set(id, timestamp)
    }
    const model = record.model?.[0] as
      | { role?: string; content?: unknown }
      | undefined
    if (model && typeof model.role === "string") {
      return {
        type: "message",
        id,
        parentId,
        timestamp,
        message: model,
      } as PortEntry
    }
    // Bookkeeping entry the app has no pi-native rendering for: typed stub.
    return {
      type: record.kind,
      id,
      parentId,
      timestamp,
      kind: record.kind,
    } as PortEntry
  }
}

// ── The session port ────────────────────────────────────────────────────────

export interface DurableSessionPortOptions {
  /** The conversation this port serves (stable id across restarts). */
  conversation: Conversation
  /** Chord context for the async handoffs (BACKGROUND_CONTEXT in the host). */
  context: Context
  /** Transcript mirror fed by the host's WatchEventsSource. */
  mirror: DurableTranscriptMirror
  /** The conversation's working directory (host-configured). */
  cwd: string
  /** Live busy flag, maintained by the host from run_start/run_end events. */
  busy(): boolean
  /** Append a custom entry via a committed app entry (best-effort). */
  appendAppEntry(entry: {
    customType: string
    content: string
    display?: boolean
    details?: unknown
  }): void
  /** Log surface for notify + asynchronous submission failures. */
  log(message: string, level?: NotifyLevel): void
  /** Event-plane fanout hook (the host's WatchEventsSource); the port's
   *  subscribeEvents is additive on it. Absent = no events surface. */
  subscribe?(
    handler: (event: string, payload: unknown) => void,
  ): () => void
}

export class DurableSessionPort implements AgentSessionPort {
  constructor(private readonly opts: DurableSessionPortOptions) {}

  private get conversation(): Conversation {
    return this.opts.conversation
  }

  get sessionId(): string | null {
    return String(this.opts.conversation.id)
  }

  get cwd(): string {
    return this.opts.cwd
  }

  get streaming(): boolean {
    return this.opts.busy()
  }

  submit(content: SubmitContent, submitOpts?: SubmitOptions): SubmitResult {
    // Fire-and-forget, matching the port contract: a refused handoff must be
    // a synchronous answer, but durable's submit is a commit — the wait
    // happens on the harness side and the reply rides the event plane.
    // `steer` maps to durable's whenBusy:"steer" (join the running work);
    // everything else queues as a follow-up, pi's deliverAs:"followUp".
    // The port's content blocks are structurally pi-ai's TextContent |
    // ImageContent — the same blocks durable's user input accepts.
    const draft: InputSubmissionDraft = {
      type: "input",
      content,
      whenBusy: submitOpts?.deliverAs === "steer" ? "steer" : undefined,
    }
    void this.conversation
      .submit(draft, this.opts.context)
      .then((submission) => submission.wait(this.opts.context))
      .then((settled) => {
        const record = settled as { status?: string; reason?: string }
        if (record?.status === "unanswered") {
          this.opts.log(
            `submission unanswered: ${String(record.reason ?? "unknown reason")}`,
            "warning",
          )
        }
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        this.opts.log(`submission failed: ${detail}`, "error")
      })
    return { ok: true }
  }

  getEntries(range?: EntryRange): EntriesPage {
    return this.opts.mirror.page(range)
  }

  abort(): boolean {
    // The port reports whether an abort was REQUESTED (the port surface is
    // synchronous; durable's abort resolves once the conversation is idle).
    if (!this.opts.busy()) return false
    void this.conversation.abort(this.opts.context)
    return true
  }

  compact(opts?: { customInstructions?: string }): void {
    // Manual compaction always works on durable; it runs as a task and the
    // bridge forwards its completion via the compaction events.
    void this.conversation.compact(
      opts?.customInstructions,
      this.opts.context,
    )
  }

  notify(message: string, level: NotifyLevel = "info"): void {
    this.opts.log(message, level)
  }

  appendEntry(entry: {
    customType: string
    content: string
    display?: boolean
    details?: unknown
  }): void {
    // Custom entries are data-only sidecars on the durable side (there is
    // no TUI renderer here); committed best-effort through the host hook.
    this.opts.appendAppEntry(entry)
  }

  subscribeEvents(
    handler: (event: string, payload: unknown) => void,
  ): () => void {
    // The event plane is owned by the host's WatchEventsSource (one stream
    // per conversation); the bridge fans translations to every subscriber.
    // Registering through the port is additive on that fanout.
    return this.opts.subscribe?.(handler) ?? (() => undefined)
  }
}

// ── Session control ─────────────────────────────────────────────────────────

export interface DurableSessionControlOptions {
  /** Create a conversation on the harness (the pi `new_session` analog). */
  createConversation(context: Context): Promise<Conversation>
  /** Called with the NEW conversation so the host retargets bridge + port. */
  retarget(conversation: Conversation): Promise<void>
  /** The CURRENT conversation (for fork). */
  current(): Conversation
  context: Context
  /** Graceful host shutdown (close relay + harness; the process exits). */
  shutdownHost(): Promise<void>
}

export class DurableSessionControl implements SessionControlPort {
  constructor(private readonly opts: DurableSessionControlOptions) {}

  async newSession(): Promise<void> {
    const created = await this.opts.createConversation(this.opts.context)
    await this.opts.retarget(created)
  }

  async fork(
    entryId: string,
    _opts?: { position?: "at" | "before"; requestId?: string },
  ): Promise<void> {
    // Durable forks always branch AT the entry (there is no "before"
    // placement); the requestId correlation is app-plane state the bridge
    // tracks, not a conversation concern. The app's string id parses back
    // to the durable Seq id (see the module header's ID-mapping note).
    const at = Number(entryId) as EntryId
    if (!Number.isFinite(at)) throw new Error(`Entry not found: ${entryId}`)
    const forked = await this.opts.current().fork(at, {
      ownership: { kind: "ownerless" },
    }, this.opts.context)
    await this.opts.retarget(forked)
  }

  async navigateTree(_entryId: string): Promise<void> {
    // Durable transcripts are linear: branching happens by forking a NEW
    // conversation (which keeps a stable id of its own). In-place leaf
    // moves have no durable equivalent.
    throw new Error(
      "navigateTree is not implemented on the durable binding — fork instead",
    )
  }

  async shutdown(): Promise<void> {
    await this.opts.shutdownHost()
  }
}