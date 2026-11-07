/**
 * Durable binding's EventSource: watches the conversation view
 * (`Conversation.watch()`) and turns each value into the pi-shaped events
 * the rpc-envelope producer consumes (see ViewTranslator for the table),
 * keeping the transcript mirror (the get_entries surface) in step.
 *
 * The view's `entries` are a window over the transcript. A
 * ConversationTranscript layered over it keeps every entry it has seen and
 * pages in the rest: at attachment it loads the whole history before the
 * window, and whenever a value leaves a gap (a stall or an overflow skipped
 * entries) it fills the gap before anything is emitted. The mirror and the
 * translator therefore always see the transcript complete and in order.
 */
import type { Context, WatchEnd } from "@earendil-works/chord"
import {
  ConversationTranscript,
  type Conversation,
  type ConversationWatch,
  type EntryRecord,
  type InboxState,
  type LiveState,
  type RunFailure,
  type TranscriptView,
} from "@earendil-works/pi-durable"
import type { EventSource } from "@geohar/un-bien/core"
import type { DurableTranscriptMirror } from "./mirror.js"
import { ViewTranslator } from "./view_translator.js"

/** Entries per page when loading history before the window, or a gap. */
const PAGE_SIZE = 500

export interface ConversationViewSourceOptions {
  conversation: Conversation
  context: Context
  /** Transcript mirror: grown with every entry the view adds. */
  mirror: DurableTranscriptMirror
  /** Busy-flag callback: a run in flight → true, run ended → false. */
  onBusyChange?(busy: boolean): void
  /** A run ended without an answer (`pi.live.runFailure`). */
  onRunFailure?(failure: RunFailure): void
  /** The watch ended for a reason other than stop(). */
  onEnd?(end: WatchEnd): void
}

export class ConversationViewSource implements EventSource {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>()
  private readonly wildcards = new Set<(event: string, payload: unknown) => void>()
  private readonly translator: ViewTranslator
  private readonly transcript: ConversationTranscript
  private watch: ConversationWatch | null = null
  private stopping = false
  private inboxState: InboxState | undefined

  constructor(private readonly opts: ConversationViewSourceOptions) {
    this.translator = new ViewTranslator({
      emit: (name, payload) => this.dispatch(name, payload),
      onBusyChange: opts.onBusyChange,
      onRunFailure: opts.onRunFailure,
    })
    this.transcript = new ConversationTranscript(
      (query, limit, context) =>
        opts.conversation.entries(query, limit, undefined, context),
      { pageSize: PAGE_SIZE },
    )
  }

  /** Attach: the first value seeds the mirror and the translator, silently. */
  async open(): Promise<void> {
    const watch = await this.opts.conversation.watch(this.opts.context)
    this.watch = watch
    const view = await this.complete(this.transcript.merge(watch.value))
    this.inboxState = view.docs["pi.inbox"] as InboxState | undefined
    this.opts.mirror.ingest(entriesOf(view))
    this.translator.prime(liveOf(view))
    void watch.closed.then((end) => {
      if (!this.stopping) this.opts.onEnd?.(end)
    })
  }

  /** Start consuming values. One call per folded batch of commits. */
  start(): void {
    this.watch?.start(async (call, context) => {
      if (call.kind !== "value") return
      const view = await this.complete(this.transcript.merge(call.value), context)
      this.inboxState = view.docs["pi.inbox"] as InboxState | undefined
      const added = this.opts.mirror.ingest(entriesOf(view))
      this.translator.feed(added, liveOf(view))
    })
  }

  /** The conversation's queued submissions, as of the latest view value. */
  get inbox(): InboxState | undefined {
    return this.inboxState
  }

  async stop(): Promise<void> {
    this.stopping = true
    try {
      await this.watch?.stop()
    } catch {
      /* best-effort — a closed watch is fine */
    }
    this.watch = null
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
  onAny(handler: (event: string, payload: unknown) => void): () => void {
    this.wildcards.add(handler)
    return () => {
      this.wildcards.delete(handler)
    }
  }

  /** Load everything before the window and every gap in it. */
  private async complete(
    view: TranscriptView,
    context: Context = this.opts.context,
  ): Promise<TranscriptView> {
    let current = view
    for (;;) {
      const first = current.items[0]
      if (first?.kind === "earlier") {
        const next = await this.transcript.loadEarlier(context)
        if (next.items === current.items) return current
        current = next
        continue
      }
      const gap = current.items.find((item) => item.kind === "gap")
      if (gap?.kind === "gap") {
        const next = await this.transcript.fillGap(gap, context)
        if (next.items === current.items) return current
        current = next
        continue
      }
      return current
    }
  }

  private dispatch(name: string, payload: unknown): void {
    for (const handler of this.wildcards) {
      try {
        handler(name, payload)
      } catch {
        /* never let one consumer break the batch */
      }
    }
    for (const handler of this.handlers.get(name) ?? []) {
      try {
        handler(payload)
      } catch {
        /* never let one consumer break the batch */
      }
    }
  }
}

function entriesOf(view: TranscriptView): EntryRecord[] {
  return view.items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []))
}

function liveOf(view: TranscriptView): LiveState | undefined {
  return view.docs["pi.live"] as LiveState | undefined
}
