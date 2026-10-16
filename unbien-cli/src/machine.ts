import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { loadPeers, type PairedPeer } from "./store.js"
import { loadOrCreateIdentity } from "./identity.js"
import { SessionClient, type RoomInfo } from "./client.js"
import { Shell } from "./tui.js"

/**
 * Shared machine-control-room plumbing for the daemon-facing verbs
 * (create-session, resume-session): machine discovery by name/epk, the
 * control-room derivation (must match the daemon's own roomIdForControl),
 * and the launch request/response exchange.
 */

/** Machine discovery: name (exact or prefix) or epk prefix, over paired peers. */
export function resolveMachine(target: string): PairedPeer | null {
  const peers = loadPeers()
  if (peers.length === 0) return null
  if (!target) return peers[peers.length - 1] // last-paired, matching connect's default
  const t = target.toLowerCase()
  return (
    peers.find((p) => p.name?.toLowerCase() === t) ??
    peers.find((p) => p.name?.toLowerCase().startsWith(t)) ??
    peers.find((p) => p.epk.startsWith(target)) ??
    null
  )
}

/** A federated (remote-relay) machine resolved via the local relay's
 *  federated_peer_list. `relayUrl` is the LOCAL relay: the CLI connects
 *  through it and the cross-relay forwarding is invisible (gap 5). */
export interface RemoteMachineRef {
  epk: string
  name: string // peer relay's name (peerRelay)
  relayUrl: string // the LOCAL relay's URL — routing goes through it
  /** Structurally compatible with PairedPeer (timestamp placeholder). */
  pairedAt: string
}

/** Resolve a machine label (exact/prefix match on the peer relay name) or epk
 *  prefix to a federated machine, by asking the local relay for its
 *  federated_peer_list. Returns null when no federated machine matches. */
export async function resolveRemoteMachine(
  target: string,
  relayUrl: string,
): Promise<RemoteMachineRef | null> {
  const probe = new SessionClient(
    relayUrl,
    loadOrCreateIdentity(),
    { token: "", epk: "0".repeat(43), roomId: "main" },
  )
  let client: SessionClient | null = null
  try {
    // The probe's invite epk is a placeholder — we never route to it; we only
    // need the connection for the federated_peer_list pull.
    await probe.connect()
    client = probe
  } catch {
    return null
  }
  try {
    const rooms = await client.listFederatedSessions()
    const t = target.toLowerCase()
    // HOSTNAME-tolerant matching: the relay/machine name defaults to the
    // system hostname (short form). An FQDN target (droplet.tailnet.ts.net)
    // matches on its first DNS label, so `unbien connect <hostname>` works
    // in either form.
    const firstLabel = t.includes(".") ? t.split(".")[0] : null
    const matchesTarget = (name: string | undefined) => {
      const n = name?.toLowerCase()
      if (!n) return false
      return n === t || n.startsWith(t) || (firstLabel != null && n.startsWith(firstLabel))
    }
    // Group by (peerRelay + peer_epk): one RemoteMachineRef per machine.
    const byEpk = new Map<string, RemoteMachineRef>()
    for (const room of rooms) {
      if (!room.peer_epk) continue
      const ref: RemoteMachineRef = {
        epk: room.peer_epk,
        name: room.peerRelay ?? "?",
        relayUrl,
        pairedAt: new Date().toISOString(), // placeholder — not persisted
      }
      byEpk.set(room.peer_epk, ref)
    }
    const matches = [...byEpk.values()].filter(
      (m) => matchesTarget(m.name) || m.epk.startsWith(target),
    )
    if (matches.length === 1) return matches[0] ?? null
    if (matches.length > 1) {
      // Same relay name covers EVERY device that ever registered there, so
      // several epks can match a name — prefer the device with the most
      // real rooms (the live machine) and say so.
      const roomCounts = new Map<string, number>()
      for (const r of rooms) {
        if (r.peer_epk) {
          roomCounts.set(r.peer_epk, (roomCounts.get(r.peer_epk) ?? 0) + 1)
        }
      }
      matches.sort((a, b) => (roomCounts.get(b.epk) ?? 0) - (roomCounts.get(a.epk) ?? 0))
      console.error(
        `(${matches.length} matches for '${target}' — using the most active: ` +
          `${matches[0].epk.slice(0, 8)})`,
      )
      return matches[0] ?? null
    }
    return null
  } finally {
    client.close()
  }
}

/** Resolve + print the no-match error; exits the process when unresolved. */
export function requireMachine(target: string): PairedPeer {
  const machine = resolveMachine(target)
  if (machine) return machine
  console.error(
    `no machine matching '${target}'. Known:` +
      loadPeers()
        .map((p) => `\n  ${p.name ?? p.epk.slice(0, 12)} (${p.epk.slice(0, 10)}…)`)
        .join(""),
  )
  Shell.exitAfterDrain(1)
  process.exit(1) // narrowing: drain is async
}

/** Control room of a machine's launcher daemon — must match the daemon's own
 *  roomIdForControl (base64url(sha256(NUL+'control'+NUL+epk)).prefix(12)). */
export function controlRoomFor(epk: string): string {
  const sep = String.fromCharCode(0)
  // CANONICALIZE first: peers.json may store standard base64 (+//) while the
  // daemon derives its room from the base64url form of the same key — the raw
  // strings hash to different rooms (verified live: kVXLntWnczuI vs -R1hyjN5pwsD).
  const canonical = Buffer.from(epk, "base64").toString("base64url")
  return createHash("sha256")
    .update(sep + "control" + sep + canonical)
    .digest("base64url")
    .slice(0, 12)
}

export interface LaunchOutcome {
  ok: boolean
  note: string
}

/** Send `session_launch` and await the daemon's error frame (or its absence).
 *  Success carries no ack — the new session announces itself via its own room. */
export async function launchAndWait(
  client: SessionClient,
  params: { cwd?: string; name?: string; resume?: string },
  timeoutMs = 8_000,
): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const onUb = (frame: Record<string, unknown>) => {
      try {
        if (settled) return
        if (String(frame.type ?? "") === "error") {
          settled = true
          resolve({
            ok: false,
            note: String(frame.message ?? frame.code ?? "launch rejected"),
          })
        }
      } catch (err) {
        // A malformed frame must not crash the verb mid-wait.
        console.error(`frame handling error (ignored): ${String(err).slice(0, 120)}`)
      }
    }
    client.on("ub", onUb as (frame: Record<string, unknown>) => void)
    // Daemon errors ride control; relay refusals ride relayControl — both
    // terminal for the launch (they'd otherwise read as a silent timeout).
    const onError = (frame: Record<string, unknown>) => {
      if (settled) return
      if (String(frame.type ?? "") === "error") {
        settled = true
        resolve({
          ok: false,
          note: String(frame.message ?? frame.code ?? "launch rejected"),
        })
      }
    }
    client.on("control", onError)
    client.on("relayControl", onError)
    client.sendUb("session_launch", params)
    setTimeout(() => {
      if (settled) return
      settled = true
      client.off("ub", onUb as (frame: Record<string, unknown>) => void)
      resolve({ ok: true, note: "" })
    }, timeoutMs)
  })
}


/** Poll the machine's room list until a session matching `match` goes live
 *  (pi startup + mesh join take a few seconds after a launch). Resolves the
 *  live room, or null on timeout. */
export async function waitForRoom(
  client: SessionClient,
  match: (room: RoomInfo) => boolean,
  timeoutMs = 30_000,
  intervalMs = 2_000,
): Promise<RoomInfo | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const rooms = await client.listRooms()
      const found = rooms.find(match)
      if (found) return found
    } catch {
      /* transient relay hiccup — keep polling */
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

/** Spawn the interactive `unbien connect` attach flow for a live session and
 *  wait for it (stdio inherited — the child owns the terminal). Returns the
 *  child's exit code. */
export async function handoffToConnect(
  machine: PairedPeer,
  sessionId: string,
): Promise<number> {
  const { spawn } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  // dist/machine.js → dist/main.js (the CLI front door routes `connect`)
  const mainJs = fileURLToPath(new URL("./main.js", import.meta.url))
  const target = machine.name ?? machine.epk.slice(0, 8)
  const child = spawn(
    process.execPath,
    [mainJs, "connect", target, "--session", sessionId],
    { stdio: "inherit", env: process.env },
  )
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)))
}

/** Connect a SessionClient to a machine's control room. Exits on unreachable. */
export async function connectControlRoom(
  machine: PairedPeer,
  relayUrlOverride?: string,
): Promise<SessionClient> {
  const relayUrl = relayUrlOverride ?? machine.relayUrl
  const label = machine.name ?? machine.epk.slice(0, 12)
  const client = new SessionClient(relayUrl, loadOrCreateIdentity(), {
    token: "",
    epk: machine.epk,
    roomId: controlRoomFor(machine.epk),
  })
  try {
    await client.connect({ roomId: controlRoomFor(machine.epk) })
  } catch {
    console.error(`[relay] unreachable: ${relayUrl} (${label})`)
    Shell.exitAfterDrain(1)
    process.exit(1)
  }

  // DISCOVER the daemon's control room from its announce (caps include
  // is_daemon) instead of deriving it from the stored epk — derivation
  // silently targets the wrong room whenever the stored key and the
  // machine's live key disagree in form or vintage.
  const rooms = await client.listRooms()
  const daemonRoom = rooms.find((r) => (r.caps ?? []).includes("is_daemon"))
  if (daemonRoom) client.setRoom(daemonRoom.room_id)

  return client
}

/** Sync local resolution first; on miss, probe the local relay's federated
 *  peer list (gap 5). Exits the process when neither resolves. */
export async function requireMachineOrRemote(
  target: string,
  relayFlag?: string,
): Promise<PairedPeer> {
  const local = resolveMachine(target)
  if (local) return local
  const relayUrl =
    relayFlag ?? process.env.UNBIEN_RELAY ?? process.env.UNBIEN_RELAY_URL ?? ""
  if (!relayUrl) {
    console.error(
      `no machine matching '${target}' and no --relay to probe federation`,
    )
    Shell.exitAfterDrain(1)
    process.exit(1) // narrowing: drain is async
  }
  const remote = await resolveRemoteMachine(target, relayUrl)
  if (remote) {
    console.error(`(federated via ${remote.name} — routing through the local relay)`)
    return remote
  }
  console.error(`no machine matching '${target}' (local or federated)`)
  Shell.exitAfterDrain(1)
  process.exit(1) // narrowing
}
