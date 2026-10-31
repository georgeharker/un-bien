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
 *   - live frames come from WatchEventsSource → createRpcEnvelope — the
 *     SAME producer the pi binding uses, over the SAME event shapes;
 *   - inbound rpc commands dispatch through the shared rpc_inbound/
 *     rpc_handlers pair (createRpcHandlers over the durable port); the
 *     model-registry/slash verbs answer errors (pi-only members are null);
 *   - the un plane answers session_sync / terminate.
 */
import { hostname } from "node:os"
import type { Context, JsonValue } from "@earendil-works/chord"
import type { Conversation, Harness } from "@earendil-works/pi-durable"
import { defineEntry as defineEntryFn, watchEvents } from "@earendil-works/pi-durable"
import {
  createRpcEnvelope,
  helloEnvelope,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "@geohar/un-bien/dist/session/rpc_envelope.js"
import {
  dispatchRpcCommand,
} from "@geohar/un-bien/dist/session/rpc_inbound.js"
import {
  createRpcHandlers,
  type RpcHandlersDeps,
} from "@geohar/un-bien/dist/session/rpc_handlers.js"
import { sessionCapabilities } from "@geohar/un-bien/dist/session/capabilities.js"
import { roomIdForSession } from "@geohar/un-bien/dist/rooms.js"
import { toWebSocketUrl } from "@geohar/un-bien/dist/config.js"
import { RelayClient } from "@geohar/un-bien/dist/transport/relay_client.js"
import {
  PlainPeerChannel,
} from "@geohar/un-bien/dist/transport/peer_channel.js"
import { _findKnownPeer } from "@geohar/un-bien/dist/pairing/peer_trust.js"
import { qrSession } from "@geohar/un-bien/dist/pairing/qr.js"
import {
  addPeer,
  getOrCreateEd25519Keypair,
  listPeers,
  nextAllowListVersion,
  pairingAllowList,
} from "@geohar/un-bien/dist/pairing/storage.js"
import { buildSignedAllowList } from "@geohar/un-bien/dist/pairing/signed_allow_list.js"
import type {
  ClientMessage,
  PairErrorCode,
  ServerMessage,
} from "@geohar/un-bien/dist/protocol/types.js"
import type { Ed25519Keypair } from "@geohar/un-bien/dist/pairing/crypto.js"
import type { NotifyLevel } from "@geohar/un-bien/core"
import {
  DurableSessionControl,
  DurableSessionPort,
  DurableTranscriptMirror,
} from "./port.js"
import { WatchEventsSource } from "./event_source.js"

/** App-defined entry kind carrying un-bien custom entries (data-only
 *  sidecars: display text + details payload). */
const UnBienAppEntry = defineEntryFn<{
  customType: string
  content: string
  display?: boolean
  details?: JsonValue
}>("un-bien.app")

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
  private events: WatchEventsSource | null = null
  private rpcEnvelope: { dispose(): void } | null = null
  private myRoomId: string | null = null
  private sessionStartedAt = Date.now()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private stopped = false

  constructor(private readonly opts: DurableBridgeOptions) {}

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
    this.mirror = new DurableTranscriptMirror()
    this.port = this.buildPort(conversation)
    this.control = this.buildControl()

    this.events?.stop()
    // The watch() stream is the event + transcript source of truth; its
    // snapshot seeds the mirror (the get_entries surface).
    const stream = await watchEventsShim(
      this.opts.harness,
      conversation.id,
      this.opts.context,
    )
    this.events = new WatchEventsSource(stream, {
      mirror: this.mirror,
      onBusyChange: (busy) => {
        this.busy = busy
      },
    })
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
    const relay = new RelayClient(
      toWebSocketUrl(this.opts.relayUrl),
      this.keypair,
    )
    try {
      await relay.connect({
        roomId,
        roomMeta: {
          name: this.opts.displayName,
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
      void this.connectRelay()
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
    this.pushPairingAllowList(relay)
    if (!this.activePeers.has(appPeerId))
      this.attachOwner(relay, appPeerId, inner.device_name)
    this.emitPairOk(relay, appPeerId, inner, roomId)
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
      session_name: this.opts.displayName,
      session_started_at: this.sessionStartedAt,
      room_id: roomId,
      harness: { name: "pi-durable host", version: "0.1.0" },
      hostname: this.opts.machineName ?? hostname(),
      protocol_version: 1,
      capabilities: sessionCapabilities(),
    })
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
      pi: null, // pi-only verbs (model registry, slash registry) answer errors
      session: port,
      sessionControl: this.control,
      rootState: () => ({ turnId: null }),
      lastEventCtx: null,
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

  /** un-bien plane: session_sync (minimal ack) + terminate. */
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
          session_name: this.opts.displayName,
        },
      } as EnvelopeMessage)
      return
    }
    if (type === "terminate") {
      this.opts.log("terminate(ub): graceful host shutdown requested", "warning")
      await this.opts.shutdownHost()
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

// The watchEvents stream is THE durable event plane; the bridge is its
// only consumer (one stream per served conversation).
function watchEventsShim(
  harness: Harness,
  conversationId: Parameters<typeof watchEvents>[1],
  context: Context,
) {
  return watchEvents(harness, conversationId, context)
}