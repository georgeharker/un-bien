import {
  type Server,
  type Socket,
  createConnection,
  createServer,
} from "node:net"
import { existsSync, lstatSync, unlinkSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { usesNamedPipe } from "./ipc.js"

const MAX_ATTEMPTS = 20
const BUSY_MAX_ATTEMPTS = 100
const BASE_BACKOFF_MS = 30
const JITTER_MS = 70
const PROBE_TIMEOUT_MS = 500
/** The broker answers an unregistered `list_peers` probe; a kernel-level
 *  connect succeeding is NOT proof the broker process is serving — a busy
 *  leader shares its pi process's event loop and backlog accepts can sit
 *  unanswered. Give the app-level ack a generous window. */
const PROBE_ACK_TIMEOUT_MS = 2_000

export type ElectionResult =
  { role: "leader"; server: Server } | { role: "follower"; socket: Socket }

export interface JoinLimits {
  /** Bind-race retries before giving up. */
  maxAttempts?: number
  /** Consecutive busy probes to wait out before throwing. A busy leader is
   *  ALIVE — taking over its socket file would split the mesh into islands
   *  (one registry per generation, sessions invisible across them), so the
   *  joiner waits instead of displacing. */
  busyMaxAttempts?: number
}

/** What the current occupant of `sockPath` looks like after probing. */
type LeaderProbe =
  | { outcome: "live"; socket: Socket }
  | { outcome: "dead"; reason: "refused" | "stale" }
  | { outcome: "busy" }

/**
 * UDS-based leader election. Probes the current occupant of `sockPath` at the
 * APPLICATION level (an unregistered `list_peers` probe the broker answers);
 * only a live ack joins as follower, only a kernel-level refusal (stale file)
 * cleans up and binds. A connect-without-ack ("busy": the leader exists but
 * its event loop is starved) is waited out, never displaced.
 *
 * Returns the role + the live handle (server for leader, socket for follower).
 */
export async function joinOrLead(
  sockPath: string,
  limits: JoinLimits = {},
): Promise<ElectionResult> {
  const maxAttempts = limits.maxAttempts ?? MAX_ATTEMPTS
  const busyMaxAttempts = limits.busyMaxAttempts ?? BUSY_MAX_ATTEMPTS
  const pipe = usesNamedPipe()
  let busySeen = 0
  let raceRetries = 0
  while (raceRetries < maxAttempts && busySeen <= busyMaxAttempts) {
    // Windows named pipes have no file to `existsSync`; always connect-probe
    // first and never `unlink` (the pipe auto-disappears when its owner exits).
    // POSIX keeps the existsSync fast-path + stale-socket cleanup.
    if (pipe || existsSync(sockPath)) {
      const probe = await _probeBroker(sockPath)
      if (probe.outcome === "live") {
        return { role: "follower", socket: probe.socket }
      }
      if (probe.outcome === "busy") {
        // Connected but the broker never acked. NEVER unlink/re-bind over a
        // live-but-busy leader: its file was real, its followers keep their
        // sockets, and a second registry would make the two generations
        // invisible to each other (field-verified). Wait for it.
        busySeen += 1
        await delay(BASE_BACKOFF_MS + Math.random() * JITTER_MS)
        continue
      }
      // Nothing listening at the kernel level (ECONNREFUSED) — stale file.
      if (!pipe) _removeStaleSock(sockPath)
    }

    const server = await _tryBind(sockPath)
    if (server) return { role: "leader", server }

    // Lost a concurrent bind race (someone else rebound) — re-probe.
    raceRetries += 1
    await delay(BASE_BACKOFF_MS + Math.random() * JITTER_MS)
  }
  if (busySeen > busyMaxAttempts) {
    throw new Error(
      `leader election: broker at ${sockPath} exists but never answered ` +
        `the liveness probe after ${busyMaxAttempts + 1} attempts ` +
        `(leader busy or hung) — refusing to take over its socket file`,
    )
  }
  throw new Error(
    `leader election failed after ${maxAttempts} bind attempts: ${sockPath}`,
  )
}

/**
 * Probes a UDS path: if a live listener responds, returns the connected
 * socket; otherwise returns null (timeout or ECONNREFUSED). Exported so
 * the cwd-lock primitive can reuse it without duplicating the OS dance.
 */
export function tryConnect(sockPath: string): Promise<Socket | null> {
  return _tryConnect(sockPath)
}

/**
 * Attempts to bind a UDS server on `sockPath`. Returns the live server on
 * success, null when the path is already held (EADDRINUSE) or any other
 * bind error. Caller is responsible for `unlink`ing a stale sock file
 * before retrying.
 */
export function tryBind(sockPath: string): Promise<Server | null> {
  return _tryBind(sockPath)
}

/** Unlinks the sock file if it exists and is actually a socket. No-op
 *  otherwise. Used to clear stale sockets left behind by a crashed peer. */
export function removeStaleSock(sockPath: string): void {
  _removeStaleSock(sockPath)
}

function _tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = createConnection({ path: sockPath })
    let settled = false
    const settle = (val: Socket | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!val) sock.destroy()
      resolve(val)
    }
    const timer = setTimeout(() => settle(null), PROBE_TIMEOUT_MS)
    sock.once("connect", () => settle(sock))
    sock.once("error", () => settle(null))
  })
}

/**
 * Application-level liveness probe for the broker occupying `sockPath`.
 *
 * A `node:net` connect succeeding is kernel-level evidence only — the backlog
 * accepts while the owner's event loop is starved. The broker answers an
 * UNREGISTERED `list_peers` probe (no name assigned, no broadcasts, connection
 * left free for a later `register` handshake — see broker.ts
 * `_tryObserverProbe`), so an acked probe proves the broker is actually
 * serving, and the probed socket can go on to the follower `register`.
 *
 * Outcomes:
 *  - `live` — broker acked; `socket` is open and may proceed to `register`
 *  - `dead` — kernel-level connect FAILED: nothing listening (stale file)
 *  - `busy` — connected but no ack within the window: the leader is alive but
 *             its event loop didn't answer; the caller must NOT touch the file
 */
function _probeBroker(sockPath: string): Promise<LeaderProbe> {
  return new Promise((resolve) => {
    const sock = createConnection({ path: sockPath })
    let settled = false
    let buf = ""

    const settle = (result: LeaderProbe) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      if (ackTimer !== null) clearTimeout(ackTimer)
      // A `live` socket may proceed to `register`; any other outcome must not
      // leave the connection dangling.
      if (result.outcome !== "live") sock.destroy()
      resolve(result)
    }

    const connectTimer = setTimeout(() => {
      // Connected-but-slow at the kernel level: inconclusive, never "dead" —
      // a live leader must not be displaced on an inconclusive probe.
      settle({ outcome: "busy" })
    }, PROBE_TIMEOUT_MS)

    let ackTimer: ReturnType<typeof setTimeout> | null = null

    sock.setEncoding("utf8")
    sock.on("data", (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const env = JSON.parse(line) as { body?: { type?: unknown } }
          // PONG: the minimal liveness ack (no roster data — see broker.ts
          // _tryBrokerPing). Compatibility shim: brokers predating broker_ping
          // answer the roster-shaped list_peers ack instead; accept both until
          // every node runs a ping-aware broker, then drop the fallback.
          const bodyType = env?.body?.type
          if (bodyType === "broker_pong" || bodyType === "list_peers_reply") {
            settle({ outcome: "live", socket: sock })
            return
          }
        } catch {
          /* partial or non-JSON line: keep reading */
        }
      }
    })

    sock.once("connect", () => {
      // Kernel connect won; now wait for the APP-level ack.
      clearTimeout(connectTimer)
      sock.write(JSON.stringify({ type: "broker_ping" }) + "\n")
      // Fallback line for pre-ping brokers: they ignore broker_ping, so ask
      // again the old way.
      sock.write(JSON.stringify({ type: "list_peers" }) + "\n")
      ackTimer = setTimeout(() => settle({ outcome: "busy" }), PROBE_ACK_TIMEOUT_MS)
    })

    sock.once("error", () => {
      settle({ outcome: "dead", reason: "refused" })
    })
  })
}

function _tryBind(sockPath: string): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const settle = (val: Server | null) => {
      if (settled) return
      settled = true
      if (!val) {
        try {
          server.close()
        } catch {
          /* ignored */
        }
      }
      resolve(val)
    }
    server.once("error", () => settle(null))
    server.listen(sockPath, () => settle(server))
  })
}

function _removeStaleSock(sockPath: string): void {
  try {
    const stat = lstatSync(sockPath)
    if (stat.isSocket()) unlinkSync(sockPath)
  } catch {
    // ENOENT or not-a-socket — nothing to clean up.
  }
}
