/**
 * mesh_inbox.ts — persistent inbox for inbound mesh messages.
 *
 * The pi-subagents `get_subagent_result` pattern, adapted to mesh messaging:
 * every inbound mesh message is stored here AND pushed via `pi.sendMessage`
 * (the nudge). The model can PULL a message it missed (no more "missed push =
 * lost"), and can WAIT for a matching reply (the `agent_request` replacement:
 * `agent_send` with `re` → `wait_message({re, timeout})`).
 *
 * Pure in-process state — no I/O, no pi dependency. One inbox per extension
 * instance (the root session owns it; subagent children get their own rooms,
 * not this inbox).
 */

/** One inbound mesh message, stored for pull/wait. */
export interface MeshMessage {
  /** Stable id (the envelope id the sender assigned). */
  id: string
  /** Sender address. */
  from: string
  /** Recipient (this agent's address, or "broadcast"). */
  to: string
  /** Free-form JSON payload. */
  body: unknown
  /** The sender's `re` (correlation to an earlier message, e.g. a reply). */
  re: string | null
  /** Epoch ms when the broker delivered it to this agent. */
  sentAt: number
  /** Epoch ms when it was pushed via pi.sendMessage (null if not yet pushed). */
  deliveredAt: number | null
}

/** Filter for list/wait. */
export interface MeshFilter {
  /** Only messages from this sender (address). */
  from?: string
  /** Only messages with this `re` (correlate to a specific send of yours). */
  re?: string
  /** Only messages at-or-after this epoch ms. */
  sinceMs?: number
}

/** Options for the blocking `wait()` pull. */
export interface WaitOptions {
  /**
   * Abort signal (pi's per-tool-call signal). When it fires, the wait settles
   * to `null` right away and cleans up its timer/listener — the caller
   * distinguishes abort from timeout via its own `signal.aborted`.
   */
  signal?: AbortSignal
  /**
   * Break mutual waits early ("early interrupt"). If the awaited peer sends
   * us something that needs attention while we're blocked, resolve the wait
   * with that (non-matching!) message so the caller can act and re-wait,
   * instead of both sides stalling to timeout. Scoping:
   *   - with a `from` filter → interrupts on any non-matching message from
   *     that same peer;
   *   - without → only fresh uncorrelated requests (`re === null`) count,
   *     since those are the ones the peer can only be waiting on us for.
   * Candidates must be recent (see `INTERRUPT_GRACE_MS`): a stale broadcast
   * from hours ago must not look like deadlock evidence.
   */
  interruptOnUnmatched?: boolean
}

/** How far back a stored message can still be treated as a mutual-wait signal. */
const INTERRUPT_GRACE_MS = 30_000

/** Does `m` satisfy the filter? Shared by the inbox and the tool layer (the
 *  tool recomputes it to tell a match from an early interrupt). */
export function matchesFilter(m: MeshMessage, f: MeshFilter): boolean {
  if (f.from !== undefined && m.from !== f.from) return false
  if (f.re !== undefined && m.re !== f.re) return false
  if (f.sinceMs !== undefined && m.sentAt < f.sinceMs) return false
  return true
}

/** Could `m` be a mutual-wait signal under this filter? */
function isInterruptCandidate(
  m: MeshMessage,
  f: MeshFilter,
  waitStartMs: number,
): boolean {
  if (m.sentAt < waitStartMs - INTERRUPT_GRACE_MS) return false
  if (f.from !== undefined) return m.from === f.from
  return m.re === null
}

/**
 * Bounded inbox. Keeps every delivered message (in insertion order) so a
 * missed push is recoverable, plus a waiter set for the `wait_message`
 * blocking pull. A waiter resolves immediately if an already-stored message
 * matches (so a reply that arrived before the wait call is returned, not
 * missed), else it blocks until a matching message arrives or the timeout
 * fires.
 */
export class MeshInbox {
  private readonly messages = new Map<string, MeshMessage>()
  private readonly order: string[] = []
  private readonly waiters = new Set<{
    match: (m: MeshMessage) => boolean
    interrupts?: (m: MeshMessage) => boolean
    resolve: (m: MeshMessage | null) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  /** Cap to keep the inbox bounded across a long-lived session. */
  private readonly cap: number

  constructor(cap = 1000) {
    this.cap = cap
  }

  /** Store a delivered message + notify any matching waiter. Dedups by id. */
  add(msg: MeshMessage): void {
    if (this.messages.has(msg.id)) return
    this.messages.set(msg.id, msg)
    this.order.push(msg.id)
    // bound: drop the oldest past the cap
    while (this.order.length > this.cap) {
      const oldest = this.order.shift()!
      this.messages.delete(oldest)
    }
    // notify waiters (snapshot — resolve may mutate the set). A non-matching
    // message may still settle a waiter under `interruptOnUnmatched` (mutual-
    // wait break) — the caller re-checks the filter to tell the two apart.
    for (const w of [...this.waiters]) {
      if (w.match(msg) || w.interrupts?.(msg)) {
        clearTimeout(w.timer)
        this.waiters.delete(w)
        w.resolve(msg)
      }
    }
  }

  /** Fetch a single message by id (null if absent). */
  get(id: string): MeshMessage | null {
    return this.messages.get(id) ?? null
  }

  /** List messages matching the filter, oldest-first (or newest N via limit). */
  list(filter: MeshFilter = {}, limit?: number): MeshMessage[] {
    let msgs = this.order.map((id) => this.messages.get(id)!) as MeshMessage[]
    if (filter.from !== undefined)
      msgs = msgs.filter((m) => m.from === filter.from)
    if (filter.re !== undefined) msgs = msgs.filter((m) => m.re === filter.re)
    if (filter.sinceMs !== undefined)
      msgs = msgs.filter((m) => m.sentAt >= filter.sinceMs!)
    if (limit !== undefined && limit > 0) msgs = msgs.slice(-limit)
    return msgs
  }

  /**
   * Blocking pull: return the first message matching the filter that's already
   * stored, else wait until one arrives or `timeoutMs` elapses (→ null).
   * `get_subagent_result`'s `wait:true` semantics — a reply that already
   * arrived is returned immediately, not re-awaited.
   *
   * With `interruptOnUnmatched`, the returned message is not guaranteed to
   * match the filter (early interrupt; see `WaitOptions`) — callers must
   * re-check it with `matchesFilter`. Rejects only if `signal` is already
   * aborted; a mid-wait abort settles to `null`.
   */
  wait(
    filter: MeshFilter,
    timeoutMs: number,
    opts: WaitOptions = {},
  ): Promise<MeshMessage | null> {
    const { signal, interruptOnUnmatched } = opts
    if (signal?.aborted) return Promise.reject(new Error("aborted"))
    const match = (m: MeshMessage): boolean => matchesFilter(m, filter)
    const waitStartMs = Date.now()
    // already-stored match → resolve immediately
    for (const id of this.order) {
      const m = this.messages.get(id)!
      if (match(m)) return Promise.resolve(m)
    }
    // already-stored mutual-wait signal (the peer's request may have arrived
    // BEFORE this wait even started) → early interrupt
    if (interruptOnUnmatched) {
      for (const id of this.order) {
        const m = this.messages.get(id)!
        if (isInterruptCandidate(m, filter, waitStartMs))
          return Promise.resolve(m)
      }
    }
    // else wait
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", onAbort)
        this.waiters.delete(w)
        resolve(null)
      }, timeoutMs)
      const onAbort = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(w)
        resolve(null)
      }
      const resolveOnce = (m: MeshMessage | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this.waiters.delete(w)
        resolve(m)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      const w = {
        match,
        ...(interruptOnUnmatched
          ? {
              interrupts: (m: MeshMessage): boolean =>
                isInterruptCandidate(m, filter, waitStartMs),
            }
          : {}),
        resolve: resolveOnce,
        timer,
      }
      this.waiters.add(w)
    })
  }

  /** Drop everything (teardown / session replacement). */
  clear(): void {
    for (const w of this.waiters) clearTimeout(w.timer)
    this.waiters.clear()
    this.messages.clear()
    this.order.length = 0
  }

  /** Count of stored messages (for observability/tests). */
  get size(): number {
    return this.messages.size
  }
}
