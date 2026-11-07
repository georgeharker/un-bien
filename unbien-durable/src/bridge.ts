/**
 * The durable host's relay<->conversation bridge: the durable analog of the
 * pi extension's relay wiring, with the session-replacement machinery
 * DELETED by design — durable conversations have stable ids, so there are
 * no generations, no disposal re-arm, no root-claim weakset, no stale-ctx
 * juggling. A "session replacement" is just `retarget(conversation)`: the
 * old room gets a flushed session_shutdown broadcast, the relay reconnects
 * under the new conversation's room id, and a fresh port/mirror/watch
 * attach. Nothing else carries state across.
 *
 * Surface (the app sees the same traffic as a pi session):
 *   - the room announces on connect, keyed roomIdForSession(conversation.id)
 *     — stable across host restarts, exactly like pi's session-id rooms;
 *   - the fail-closed signed pairing allow-list is pushed on every connect;
 *   - pair_request / known-peer reconnect / unknown-peer refusal mirror the
 *     pi extension's auto-listener;
 *   - live frames come from ConversationViewSource → createRpcEnvelope —
 *     the SAME producer the pi binding uses, over the SAME event shapes;
 *   - a run that ends without an answer is recorded as a display app entry
 *     (customType un-bien:durable-run-failure), so it shows live and on
 *     replay;
 *   - inbound rpc commands dispatch through the shared rpc_inbound/
 *     rpc_handlers pair (createRpcHandlers over the durable port); the
 *     model-registry/slash verbs answer errors (pi-only members are null);
 *   - the un plane answers session_sync / terminate.
 */
import { hostname } from "node:os"
import type { Context, JsonValue } from "@earendil-works/chord"
import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { Models } from "@earendil-works/pi-ai/models"
import type {
  Conversation,
  Harness,
  RunFailure,
} from "@earendil-works/pi-durable"
import { defineEntry as defineEntryFn } from "@earendil-works/pi-durable"
import {
  TOKEN_TTL_MS,
  PlainPeerChannel,
  RelayClient,
  _findKnownPeer,
  addPeer,
  buildQRUri,
  buildSignedAllowList,
  createRpcEnvelope,
  createRpcHandlers,
  dispatchRpcCommand,
  effectiveAllowRemoteTerminate,
  getOrCreateEd25519Keypair,
  helloEnvelope,
  isEnvelopeFrame,
  listPeers,
  loadLocalConfig,
  nextAllowListVersion,
  pairingAllowList,
  qrSession,
  renderQRAscii,
  roomIdForSession,
  sessionCapabilities,
  toWebSocketUrl,
  type ClientMessage,
  type Ed25519Keypair,
  type EnvelopeMessage,
  type PairErrorCode,
  type RpcHandlersDeps,
  type ServerMessage,
} from "@geohar/un-bien/durable"
import type { NotifyLevel } from "@geohar/un-bien/core"
import { DurableSessionControl, DurableSessionPort } from "./port.js"
import { DurableTranscriptMirror, UN_BIEN_APP_KIND } from "./mirror.js"
import { ConversationViewSource } from "./event_source.js"
import { DEFAULT_THINKING_LEVEL, ensureThinkingLevel } from "./thinking.js"
import { DurableAgentConfig } from "./agent_config.js"

/** App-defined entry kind carrying un-bien custom entries (data-only
 *  sidecars: display text + details payload). */
const UnBienAppEntry = defineEntryFn<{
  customType: string
  content: string
  display?: boolean
  details?: JsonValue
}>(UN_BIEN_APP_KIND)

/** customType of the hidden record of a session rename. */
const SESSION_NAME_CUSTOM_TYPE = "un-bien:session-name"

/** The newest session name recorded in the conversation, if any. */
function recordedSessionName(mirror: DurableTranscriptMirror): string | undefined {
  // SAFETY: the mirror's wire entries are mirror.ts toWire() output; an
  // un-bien.app record is a custom_message with string customType/content.
  const entries = mirror.page().entries as unknown as Array<{
    type?: string
    customType?: string
    content?: string
  }>
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === "custom_message" && entry.customType === SESSION_NAME_CUSTOM_TYPE)
      return entry.content
  }
  return undefined
}

/** customType of the transcript notice for a run that ended unanswered. */
const RUN_FAILURE_CUSTOM_TYPE = "un-bien:durable-run-failure"

/** The notice text per RunFailureReason. */
const RUN_FAILURE_TEXT: Record<RunFailure["reason"], string> = {
  model_error: "The model request failed",
  no_model: "No model is available",
  aborted: "Stopped",
  reset: "The context was reset before an answer",
  faulted: "The run failed",
  orphaned: "The run could not continue",
  interrupted: "The host stopped while the model was answering",
  restart_limit: "The run was cut off too many times",
  nothing_to_answer: "Nothing to answer",
  turn_limit: "The turn limit was reached",
}

/** Reconnect backoffs — the pi extension's ladder, minus the generations. */
const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export interface DurableBridgeOptions {
  harness: Harness
  context: Context
  /** http(s):// relay URL (converted to ws(s):// at the boundary). */
  relayUrl: string
  /** Display name for room_meta + pair_ok. */
  displayName: string
  /** Machine name the app records (defaults to os.hostname()). Distinct for
   *  the durable host so the app lists it as its own machine, not the Mac. */
  machineName?: string
  /** The conversations' working directory. */
  cwd: string
  /** Pairing QR rotation cadence in ms (default: the 60s token TTL, so the
   *  invite renews exactly as the previous token expires). Tests shrink it
   *  to observe rotation in real time. */
  pairingRotationMs?: number
  /** Suppress the auto-minted rotating pairing QR (no user gesture minted
   *  it — headless hosts pair via the CLI instead). Default: false, the
   *  rotation mints as before. */
  pairingQr?: boolean
  /** Relay client factory — tests inject a fake; production gets the real
   *  RelayClient. */
  createRelay?: (wsUrl: string, keypair: Ed25519Keypair) => RelayClient
  /** The harness's model registry. With it, each attached conversation
   *  still at thinking level "off" (pi-durable's default) is raised to
   *  `thinkingLevel`, clamped to its model — see thinking.ts. */
  models?: Models
  /** Default thinking level (default "medium", pi's). "off" disables. */
  thinkingLevel?: ModelThinkingLevel
  /** Host log surface (notify + async failures). */
  log(message: string, level?: NotifyLevel): void
  /** Graceful host shutdown (terminate frame) — close bridge + harness. */
  shutdownHost(): Promise<void>
}

export class DurableBridge {
  private relay: RelayClient | null = null
  private readonly activePeers = new Map<string, PlainPeerChannel>()
  private keypair: Ed25519Keypair | null = null
  private conversation!: Conversation
  private mirror = new DurableTranscriptMirror()
  private busy = false
  private port!: DurableSessionPort
  private control!: DurableSessionControl
  private events: ConversationViewSource | null = null
  private rpcEnvelope: { dispose(): void } | null = null
  private myRoomId: string | null = null
  private sessionStartedAt = Date.now()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private stopped = false
  private pairingRotationActive = false
  private pairingRotationTimer: ReturnType<typeof setTimeout> | null = null
  /** The last minted rotating invite (null when paired/not rotating) —
   *  surfaced via currentPairingInvite() for host-side web pages. */
  private lastPairingInvite: string | null = null

  /** The served session's display name: the newest rename recorded in the
   *  conversation, else the host's displayName. */
  private sessionName: string
  private agentConfig: DurableAgentConfig | null = null

  constructor(private readonly opts: DurableBridgeOptions) {
    this.sessionName = opts.displayName
  }

  /** The currently served conversation (stable id across restarts). */
  get currentConversation(): Conversation {
    return this.conversation
  }

  /** Live busy flag (run in flight) — the port's `streaming`. */
  get isBusy(): boolean {
    return this.busy
  }

  /** Attach to a conversation: port + control + watch + event fanout. */
  async attach(conversation: Conversation): Promise<void> {
    this.conversation = conversation
    if (this.opts.models !== undefined) {
      try {
        const set = await ensureThinkingLevel(
          conversation,
          this.opts.models,
          this.opts.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
          this.opts.context,
        )
        if (set !== undefined) this.opts.log(`thinking level: ${set}`)
      } catch (err: unknown) {
        this.opts.log(
          `thinking level not set: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        )
      }
    }
    this.mirror = new DurableTranscriptMirror()
    this.port = this.buildPort(conversation)
    this.control = this.buildControl()

    await this.events?.stop()
    // The conversation view is the event + transcript source of truth: its
    // first value (and the history before its window) seeds the mirror,
    // the get_entries surface.
    this.events = new ConversationViewSource({
      conversation,
      context: this.opts.context,
      mirror: this.mirror,
      onBusyChange: (busy) => {
        this.busy = busy
      },
      onRunFailure: (failure) => this.recordRunFailure(failure),
      onEnd: (end) => {
        this.opts.log(`conversation watch ended: ${end.kind}`, "warning")
      },
    })
    await this.events.open()
    this.sessionName = recordedSessionName(this.mirror) ?? this.opts.displayName
    this.agentConfig =
      this.opts.models !== undefined
        ? new DurableAgentConfig({
            conversation: () => this.conversation,
            harness: this.opts.harness,
            models: this.opts.models,
            context: this.opts.context,
            inbox: () => this.events?.inbox,
            rename: (name) => this.renameSession(name),
          })
        : null
    this.events.start()
    this.rpcEnvelope?.dispose()
    this.rpcEnvelope = createRpcEnvelope(this.events, (env) =>
      this.broadcast(env),
    )
    // The conversation's session clock: a fresh attach (first start or a
    // retarget to a NEW conversation) restamps; a restart re-attaching the
    // SAME stable conversation keeps its id but the clock is per-process.
    this.sessionStartedAt = Date.now()
  }

  /** Connect the relay + announce this conversation's room. */
  async start(): Promise<void> {
    this.stopped = false
    this.keypair = this.keypair ?? (await getOrCreateEd25519Keypair())
    await this.connectRelay()
  }

  /** Full teardown (host shutdown / retarget). */
  async stop(): Promise<void> {
    this.stopped = true
    this.stopPairingRotation()
    qrSession.clear()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rpcEnvelope?.dispose()
    this.rpcEnvelope = null
    await this.events?.stop()
    this.events = null
    for (const channel of this.activePeers.values()) {
      try {
        channel.detach()
      } catch {
        /* best-effort */
      }
    }
    this.activePeers.clear()
    this.relay?.close()
    this.relay = null
    this.myRoomId = null
  }

  /**
   * Session replacement WITHOUT replacement machinery: flush a
   * session_shutdown to the old room, stop everything, attach to the new
   * conversation, reconnect under its room. The app drops the old
   * conversation on the new hello (changed sessionId), exactly as it does
   * for pi.
   */
  async retarget(conversation: Conversation): Promise<void> {
    if (this.activePeers.size > 0) {
      try {
        await this.broadcastFlushed({ rpc: { type: "session_shutdown" } })
      } catch {
        /* best-effort — the room dies with the disconnect anyway */
      }
    }
    const relay = this.relay
    this.relay = null
    relay?.close()
    for (const channel of this.activePeers.values()) {
      try {
        channel.detach()
      } catch {
        /* best-effort */
      }
    }
    this.activePeers.clear()
    await this.attach(conversation)
    if (!this.stopped) await this.connectRelay()
  }

  // ── internals ────────────────────────────────────────────────────────────

  private buildPort(conversation: Conversation): DurableSessionPort {
    return new DurableSessionPort({
      conversation,
      context: this.opts.context,
      mirror: this.mirror,
      cwd: this.opts.cwd,
      busy: () => this.busy,
      appendAppEntry: (entry) => {
        // Custom entries are committed best-effort; a failed commit logs,
        // never throws into the caller (the port contract).
        void this.conversation
          .commit(
            (tx) =>
              tx.appendEntry(UnBienAppEntry, this.conversation.id, {
                data: {
                  customType: entry.customType,
                  content: entry.content,
                  ...(entry.display !== undefined
                    ? { display: entry.display }
                    : {}),
                  ...(entry.details !== undefined
                    ? // SAFETY: the port types details `unknown` to stay
                      // harness-neutral; mesh/relay details payloads are JSON
                      // trees by wire contract.
                      { details: entry.details as JsonValue }
                    : {}),
                },
              }),
            this.opts.context,
          )
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err)
            this.opts.log(`custom entry commit failed: ${detail}`, "warning")
          })
      },
      log: (message, level) => this.opts.log(message, level),
      subscribe: (handler) => this.events?.onAny(handler) ?? (() => undefined),
    })
  }

  private buildControl(): DurableSessionControl {
    return new DurableSessionControl({
      createConversation: (context) =>
        this.opts.harness.createConversation(
          { ownership: { kind: "ownerless" } },
          context,
        ),
      retarget: (conversation) => this.retarget(conversation),
      current: () => this.conversation,
      context: this.opts.context,
      shutdownHost: this.opts.shutdownHost,
    })
  }

  private async connectRelay(): Promise<void> {
    if (!this.keypair) return
    const roomId = roomIdForSession(String(this.conversation.id))
    const relay = (this.opts.createRelay ?? defaultCreateRelay)(
      toWebSocketUrl(this.opts.relayUrl),
      this.keypair,
    )
    try {
      await relay.connect({
        roomId,
        roomMeta: {
          name: this.sessionName,
          cwd: this.opts.cwd,
          sessionId: String(this.conversation.id),
          caps: sessionCapabilities(),
        },
      })
    } catch (err) {
      relay.close()
      this.scheduleReconnect()
      const detail = err instanceof Error ? err.message : String(err)
      this.opts.log(`relay connect failed: ${detail}`, "error")
      return
    }
    this.reconnectAttempt = 0
    this.relay = relay
    this.myRoomId = roomId
    relay.on("close", () => {
      if (this.relay !== relay || this.stopped) return
      this.relay = null
      this.scheduleReconnect()
    })
    this.pushPairingAllowList(relay)
    this.installAutoListener(relay)
    this.armPairingRotation()
    this.opts.log(
      `[un-bien-durable] relay connected — room ${roomId} (conversation ${String(this.conversation.id)})`,
      "info",
    )
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer !== null) return
    const delay =
      RECONNECT_BACKOFFS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1)
      ]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // Fire-and-forget (a timer callback can't await): connectRelay's own
      // try covers relay.connect(), this catch covers anything else thrown
      // on the path (the relay factory, room-id derivation) — escaping as an
      // unhandled rejection would take the host down.
      void this.connectRelay().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        this.opts.log(`relay reconnect failed: ${detail}`, "error")
      })
    }, delay)
  }

  /** Fail-closed signed allow-list push (the relay refuses rooms whose
   *  owners are not listed). Same single-signer path as the pi extension. */
  private pushPairingAllowList(relay: RelayClient): void {
    const kp = this.keypair
    if (!kp) return
    void Promise.all([listPeers(), nextAllowListVersion()])
      .then(([peers, version]) => {
        const owners = pairingAllowList(peers)
        const { blob, sig } = buildSignedAllowList(kp, owners, version)
        relay.sendControl({ type: "pairing_set", blob, sig })
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        this.opts.log(`pairing_set push failed: ${detail}`, "warning")
      })
  }

  /**
   * The auto-listener: pair_request from new devices, reconnect attach for
   * known peers, unknown-peer refusal. The durable port of the pi
   * extension's listener — no listener-authority generations (a stopped
   * bridge is `this.relay !== relay`, checked directly).
   */
  private installAutoListener(relay: RelayClient): void {
    const onMsg = async (line: string): Promise<void> => {
      let outer: { peer?: string; ct?: string }
      try {
        outer = JSON.parse(line) as { peer?: string; ct?: string }
      } catch {
        return
      }
      if (!outer.peer || !outer.ct) return
      if (this.relay !== relay) return
      const appPeerId = outer.peer

      let inner: ClientMessage
      try {
        const plaintext = Buffer.from(outer.ct, "base64").toString("utf8")
        const parsed = JSON.parse(plaintext) as unknown
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof (parsed as Record<string, unknown>).type !== "string"
        )
          return
        inner = parsed as ClientMessage
      } catch {
        return
      }

      if (inner.type === "pair_request") {
        await this.handlePairRequest(relay, appPeerId, inner)
        return
      }
      if (this.activePeers.has(appPeerId)) return

      const known = await _findKnownPeer(appPeerId)
      if (this.relay !== relay) return
      if (known) {
        const channel = this.attachOwner(relay, appPeerId, known.name)
        // The channel listener missed the line that triggered the attach —
        // route it explicitly, mirroring the channel's own dispatch.
        const innerObj = inner as Record<string, unknown>
        if (isEnvelopeFrame(innerObj)) {
          // SAFETY: isEnvelopeFrame confirmed rpc/evt/ub envelope keys are
          // present, so this ClientMessage is byte-compatible with
          // EnvelopeMessage.
          const innerEnv = inner as unknown as EnvelopeMessage
          if (innerEnv.ub === undefined) this.routeRpc(channel, innerEnv)
          else void this.routeUnBienPlane(channel, innerEnv)
        } else {
          this.routeStock(channel, inner)
        }
        return
      }

      this.sendInner(relay, appPeerId, {
        type: "error",
        code: "unknown_peer",
        message: "Peer not paired — re-scan QR",
      })
    }
    relay.on("message", onMsg)
  }

  private async handlePairRequest(
    relay: RelayClient,
    appPeerId: string,
    inner: Extract<ClientMessage, { type: "pair_request" }>,
  ): Promise<void> {
    const sendError = (code: PairErrorCode, message: string) =>
      this.sendInner(relay, appPeerId, {
        type: "pair_error",
        in_reply_to: inner.id,
        code,
        message,
      })

    const known = await _findKnownPeer(appPeerId)
    if (known) {
      // Idempotent re-confirm for an already-trusted owner (design
      // 01M20G8SE): pair_ok without consuming a token.
      const roomId = this.myRoomId
      if (!roomId) {
        sendError(
          "internal_error",
          "No session room yet — retry pairing once this host has started.",
        )
        return
      }
      if (!this.activePeers.has(appPeerId))
        this.attachOwner(relay, appPeerId, known.name)
      this.emitPairOk(relay, appPeerId, inner, roomId)
      return
    }

    const status = qrSession.consumeToken(inner.token)
    if (status !== "ok") {
      const code: PairErrorCode =
        status === "expired"
          ? "token_expired"
          : status === "consumed"
            ? "token_consumed"
            : "token_unknown"
      sendError(
        code,
        code === "token_expired"
          ? "Ephemeral token expired. Generate a new QR from a paired session."
          : code === "token_consumed"
            ? "Token already consumed by another pair_request."
            : "Token was not issued by this host.",
      )
      return
    }

    const roomId = this.myRoomId
    if (!roomId) {
      sendError(
        "internal_error",
        "No session room yet — retry pairing once this host has started.",
      )
      return
    }
    try {
      await addPeer({
        name: inner.device_name,
        remote_epk: appPeerId,
        paired_at: new Date().toISOString(),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      sendError("internal_error", `Failed to persist pairing: ${detail}`)
      return
    }
    if (this.relay !== relay) return
    this.stopPairingRotation()
    this.opts.log(
      `[un-bien-durable] paired with ${inner.device_name} — pairing QR rotation stopped`,
      "info",
    )
    this.pushPairingAllowList(relay)
    if (!this.activePeers.has(appPeerId))
      this.attachOwner(relay, appPeerId, inner.device_name)
    this.emitPairOk(relay, appPeerId, inner, roomId)
  }

  // ── Pairing QR rotation ─────────────────────────────────────────────────────

  /**
   * The startup pairing invite: while the machine has no paired peers, the
   * bridge ITSELF mints the rotating QR on the same qrSession the
   * pair_request handler consumes from — one process issues AND validates
   * the token, so a scan can never hit "token was not issued by this host"
   * (the failure mode of minting in a separate CLI process). Armed on every
   * successful relay connect (startup + reconnects); the first tick reads
   * peers.json and retires silently when a peer already exists, so a
   * revoked-then-restarted host re-arms on its next start().
   */
  private armPairingRotation(): void {
    if (this.pairingRotationActive || this.stopped) return
    // Suppressed by the host (--no-pairing-qr / UNBIEN_NO_PAIRING_QR): the
    // auto-minted invite mints with no user gesture, which headless hosts
    // don't want — pairing happens via the un-bien CLI instead.
    if (this.opts.pairingQr === false) return
    this.pairingRotationActive = true
    this.tickPairingRotation()
  }

  /** Fire-and-forget one rotation step: a rejection (listPeers on a wedged
   *  broker socket, …) logs + retires the rotation instead of escaping as
   *  an unhandled rejection — the rotation re-arms on the next successful
   *  relay connect. */
  private tickPairingRotation(): void {
    void this.rotatePairingQR().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      this.opts.log(`pairing QR rotation failed: ${detail}`, "warning")
      this.stopPairingRotation()
    })
  }

  /** One rotation step: retire when peers exist, otherwise mint + log a
   *  fresh invite and schedule the next tick. */
  private async rotatePairingQR(): Promise<void> {
    if (this.stopped || !this.pairingRotationActive) return
    // A peer landing in peers.json by any path (this bridge's handshake, a
    // CLI pair-token --wait, a copied file) retires the invite.
    if ((await listPeers()).length > 0) {
      this.stopPairingRotation()
      return
    }
    const kp = this.keypair
    if (!kp) {
      this.stopPairingRotation()
      return
    }
    // The QR's rm/n must match what emitPairOk answers with: this
    // conversation's room and the configured display name. Re-derived per
    // tick so a retarget mid-rotation re-keys the invite to the new room.
    const roomId = roomIdForSession(String(this.conversation.id))
    const { token, expiresAt } = qrSession.issueToken()
    const uri = buildQRUri(token, kp.publicKey, this.opts.displayName, roomId)
    // Surfaced to host-side web pages (GET /pair) via currentPairingInvite().
    this.lastPairingInvite = uri
    this.opts.log(
      `[un-bien-durable] machine unpaired — scan this QR with the un-bien app:\n\n` +
        `${renderQRAscii(uri)}\n` +
        `Or paste this URI into the app's pair flow:\n\n${uri}\n\n` +
        `The invite renews at ${new Date(expiresAt).toLocaleTimeString()} — rotation continues until a device pairs.`,
      "info",
    )
    this.pairingRotationTimer = setTimeout(() => {
      this.pairingRotationTimer = null
      this.tickPairingRotation()
    }, this.opts.pairingRotationMs ?? TOKEN_TTL_MS)
  }

  /** Cancel the rotation (a peer paired / teardown). No qrSession.clear()
   *  here: the outstanding token either was just consumed by the pairing
   *  handshake or dies with the process — consumption is same-process by
   *  design. */
  private stopPairingRotation(): void {
    this.pairingRotationActive = false
    this.lastPairingInvite = null
    if (this.pairingRotationTimer !== null) {
      clearTimeout(this.pairingRotationTimer)
      this.pairingRotationTimer = null
    }
  }

  /** The CURRENT pairing invite as a deep-link URI — what a /pair web page
   *  renders as a tappable link. null when not rotating (paired already, or
   *  rotation stopped). Updated on every rotation tick. */
  currentPairingInvite(): string | null {
    return this.pairingRotationActive ? (this.lastPairingInvite ?? null) : null
  }

  /** Ask attached app peers to authorize: ONE live toast
   *  (extension_ui_request notify) is the visible channel. An authorize
   *  pending expires in minutes, so nothing replays it; a late peer gets a
   *  fresh mint when the model calls the tool again. The request is also
   *  recorded as a hidden app entry (customType "un-bien:auth-required",
   *  display:false), kept for the record and out of model context.
   *
   *  `message` is the elicit text and names the real upstream server;
   *  `server` is the caller's label (the combiner bridge, say), kept in
   *  details. `url` is appended unless the message already carries it, and
   *  may be empty for a prompt with nothing to open. */
  async sendAuthorizeCard(
    server: string,
    url: string,
    message: string,
  ): Promise<void> {
    const content =
      url !== "" && !message.includes(url) ? `${message}\n\n${url}` : message
    await this.conversation
      .commit(
        (tx) =>
          tx.appendEntry(UnBienAppEntry, this.conversation.id, {
            data: {
              customType: "un-bien:auth-required",
              content,
              display: false,
              details: { server, url, message, kind: "authorize" },
            },
          }),
        this.opts.context,
      )
      .catch((err: unknown) => {
        this.opts.log(
          `authorize card commit failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        )
      })
    await this.broadcastFlushed({
      rpc: {
        type: "extension_ui_request",
        id: `auth-${Date.now()}`,
        method: "notify",
        message: content,
        notify_type: "warning",
      },
    })
  }

  /** Rename the served session: record it in the conversation (a hidden app
   *  entry, read back at attach), then confirm it live as pi does — the
   *  session_info evt to attached apps and room_meta_update so the relay
   *  pushes the name to room subscribers. */
  private async renameSession(name: string): Promise<void> {
    await this.conversation.commit(
      (tx) =>
        tx.appendEntry(UnBienAppEntry, this.conversation.id, {
          data: { customType: SESSION_NAME_CUSTOM_TYPE, content: name, display: false },
        }),
      this.opts.context,
    )
    this.sessionName = name
    this.broadcast({ evt: { channel: "session_info", data: { name } } })
    if (this.relay && this.myRoomId) {
      this.relay.sendControl({
        type: "room_meta_update",
        room_id: this.myRoomId,
        meta: { name },
      })
    }
  }

  /** Record a run that ended without an answer as a display app entry, so
   *  the app shows why (live, and on replay). `nothing_to_answer` (a
   *  continue with nothing pending) is not a failure anyone needs to see. */
  private recordRunFailure(failure: RunFailure): void {
    if (failure.reason === "nothing_to_answer") return
    const why = RUN_FAILURE_TEXT[failure.reason] ?? failure.reason
    const content =
      failure.detail !== undefined ? `${why}: ${failure.detail}` : why
    void this.conversation
      .commit(
        (tx) =>
          tx.appendEntry(UnBienAppEntry, this.conversation.id, {
            data: {
              customType: RUN_FAILURE_CUSTOM_TYPE,
              content,
              display: true,
              details: {
                reason: failure.reason,
                ...(failure.detail !== undefined
                  ? { detail: failure.detail }
                  : {}),
              },
            },
          }),
        this.opts.context,
      )
      .catch((err: unknown) => {
        this.opts.log(
          `run failure entry commit failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        )
      })
  }

  /** Mint a FRESH pairing invite on demand — for host-side pairing pages
   *  (/pair) so a SECOND device can be added after the rotation retired, or
   *  an operator can open pairing mode without a restart. One process mints
   *  + consumes (this bridge), so the token race is structurally excluded.
   *  Multi-device safe: adding a peer appends to peers.json; the page's
   *  caller gates availability (enable/disable toggle). */
  forcePairingInvite(): string | null {
    const kp = this.keypair
    if (!kp || this.stopped) return null
    const roomId = roomIdForSession(String(this.conversation.id))
    const { token } = qrSession.issueToken()
    const uri = buildQRUri(token, kp.publicKey, this.opts.displayName, roomId)
    this.lastPairingInvite = uri
    return uri
  }

  private emitPairOk(
    relay: RelayClient,
    appPeerId: string,
    inner: Extract<ClientMessage, { type: "pair_request" }>,
    roomId: string,
  ): void {
    this.sendInner(relay, appPeerId, {
      type: "pair_ok",
      in_reply_to: inner.id,
      session_name: this.sessionName,
      session_started_at: this.sessionStartedAt,
      room_id: roomId,
      harness: { name: "pi-durable host", version: "0.1.0" },
      hostname: this.opts.machineName ?? hostname(),
      protocol_version: 1,
      capabilities: sessionCapabilities(),
    })
  }

  /** un-plane error reply, correlated to the request id when present.
   *  Same best-effort wire as sendEnvelope — a relay hiccup mid-reply must
   *  not throw into the fire-and-forget ub dispatch. */
  private sendUbError(
    sender: PlainPeerChannel,
    inReplyTo: string | undefined,
    message: string,
  ): void {
    try {
      sender.sendEnvelope({
        type: "ub",
        ub: {
          type: "error",
          ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
          code: "internal_error",
          message,
        },
      })
    } catch {
      /* best-effort */
    }
  }

  private sendInner(
    relay: RelayClient,
    appPeerId: string,
    msg: ServerMessage,
  ): void {
    try {
      const ct = Buffer.from(JSON.stringify(msg)).toString("base64")
      relay.send(JSON.stringify({ peer: appPeerId, ct }))
    } catch {
      /* best-effort */
    }
  }

  /** Attach (or re-attach) an owner channel and say hello. */
  private attachOwner(
    relay: RelayClient,
    appPeerId: string,
    _peerName: string,
  ): PlainPeerChannel {
    const existing = this.activePeers.get(appPeerId)
    if (existing) {
      try {
        existing.detach()
      } catch {
        /* best-effort */
      }
      this.activePeers.delete(appPeerId)
    }
    const channel = new PlainPeerChannel(
      relay,
      appPeerId,
      this.myRoomId ?? undefined,
      (msg) => this.routeStock(channel, msg),
      () => {
        this.activePeers.delete(appPeerId)
      },
      (env) => {
        if (env.ub === undefined) this.routeRpc(channel, env)
        else void this.routeUnBienPlane(channel, env)
      },
      () => this.port.sessionId ?? undefined,
    )
    this.activePeers.set(appPeerId, channel)
    channel.sendEnvelope(
      helloEnvelope(sessionCapabilities(), this.port.sessionId ?? undefined),
    )
    return channel
  }

  // ── Inbound routing ──────────────────────────────────────────────────────

  private buildRpcDeps(): RpcHandlersDeps {
    const port = this.port
    return {
      agent: this.agentConfig,
      session: port,
      sessionControl: this.control,
      rootState: () => ({ turnId: null }),
      imageDeps: {
        session: port,
        rootState: () => ({ turnId: null }),
        myRoomMeta: null,
        wakeAgent: (content, _label, deliverAs) =>
          port.submit(content, { deliverAs }),
      },
      wakeAgent: (content, _label, deliverAs) =>
        port.submit(content, { deliverAs }),
      abortCurrentTurn: () => port.abort(),
    }
  }

  /** Envelope-carried pi rpc command dispatch (the shared handlers). */
  private routeRpc(sender: PlainPeerChannel, env: EnvelopeMessage): void {
    const frame = env.rpc
    if (!frame || typeof frame !== "object") return
    const handlers = createRpcHandlers(this.buildRpcDeps(), sender)
    void dispatchRpcCommand(frame as Record<string, unknown>, handlers)
      .then((resp) => {
        if (resp) sender.sendEnvelope(resp)
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        this.opts.log(`rpc inbound dispatch failed: ${detail}`, "warning")
      })
  }

  /** un-bien plane: session_sync (minimal ack) + session_fork/
 *  session_navigate + terminate. */
  private async routeUnBienPlane(
    sender: PlainPeerChannel,
    env: EnvelopeMessage,
  ): Promise<void> {
    const frame = env.ub
    if (!frame || typeof frame !== "object") return
    const type = (frame as Record<string, unknown>).type
    if (type === "session_sync") {
      const f = frame as Record<string, unknown>
      // The durable host has no panel/ask surfaces; the transcript arrives
      // through get_entries. Answer with the terminator so the app's open +
      // reconnect cycle completes.
      sender.sendEnvelope({
        ub: {
          type: "session_sync_end",
          ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
          session_started_at: this.sessionStartedAt,
          session_name: this.sessionName,
        },
      } as EnvelopeMessage)
      return
    }
    if (type === "session_fork" || type === "session_navigate") {
      // app->host: fork a NEW conversation / branch in place from a transcript
      // entry. The durable analog of the pi extension's routing.ts handlers:
      // the DurableSessionControl implements both verbs directly (no command
      // ctx to self-dispatch through — durable tools ARE the surface).
      const f = frame as Record<string, unknown>
      const entryId = typeof f.entry_id === "string" ? f.entry_id : ""
      const reqId = typeof f.id === "string" ? f.id : undefined
      const replyError = (message: string): void => {
        this.sendUbError(sender, reqId, message)
      }
      if (!entryId) {
        this.opts.log(
          `${String(type)}(ub): missing entry_id — ignored`,
          "warning",
        )
        replyError("session_fork/session_navigate requires an entry_id")
        return
      }
      const control = this.control
      if (!control) {
        // No conversation attached (the bridge never attach()ed) — the app
        // must learn the verb didn't land instead of waiting for a tile that
        // never appears.
        const message = `No conversation attached — ${String(type)} unavailable`
        this.opts.log(`${String(type)}(ub): ${message}`, "warning")
        replyError(message)
        return
      }
      if (type === "session_fork") {
        const position =
          f.position === "at" || f.position === "before" ? f.position : undefined
        try {
          // The request id threads through so the retargeted bridge's first
          // session_sync can echo forked_from_req (the app's auto-nav).
          await control.fork(entryId, {
            ...(position ? { position } : {}),
            ...(reqId ? { requestId: reqId } : {}),
          })
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          this.opts.log(`session_fork(ub) error: ${detail}`, "warning")
          replyError(`session_fork failed: ${detail}`)
        }
        return
      }
      try {
        await control.navigateTree(entryId)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        this.opts.log(`session_navigate(ub) error: ${detail}`, "warning")
        replyError(`session_navigate failed: ${detail}`)
      }
      return
    }
    if (type === "terminate") {
      // DELIBERATE ASYMMETRY vs the pi binding, documented here: on pi,
      // terminate kills ONE session — a TUI the user may be locally typing
      // into — so the gate is a per-session concern with a per-session
      // config file. The durable host is a headless box with exactly ONE
      // conversation and no local UI — the app IS the UI, so remote
      // terminate is the machine's off switch and is served by design
      // (shutdownHost: bridge stop → mesh leave → harness close → exit).
      // What is NOT asymmetric: the advertised capability and the honored
      // behavior must read the same config — sessionCapabilities() already
      // gates the `remote_terminate` cap on this same check, so a host that
      // advertises the cap honors it, and a host that opted out never shows
      // the red trash in the first place. Same check, same layering
      // (UNBIEN_DIRECT_CONFIG env wins, then the cwd's config.json, then the
      // global defaults) — the headless box pins it via env.
      if (
        !effectiveAllowRemoteTerminate(loadLocalConfig(process.cwd()))
      ) {
        this.opts.log(
          "terminate(ub): remote terminate disabled on this machine — refused",
          "warning",
        )
        return
      }
      this.opts.log("terminate(ub): graceful host shutdown requested", "warning")
      // routeUnBienPlane runs fire-and-forget from the channel loop — a
      // failed shutdown must log here, not escape as an unhandled rejection.
      try {
        await this.opts.shutdownHost()
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        this.opts.log(`terminate(ub) shutdown failed: ${detail}`, "error")
      }
      return
    }
  }

  /** Stock ClientMessage switch: ping/pong + cancel. */
  private routeStock(sender: PlainPeerChannel, msg: ClientMessage): void {
    if (msg.type === "ping") {
      sender.send({ type: "pong", in_reply_to: msg.id })
      return
    }
    if (msg.type === "cancel") {
      try {
        const aborted = this.port.abort()
        if (!aborted) {
          sender.send({
            type: "error",
            code: "internal_error",
            in_reply_to: msg.id,
            message: "No active run to abort",
          })
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        sender.send({
          type: "error",
          code: "internal_error",
          in_reply_to: msg.id,
          message: `Abort failed: ${detail}`,
        })
      }
      return
    }
    if (msg.type === "pair_request") return // idempotent re-confirm; handled by the listener
  }

  // ── Outbound fanout ─────────────────────────────────────────────────────

  private broadcast(env: EnvelopeMessage): void {
    for (const channel of this.activePeers.values()) {
      try {
        channel.sendEnvelope(env)
      } catch {
        /* best-effort per channel */
      }
    }
  }

  private async broadcastFlushed(
    env: EnvelopeMessage,
    timeoutMs = 1_000,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(
          [...this.activePeers.values()].map((ch) => ch.sendEnvelopeFlushed(env)),
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

// The production relay factory (tests inject their own via opts.createRelay).
function defaultCreateRelay(
  wsUrl: string,
  keypair: Ed25519Keypair,
): RelayClient {
  return new RelayClient(wsUrl, keypair)
}
