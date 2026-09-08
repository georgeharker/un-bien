import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import {
  EVT_KIND,
  RPC_KIND,
  UB_KIND,
  RelayClient,
  type EnvelopeMessage,
  type Ed25519Keypair,
} from "@geohar/un-bien/client"
import type { PairingInvite } from "./invite.js"

/** The relay's outer routing wrapper: `ct` is base64(JSON(inner)), opaque to it. */
interface OuterEnvelope {
  peer: string
  room?: string
  ct: string
}

/** Config stores relay URLs as http(s); the socket needs ws(s). */
function toWsUrl(url: string): string {
  if (url.startsWith("http://")) return `ws://${url.slice(7)}`
  if (url.startsWith("https://")) return `wss://${url.slice(8)}`
  return url
}

/** One session's relay room, as announced by the pi that owns it. */
export interface RoomInfo {
  room_id: string
  name?: string
  cwd?: string
  started_at?: number
  parent?: string
  sessionId?: string
  caps?: string[]
}

export interface SessionClientEvents {
  /** An inner envelope frame ({rpc|evt|ub}) from the pi. */
  envelope: [EnvelopeMessage]
  /** A pre-attach stock frame — only `pair_ok` / `pair_error` arrive this way. */
  control: [Record<string, unknown>]
  /** A relay control frame (rooms / presence) — not routed to any pi. */
  relayControl: [Record<string, unknown>]
  close: []
}

/**
 * The owner end of a session channel: relay auth, pairing, then the envelope
 * plane. The pi is addressed by its Ed25519 public key (`invite.epk`) — an
 * opaque routing key that is echoed verbatim, never parsed.
 */
export class SessionClient extends EventEmitter<SessionClientEvents> {
  private readonly relay: RelayClient

  /** The room being driven. Mutable: one pairing reaches every room the pi
   *  owns, so picking a session is a routing change, not a re-pair. */
  room: string

  constructor(
    relayUrl: string,
    keypair: Ed25519Keypair,
    private readonly invite: PairingInvite,
  ) {
    super()
    this.room = invite.roomId
    this.relay = new RelayClient(toWsUrl(relayUrl), keypair)
  }

  /** Snapshot the pi's currently-open rooms (one per live session). */
  listRooms(timeoutMs = 5_000): Promise<RoomInfo[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("relayControl", onControl)
        resolve([])
      }, timeoutMs)
      const onControl = (frame: Record<string, unknown>) => {
        if (frame.type !== "rooms" || frame.peer !== this.invite.epk) return
        clearTimeout(timer)
        this.off("relayControl", onControl)
        resolve(Array.isArray(frame.rooms) ? (frame.rooms as RoomInfo[]) : [])
      }
      this.on("relayControl", onControl)
      this.relay.send(
        JSON.stringify({ type: "rooms_check", peers: [this.invite.epk] }),
      )
    })
  }

  async connect(): Promise<void> {
    this.relay.on("message", (line) => this.onLine(line))
    this.relay.on("close", () => this.emit("close"))
    // No room_id: an owner subscribes to rooms, it does not own one.
    await this.relay.connect()
  }

  /** The one non-envelope frame a client ever sends — nothing exists before it. */
  pair(deviceName: string): void {
    this.sendInner({
      type: "pair_request",
      id: randomUUID(),
      token: this.invite.token,
      device_name: deviceName,
    })
  }

  /** Ask the extension to replay panels + pending UI for this session. */
  requestSync(): void {
    this.sendEnvelope({ ub: { type: "session_sync", id: randomUUID() } })
  }

  /**
   * Pull the session's persisted transcript. This is pi's native history verb —
   * `session_sync` covers panels and pending UI only, never the transcript.
   */
  /**
   * Walk the whole transcript. `get_entries` is PAGED: each reply carries a
   * page plus the `leafId` to continue from, and the walk ends on an empty
   * page. A single call returns only the first page, which silently looks like
   * a short history.
   *
   * Mirrors the app's walk, including its repeated-leaf circuit breaker: a
   * non-empty page whose leaf did not advance would otherwise page forever.
   */
  async getEntries(maxPages = 200): Promise<unknown[]> {
    const all: unknown[] = []
    let since: string | undefined

    for (let page = 0; page < maxPages; page++) {
      let data: { entries?: unknown[]; leafId?: string } | undefined
      try {
        data = await this.request<{ entries?: unknown[]; leafId?: string }>(
          "get_entries",
          since ? { since } : {},
        )
      } catch {
        break // timeout or error: keep whatever we already walked
      }
      const entries = data?.entries ?? []
      const leaf = data?.leafId
      if (entries.length === 0 || !leaf) break
      all.push(...entries)
      if (leaf === since) break // leaf did not advance — the walk is spinning
      since = leaf
    }
    return all
  }

  /**
   * Issue a pi rpc command and await its correlated `response`. pi's verbs are
   * used directly — an un-bien hop would only be a second name for the same
   * thing.
   */
  request<T>(
    type: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T | undefined> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("envelope", onEnvelope)
        reject(new Error(`${type}: timed out`))
      }, timeoutMs)
      const onEnvelope = (env: EnvelopeMessage) => {
        const rpc = env.rpc
        if (typeof rpc !== "object" || rpc === null) return
        const frame = rpc as Record<string, unknown>
        if (frame.type !== "response" || frame.id !== id) return
        clearTimeout(timer)
        this.off("envelope", onEnvelope)
        if (frame.success === false) {
          reject(new Error(String(frame.error ?? `${type} failed`)))
          return
        }
        resolve(frame.data as T | undefined)
      }
      this.on("envelope", onEnvelope)
      this.sendEnvelope({ rpc: { type, id, ...params } })
    })
  }

  /**
   * un-bien's own plane, for the things pi has no same-process verb for.
   *
   * SAFETY: the exported `UbFrame` union is narrower than what the extension
   * actually routes — `session_fork` / `session_navigate` are dispatched from
   * `index.ts` but absent from the published type, which casts them the same
   * way. Typing this parameter to the union would reject frames the receiver
   * handles today.
   */
  sendUb(type: string, params: Record<string, unknown> = {}): void {
    const frame = { type, id: randomUUID(), ...params }
    this.sendEnvelope({ ub: frame as EnvelopeMessage["ub"] })
  }

  /** Drive the agent. `prompt` is pi's own rpc verb — no invented hop. */
  prompt(message: string): void {
    this.sendEnvelope({
      rpc: { type: "prompt", id: randomUUID(), message },
    })
  }

  /** Interrupt a running turn with a steering message. */
  steer(message: string): void {
    this.sendEnvelope({ rpc: { type: "steer", id: randomUUID(), message } })
  }

  abort(): void {
    this.sendEnvelope({ rpc: { type: "abort", id: randomUUID() } })
  }

  close(): void {
    this.relay.close()
  }

  /**
   * The single outbound choke, mirroring the extension's: stamp the plane's
   * REAL wrapper kind plus a timestamp.
   *
   * The kind is not decoration. The extension's pre-attach listener drops any
   * frame whose top-level `type` is not a string (relay_lifecycle.ts), so an
   * unstamped envelope is silently ignored — it routes, arrives, and vanishes.
   */
  sendEnvelope(env: EnvelopeMessage): void {
    const kind = env.rpc ? RPC_KIND : env.evt ? EVT_KIND : UB_KIND
    this.sendInner({ type: kind, ...env, ts: Date.now() })
  }

  private sendInner(inner: unknown): void {
    const outer: OuterEnvelope = {
      peer: this.invite.epk,
      room: this.room,
      ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
    }
    this.relay.send(JSON.stringify(outer))
  }

  private onLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    // Relay control frames (rooms/presence) carry no `ct` — they are addressed
    // to us, not routed through a pi.
    const ct = frame.ct
    if (typeof ct !== "string") {
      this.emit("relayControl", frame)
      return
    }

    let inner: Record<string, unknown>
    try {
      inner = JSON.parse(Buffer.from(ct, "base64").toString("utf8")) as Record<
        string,
        unknown
      >
    } catch {
      return
    }

    if ("rpc" in inner || "evt" in inner || "ub" in inner) {
      this.emit("envelope", inner as EnvelopeMessage)
      return
    }
    this.emit("control", inner)
  }
}
