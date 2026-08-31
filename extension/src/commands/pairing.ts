/**
 * `/unbien` pairing commands: pair (fresh QR), revoke (by shortid), and
 * the shortid completions backing `/unbien revoke <tab>`.
 *
 * Both pair and revoke auto-bootstrap the mesh + relay when down
 * (mirroring each other). Everything they need from index.ts's module
 * scope comes through `CommandDeps` (see deps.ts). Carved out of index.ts
 * (phase 1 of the index.ts carve-up).
 */
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { localConfigExists } from "../session/local_config.js"
import { listPeers, removePeer } from "../pairing/storage.js"
import {
  _inspectPeerRecord,
  type InspectedPeerRecord,
} from "../pairing/peer_trust.js"
import {
  buildQRUri,
  clampPairTtlMs,
  qrSession,
  renderQRAscii,
  TOKEN_TTL_MS,
} from "../pairing/qr.js"
import type { CommandDeps } from "./deps.js"
import { _cmdJoin, _cmdStart } from "./lifecycle.js"

/**
 * `/unbien pair` — always generates a fresh QR when the relay is up.
 *
 * Pre-W2D this rejected with "Already paired with X" once one owner was
 * connected, forcing /unbien stop to pair a second device — the
 * catch-22 the multi-channel refactor was designed to break. Now the new
 * device is **added** to `deps.activePeers` after scanning, while existing
 * owners keep their session.
 */
export async function _cmdPair(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  args = "",
): Promise<void> {
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : ""

  // Auto-bootstrap when services are down. Before this, `/unbien pair`
  // on a fresh terminal forced the user to call `/unbien` first — every
  // session began with the same surprise warning + second command. Now we
  // do the join + relay-start inline so the common "I just opened a
  // terminal and want to pair my phone" flow is a single command.
  //
  // We don't run the first-time wizard here: pair is a focused operation
  // and the wizard prompts are wrong UX in that flow. If there's no local
  // config, the user truly needs to run `/unbien` first to configure.
  if (deps.state === "idle") {
    if (!localConfigExists(cwd)) {
      ctx.ui.notify(
        "[un-bien] First-time setup needed. Run /unbien to configure, then /unbien pair.",
        "warning",
      )
      return
    }
    ctx.ui.notify("[un-bien] Starting mesh + relay before pairing…", "info")
    if (!deps.meshNode) await _cmdJoin(deps, ctx)
    if (deps.state === "idle") await _cmdStart(deps, ctx)
  }

  // Relay must be up — the QR carries a token the app exchanges through
  // the relay. Without a live WS there's nothing for the scan to land on.
  if (deps.state === "idle" || !deps.relay) {
    ctx.ui.notify(
      "[un-bien] Pair requires the relay to be connected. " +
        "Run /unbien to start it (or fix your relay URL via /unbien set-relay).",
      "warning",
    )
    return
  }

  const edKp = deps.cachedEd25519!
  // Embed the user-configured name in the QR so the app shows it on the
  // pairing screen before pair_ok lands (better UX than "remote" or a
  // raw path snippet).
  const sessionName = deps.displayName(cwd)

  // Optional `--ttl <seconds>` — RPC clients (e.g. Cockpit) pass a caller-
  // defined expiry. Defaults to TOKEN_TTL_MS, clamped to the safe window.
  const ttlMatch = /--ttl\s+(\d+)/.exec(args)
  const ttlMs = ttlMatch
    ? clampPairTtlMs(Number(ttlMatch[1]) * 1000)
    : TOKEN_TTL_MS
  const { token, expiresAt } = qrSession.issueToken(ttlMs)
  // The QR room is the ISSUING session's room (session-id-derived `deps.myRoomId`).
  // Pairing is room-scoped to this session (it owns the QR token), so only this
  // session answers the pair_request — no fan-out race. Trust still lands on the
  // MACHINE: pair_ok persists a PairedMachine keyed by epk, and the app then
  // discovers all the machine's sessions via room_announced.
  const roomId = deps.myRoomId ?? deps.deriveRoomId(cwd, sessionName)
  const qrUri = buildQRUri(token, edKp.publicKey, sessionName, roomId)
  // Render both the QR ASCII and the copy-paste URI inside the Pi TUI's
  // chat panel via `pi.sendMessage` — the same channel the SDK uses for
  // agent responses + tool results. `process.stderr.write` (the old QR
  // path via `displayQR`) broke the TUI layout because it bypassed the
  // chat widget and bled into the prompt area. qrcode-terminal v0.12
  // small mode is pure Unicode (█ ▀ ▄ space, no ANSI escapes — see
  // `lib/main.js:48-53`), so embedding the ASCII inside a sendMessage
  // content string renders correctly without raw escape bytes.
  if (deps.pi) {
    const qrAscii = renderQRAscii(qrUri)
    deps.pi.sendMessage({
      customType: "un-bien:pair-code",
      content:
        `📱 Scan to pair:\n\n${qrAscii}\n` +
        `📋 Or copy this pairing code (camera-less devices):\n\n${qrUri}`,
      // Structured payload for RPC clients (e.g. Cockpit): render their own QR
      // from `uri` + show the expiry, without scraping the display string.
      details: { uri: qrUri, token, expiresAt, roomId, name: sessionName },
      display: true,
    })
  }

  ctx.ui.notify(
    `[un-bien] QR ready — valid until ${new Date(expiresAt).toLocaleTimeString()}. ` +
      `Scan with the app, or copy the pairing code printed above.`,
    "info",
  )
  // Returns immediately; the auto-listener transitions to 'paired' on pair_request.
}

export async function _cmdRevoke(
  deps: CommandDeps,
  arg: string,
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  const shortid = arg.trim()
  if (!shortid) {
    ctx.ui.notify(
      "[un-bien] Usage: /unbien revoke <shortid>. Run /unbien list to see shortids.",
      "warning",
    )
    return
  }

  // Revoke needs the relay so the revoked device's live channel is torn down
  // — not just a silent peers.json edit. Auto-bootstrap the mesh + relay when
  // down, mirroring `_cmdPair`.
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : ""
  if (deps.state === "idle") {
    if (!localConfigExists(cwd)) {
      ctx.ui.notify(
        "[un-bien] First-time setup needed. Run /unbien to configure, then /unbien revoke.",
        "warning",
      )
      return
    }
    ctx.ui.notify("[un-bien] Starting mesh + relay before revoking…", "info")
    if (!deps.meshNode) await _cmdJoin(deps, ctx)
    if (deps.state === "idle") await _cmdStart(deps, ctx)
  }
  if (deps.state === "idle" || !deps.relay) {
    ctx.ui.notify(
      "[un-bien] Revoke requires the relay to be connected. " +
        "Run /unbien to start it (or fix your relay URL via /unbien set-relay).",
      "warning",
    )
    return
  }

  const matches = (await listPeers())
    .map(_inspectPeerRecord)
    .filter((peer): peer is InspectedPeerRecord => peer !== null)
    .filter((peer) => peer.rawHandle.startsWith(shortid))

  if (matches.length === 0) {
    ctx.ui.notify(
      "[un-bien] No peer matching that shortid. Run /unbien devices to see shortids.",
      "warning",
    )
    return
  }

  if (matches.length > 1) {
    const collisions = matches
      .map((peer) => peer.rawHandle.slice(0, 8))
      .join(", ")
    ctx.ui.notify(
      `[un-bien] Ambiguous shortid — ${matches.length} matches: ${collisions}. Use mais chars.`,
      "warning",
    )
    return
  }

  const peer = matches[0]!
  await removePeer(peer.rawHandle)
  deps.refreshPairingsCache()

  // Storage removal uses the exact saved representation; the active channel
  // is indexed by its canonical identity.
  if (peer.runtimeKey !== null && deps.activePeers.has(peer.runtimeKey)) {
    deps.detachPeerChannel(peer.runtimeKey)
    deps.refreshFooter()
  }

  ctx.ui.notify(
    `[un-bien] Revoked: ${peer.record.name} (${peer.rawHandle.slice(0, 8)}…)`,
    "info",
  )
}

export async function _shortidCompletions(
  prefix: string,
  valuePrefix = "",
): Promise<Array<{ value: string; label: string }>> {
  const peers = (await listPeers())
    .map(_inspectPeerRecord)
    .filter((peer): peer is InspectedPeerRecord => peer !== null)
  return peers
    .map((peer) => ({
      shortid: peer.rawHandle.slice(0, 8),
      name: peer.record.name,
    }))
    .filter((entry) => entry.shortid.startsWith(prefix))
    .map((entry) => ({
      value: `${valuePrefix}${entry.shortid}`,
      label: `${entry.shortid} (${entry.name})`,
    }))
}
