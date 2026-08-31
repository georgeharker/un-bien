/**
 * `/unbien` info commands: status, peers, devices/list, config, identity.
 *
 * Read-only views over the composition root's state — everything they need
 * from index.ts's module scope comes through `CommandDeps` (see deps.ts).
 * Carved out of index.ts (phase 1 of the index.ts carve-up).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveRelayUrl } from "../config.js"
import { describeIdentity, listPeers } from "../pairing/storage.js"
import { _inspectPeerRecord } from "../pairing/peer_trust.js"
import { formatPeerInventory } from "../session/peer_inventory.js"
import type { CommandDeps } from "./deps.js"

/**
 * `/unbien status` — full state snapshot. Two lines: local mesh + relay.
 *
 * Always callable; safe when nothing is up (renders the off variants).
 * Reuses the same icons as the footer so terminal + status output stay
 * visually consistent.
 */
export function _cmdStatus(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui">,
): void {
  const relayUrl = deps.relayUrl ?? resolveRelayUrl().url ?? "not configured"

  // Mesh line
  let meshLine: string
  if (deps.meshNode) {
    const name = deps.meshNode.name()
    meshLine = `🟢 Local mesh: connected as "${name}" (${deps.sessionPeerCount} peer${deps.sessionPeerCount === 1 ? "" : "s"})`
  } else {
    meshLine = "⚪ Local mesh: not connected"
  }

  // Relay line — paired state is derived from deps.activePeers.size now.
  let relayLine: string
  if (deps.state === "idle") {
    relayLine = `⚪ Relay: off (${relayUrl}) — run /unbien to start`
  } else if (deps.activePeers.size > 0) {
    const count = deps.activePeers.size
    const shortids = [...deps.activePeers.keys()]
      .map((peerId) => peerId.slice(0, 8))
      .join(", ")
    relayLine = `🟢 Relay: ${count} owner${count === 1 ? "" : "s"} online (${shortids}) (${relayUrl})`
  } else {
    relayLine = deps.hasGlobalPairings
      ? `🟢 Relay: on, waiting for an app to connect (${relayUrl})`
      : `🟡 Relay: on, waiting for first pairing (${relayUrl})`
  }

  ctx.ui.notify(`[un-bien]\n  ${meshLine}\n  ${relayLine}`, "info")
}

/**
 * Plan/25 Wave D: `/unbien peers`.
 *
 * Queries the local broker for the aggregated peer inventory (`list_peers`
 * returns locals + cross-PC entries prefixed with `<pc_label>:`). Formats
 * the result grouped by source so users can see at a glance who's on
 * their machine vs. on a paired sibling Pi.
 */
export async function _cmdPeers(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  if (!deps.meshNode) {
    ctx.ui.notify(
      "[un-bien] Not on the local mesh. Run /unbien to join.",
      "warning",
    )
    return
  }
  let peers: string[]
  try {
    const reply = await deps.meshNode.request(
      "broker",
      { type: "list_peers" },
      2000,
    )
    peers = (reply.body as { peers?: string[] } | null)?.peers ?? []
  } catch (err) {
    ctx.ui.notify(`[un-bien] peers list failed: ${String(err)}`, "error")
    return
  }
  // Exclude self from the printed list — `list_peers` returns every peer
  // registered with the broker including the caller, which is noise here.
  const selfName = deps.meshNode.name()
  ctx.ui.notify(
    `[un-bien] peers:\n${formatPeerInventory(peers, selfName)}`,
    "info",
  )
}

export async function _cmdList(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  const peers = await listPeers()
  if (peers.length === 0) {
    ctx.ui.notify("[un-bien] No paired devices.", "info")
    return
  }
  // Multi-channel (W2D): each peer is either `online` (channel attached
  // right now) or `offline` (in peers.json but not connected). Replaces
  // the singleton " (active)" marker that only ever marked one peer.
  const lines = peers
    .flatMap((record) => {
      const inspected = _inspectPeerRecord(record)
      if (!inspected) return []
      const tag =
        inspected.runtimeKey !== null &&
        deps.activePeers.has(inspected.runtimeKey)
          ? " 🟢 online"
          : " ⚪ offline"
      return `• ${inspected.rawHandle.slice(0, 8)} — ${inspected.record.name}${tag}`
    })
    .join("\n")
  ctx.ui.notify(`[un-bien] Paired devices:\n${lines}`, "info")
}

/**
 * `/unbien config` — print the effective relay URL and where it came from.
 *
 * Documented in the README ("Verify the active URL and its source") and in
 * CLAUDE.md, but like the `relay` family (issue #119) it had no handler and
 * fell through to the status panel, which shows the URL but not the source —
 * so `env` vs `config` vs `default` was unverifiable without a restart.
 */
export function _cmdConfig(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui">,
): void {
  const { url, source } = resolveRelayUrl()
  const origin =
    source === "env"
      ? "UNBIEN_RELAY environment variable"
      : source === "config"
        ? "extensions/un-bien.json (set via /unbien set-relay)"
        : "not set — run /unbien set-relay <url> or set UNBIEN_RELAY"
  const live =
    deps.relayUrl && deps.relayUrl !== url
      ? `\n  ⚠ Live connection still on ${deps.relayUrl} — run /unbien relay stop then /unbien relay start to apply.`
      : ""
  ctx.ui.notify(
    `[un-bien]\n  Relay URL: ${url ?? "(none)"}\n  Source: ${source} — ${origin}${live}`,
    "info",
  )
}

/**
 * `/unbien identity` — report NON-SECRET identity state (active EPK, backend,
 * resolved source). The private seed is NEVER shown: command output is
 * LLM-visible, so extraction stays a manual `cat`/keychain op. Read-only
 * (never mints).
 */
export async function _cmdIdentity(
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  const info = await describeIdentity()
  const backendLine =
    info.backend === "file" ? `file (${info.filePath})` : "keychain"
  const epkLine = info.epk ?? "(none yet — minted on first use)"
  const sourceLine = info.detail
    ? `${info.source} — ${info.detail}`
    : info.source
  ctx.ui.notify(
    `[un-bien] identity\n  Backend: ${backendLine}\n  EPK (public): ${epkLine}\n  Source: ${sourceLine}`,
    info.source === "error" ? "error" : "info",
  )
}
