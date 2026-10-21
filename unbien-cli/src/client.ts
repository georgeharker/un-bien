import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import {
  EVT_KIND,
  RPC_KIND,
  UB_KIND,
  RelayClient,
  ed25519Sign,
  type EnvelopeMessage,
  type Ed25519Keypair,
} from "@geohar/un-bien/client"
import type { PairingInvite } from "./invite.js"
import { nextProxyAllowVersion } from "./store.js"

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
  /** If present, this session is on a federated (remote) peer relay.
   *  The value is the peer relay's name. Absent = direct (local to the
   *  relay the CLI connected to). */
  peerRelay?: string
  /** The ROOM-OWNING machine's epk for federated sessions (from the
   *  federated_peer_list) — used for control-room routing (remote launch). */
  peer_epk?: string
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

/** What `listRooms` learned. The machine's signed allow-list gates `rooms_check`;
 *  the relay answers a refused listing with {type:"error",code:"unknown_peer"}. */
export type RelayRoomList =
  | { status: "ok"; rooms: RoomInfo[] }
  | { status: "unknown_peer"; peer?: string }
  | { status: "refused"; detail: string }
  | { status: "timeout" }

/** Pairing verdict from the machine — `ok` on pair_ok (with its hello),
 *  `ok:false` with the machine's detail on pair_error / timeout. */
export type PairVerdict =
  | { ok: true; machine: Record<string, unknown> }
  | { ok: false; detail: string }

/** One honest line about a non-ok session listing. */
export function explainRoomList(result: RelayRoomList): string {
  if (result.status === "ok") return ""
  switch (result.status) {
    case "unknown_peer":
      return (
        "relay refused the listing (unknown_peer): this device is not in the " +
        "machine's signed allow-list. Run `unbien pair` with a fresh /unbien " +
        "pair code (re-pairs are safe)."
      )
    case "refused":
      return `relay refused the session listing (${result.detail})`
    case "timeout":
      return "relay did not answer the session listing in time — is it reachable?"
  }
}

/** Rooms from an `ok` listing; throws an actionable error otherwise. For
 *  verbs that cannot proceed without seeing a machine's rooms
 *  (create-session, resume-session, control-room discovery). */
export function roomsOrActionable(result: RelayRoomList): RoomInfo[] {
  if (result.status === "ok") return result.rooms
  throw new Error(explainRoomList(result))
}

/**
 * The owner end of a session channel: relay auth, pairing, then the envelope
 * plane. The pi is addressed by its Ed25519 public key (`invite.epk`) — an
 * opaque routing key that is echoed verbatim, never parsed.
 */
export class SessionClient extends EventEmitter<SessionClientEvents> {
  private readonly relay: RelayClient
  private readonly keypair: Ed25519Keypair

  /** The room being driven. Mutable: one pairing reaches every room the pi
   *  owns, so picking a session is a routing change, not a re-pair. */
  room: string

  constructor(
    relayUrl: string,
    keypair: Ed25519Keypair,
    private readonly invite: PairingInvite,
    opts: { expectRelayPubkey?: string } = {},
  ) {
    super()
    this.room = invite.roomId
    this.keypair = keypair
    this.relay = new RelayClient(toWsUrl(relayUrl), keypair, opts)
    // P7: surface a failed relay-identity check to callers as a control frame
    // (pair/attach flows print it and exit; the socket is already terminated
    // by the RelayClient).
    this.relay.on(
      "relayIdentityError",
      (payload: {
        reason: string
        expectedRelayPubkey?: string
        gotRelayPubkey?: string
      }) => {
        this.emit("control", { type: "relay_identity_error", ...payload })
      },
    )
  }

  /** Verified relay identity for this connection (P7 TOFU) — null until the
   *  post-auth `identity_ack` verifies, or on relays predating the ack.
   *  `endpoints` (P6) are the relay's advertised dialable binds. */
  relayIdentity(): {
    relayPubkey: string
    relayName: string
    relayUrl: string
    endpoints: string[]
  } | null {
    return this.relay.relayIdentity()
  }

  /** Snapshot the pi's currently-open rooms (one per live session).
   *
   *  Returns an HONEST result: `ok` with rooms, `unknown_peer` when the relay
   *  refused the listing (fail-closed pairing gate — this device is NOT in
   *  the machine's signed allow-list), `refused` for any other relay
   *  refusal, or `timeout` when nothing answered. Collapsing all of these
   *  into `[]` made an unpaired-but-working setup indistinguishable from
   *  "no sessions running" (field-verified: `unbien connect` printed
   *  "none open" while sessions were visible from the phone). */
  listRooms(timeoutMs = 5_000): Promise<RelayRoomList> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("relayControl", onControl)
        resolve({ status: "timeout" })
      }, timeoutMs)
      const settle = (result: RelayRoomList): void => {
        clearTimeout(timer)
        this.off("relayControl", onControl)
        resolve(result)
      }
      const onControl = (frame: Record<string, unknown>) => {
        // rooms_check answers `rooms` on success, and an
        // {type:"error",code:"unknown_peer"} refusal when the requester is
        // not in the target machine's signed allow-list.
        if (frame.type === "error") {
          const code = typeof frame.code === "string" ? frame.code : "error"
          if (code === "unknown_peer") {
            settle({
              status: "unknown_peer",
              peer: typeof frame.peer === "string" ? frame.peer : undefined,
            })
          } else {
            settle({ status: "refused", detail: code })
          }
          return
        }
        if (frame.type !== "rooms" || frame.peer !== this.invite.epk) return
        const peerRelay =
          typeof frame.peerRelay === "string" ? frame.peerRelay : undefined
        const rooms = Array.isArray(frame.rooms) ? (frame.rooms as RoomInfo[]) : []
        // Tag each room with the peerRelay (federated sessions).
        settle(
          peerRelay
            ? { status: "ok", rooms: rooms.map((r) => ({ ...r, peerRelay })) }
            : { status: "ok", rooms },
        )
      }
      this.on("relayControl", onControl)
      this.relay.send(
        JSON.stringify({ type: "rooms_check", peers: [this.invite.epk] }),
      )
    })
  }

  /** Listen for the relay's federated_peer_list push (Phase 4) — sessions
   *  on federated peer relays. Returns rooms tagged with peerRelay so the
   *  session picker shows '(remote: peerRelay)'. */
  listFederatedSessions(timeoutMs = 3_000): Promise<RoomInfo[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("relayControl", onControl)
        resolve([])
      }, timeoutMs)
      const onControl = (frame: Record<string, unknown>) => {
        if (frame.type !== "federated_peer_list") return
        clearTimeout(timer)
        this.off("relayControl", onControl)
        const peers = Array.isArray(frame.peers) ? frame.peers : []
        const rooms: RoomInfo[] = []
        for (const peer of peers as Record<string, unknown>[]) {
          const relayName = typeof peer.relay_name === "string" ? peer.relay_name : "?"
          const remoteEpk = typeof peer.epk === "string" ? peer.epk : ""
          const peerRooms = Array.isArray(peer.rooms) ? peer.rooms : []
          for (const room of peerRooms as RoomInfo[]) {
            // peer_epk lets the caller construct control-room invites for
            // remote machines (gap 5: remote session launch).
            rooms.push({ ...room, peerRelay: relayName, peer_epk: remoteEpk })
          }
        }
        resolve(rooms)
      }
      this.on("relayControl", onControl)
    })
  }

  async connect(options?: { roomId?: string }): Promise<void> {
    this.relay.on("message", (line) => this.onLine(line))
    this.relay.on("close", () => this.emit("close"))
    // No room_id by default: an owner subscribes to rooms, it does not own
    // one. Daemon-facing verbs (create/resume-session) PASS a roomId — the
    // relay (0.7.x subscription model) only routes frames between mutual
    // subscribers of a room, so a roomless client's frames never reach the
    // daemon's control room (verified: handler never fired, replies timed out).
    await this.relay.connect(
      options?.roomId ? { roomId: options.roomId } : undefined,
    )
    // A device advertises the owner it belongs to (federation v2 §3): this
    // CLI is its own owner device (proxy-identity.json), so its set names
    // itself. Without the push, federated reply legs to this epk are
    // refused at the remote machine's relay (strict owner-set gates).
    // Version: PERSISTED-monotonic (max(epochSeconds, floor+1), cross-process
    // locked) — raw epoch seconds collide when two CLI processes push in the
    // same second and the relay's StaleVersion guard silently drops one,
    // which could discard a REAL allow-list change.
    const pk = Buffer.from(this.keypair.publicKey).toString("base64")
    const blobBytes = Buffer.from(
      JSON.stringify({
        machine_pk: pk,
        owners: [pk],
        version: nextProxyAllowVersion(),
        issued_at: Date.now(),
      }),
      "utf8",
    )
    const sig = ed25519Sign(this.keypair.secretKey, new Uint8Array(blobBytes))
    this.relay.send(
      JSON.stringify({
        type: "pairing_set",
        blob: blobBytes.toString("base64"),
        sig: Buffer.from(sig).toString("base64"),
      }),
    )
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

  /** Send `pair_request` and WAIT for the machine's verdict.
   *
   *  `pair()` alone is fire-and-forget: the machine's `pair_ok`/`pair_error`
   *  reply targets the sender's registered room, and a caller that closes the
   *  socket immediately loses it — while the machine either consumes the
   *  one-time token or records the peer. The field-verified failure: `unbien
   *  pair` printed success (and remembered the machine) on every run while
   *  the machine's `peers.json` never changed, leaving `rooms_check` refused
   *  (unknown_peer) forever. Any caller MUST await this verdict before it
   *  remembers the peer or closes the socket. */
  pairAwaited(deviceName: string, timeoutMs = 15_000): Promise<PairVerdict> {
    return new Promise((resolve) => {
      const onControl = (frame: Record<string, unknown>) => {
        if (frame.type === "pair_ok") {
          clearTimeout(timer)
          this.off("control", onControl)
          resolve({ ok: true, machine: frame })
        } else if (frame.type === "pair_error") {
          clearTimeout(timer)
          this.off("control", onControl)
          resolve({
            ok: false,
            detail: String(frame.message ?? frame.code ?? "rejected"),
          })
        } else if (frame.type === "relay_identity_error") {
          clearTimeout(timer)
          this.off("control", onControl)
          const expected =
            typeof frame.expectedRelayPubkey === "string"
              ? frame.expectedRelayPubkey.slice(0, 12)
              : "?"
          const got =
            typeof frame.gotRelayPubkey === "string"
              ? frame.gotRelayPubkey.slice(0, 12)
              : "unverified"
          resolve({
            ok: false,
            detail: `the relay at this URL is not the one you paired with (pinned ${expected}…, got ${got}…). If you rebuilt/rotated the relay deliberately, clear the pin: unbien relay forget <url>, then re-pair.`,
          })
        }
        // other control frames: keep waiting
      }
      const timer = setTimeout(() => {
        this.off("control", onControl)
        resolve({
          ok: false,
          detail: "timed out — run /unbien pair for a fresh code and retry",
        })
      }, timeoutMs)
      this.on("control", onControl)
      this.pair(deviceName)
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

  /** Re-target the client at a room discovered post-connect (e.g. the
   *  launcher daemon's control room, found by its is_daemon capability). */
  setRoom(roomId: string): void {
    this.room = roomId
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

  /** Queue a message to run AFTER the current turn ends (followUp). */
  queue(message: string): void {
    this.sendEnvelope({
      rpc: {
        type: "prompt",
        id: randomUUID(),
        message,
        streamingBehavior: "followUp",
      },
    })
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
