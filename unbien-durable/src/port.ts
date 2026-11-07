/**
 * Durable binding's AgentSessionPort + SessionControlPort implementations.
 *
 * A durable Conversation already has everything the port promises, with ONE
 * structural difference from pi: its transcript and busy state are read
 * asynchronously (Chord commits), while the port is synchronous (inbound rpc
 * dispatch must not await the store). The bridge closes that gap with a
 * TRANSCRIPT MIRROR (mirror.ts) kept in sync by the ConversationViewSource,
 * which grows it with every entry the conversation view adds. Because
 * durable conversation IDs are
 * stable across restarts, there is NO session-replacement machinery here —
 * no generations, no disposal re-arm, no stale-ctx juggling. A replacement
 * is just a new conversation handle retargeted into a fresh port.
 *
 * ID mapping (documented v1 contract): durable ids are Seq-orderable
 * branded numbers; the app's wire protocol (pi `SessionEntry` shape) keys
 * entries by STRING ids and resumes paging with `since: <string leafId>`.
 * The mirror stringifies every entry id (`String(id)`, `<id>.<n>` for an
 * entry's later model messages) and the session-control verbs parse the
 * app's string ids back with `entryIdOf`.
 */
import type { Context } from "@earendil-works/chord"
import type {
  Conversation,
  InputSubmissionDraft,
} from "@earendil-works/pi-durable"
import type {
  AgentSessionPort,
  EntriesPage,
  EntryRange,
  NotifyLevel,
  SessionControlPort,
  SubmitContent,
  SubmitOptions,
  SubmitResult,
} from "@geohar/un-bien/core"
import { type DurableTranscriptMirror, entryIdOf } from "./mirror.js"

export { DurableTranscriptMirror } from "./mirror.js"

// ── The session port ────────────────────────────────────────────────────────

export interface DurableSessionPortOptions {
  /** The conversation this port serves (stable id across restarts). */
  conversation: Conversation
  /** Chord context for the async handoffs (BACKGROUND_CONTEXT in the host). */
  context: Context
  /** Transcript mirror fed by the host's ConversationViewSource. */
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
  /** Event-plane fanout hook (the host's ConversationViewSource); the port's
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
    // Fire-and-forget per the port contract — but not unguarded: a store
    // failure must log, not surface as an unhandled rejection.
    void this.conversation.abort(this.opts.context).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      this.opts.log(`abort failed: ${detail}`, "warning")
    })
    return true
  }

  compact(opts?: { customInstructions?: string }): void {
    // Manual compaction always works on durable; it runs as a task and the
    // bridge forwards its completion via the compaction events.
    void this.conversation
      .compact(opts?.customInstructions, this.opts.context)
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        this.opts.log(`compact failed: ${detail}`, "warning")
      })
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
    // The event plane is owned by the host's ConversationViewSource (one watch
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
    const at = entryIdOf(entryId)
    if (at === undefined) throw new Error(`Entry not found: ${entryId}`)
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