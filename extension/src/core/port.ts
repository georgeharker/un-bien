/**
 * Harness-neutral agent-session port.
 *
 * The seam type the shared core (mesh tools, rpc-inbound handlers, the
 * received-image pipeline, the rpc-envelope producer) codes against instead
 * of a concrete harness API. Two bindings implement it:
 *
 *   - pi-coding-agent: `PiSessionPort` / `PiSessionControl`
 *     (pi_binding/session_port.ts) wrap the root session's `ExtensionAPI` +
 *     the always-fresh session_start ctx. Slash commands, the ctx.ui/pi-ask
 *     bridge, and the model-registry rpc verbs stay pi-only and are NOT part
 *     of this port (flagged not-implemented on other bindings).
 *   - pi-durable: `DurableSessionPort` / `DurableSessionControl`
 *     (unbien-durable) wrap a durable `Conversation`. Because durable
 *     conversations have stable IDs that survive restarts, the pi binding's
 *     session-replacement machinery (generations, disposal re-arm, stale-ctx
 *     juggling) does not exist on that side of the port.
 *
 * The surface is lifted from ACTUAL usage in the existing seams
 * (commands/deps.ts, session/rpc_handlers.ts, session/relay_lifecycle.ts,
 * routing.ts, session/received_images.ts) — every member names an operation
 * those seams already perform against the pi API. Nothing speculative.
 *
 * Wire-shape rule: `getEntries` returns entries in the pi `SessionEntry`
 * JSON shape (`{ type: "message", id, parentId, timestamp, message }` as the
 * outer envelope) because the app reduces raw entries itself. Bindings that
 * store a different entry shape must map to this shape before returning.
 */

// ── submit(): the app→agent content handoff ────────────────────────────────

/** One content block accepted by `submit()`. Structurally the pi
 *  `TextContent | ImageContent` union and the durable user-input blocks. */
export type SubmitBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

/** Prompt content: plain text or a multimodal block list. */
export type SubmitContent = string | SubmitBlock[]

/** Delivery verb when the session is mid-run. Maps to pi `deliverAs`; the
 *  durable binding queues the equivalent steer/follow-up submission. */
export type SubmitDelivery = "steer" | "followUp"

export interface SubmitOptions {
  /** How to place the content when a run is active. Absent = host default. */
  deliverAs?: SubmitDelivery
  /** Expand prompt templates / slash-command syntax in the content. */
  expandPromptTemplates?: boolean
}

/** Result of `submit()`: fire-and-forget handoffs still need a synchronous
 *  refused/ok answer (a dropped message must be visible to the caller). */
export type SubmitResult = { ok: true } | { ok: false; detail: string }

// ── appendEntry(): custom transcript entries ───────────────────────────────

/**
 * A custom (harness-namespaced) transcript entry. Pi's `sendMessage` custom
 * message and durable's app-defined entries both reduce to this: a typed tag,
 * display text, and an opaque details payload.
 */
export interface CustomEntryInput {
  /** Namespaced discriminator, e.g. `un-bien:mesh-message`. */
  customType: string
  /** Display text carried by the entry. */
  content: string
  /** False = data-only (kept out of model context where the harness allows). */
  display?: boolean
  /** Opaque structured payload for renderers/consumers. */
  details?: unknown
}

// ── getEntries(): the transcript read ───────────────────────────────────────

/**
 * One transcript entry in the pi `SessionEntry` wire shape. Opaque JSON
 * keyed by `id` — consumers (the app, the get_entries paging code) read the
 * fields they know; producers (bindings) emit the pi-faithful keys
 * (`type`, `parentId`, `timestamp`, `message`, …). Kept minimal (not a
 * `Record` intersection) so host-native entry interfaces — which carry no
 * index signature — remain assignable to it.
 */
export type PortEntry = { id: string } & object

/** Read range. `since` = resume AFTER that entry id; absent = from the head.
 *  A binding MAY ignore the hint and return the full log (paging is the
 *  producer's job — see rpc_inbound.pageEntries); `since`, when honored,
 *  must refer to an existing entry or the call throws `Entry not found:`. */
export interface EntryRange {
  since?: string
  limit?: number
}

/** One `getEntries()` result: the entries plus the session's current leaf. */
export interface EntriesPage {
  entries: PortEntry[]
  leafId: string | null
}

// ── The port ────────────────────────────────────────────────────────────────

export type NotifyLevel = "info" | "warning" | "error"

/**
 * The live agent session, as the shared core needs it.
 *
 * All members are synchronous-or-throwing: the inbound dispatch paths that
 * use them answer app RPCs and must not block the transport loop (submits are
 * fire-and-forget handoffs; waits happen on the harness side).
 */
export interface AgentSessionPort {
  /** Stable session identity (pi session id / durable conversation id). */
  readonly sessionId: string | null
  /** The session's working directory. */
  readonly cwd: string
  /** True while a run is streaming or settling (the authoritative busy flag). */
  readonly streaming: boolean

  /**
   * Hand content to the agent as user input, waking (or steering) a run.
   * Does NOT wait for the answer — the reply rides the event plane
   * (subscribeEvents) back out.
   */
  submit(content: SubmitContent, opts?: SubmitOptions): SubmitResult

  /**
   * Read the transcript. `range.since` is a paging/resume hint; a binding
   * returning the full log is valid (the caller pages). Throws
   * `Entry not found: <id>` for an unknown `since`.
   */
  getEntries(range?: EntryRange): EntriesPage

  /**
   * Abort the current run. Returns false when nothing is running (or no
   * abortable context is live). Never throws for a stale context — it moves
   * to the next candidate / reports false.
   */
  abort(): boolean

  /**
   * Compact the model-visible context. `opts.customInstructions` steers the
   * summary. Throws when no compactable context is live.
   */
  compact(opts?: { customInstructions?: string }): void

  /**
   * Surface a transient notice to the session's human owner (TUI toast,
   * notification surface). Best-effort: never throws.
   */
  notify(message: string, level?: NotifyLevel): void

  /**
   * Append a custom transcript entry (display/data sidecar, never an LLM
   * turn). Throws only on a hard refusal (e.g. runtime not initialized).
   */
  appendEntry(entry: CustomEntryInput): void

  /**
   * Subscribe to the session's event plane. `handler` receives
   * (eventName, payload) — the AgentSessionEvent names/payloads the
   * rpc-envelope producer consumes. Returns a disposer; pi has no
   * unregister, so that binding's disposer is a gate (handlers stop firing
   * into the callback), documented here so callers don't rely on removal.
   */
  subscribeEvents(
    handler: (event: string, payload: unknown) => void,
  ): () => void
}

// ── Session control: branching + replacement ───────────────────────────────

/**
 * Session-replacement / tree operations, lifted from how the pi extension
 * uses its command ctx (`ctx.newSession` / `ctx.fork` / `ctx.navigateTree`)
 * and event ctx (`ctx.shutdown`):
 *
 *   - newSession(): start a FRESH session (new identity; the app drops the
 *     old conversation when the replacement announces a changed sessionId).
 *   - fork(entryId, opts): create a NEW session continuing from `entryId`.
 *     `opts.position` selects the fork point relative to the entry;
 *     `opts.requestId` is the app's originating request id, echoed back on
 *     the replacement's first session sync so the app auto-navigates.
 *   - navigateTree(entryId): move the active leaf to `entryId` IN PLACE —
 *     same session identity, the app re-derives its active path from the
 *     leaf beacon. Bindings with linear transcripts may decline.
 *   - shutdown(): graceful host shutdown (the /quit equivalent): abort any
 *     running turn, tear down live surfaces, let the process exit. The
 *     app learns the end from the session-shutdown forward + disconnect.
 *
 * On the durable binding these map to `createConversation()` / `fork()` /
 * (not applicable — durable forks branch by conversation, so navigateTree
 * throws not-implemented) / harness close. Because durable conversation IDs
 * are stable, no replacement/rearm machinery is needed: the caller simply
 * retargets the port at the new conversation.
 */
export interface SessionControlPort {
  newSession(): Promise<void>
  fork(
    entryId: string,
    opts?: { position?: "at" | "before"; requestId?: string },
  ): Promise<void>
  navigateTree(entryId: string): Promise<void>
  shutdown(): Promise<void>
}

// ── Headless pi launches (the launch-wait-quit tool's port) ─────────────────

/**
 * The ONE place the two bindings meet at runtime: a durable-host tool that
 * needs ad-hoc pi firepower. The durable binding's `launch_pi_task` tool
 * drives a short-lived headless pi-coding-agent session through this port;
 * the pi binding has no use for it (a pi session spawns subagents natively).
 *
 * Contract:
 *   - launchHeadless(opts): create a headless pi AgentSession in `opts.cwd`
 *     with the un-bien pi extension discoverable (installed pi-package or
 *     project-local). The session is NOT yet on the mesh. `opts.name` is the
 *     SCOPED mesh name the session will register under (the tool mints one
 *     per invocation, e.g. `pi-task/<uuid-prefix>`, so concurrent launches
 *     can never collide).
 *   - joinMeshUnderName(): bind the scoped name to the session and bring the
 *     un-bien extension up (its session_start auto-join connects the UDS
 *     broker under that name). Resolves once the extension lifecycle has been
 *     handed the join; the actual broker registration is confirmed by
 *     awaitReady.
 *   - awaitReady(opts): poll the local UDS broker until the launched peer is
 *     listed (it is addressable), or throw on timeout. After this resolves,
 *     `address` is the broker-assigned routing key for agent_send.
 *   - tearDown(): quit the session gracefully (its session_shutdown handler
 *     leaves the mesh and closes the relay) and release the runtime. Idempotent.
 *
 * Failure semantics: every step throws on failure; the caller (the tool) MUST
 * call tearDown() in a finally so a failed task never leaks a live pi peer.
 */
export interface HeadlessLaunchPort {
  launchHeadless(opts: {
    cwd: string
    name: string
  }): Promise<HeadlessLaunchedSession>
}

/** A launched, not-yet-ready headless session. */
export interface HeadlessLaunchedSession {
  /** The requested (scoped) mesh name. */
  readonly name: string
  /** join-mesh-under-name — see HeadlessLaunchPort. */
  joinMeshUnderName(): Promise<void>
  /** await-ready — resolves with the broker-assigned address. */
  awaitReady(opts?: { timeoutMs?: number }): Promise<{ address: string }>
  /** tear-down — see HeadlessLaunchPort. */
  tearDown(): Promise<void>
}