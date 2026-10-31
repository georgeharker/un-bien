#!/usr/bin/env node
/** `unbien pair-token` — machine-side pairing invite generator.
 *
 * The OTHER half of pairing: `unbien pair <uri>` consumes an invite from
 * the owner's CLI (pairs it as a phone with a machine). This GENERATES
 * the invite from the machine side, so a headless host — the durable
 * host, a GCE VM, any pi box without a TUI — can start pairing by
 * printing a QR / URI for the app to scan or paste.
 *
 * Uses the MACHINE identity (identity.json in $UNBIEN_STATE_DIR or
 * ~/.local/state/un-bien, via getOrCreateEd25519Keypair) — NOT the
 * CLI's owner identity (proxy-identity.json). The CLI running inside
 * a container must generate the invite for the MACHINE it's on, so
 * the app's pair_request routes to the right room.
 *
 * Two modes:
 *   ALWAYS waits (the qrSession is per-process — a print-and-exit token
 *     extension bridge (or the durable host's bridge) is the live
 *     validator: it receives the app's pair_request against its own
 *     QRSession and answers pair_ok.
 *   The CLI itself IS the pairing endpoint (minter + validator):
 *     session — the CLI connects to the relay as the machine's room
 *     holder, listens for the app's pair_request, validates the token,
 *     persists the peer, re-pushes the signed allow-list, replies
 *     pair_ok, and exits 0 (timeout exits 1). The handshake is the
 *     same wire protocol the extension's auto-listener speaks
 *     (relay_lifecycle._handlePairRequest), so the app cannot tell
 *     the difference. Relay pair frames (pair_request / pair_ok) are
 *     exempt from the fail-closed content gate, so pairing bootstraps
 *     before any trust relationship exists.
 *
 * Usage:
 *   unbien pair-token [--name <session-name>] [--room <room-id>]
 *                     [--state-dir <dir>] [--timeout <seconds>]
 *                     [--relay <url>]
 *
 * Output: QR ASCII to stderr (for a terminal), plain unbien://pair URI
 * to stdout (for copy-paste / piping). The token rotates (60s TTL per
 * the token lives for the whole wait window (clamped to the safe
 * pairing bounds) so a scan at any point in it is valid.
 */
import { hostname as osHostname } from "node:os"
import type { QRSession } from "@geohar/un-bien"
import type {
  Ed25519Keypair,
  ServerMessage,
} from "@geohar/un-bien/client"

// NOTE: no static import of "@geohar/un-bien" here. The pairing storage
// module freezes the state root (identity.json / peers.json paths) at
// module load, so a --state-dir flag must land in the env BEFORE the
// barrel (and its transitive storage import) is first evaluated. The
// dynamic imports below run after arg parsing.

/** Default wait window: two minutes to fetch a phone and scan. */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000

export interface PairTokenOptions {
  /** Session name shown in the app's pre-pair preview (the QR's `n`). */
  sessionName: string
  /** The room the app routes pair_request to (the QR's `rm`). */
  roomId: string
  /** --state-dir: where identity.json lives ("" = ambient state dir). */
  stateDir: string
  /** Wait window in ms (token TTL is stretched to cover it). */
  timeoutMs: number
  /** --relay: explicit relay URL ("" = config / env resolution). */
  relayUrl: string
  help: boolean
}

/** Parse `unbien pair-token` args. Pure — no env or process side effects. */
export function parsePairTokenArgs(argv: string[]): PairTokenOptions {
  let sessionName = "durable"
  let roomId = "main"
  let stateDir = ""
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
  let relayUrl = ""
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--name" || arg === "-n") {
      sessionName = argv[++i] ?? sessionName
    } else if (arg === "--room" || arg === "-r") {
      roomId = argv[++i] ?? roomId
    } else if (arg === "--state-dir" || arg === "-s") {
      stateDir = argv[++i] ?? ""
    } else if (arg === "--timeout") {
      const seconds = Number(argv[++i])
      timeoutMs = Number.isFinite(seconds) && seconds > 0
        ? seconds * 1_000
        : DEFAULT_WAIT_TIMEOUT_MS
    } else if (arg === "--relay") {
      relayUrl = argv[++i] ?? ""
    } else if (arg === "--help" || arg === "-h") {
      help = true
    }
  }
  return { sessionName, roomId, stateDir, timeoutMs, relayUrl, help }
}

function printHelp(): void {
  console.log(
    "usage: unbien pair-token [--name <session-name>] [--room <room-id>]\n" +
      "                         [--state-dir <dir>] [--timeout <seconds>]\n" +
      "                         [--relay <url>]\n" +
      "\n" +
      "  Generates a pairing invite (QR + unbien://pair URI) for THIS machine.\n" +
      "  The app scans the QR or the URI is pasted into the app's pair flow.\n" +
      "\n" +
      "  --name, -n         session name shown in the app's pair preview (default: durable)\n" +
      "  --room, -r         pi room id the pair_request routes to (default: main).\n" +
      "                     MUST match the room the target pi session announces;\n" +
      "                     the app routes pair_request to this room.\n" +
      "  --state-dir, -s    where identity.json lives (default: $UNBIEN_STATE_DIR\n" +
      "                     or ~/.local/state/un-bien).\n" +
      "  --timeout <secs>   wait window (default: 120, clamped to the safe\n" +
      "                     pairing bounds 10s–600s). The token lives for the\n" +
      "                     whole window, so a scan at any point in it works.\n" +
      "  --relay <url>      relay URL to listen on (default: UNBIEN_RELAY env or\n" +
      "                     the configured relay).\n" +
      "\n" +
      "  The CLI ALWAYS listens (minter + validator): it connects to the\n" +
      "  relay, joins the machine's room, and answers the app's pair_request\n" +
      "  with pair_ok. A running session/extension on the same room will\n" +
      "  conflict — stop it first, or use it as the validator instead.\n" +
      "  Works for any headless machine, not just the durable host.\n",
  )
}

// ── The machine-side handshake (the extension's auto-listener, standalone) ──

/** The validator surface of a QRSession — structural, so tests can fake it. */
export interface TokenValidator {
  consumeToken(token: string): "ok" | "expired" | "consumed" | "unknown"
}

/** Injectables for `handlePairRequest` — the storage + relay surfaces the
 *  handshake touches, so tests drive it without a filesystem or socket. */
export interface PairRequestDeps {
  /** Token validator — the process's own QRSession (the CLI minted the token). */
  qrSession: TokenValidator
  /** Known-owner lookup (peers.json, canonicalized epk match) — null if new. */
  findKnownPeer(
    appPeerId: string,
  ): Promise<{ name: string; remote_epk: string } | null>
  /** Persist the new owner to peers.json. */
  addPeer(record: {
    name: string
    remote_epk: string
    paired_at: string
  }): Promise<void>
  /** Re-push the signed allow-list AFTER the peer lands in peers.json, so
   *  the relay admits the just-paired owner immediately. */
  pushAllowList(): Promise<void>
}

/** The inbound pair_request frame (ClientMessage's pair_request shape). */
export interface PairRequestFrame {
  id: string
  token: string
  device_name: string
}

/** Identity/context carried on every reply. */
export interface PairHandshakeContext {
  roomId: string
  sessionName: string
  sessionStartedAt: number
  hostname: string
  harness: { name: string; version: string }
}

export type PairHandshakeReply =
  | Extract<ServerMessage, { type: "pair_ok" }>
  | Extract<ServerMessage, { type: "pair_error" }>

/**
 * One pair_request → one reply, mirroring the extension's
 * `_handlePairRequest` (relay_lifecycle.ts) decision for decision:
 *
 *   - already-known owner → idempotent pair_ok WITHOUT consuming a token
 *     (the relay rewrites outer.peer to the challenge-verified sender, so a
 *     known epk is an already-trusted owner — design 01M20G8SE);
 *   - valid fresh token → consume, persist the peer, re-push the allow-list,
 *     pair_ok;
 *   - bad/expired/consumed token → pair_error with the matching code.
 *
 * Returns `settled: true` only when pairing succeeded (the caller stops
 * waiting); a refusal keeps the caller listening — another device may
 * still scan correctly within the window.
 */
export async function handlePairRequest(
  deps: PairRequestDeps,
  ctx: PairHandshakeContext,
  appPeerId: string,
  inner: PairRequestFrame,
): Promise<{ settled: boolean; reply: PairHandshakeReply; deviceName: string }> {
  const deviceName = inner.device_name

  const known = await deps.findKnownPeer(appPeerId)
  if (known) {
    return {
      settled: true,
      deviceName,
      reply: {
        type: "pair_ok",
        in_reply_to: inner.id,
        session_name: ctx.sessionName,
        session_started_at: ctx.sessionStartedAt,
        room_id: ctx.roomId,
        harness: ctx.harness,
        hostname: ctx.hostname,
        protocol_version: 1,
      },
    }
  }

  const status = deps.qrSession.consumeToken(inner.token)
  if (status !== "ok") {
    const code =
      status === "expired"
        ? "token_expired"
        : status === "consumed"
          ? "token_consumed"
          : "token_unknown"
    const message =
      code === "token_expired"
        ? "Ephemeral token expired. Re-run unbien pair-token for a fresh QR."
        : code === "token_consumed"
          ? "Token already consumed by another pair_request."
          : "Token was not issued by this machine."
    return {
      settled: false,
      deviceName,
      reply: { type: "pair_error", in_reply_to: inner.id, code, message },
    }
  }

  try {
    await deps.addPeer({
      name: deviceName,
      remote_epk: appPeerId,
      paired_at: new Date().toISOString(),
    })
    await deps.pushAllowList()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      settled: false,
      deviceName,
      reply: {
        type: "pair_error",
        in_reply_to: inner.id,
        code: "internal_error",
        message: `Failed to persist pairing: ${detail}`,
      },
    }
  }

  return {
    settled: true,
    deviceName,
    reply: {
      type: "pair_ok",
      in_reply_to: inner.id,
      session_name: ctx.sessionName,
      session_started_at: ctx.sessionStartedAt,
      room_id: ctx.roomId,
      harness: ctx.harness,
      hostname: ctx.hostname,
      protocol_version: 1,
    },
  }
}

// ── Command entry ──────────────────────────────────────────────────────────

/** Run the command; resolves with the process exit code. Exported for
 *  tests? No — this drives the real relay; the pieces it composes are the
 *  exported units above. */
async function runPairTokenCommand(argv: string[]): Promise<number> {
  const opts = parsePairTokenArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }

  // --state-dir must land BEFORE the pairing storage module is first
  // imported: it freezes the state root at module load, so applying the
  // env after import would silently keep the ambient state dir.
  if (opts.stateDir) process.env.UNBIEN_STATE_DIR = opts.stateDir

  const unbien = await import("@geohar/un-bien")
  const kp = await unbien.getOrCreateEd25519Keypair()

  // The token lives for the whole wait window (clamped to the safe
  // pairing bounds) so a scan at any point in it is valid.
  const qrSession = new unbien.QRSession()
  const { token } = qrSession.issueToken(
    unbien.clampPairTtlMs(opts.timeoutMs),
  )
  const uri = unbien.buildQRUri(
    token,
    kp.publicKey,
    opts.sessionName,
    opts.roomId,
  )

  // QR to stderr (terminal display), URI to stdout (copy-paste / pipe).
  process.stderr.write(
    `\n${unbien.renderQRAscii(uri)}\n\nScan with the app, or paste this URI:\n\n`,
  )
  console.log(uri)

  return runPairTokenWait(unbien, opts, kp, qrSession)
}

/** The --wait mode: the CLI IS the machine's pairing endpoint. */
async function runPairTokenWait(
  unbien: Awaited<typeof import("@geohar/un-bien")>,
  opts: PairTokenOptions,
  kp: Ed25519Keypair,
  qrSession: QRSession,
): Promise<number> {
  const client = await import("@geohar/un-bien/client")

  const httpUrl = opts.relayUrl || unbien.resolveRelayUrl().url
  if (!httpUrl) {
    process.stderr.write(
      "[pair-token] --wait needs a relay: pass --relay <url> or set UNBIEN_RELAY " +
        "(/unbien set-relay on a machine with a session).\n",
    )
    return 1
  }

  // Best-effort version for the pair_ok harness block.
  let version = "0.0.0"
  try {
    const { readFileSync } = await import("node:fs")
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string }
    if (typeof pkg.version === "string") version = pkg.version
  } catch {
    /* diagnostic only */
  }

  const sessionStartedAt = Date.now()
  const relay = new client.RelayClient(unbien.toWebSocketUrl(httpUrl), kp)
  try {
    await relay.connect({
      roomId: opts.roomId,
      roomMeta: { name: opts.sessionName, cwd: process.cwd() },
    })
  } catch (err) {
    if (err instanceof client.RoomAlreadyOpenError) {
      process.stderr.write(
        "[pair-token] the relay says this identity+room is already connected — " +
          "a session or the durable host is live on this machine. Use the default " +
          "print-and-exit mode and let the running bridge validate the scan.\n",
      )
      return 1
    }
    const detail = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[pair-token] relay connect failed: ${detail}\n`)
    return 1
  }

  const knownPeers = new Map<string, { name: string; remote_epk: string }>()
  const deps: PairRequestDeps = {
    qrSession,
    findKnownPeer: async (appPeerId) => {
      const canon = client.canonicalizeEd25519PublicKey(
        appPeerId,
        "relay owner key",
      )
      for (const record of await unbien.listPeers()) {
        if (
          client.canonicalizeEd25519PublicKey(
            record.remote_epk,
            "stored owner key",
          ) === canon
        )
          return record
      }
      return knownPeers.get(canon) ?? null
    },
    addPeer: async (record) => {
      await unbien.addPeer(record)
      knownPeers.set(
        client.canonicalizeEd25519PublicKey(
          record.remote_epk,
          "paired owner key",
        ),
        record,
      )
    },
    pushAllowList: async () => {
      const [peers, nextVersion] = await Promise.all([
        unbien.listPeers(),
        unbien.nextAllowListVersion(),
      ])
      const { blob, sig } = unbien.buildSignedAllowList(
        kp,
        unbien.pairingAllowList(peers),
        nextVersion,
      )
      relay.sendControl({ type: "pairing_set", blob, sig })
    },
  }
  // The fail-closed relay gate is armed by the allow-list push; pair frames
  // ride the exemption either way, but pushing up front mirrors the
  // extension's connect path exactly.
  await deps.pushAllowList().catch(() => {
    /* pairing still bootstraps — the pair-frame exemption carries it */
  })

  const ctx: PairHandshakeContext = {
    roomId: opts.roomId,
    sessionName: opts.sessionName,
    sessionStartedAt,
    hostname: osHostname(),
    harness: { name: "unbien-cli pair-token", version },
  }

  let finished = false
  const finish = (exitCode: number): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    relay.close()
    process.exit(exitCode)
  }
  const timer = setTimeout(() => {
    process.stderr.write(
      `[pair-token] no pair_request within ${Math.round(opts.timeoutMs / 1000)}s — ` +
        "the invite expired. Re-run to mint a fresh one.\n",
    )
    finish(1)
  }, opts.timeoutMs)
  process.on("SIGINT", () => {
    process.stderr.write("\n[pair-token] cancelled\n")
    finish(130)
  })

  process.stderr.write(
    `[pair-token] waiting for the app to scan (room "${opts.roomId}", ` +
      `relay ${httpUrl}) — Ctrl-C to cancel…\n`,
  )

  relay.on("message", (line: string) => {
    void (async () => {
      let outer: { peer?: string; ct?: string }
      try {
        outer = JSON.parse(line) as { peer?: string; ct?: string }
      } catch {
        return
      }
      if (!outer.peer || !outer.ct) return

      let inner: unknown
      try {
        inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"))
      } catch {
        return
      }
      const frame = inner as Record<string, unknown>
      // The CLI is a pairing endpoint, not a session: the ONLY inbound
      // frame it serves is pair_request (the relay's control frames and
      // anything else are ignored).
      if (typeof frame.type !== "string" || frame.type !== "pair_request")
        return
      if (
        typeof frame.id !== "string" ||
        typeof frame.token !== "string" ||
        typeof frame.device_name !== "string"
      )
        return

      const { settled, deviceName, reply } = await handlePairRequest(
        deps,
        ctx,
        outer.peer,
        { id: frame.id, token: frame.token, device_name: frame.device_name },
      )
      const ct = Buffer.from(JSON.stringify(reply)).toString("base64")
      relay.send(JSON.stringify({ peer: outer.peer, ct }))
      if (settled) {
        process.stderr.write(
          `\n[pair-token] Paired with ${deviceName} — the device is in peers.json. ` +
            "Start the durable host (or a pi session) and the app will reconnect.\n",
        )
        finish(0)
      } else {
        process.stderr.write(
          `[pair-token] refused a scan (${reply.type === "pair_error" ? reply.code : "?"}) — still waiting…\n`,
        )
      }
    })()
  })
  relay.on("close", () => {
    if (!finished) {
      process.stderr.write("[pair-token] relay connection closed\n")
      finish(1)
    }
  })

  // Park until the timer, a pair_ok, or a signal ends the process.
  return new Promise<number>(() => {})
}

// ── Entry ───────────────────────────────────────────────────────────────────
// main.ts loads this module as a command: importing it IS the invocation.
// Guarded on VITEST so the test suite can import the unit surface above
// without running the CLI.
if (process.env.VITEST === undefined) {
  void runPairTokenCommand(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code)
  })
}