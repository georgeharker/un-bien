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
import { LOCAL_SESSION_NAME } from "../session/global_config.js"
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
    meshLine = `🟢 Local mesh: ${deps.meshNode.address()} (broker "${LOCAL_SESSION_NAME}"; ${deps.sessionPeerCount} peer${deps.sessionPeerCount === 1 ? "" : "s"})`
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

/**
 * `/unbien devices` — combined device report: relay presence (who has a
 * live WebSocket to the relay) + session attachment (who is attached to THIS
 * session’s channel). Uses the relay’s presence_check when the relay is up;
 * falls back to session-only otherwise.
 */
export async function _cmdList(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  const peers = await listPeers()
  if (peers.length === 0) {
    ctx.ui.notify("[un-bien] No paired devices.", "info")
    return
  }

  const entries = peers.flatMap((record) => {
    const inspected = _inspectPeerRecord(record)
    if (!inspected || inspected.runtimeKey === null) return []
    return [{ inspected, runtimeKey: inspected.runtimeKey }]
  })
  if (entries.length === 0) {
    ctx.ui.notify("[un-bien] No valid paired devices.", "warning")
    return
  }

  // RELAY PRESENCE: who has a live WebSocket right now (regardless of
  // which session they’re attached to). 3s timeout; falls back to
  // session-only if the relay is down or doesn’t respond.
  let onlineSet = new Set<string>()
  if (deps.relay) {
    const states = await new Promise<Array<{ peer: string; online: boolean }>>(
      (resolve) => {
        const timer = setTimeout(() => resolve([]), 3_000)
        const handler = (line: string) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            if (parsed.type !== "presence") return
            clearTimeout(timer)
            resolve(
              (parsed.states as Array<{ peer: string; online: boolean }>) ?? [],
            )
          } catch {
            /* not JSON */
          }
        }
        deps.relay!.on("message", handler)
        deps.relay!.send(
          JSON.stringify({
            type: "presence_check",
            peers: entries.map((e) => e.runtimeKey),
          }),
        )
      },
    )
    onlineSet = new Set(states.filter((s) => s.online).map((s) => s.peer))
  }

  const relayUp = deps.relay !== null
  const lines = entries
    .map(({ inspected, runtimeKey }) => {
      const onRelay = onlineSet.has(runtimeKey)
      const onSession = deps.activePeers.has(runtimeKey)
      const tag = relayUp ? (onRelay ? " 🟢 on relay" : " ⚪ off relay") : ""
      const session = onSession ? " (this session)" : ""
      return `• ${inspected.rawHandle.slice(0, 8)} — ${inspected.record.name}${tag}${session}`
    })
    .join("\n")
  const scope = relayUp ? "" : " (relay off — session attachment only)"
  ctx.ui.notify(`[un-bien] Paired devices:${scope}\n${lines}`, "info")
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
