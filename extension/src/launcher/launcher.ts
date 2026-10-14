import { Buffer } from "node:buffer"
import { hostname, homedir } from "node:os"
import { RelayClient } from "../transport/relay_client.js"
import { PlainPeerChannel } from "../transport/peer_channel.js"
import {
  getOrCreateEd25519Keypair,
  listPeers,
  pairingAllowList,
  nextAllowListVersion,
} from "../pairing/storage.js"
import { buildSignedAllowList } from "../pairing/signed_allow_list.js"
import { roomIdForControl } from "../rooms.js"
import { _findKnownPeer } from "../pairing/peer_trust.js"
import { _launchSession, _expandTilde, launchDirAllowed } from "../launch.js"
import {
  helloEnvelope,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "../session/rpc_envelope.js"
import { loadConfig, resolveRelayUrl } from "../config.js"
import {
  loadLocalConfig,
  effectiveAllowRemoteLaunch,
} from "../session/local_config.js"
import { launcherLog } from "../session/debug_log.js"
import type { ClientMessage, ServerMessage } from "../protocol/types.js"

/**
 * Regime-2 machine-launcher core (pi-INDEPENDENT — no pi SDK). A lightweight
 * mesh peer that lets a paired app reach a machine with NO live pi session:
 * it joins the machine-level control room (roomIdForControl), advertises the
 * `remote_launch` capability, and on a `session_launch` frame spawns a
 * tmux/herdr window via the shared launch module. Owner-auth reuses the extension's
 * exact gate (relay verifies the peer's key; _findKnownPeer checks peers.json).
 *
 * NOT a pi process: no transcript/rpc/panels, no pairing (pairing happens once
 * via any session extension's QR — the launcher only trusts already-paired owners).
 */

const RECONNECT_DELAY_MS = 3_000

/** Caps the launcher daemon advertises: `remote_launch` gates the app's launch
 *  control; `is_daemon` marks the control room so the app filters it;
 *  `session_resume` gates the app's Resume affordance — without it an older
 *  daemon would silently ignore `sessions_list` (unknown frame) and the app
 *  would show a misleading "No stored sessions" after a 10s timeout. Version
 *  gate, not a feature toggle: every daemon that handles `sessions_list` /
 *  `session_launch {resume}` advertises it. */
const DAEMON_CAPS = ["remote_launch", "is_daemon", "session_resume"] as const

export interface LauncherHandle {
  readonly roomId: string
  readonly epk: string
  stop(): void
}

export interface LauncherOptions {
  /** Test seam: the stored-session lister behind `sessions_list`. Defaults to
   *  pi's SessionManager (lazy import — the daemon stays pi-independent at
   *  runtime until this is first exercised). */
  sessionsLister?: () => Promise<
    Array<{
      path: string
      id: string
      name?: string
      firstMessage: string
      cwd: string
      modified: Date
      messageCount: number
    }>
  >
}

export async function startLauncher(
  options: LauncherOptions = {},
): Promise<LauncherHandle> {
  const sessionsLister = options.sessionsLister
  const kp = await getOrCreateEd25519Keypair()
  const epk = Buffer.from(kp.publicKey).toString("base64url")
  const roomId = roomIdForControl(epk)

  const resolution = resolveRelayUrl()
  if (!resolution.url) {
    throw new Error(
      "un-bien launcher: no relay configured (set UNBIEN_RELAY or the `relay` config key)",
    )
  }
  const relayUrl = resolution.url

  let stopped = false
  let relay: RelayClient | null = null
  // One in-flight reconnect chain, not N: `close` on the CURRENT relay and a
  // failed connectOnce can both schedule; without the guard they multiply.
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const channels = new Map<string, PlainPeerChannel>()

  /** The machine's configured launch backend (rpc is a fast-follow). */
  function configuredBackend(): "tmux" | "herdr" {
    return loadConfig().launch?.backend === "herdr" ? "herdr" : "tmux"
  }

  /** Liveness: answer a stock `ping` with `pong`, mirroring the extension's
   *  transport-control handler (index.ts) so a health check works against an
   *  idle machine too. Distinct from the `presence_status` caps PULL — this is
   *  the plain are-you-there reply, no caps. */
  function handleStockMessage(
    msg: ClientMessage,
    sender: PlainPeerChannel,
  ): void {
    if ((msg as { type?: string }).type === "ping") {
      sender.send({
        type: "pong",
        in_reply_to: (msg as { id?: string }).id,
      } as ServerMessage)
    }
  }

  /** Handle a ub-frame from an attached owner. `presence_status` is the
   *  DAEMON-SPECIFIC caps PULL (design 01M1813Q) — reply with caps + hostname +
   *  backend. `session_launch` mirrors the extension's _routeUnBienPlaneFrom handler:
   *  per-cwd opt-in, machine-config backend, clean exec (no keystrokes). */
  async function handleUbFrame(
    env: EnvelopeMessage,
    sender: PlainPeerChannel,
    peer: string,
  ): Promise<void> {
    if (env.ub === undefined) return
    const frame = env.ub as Record<string, unknown>
    launcherLog(`launcher ub frame: type=${String(frame.type)} peer=${peer}`)
    // This handler runs async-void: an uncaught throw here would kill the
    // whole daemon with no trace. Log EVERYTHING, answer with the daemon's
    // error frame, and stay alive.
    try {

    if (frame.type === "presence_status") {
      sender.sendEnvelope({
        ub: {
          type: "presence_status",
          caps: [...DAEMON_CAPS],
          hostname: hostname(),
          backend: configuredBackend(),
          ...(typeof frame.id === "string" ? { in_reply_to: frame.id } : {}),
        },
      })
      return
    }

    // Prototype (cli resume-session): list stored sessions via pi's public
    // SessionManager — the daemon is pi-INDEPENDENT at runtime, but the
    // package (and therefore the dep) ships with it, so this import is free.
    // Lister is injectable so tests don't scan the real session dir.
    if (frame.type === "sessions_list") {
      const defaultLister = async (): Promise<
          Array<{
            path: string
            id: string
            name?: string
            firstMessage: string
            cwd: string
            modified: Date
            messageCount: number
          }>
        > => {
          const { SessionManager } = await import("@earendil-works/pi-coding-agent")
          const scope = frame.scope === "all" ? "all" : "cwd"
          const cwd =
            typeof frame.cwd === "string" && frame.cwd.length > 0
              ? _expandTilde(frame.cwd)
              : process.cwd()
          // Session dir resolution MUST mirror pi's CLI (main.js): the env
          // session dir wins — the default agentDir/sessions is a DIFFERENT
          // store from what the user's pi actually writes (found live: 4
          // sessions in agentDir/sessions vs 475 in PI_CODING_AGENT_SESSION_DIR).
          const envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
          const sessionDir = envSessionDir
            ? _expandTilde(envSessionDir)
            : undefined
          const found =
            scope === "all"
              ? await SessionManager.listAll(sessionDir)
              : await SessionManager.list(cwd, sessionDir)
          return found.map((s) => ({
            path: s.path,
            id: s.id,
            ...(s.name ? { name: s.name } : {}),
            firstMessage: s.firstMessage,
            cwd: s.cwd,
            modified: s.modified,
            messageCount: s.messageCount,
          }))
        }
      // A lister throw must NOT kill the daemon (this handler runs async-void
      // — an unhandled rejection exits node): reply with the daemon's standard
      // error frame (same inner shape as unknown_peer / permission_denied).
      let all
      try {
        all = await (sessionsLister ?? defaultLister)()
      } catch (err) {
        const detail = String(err instanceof Error ? err.message : err).slice(0, 200)
        launcherLog(`sessions_list: lister failed: ${detail}`)
        sender.send({
          type: "error",
          code: "list_failed",
          message: detail,
          in_reply_to: typeof frame.id === "string" ? frame.id : "",
        })
        return
      }
      launcherLog(`sessions_list: ${all.length} sessions (scope=${String(frame.scope)})`)
      const filter =
        typeof frame.filter === "string" && frame.filter.trim().length > 0
          ? frame.filter.trim().toLowerCase()
          : null
      const sessions = all
        .filter((s) => {
          if (!filter) return true
          return (
            (s.name ?? "").toLowerCase().includes(filter) ||
            s.firstMessage.toLowerCase().includes(filter)
          )
        })
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .slice(0, 50)
        .map((s) => ({
          path: s.path,
          id: s.id,
          ...(s.name ? { name: s.name } : {}),
          summary: s.firstMessage.slice(0, 120),
          cwd: s.cwd,
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
        }))
      sender.sendEnvelope({
        ub: {
          type: "sessions_list_result",
          id: typeof frame.id === "string" ? frame.id : "",
          in_reply_to: typeof frame.id === "string" ? frame.id : "",
          sessions,
        },
      })
      return
    }

    if (frame.type !== "session_launch") return
    const cwd = _expandTilde(
      typeof frame.cwd === "string" && frame.cwd.length > 0
        ? frame.cwd
        : process.cwd(),
    )
    if (!effectiveAllowRemoteLaunch(loadLocalConfig(cwd))) {
      launcherLog("launcher session_launch: remote launch disabled on this machine")
      return
    }
    // Re-check pairing FRESH per launch (design 01M211VW9): the launcher has NO
    // revoke-detach path (unlike the extension), so consult peers.json each
    // request — a revoked owner stops launching without a daemon restart.
    if (!(await _findKnownPeer(peer))) {
      launcherLog(`launcher session_launch REFUSED: peer ${peer} not in known-peers (re-scan QR) — the error goes to the sender, this line is the log record`)
      sender.send({
        type: "error",
        code: "unknown_peer",
        message: "Peer not paired — re-scan QR",
      })
      return
    }
    // Directory allow-list, read FRESH each request.
    if (!launchDirAllowed(cwd, loadConfig().launch?.dirs)) {
      launcherLog("launcher session_launch: cwd not in launch.dirs allow-list")
      sender.send({
        type: "error",
        code: "permission_denied",
        message: "Remote launch not permitted for this directory",
      })
      return
    }
    const launchError = _launchSession(
      configuredBackend(),
      cwd,
      typeof frame.name === "string" ? frame.name : undefined,
      typeof frame.resume === "string" && frame.resume.trim().length > 0
        ? frame.resume.trim()
        : undefined,
      // Launch correlation: pi is spawned with UNBIEN_LAUNCH_REQ=<id> and
      // echoes it in room_meta, so the launching app can match the announcing
      // room to THIS request and auto-open the chat (resume flow).
      typeof frame.id === "string" && frame.id.trim().length > 0
        ? frame.id.trim()
        : undefined,
    )
    if (launchError) launcherLog(`launcher session_launch error: ${launchError}`)
    } catch (err) {
      const detail = String(err instanceof Error ? err.message : err).slice(0, 200)
      launcherLog(`launcher ub frame FAILED (${String(frame.type)}): ${detail}`)
      try {
        sender.send({
          type: "error",
          code: "handler_failed",
          message: detail,
        })
      } catch {
        /* relay down — the log line above is the record */
      }
    }
  }

  async function gateAndAttach(
    r: RelayClient,
    peer: string,
    firstInner: unknown,
    ownerRoom: string,
  ): Promise<void> {
    const known = await _findKnownPeer(peer)
    if (!known) {
      // Relay-verified but not a paired owner (never paired / revoked). Signal
      // so the app can react, mirroring the extension's unknown-peer reply.
      try {
        const errCt = Buffer.from(
          JSON.stringify({
            type: "error",
            code: "unknown_peer",
            message: "Peer not paired — re-scan QR",
          }),
        ).toString("base64")
        r.send(JSON.stringify({ peer, ct: errCt }))
      } catch {
        /* relay down — nothing to signal */
      }
      return
    }
    if (channels.has(peer)) return

    const channel = new PlainPeerChannel(
      r,
      peer,
      ownerRoom, // replies route to the OWNER's room, not our control room
      (msg) => handleStockMessage(msg, channel), // liveness ping->pong
      () => channels.delete(peer),
      (env) => {
        void handleUbFrame(env, channel, peer)
      },
      undefined, // sessionIdProvider
      true, // includeRoomInOuter
    )
    channels.set(peer, channel)
    // Advertise machine caps up front so the app enables its launch control for
    // this control room. No sessionId — the launcher has no pi session.
    channel.sendEnvelope(helloEnvelope([...DAEMON_CAPS]))
    launcherLog(
      `launcher: owner ${peer.slice(0, 8)} (${known.name}) attached; caps sent`,
    )
    // The channel didn't see the line that triggered the attach — route it.
    if (isEnvelopeFrame(firstInner as Record<string, unknown>)) {
      void handleUbFrame(firstInner as EnvelopeMessage, channel, peer)
    }
  }

  function onMsg(r: RelayClient, line: string): void {
    let outer: { peer?: string; room?: string; ct?: string }
    try {
      outer = JSON.parse(line) as { peer?: string; ct?: string }
    } catch {
      return
    }
    if (!outer.peer || !outer.ct) return
    if (channels.has(outer.peer)) return // its PlainPeerChannel handles routing
    // The relay rewrites outer.room to the SENDER's registered room — the
    // reply-to address for this owner (CLI: its control-room join; the app:
    // its roomless/main registration). Replies must mirror it per-channel.
    const senderRoom = outer.room
    if (!senderRoom) return

    let inner: unknown
    try {
      inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"))
    } catch {
      return
    }
    if (!inner || typeof inner !== "object") return
    void gateAndAttach(r, outer.peer, inner, senderRoom)
  }

  function scheduleReconnect(): void {
    if (stopped) return
    if (reconnectTimer) return // a retry chain is already pending
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped) return
      connectOnce().catch(() => scheduleReconnect())
    }, RECONNECT_DELAY_MS)
  }

  async function connectOnce(): Promise<void> {
    launcherLog(`connectOnce: dialing ${relayUrl} (room ${roomId})`)
    const r = new RelayClient(relayUrl, kp)
    relay = r
    // CONNECT TIMEOUT: a hung r.connect (observed once under launchd — the
    // promise pending forever with no I/O and no error) must convert to a
    // retry, not a permanent silent stall. 15s: generous enough for slow
    // starts, tight enough that a dead relay costs ~2 retries/min.
    let connectTimedOut = false
    const connectTimer = setTimeout(() => {
      connectTimedOut = true
      try {
        r.close()
      } catch {
        /* already closed */
      }
    }, 15_000)
    connectTimer.unref()
    r.on("message", (line: string) => onMsg(r, line))
    r.on("close", () => {
      channels.clear()
      if (!stopped) scheduleReconnect()
    })
    try {
      await r.connect({
        roomId,
        // caps ride room_meta so the app filters the control room from the announce.
        roomMeta: { name: hostname(), cwd: homedir(), caps: [...DAEMON_CAPS] },
      })
    } finally {
      clearTimeout(connectTimer)
    }
    if (connectTimedOut) {
      // The close() above surfaces as a connect failure/rejection upstream;
      // belt-and-braces in case the close raced a late resolve.
      throw new Error("relay connect timed out after 15s")
    }
    // ALLOW-LIST PARITY (design 01M23MKVG + 01M23MB5D): the launcher is the
    // machine's THIRD connect path but the ONLY one live on a pi-less machine —
    // without its own signed pairing_set push, a fresh relay (or wiped DB)
    // leaves it unreachable until a pi session happens to start. Same machine
    // key = same signer = exactly as authoritative as the extension's push.
    // The relay's monotonic StaleVersion rejection makes a concurrent push
    // from a sibling extension benign (higher version wins, no downgrade).
    try {
      const [peers, version] = await Promise.all([
        listPeers(),
        nextAllowListVersion(),
      ])
      const owners = pairingAllowList(peers)
      const { blob, sig } = buildSignedAllowList(kp, owners, version)
      r.sendControl({ type: "pairing_set", blob, sig })
    } catch (err) {
      launcherLog(`launcher pairing_set push failed: ${String(err)}`)
    }
    launcherLog(
      `launcher: connected to control room ${roomId} (epk ${epk.slice(0, 12)}…)`,
    )
  }

  // A DAEMON must not die on a first-connect race: a profile `up` can start
  // the launcher in the same breath as the relay, whose port may not be
  // listening yet — a fatal initial connect made the launcher exit(1) and the
  // sharedserver's health check merely WARN (the "tends to just die" symptom).
  // Post-connect drops already retried; the INITIAL connect now does too.
  try {
    await connectOnce()
  } catch (err) {
    launcherLog(
      `launcher: initial connect failed (${err instanceof Error ? err.message : String(err)}) — retrying every ${RECONNECT_DELAY_MS}ms`,
    )
    scheduleReconnect()
  }

  return {
    roomId,
    epk,
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      for (const ch of channels.values()) {
        try {
          ch.detach()
        } catch {
          /* best-effort */
        }
      }
      channels.clear()
      relay?.close()
    },
  }
}
