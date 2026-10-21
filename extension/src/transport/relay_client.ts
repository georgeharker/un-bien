import { EventEmitter } from "node:events"
import WebSocket from "ws"
import { ed25519Sign, ed25519Verify } from "../pairing/crypto.js"
import type { Ed25519Keypair } from "../pairing/crypto.js"
import type { ThinkingLevel } from "../protocol/types.js"
import { envLog } from "../session/debug_log.js"

const AUTH_TIMEOUT_MS = 5_000

/** Inbound frame cap for the `ws` socket — PINNED, not the lib's 100 MiB
 *  default: aligned with the relay's WS message limit (64 MiB). The largest
 *  LEGAL frame is a max-ct envelope ≈ 5.4 MiB, so this is pure headroom that
 *  can't drift with a `ws` upgrade. */
const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024

/**
 * Liveness watchdog. The relay sends a WS Ping every ~25s (relay `peer.rs`),
 * so a healthy connection sees inbound frames at least that often. If NOTHING
 * arrives for this long the socket is silently dead — NAT/router idle drop,
 * laptop sleep, or the relay/Cloudflare reaping the connection WITHOUT a clean
 * close frame. That half-open case never fires `close`, so reconnect never
 * triggers and a background daemon sits "online" but dead after a few idle
 * hours. We force-close on timeout so `close` drives the caller's reconnect.
 */
const LIVENESS_TIMEOUT_MS = 70_000 // ~2.8 missed relay pings → confidently dead
const LIVENESS_CHECK_MS = 20_000

/** Relay control messages (sent/received during auth). */
interface HelloMsg {
  type: "hello"
  pubkey: string
  room_id?: string
  room_meta?: RoomMeta
}
interface ChallengeMsg {
  type: "challenge"
  nonce: string
}
interface AuthMsg {
  type: "auth"
  sig: string
}

export interface RoomMeta {
  name: string
  cwd: string
  /** Friendly model name (e.g. "claude-sonnet-4.5"). Optional — pi-ext sends
   *  when `ExtensionContext.model` is available; relay/app tolerate absence. */
  model?: string
  /** Parent room id, when this room is a SUBAGENT child session:
   *  the roomId of the spawning (root) session. Absent for normal top-level
   *  sessions. Lets the app NEST the child under its parent in the home list
   *  from `room_announced` alone, without attaching. */
  parent?: string
  /** Subagent record id, when this room is a subagent child session. Lets a
   *  consumer map a subagents-panel row to this room. Rides the relay's
   *  room_meta passthrough alongside `parent`. */
  subagentId?: string
  /** This room's OWN pi sessionId, and its PARENT's pi sessionId when it is a
   *  subagent child. Pi ids (NOT roomIds) — the app nests + maps panel rows by
   *  these, at list time, from room_announced. roomId stays relay-routing only. */
  sessionId?: string
  parentSessionId?: string
  /** Caps the room advertises about itself; the launcher daemon stamps
   *  `is_daemon` so the app filters its control room. */
  caps?: string[]
  /** Launch-correlation echo (resume flow): when pi was spawned REMOTELY
   *  (`session_launch`), the launcher daemon passed `UNBIEN_LAUNCH_REQ=<id>`
   *  and the extension echoes it here. The relay flattens room_meta verbatim
   *  into `room_announced`, so the launching app can deterministically match
   *  the announcing room to its request and auto-open the chat. Absent for
   *  locally-started sessions. */
  launchReq?: string
}

/** Control frame sent to relay (not routed to app peer). Each publish carries
 *  ONE changed field (model / working / thinking); the relay merges them into
 *  the room's meta and fans a `room_meta_updated` to the app. */
export interface RoomMetaUpdateFrame {
  type: "room_meta_update"
  room_id: string
  meta: {
    model?: string
    working?: boolean
    thinking?: ThinkingLevel
    // Session display name (a live /name rename). Relay >=0.6.0 merges + fans
    // it to room subscribers; older relays drop the unknown field.
    name?: string
    // Subagent parentage re-advertised after the child attaches (set-once on
    // the relay — never overrides an already-set parent).
    parent?: string
    parentSessionId?: string
  }
}

/** Control frame pushing this machine's ROOMS-gate allow-list to the relay
 *  (design 01M1ZE43): the set of Owner epks (relay `peer_id` encoding) permitted
 *  to list this machine's rooms. Full-set replace on connect + every change. */
export interface PairingSetFrame {
  type: "pairing_set"
  // Machine-signed allow-list envelope (design 01M23MKVG): base64 canonical-JSON
  // blob {machine_pk, owners, version, issued_at} + base64 Ed25519 sig. The
  // relay verifies the exact blob bytes and forges neither plane. Mirrors
  // MeshEnvelopeWire.
  blob: string
  sig: string
}

export interface ConnectOptions {
  roomId?: string
  roomMeta?: RoomMeta
}

/** Relay rejected hello because another peer already holds (pubkey, room_id). */
export class RoomAlreadyOpenError extends Error {
  constructor(public readonly roomId: string | undefined) {
    super(
      roomId
        ? `relay rejected hello: room ${roomId} already open for this peer`
        : "relay rejected hello: peer already connected",
    )
    this.name = "RoomAlreadyOpenError"
  }
}

export interface RelayClientEvents {
  /** A single JSONL line delivered by the relay (outer envelope). */
  message: [line: string]
  close: []
  error: [err: Error]
}

/**
 * Thin WebSocket client for the Remote Pi relay.
 *
 * Lifecycle:
 *   const relay = new RelayClient(url, ed25519Keypair)
 *   await relay.connect()          // opens WS + runs Ed25519 challenge-response
 *   relay.on("message", line => …) // outer envelopes: { peer, ct }
 *   relay.send(jsonLine)           // write to relay
 *   relay.close()
 *
 * Auth sequence (pairing.md §Challenge-response):
 *   → { type:"hello",     pubkey: "<Ed25519 pubkey base64>" }
 *   ← { type:"challenge", nonce:  "<32 bytes base64>" }
 *   → { type:"auth",      sig:    "<Ed25519 sig base64>" }
 */
/** Result of checking an `identity_ack` frame (P7 device-pairing pin).
 *  The signature is over `nonce|relay_pubkey|relay_name|relay_url` where the
 *  nonce is THIS connection's challenge — replaying an ack from another
 *  connection fails here. `endpoints` (P6) are unsigned reachability
 *  metadata the trust decision never depends on: dialing a spoofed endpoint
 *  simply fails the pin, so they may ride outside the signature. */
export type RelayIdentityCheck =
  | {
      ok: true
      relayPubkey: string
      relayName: string
      relayUrl: string
      endpoints: string[]
    }
  | { ok: false; reason: "bad_sig" | "wrong_nonce" | "pin_mismatch" | "malformed" }

export interface RelayIdentityAckFrame {
  type?: unknown
  relay_pubkey?: unknown
  relay_name?: unknown
  relay_url?: unknown
  endpoints?: unknown
  nonce?: unknown
  sig?: unknown
}

/**
 * Pure check for the relay's post-auth `identity_ack` (P7): proves the relay
 * controls `relay_pubkey` on THIS connection (nonce-bound) and that the
 * pubkey matches any pin the caller recorded (TOFU at pair time).
 */
export function verifyRelayIdentityAck(
  frame: RelayIdentityAckFrame,
  receivedNonceB64: string,
  expectedRelayPubkey?: string,
): RelayIdentityCheck {
  const relayPubkey = typeof frame.relay_pubkey === "string" ? frame.relay_pubkey : null
  const relayName = typeof frame.relay_name === "string" ? frame.relay_name : ""
  const relayUrl = typeof frame.relay_url === "string" ? frame.relay_url : ""
  const endpoints = Array.isArray(frame.endpoints)
    ? frame.endpoints.filter(
        (e): e is string => typeof e === "string" && e.length > 0,
      )
    : []
  const nonceB64 = typeof frame.nonce === "string" ? frame.nonce : null
  const sigB64 = typeof frame.sig === "string" ? frame.sig : null
  if (
    !relayPubkey ||
    !nonceB64 ||
    !sigB64 ||
    nonceB64 !== receivedNonceB64
  ) {
    // A nonce mismatch with a VALID signature is a replay across connections:
    // indistinguishable from a malformed frame at this layer — both refuse.
    return { ok: false, reason: nonceB64 === null ? "malformed" : "wrong_nonce" }
  }
  const msg = `${nonceB64}|${relayPubkey}|${relayName}|${relayUrl}`
  const pkBytes = Buffer.from(relayPubkey, "base64")
  const sigBytes = Buffer.from(sigB64, "base64")
  if (pkBytes.length !== 32 || !ed25519Verify(pkBytes, Buffer.from(msg, "utf8"), sigBytes)) {
    return { ok: false, reason: "bad_sig" }
  }
  if (
    expectedRelayPubkey !== undefined &&
    expectedRelayPubkey !== relayPubkey
  ) {
    return { ok: false, reason: "pin_mismatch" }
  }
  return { ok: true, relayPubkey, relayName, relayUrl, endpoints }
}

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null
  /** Epoch ms of the last inbound frame (message / relay ping / pong). */
  private lastActivityAt = 0
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  /** This connection's challenge nonce (P7 identity check binds to it). */
  private challengeNonceB64: string | null = null
  /** Verified identity of the relay serving this connection, once the
   *  `identity_ack` arrives (null until then = older relay or pre-auth).
   *  `endpoints` (P6) ride unsigned — reachability metadata, not trust. */
  private verifiedIdentity: {
    relayPubkey: string
    relayName: string
    relayUrl: string
    endpoints: string[]
  } | null = null

  constructor(
    private readonly url: string,
    private readonly keypair: Ed25519Keypair,
    private readonly options: { expectRelayPubkey?: string } = {},
  ) {
    super()
  }

  // ── Public API ──────────────────────────────────────────────────────
  /**
   * Verified identity of the relay serving this connection (P7): set once the
   * post-auth `identity_ack` verifies. Null on relays predating identity_ack.
   */
  relayIdentity(): {
    relayPubkey: string
    relayName: string
    relayUrl: string
    endpoints: string[]
  } | null {
    return this.verifiedIdentity
  }

  /**
   * Connects and completes Ed25519 auth.  Resolves when relay is ready.
   *
   * `options.roomId` (12-char id derived from cwd, see `src/rooms.ts`) is
   * included in the hello so the relay can multiplex N concurrent peers
   * with the same Ed25519 pubkey but different rooms (one pi-ext per cwd).
   * Omitting `roomId` is backward-compat with old relays (treated as the
   * default "main" room server-side).
   *
   * Throws `RoomAlreadyOpenError` if the relay rejects the hello because
   * another peer already holds the (pubkey, room_id) tuple. Caller (e.g.
   * `_cmdStart`) maps that to a clearer UI message.
   */
  async connect(options: ConnectOptions = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: MAX_WS_PAYLOAD_BYTES })
      this.ws = ws

      ws.on("error", (err) => reject(err))

      ws.on("open", async () => {
        try {
          await this._authenticate(ws, options)

          // Auth done — wire persistent message handler. Every inbound frame
          // (data, plus the relay's keepalive ping/pong below) refreshes the
          // liveness clock.
          this.lastActivityAt = Date.now()
                    ws.on("message", (raw) => {
                        this.lastActivityAt = Date.now()
                        const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw)
                        for (const line of text.split("\n")) {
                            const trimmed = line.trim()
                            if (!trimmed) continue
                            // Relay refusal (payload_too_large / invalid_envelope / unknown_peer):
                            // surface in the envelope debug log so an oversized send is VISIBLE
                            // instead of the message silently vanishing (silent-drop fix).
                            if (trimmed.startsWith('{"type":"error"')) {
                                envLog(`relay error frame: ${trimmed}`)
                            }
                            // P7: the relay proves its identity right after auth. A pin
                            // mismatch (TOFU'd at pair time) or forged ack kills the
                            // connection BEFORE any caller traffic rides it. NB: serde
                            // JSON keys may serialize alphabetically (no preserve_order),
                            // so detect by substring + parse, not a "type"-first prefix.
                            if (trimmed.includes('"identity_ack"')) {
                                try {
                                    const frame = JSON.parse(trimmed) as RelayIdentityAckFrame
                                    if (frame?.type !== "identity_ack") continue // data frame that merely mentions it
                                    const check = verifyRelayIdentityAck(
                                        frame,
                                        this.challengeNonceB64 ?? "",
                                        this.options.expectRelayPubkey,
                                    )
                                    if (check.ok) {
                                        this.verifiedIdentity = {
                                            relayPubkey: check.relayPubkey,
                                            relayName: check.relayName,
                                            relayUrl: check.relayUrl,
                                            endpoints: check.endpoints,
                                        }
                                        this.emit("relayIdentity", check)
                                    } else {
                                        envLog(`relay identity check failed: ${check.reason}`)
                                        this.emit("relayIdentityError", {
                                            reason: check.reason,
                                            expectedRelayPubkey: this.options.expectRelayPubkey,
                                            gotRelayPubkey:
                                                typeof frame.relay_pubkey === "string"
                                                    ? frame.relay_pubkey
                                                    : undefined,
                                        })
                                        this._stopLiveness()
                                        ws.terminate()
                                        continue
                                    }
                                } catch {
                                    envLog(`relay identity_ack unparseable: ${trimmed}`)
                                    continue
                                }
                            }
                            this.emit("message", trimmed)
                        }
                    })
          // The relay pings every ~25s; `ws` auto-replies Pong (keeping the
          // relay's view of us alive). The relay ignores client pings rather
          // than ponging, so these inbound pings — not a ping/pong we initiate
          // — are our liveness signal.
          ws.on("ping", () => {
            this.lastActivityAt = Date.now()
          })
          ws.on("pong", () => {
            this.lastActivityAt = Date.now()
          })

          ws.on("close", () => {
            this._stopLiveness()
            this.emit("close")
          })
          this._startLiveness(ws)
          resolve()
        } catch (err) {
          ws.terminate()
          reject(err)
        }
      })
    })
  }

  /** True only while the authenticated Relay WebSocket is currently open. */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Sends a raw line to the relay (caller is responsible for framing).
   *  `onWritten`, when given, is the ws send-completion callback: it fires
   *  once the frame is handed to the socket (or with an error) — the
   *  flush-before-teardown guarantee for teardown-path frames. */
  send(line: string, onWritten?: (err?: Error) => void): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay: not connected")
    }
    this.ws.send(line, onWritten)
  }

  /**
   * Sends a control frame to the relay (not routed to app peer). Used for
   * out-of-band metadata updates like `room_meta_update`. Silently no-ops if
   * the WS isn't open (best-effort: control frames are observational; we
   * don't want them throwing inside SDK event callbacks).
   */
  sendControl(frame: RoomMetaUpdateFrame | PairingSetFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }

  close(): void {
    this._stopLiveness()
    this.ws?.close()
    this.ws = null
  }

  // ── Liveness watchdog ─────────────────────────────────────────────────────

  /** Force-close the WS when no inbound frame has arrived for
   *  `LIVENESS_TIMEOUT_MS` — see the constant's doc for why. `terminate()`
   *  fires `close`, which the owner turns into a reconnect. */
  private _startLiveness(ws: WebSocket): void {
    this._stopLiveness()
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt > LIVENESS_TIMEOUT_MS) {
        this._stopLiveness()
        ws.terminate()
      }
    }, LIVENESS_CHECK_MS)
  }

  private _stopLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  private async _authenticate(
    ws: WebSocket,
    opts: ConnectOptions,
  ): Promise<void> {
    const pubkeyB64 = Buffer.from(this.keypair.publicKey).toString("base64")
    const hello: HelloMsg = { type: "hello", pubkey: pubkeyB64 }
    if (opts.roomId) hello.room_id = opts.roomId
    if (opts.roomMeta) hello.room_meta = opts.roomMeta
    this._rawSend(ws, JSON.stringify(hello))

    const challengeRaw = await this._nextMsg(ws)
    let challenge:
      ChallengeMsg | { type: "error"; code?: string; message?: string }
    try {
      challenge = JSON.parse(challengeRaw) as typeof challenge
    } catch {
      throw new Error(`relay auth_failed: not JSON: ${challengeRaw}`)
    }
    if (challenge.type === "error") {
      const code = (challenge as { code?: string }).code ?? ""
      if (code === "room_already_open") {
        throw new RoomAlreadyOpenError(opts.roomId)
      }
      throw new Error(
        `relay rejected hello: ${code || (challenge as { message?: string }).message || "unknown"}`,
      )
    }
    if (challenge.type !== "challenge" || !(challenge as ChallengeMsg).nonce) {
      throw new Error(
        `relay auth_failed: expected challenge, got ${challengeRaw}`,
      )
    }

    const nonce = Buffer.from((challenge as ChallengeMsg).nonce, "base64")
    this.challengeNonceB64 = (challenge as ChallengeMsg).nonce
    const sig = ed25519Sign(this.keypair.secretKey, nonce)
    const auth: AuthMsg = {
      type: "auth",
      sig: Buffer.from(sig).toString("base64"),
    }
    this._rawSend(ws, JSON.stringify(auth))

    // The relay sends `identity_ack` right after auth (P7); the persistent
    // message handler below verifies it — a mismatched relay pubkey (or bad
    // signature) terminates the socket before any caller traffic flows.',
  }

  /** Waits for the next single WS message with a timeout. */
  private _nextMsg(ws: WebSocket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay auth timeout")),
        AUTH_TIMEOUT_MS,
      )
      ws.once("message", (raw) => {
        clearTimeout(timer)
        resolve(Buffer.isBuffer(raw) ? raw.toString() : String(raw))
      })
    })
  }

  private _rawSend(ws: WebSocket, data: string): void {
    ws.send(data)
  }
}
