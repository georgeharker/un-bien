/**
 * Pi binding's AgentSessionPort + SessionControlPort implementations.
 *
 * PiSessionPort adapts the ROOT session's ExtensionAPI (plus the always-fresh
 * session_start base ctx and the root sessionManager) to the harness-neutral
 * core port. It is constructed LIVE (per call site, from accessor closures)
 * so it always sees the current session — never captured, so a session
 * replacement can't strand a stale port.
 *
 * Session-control ops exist ONLY on pi's command ctx, so PiSessionControl
 * reaches them the same way the extension always has: self-dispatching the
 * registered `/unbien …` commands via sendUserMessage (pi runs them with a
 * real command ctx). `shutdown()` is the event-ctx path the app's terminate
 * frame uses (see routing.ts).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type {
  AgentSessionPort,
  CustomEntryInput,
  EntriesPage,
  EntryRange,
  NotifyLevel,
  SessionControlPort,
  SubmitContent,
  SubmitOptions,
  SubmitResult,
} from "../core/port.js"
import { envLog } from "../session/debug_log.js"
import { RPC_EVENT_NAMES } from "../session/rpc_envelope.js"

/** Minimal structural view of the root sessionManager the port reads. */
export interface PiSessionManagerView {
  getSessionId(): string
  getEntries(): Array<{ id: string } & Record<string, unknown>>
  getLeafId(): string | null
  getCwd?: () => string
}

export interface PiSessionPortOptions {
  /** The root session's ExtensionAPI (null before the factory wired it). */
  getPi(): ExtensionAPI | null
  /** The always-fresh session_start base ctx (compact / abort / ui). */
  getBaseCtx(): Pick<ExtensionContext, "compact" | "abort" | "ui"> | null
  /** The root session's sessionManager (transcript + id + cwd reads). */
  getSessionManager(): PiSessionManagerView | null
}

/** Abort via the first candidate whose abort() works; stale-ctx throws of a
 *  candidate are skipped, real failures rethrow. Shared by the port and the
 *  binding composition's fallback-ctx variant. */
export function abortWithCandidates(
  candidates: Array<Pick<ExtensionContext, "abort"> | null | undefined>,
): boolean {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (typeof candidate.abort !== "function") continue
    try {
      candidate.abort()
      return true
    } catch (err) {
      // Only skip SDK stale-ctx throws and try the next candidate. Real abort
      // failures rethrow so the cancel handler can report action_error.
      const msg = err instanceof Error ? err.message : String(err)
      if (/stale|session replacement or reload/i.test(msg)) continue
      throw err
    }
  }
  return false
}

export class PiSessionPort implements AgentSessionPort {
  constructor(private readonly opts: PiSessionPortOptions) {}

  private get pi(): ExtensionAPI | null {
    return this.opts.getPi()
  }

  get sessionId(): string | null {
    return this.opts.getSessionManager()?.getSessionId() ?? null
  }

  get cwd(): string {
    const sm = this.opts.getSessionManager()
    return sm && typeof sm.getCwd === "function" ? sm.getCwd() : process.cwd()
  }

  get streaming(): boolean {
    // The concrete AgentSession carries isStreaming; the public
    // ExtensionAPI type omits it.
    return (this.pi as { isStreaming?: boolean } | null)?.isStreaming === true
  }

  submit(content: SubmitContent, portOpts?: SubmitOptions): SubmitResult {
    const pi = this.pi
    if (!pi) return { ok: false, detail: "agent session not bound yet" }
    try {
      pi.sendUserMessage(content, {
        ...(portOpts?.deliverAs ? { deliverAs: portOpts.deliverAs } : {}),
        ...(portOpts?.expandPromptTemplates !== undefined
          ? { expandPromptTemplates: portOpts.expandPromptTemplates }
          : {}),
      })
      return { ok: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, detail }
    }
  }

  getEntries(range?: EntryRange): EntriesPage {
    const sm = this.opts.getSessionManager()
    if (!sm) return { entries: [], leafId: null }
    const all = sm.getEntries()
    if (range?.since !== undefined) {
      // pi-faithful `since` semantics (rpc-mode.js): unknown id → error,
      // not a silent restart from the beginning.
      const at = all.findIndex((e) => e.id === range.since)
      if (at === -1) throw new Error(`Entry not found: ${range.since}`)
      return { entries: all.slice(at + 1), leafId: sm.getLeafId() }
    }
    return { entries: all, leafId: sm.getLeafId() }
  }

  abort(): boolean {
    return abortWithCandidates([this.opts.getBaseCtx()])
  }

  compact(opts?: { customInstructions?: string }): void {
    const ctx = this.opts.getBaseCtx()
    if (!ctx?.compact)
      throw new Error("compact unavailable (no active session ctx)")
    ctx.compact(opts?.customInstructions ? { customInstructions: opts.customInstructions } : undefined)
  }

  notify(message: string, level: NotifyLevel = "info"): void {
    try {
      // The base ctx carries a guarded `ui` getter that can throw after a
      // session replacement — never let that escape into a notify path.
      const ui = this.opts.getBaseCtx()?.ui as
        | { notify?: (message: string, level?: string) => void }
        | null
        | undefined
      if (ui && typeof ui.notify === "function") ui.notify(message, level)
    } catch {
      /* never let notify take down the process */
    }
  }

  appendEntry(entry: CustomEntryInput): void {
    // pi's CustomMessage requires `display` (and callers historically always
    // passed it); the port treats an absent flag as data-only (false).
    this.pi?.sendMessage({
      customType: entry.customType,
      content: entry.content,
      display: entry.display ?? false,
      ...(entry.details !== undefined ? { details: entry.details } : {}),
    })
  }

  subscribeEvents(
    handler: (event: string, payload: unknown) => void,
  ): () => void {
    const pi = this.pi
    if (!pi) return () => undefined
    // SAFETY: see PiOnEventSource — string-name subscription is valid at
    // runtime for every RPC_EVENT_NAMES entry.
    const on = pi.on.bind(pi) as unknown as (
      event: string,
      cb: (payload: unknown) => void,
    ) => void
    // pi.on has no unregister: the disposer is a gate, checked INSIDE the
    // registered callback — pi's event dispatch keeps calling in, but the
    // callback stops forwarding. (The gate has to live in the callback's
    // closure, not just the disposer, or it never gates anything.)
    let disposed = false
    for (const name of RPC_EVENT_NAMES)
      on(name, (payload) => {
        if (disposed) return
        handler(name, payload)
      })
    return () => {
      disposed = true
    }
  }
}

/**
 * Session control for the pi binding: fork/branch/new go through the
 * registered `/unbien` commands (command-ctx-only powers, reached by
 * self-dispatch); shutdown is the app-terminate graceful path.
 */
export class PiSessionControl implements SessionControlPort {
  constructor(private readonly getPi: () => ExtensionAPI | null) {}

  private dispatch(command: string): void {
    this.getPi()?.sendUserMessage(command, {
      deliverAs: "followUp",
      expandPromptTemplates: true,
    })
  }

  async newSession(): Promise<void> {
    this.dispatch("/unbien new")
  }

  async fork(
    entryId: string,
    opts?: { position?: "at" | "before"; requestId?: string },
  ): Promise<void> {
    // Byte-identical to the app's session_fork self-dispatch: the command
    // parser expects `<entryId> [reqId] [position]`.
    const reqArg = opts?.requestId ? ` ${opts.requestId}` : ""
    const posArg =
      opts?.position === "at" || opts?.position === "before"
        ? ` ${opts.position}`
        : ""
    this.dispatch(`/unbien fork ${entryId}${reqArg}${posArg}`)
  }

  async navigateTree(entryId: string): Promise<void> {
    this.dispatch(`/unbien branch ${entryId}`)
  }

  async shutdown(): Promise<void> {
    // ctx.shutdown() IS the /quit equivalent — pi's own source lists
    // "extension shutdown()" alongside Ctrl+D / /quit (interactive-mode.js:
    // same graceful this.shutdown(): drain input, ui.stop() restores cooked
    // mode + cursor, extension disposal, resume hint, exit). It sits DIRECTLY
    // on the event ctx (ExtensionContext.shutdown — there is no ctx.actions
    // sub-object). MID-TURN DEFERRAL: the interactive handler fires
    // immediately only when idle; otherwise it sets `shutdownRequested` and
    // waits for `agent_settled` — which never arrives when nothing is
    // running. So abort() FIRST: aborting a running turn forces the settle
    // that re-checks the flag; on an idle session abort is a no-op and the
    // idle fast-path fires directly. NO process.exit fallback, ever: a raw
    // exit leaves the TTY in raw mode.
    const pi = this.getPi()
    // SAFETY: ExtensionContext.shutdown/abort are guarded getters on a
    // proxy; a plain structural read is proxy-safe per property and the
    // typeof checks below gate every invocation.
    const ctx = pi as unknown as
      | { abort?: () => void; shutdown?: () => void }
      | null
    if (ctx?.shutdown) {
      ctx.abort?.()
      ctx.shutdown()
    } else {
      envLog(
        "terminate(ub): no live ctx — refusing raw exit (would leave the terminal in raw mode); staying up",
      )
    }
  }
}