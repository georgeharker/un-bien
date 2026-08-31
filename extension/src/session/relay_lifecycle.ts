/**
 * Relay lifecycle + owner management.
 *
 * Everything that owns the relay connection's lifetime and the attached-owner
 * set: full/partial teardown (`_goIdle` / `_onRelayClose`), the reconnect
 * backoff machine, the relay-state event + transparent control channel
 * (Cockpit), per-owner channel attach/detach + broadcast fanout, the
 * pair_request auto-listener, and the pair handshake payload
 * (capabilities / harness identity).
 *
 * Seam: index.ts (composition root) owns every piece of shared mutable module
 * state (`_state`, `_relay`, `_activePeers`, …) and the helpers that stayed
 * there (`_refreshFooter`, `_routeClientMessageFrom`, …); they are threaded
 * through `RelayLifecycleDeps`. This module MUST NOT import `../index.js`
 * (circular import). The reconnect timers + attempt counter, the relay
 * lifecycle generation, and the last-emitted relay status are RELAY-OWNED and
 * live here in module scope; index reaches the generation + timer only through
 * the exported accessors (session_shutdown bump, CommandDeps get/set, the
 * test-hooks reconnect probe).
 *
 * NOT here: `_renameAgent` (rename touches mesh + config + relay; stays in
 * index and is passed in as a dep), `_revokeActiveOwnerRuntime` /
 * `_reportRevocationByFingerprint` (revoke reporting; index), `_getState`
 * (public state snapshot; index).
 */
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import { fileURLToPath } from "node:url"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { qrSession } from "../pairing/qr.js"
import { addPeer } from "../pairing/storage.js"
import type { Ed25519Keypair } from "../pairing/crypto.js"
import { _findKnownPeer } from "../pairing/peer_trust.js"
import type { SelfRevoke } from "../mesh/self_revoke.js"
import type { MeshTopologySnapshot } from "../mesh/siblings.js"
import type {
  ClientMessage,
  PairErrorCode,
  ServerMessage,
  ThinkingLevel,
} from "../protocol/types.js"
import { RelayClient } from "../transport/relay_client.js"
import { PlainPeerChannel } from "../transport/peer_channel.js"
import { toWebSocketUrl } from "../config.js"
import type { MeshNode } from "./mesh_node.js"
import {
  helloEnvelope,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "./rpc_envelope.js"
import { envLog } from "./debug_log.js"
import { effectiveAllowRemoteLaunch, loadLocalConfig } from "./local_config.js"
import { clearPendingReceivedImagePreviews } from "./received_images.js"
import type { CommandDeps } from "../commands/deps.js"
import { _cmdStart } from "../commands/lifecycle.js"

/**
 * The seam between index.ts (composition root) and the relay lifecycle +
 * owner-management code.
 *
 * Same shape as `CommandDeps`: index.ts owns every piece of mutable module
 * state this code touches; it reaches it only through accessor closures /
 * function references on this object. Members are added exactly as the moved
 * code requires them — nothing speculative. Mutable state written here is a
 * get/set pair; state only read is `readonly`.
 */
export interface RelayLifecycleDeps {
  // ── Mutable module state (accessor closures over index.ts's variables) ──

  /** Remote state machine: `idle` → `started` (`paired` is derived). */
  state: "idle" | "started"
  /** Live relay WS connection, null when off. */
  relay: RelayClient | null
  /** URL used by the current relay connection (http(s):// canonical form). */
  relayUrl: string | null
  /** Shortid of the most recently attached peer (UX hint only). */
  peerShort: string
  /** Auto-listener dispose fn for the current relay connection. */
  stopAutoListener: (() => void) | null
  /** SelfRevoke topology producer for the relay path. */
  selfRevoke: SelfRevoke | null
  /** Epoch guarding the SelfRevoke producer identity. */
  selfRevokeEpoch: number
  /** Producer epoch that last published a verified topology. */
  selfRevokeTopologyReadyEpoch: number
  /** Last topology snapshot published by the producer. */
  selfRevokeTopology: MeshTopologySnapshot | null
  /** Root replacement authority epoch (session replacements). */
  rootLifecycleGeneration: number

  // ── Read-only state ──────────────────────────────────────────────────────

  /** Connected owner channels, keyed by canonical owner pubkey. */
  readonly activePeers: Map<string, PlainPeerChannel>
  /** Local UDS mesh node, null when not joined. */
  readonly meshNode: MeshNode | null
  /** Cached Ed25519 identity of this connect cycle. */
  readonly cachedEd25519: Ed25519Keypair | null
  /** THE App↔Pi room id for the current chat session. */
  readonly myRoomId: string | null
  /** Room meta hello payload persisted for reconnect replay. */
  readonly myRoomMeta: {
    name: string
    cwd: string
    model?: string
    thinking?: ThinkingLevel
    working?: boolean
    sessionId?: string
  } | null
  /** Epoch ms the state machine entered 'started'. */
  readonly sessionStartedAt: number | null
  /** Most recent command ctx (pair_request cwd fallback). */
  readonly lastCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null
  /** Set by session_shutdown; blocks listener authority until rearm. */
  readonly disposed: boolean
  /** The ROOT session's ExtensionAPI (never a subagent child's). */
  readonly pi: ExtensionAPI | null
  /** The root session's pi sessionId, null pre-sessionManager. */
  readonly rootSessionId: string | null
  /** The `/unbien` command seam index.ts builds (`_cmdStart` for relay:on). */
  readonly commandDeps: CommandDeps

  // ── Helpers (direct function references from index.ts) ──────────────────

  /** The ROOT session's state record (turn teardown + sessionId reads). */
  rootState(): {
    turnId: string | null
    sessionManager?: { getSessionId(): string } | null
  }
  /** Test-visible state: `idle` | `started` | derived `paired`. */
  getState(): "idle" | "started" | "paired"
  /** Repaint the footer status line from current state. */
  refreshFooter(
    ctx?: { ui?: { setStatus?: unknown; setTitle?: unknown } } | null,
  ): void
  /** ctx.ui.notify that never throws (stale-ctx safe). */
  safeNotify(
    message: string,
    level?: "info" | "warning" | "error",
    preferred?: { ui?: unknown } | null,
  ): void
  /** Reads peers.json and refreshes the global-pairings cache + footer. */
  refreshPairingsCache(): void
  /** Friendly (configured or derived) agent name for a cwd. */
  displayName(cwd: string): string
  /** Room id for (cwd, name), preferring the stable pi session id. */
  deriveRoomId(cwd: string, name: string): string
  /** Attach the cross-PC bridge once relay + leader are both up. */
  attachBridgeIfReady(): void
  /** Stock ClientMessage router (ping / cancel / pre-attach paths). */
  routeClientMessageFrom(
    sender: PlainPeerChannel,
    msg: ClientMessage,
    ctx: Pick<ExtensionContext, "abort">,
  ): void
  /** Envelope-carried pi RpcCommand router. */
  routeRpcCommandFrom(sender: PlainPeerChannel, env: EnvelopeMessage): void
  /** un-bien plane (session_sync / session_launch) router. */
  routeUnBienPlaneFrom(sender: PlainPeerChannel, env: EnvelopeMessage): void
  /** Always-fresh ctx (session_start ctx preferred over captured ones). */
  liveCtx(): { ui?: unknown } | null
  /** Fallback ctx when no live ctx exists (notify/abort no-ops). */
  readonly noopCtx: { ui: { notify(): void }; abort(): void }
  /** Rename this agent (mesh + relay room) — control `rename:<name>`. */
  renameAgent(newName: string): Promise<void>
}

/** Sentinel prefix for a transparent control message an RPC client sends on the
 *  `prompt` channel (stdin). The `input` hook intercepts it, runs the action,
 *  and swallows it (`action:"handled"`) so it never becomes an LLM turn or a
 *  transcript entry. Starts with NUL so it can't collide with real user input
 *  and doesn't begin with "/" (which would route to the command parser). */
export const CTRL_PREFIX = "\x00un-bien-ctrl:"

/** Relay connectivity as seen by an RPC client (Cockpit). Derived from
 *  `_state` + `_relay`: "disconnected" = relay off (idle); "connected" = live
 *  WS; "reconnecting" = was on, WS dropped, retrying. Surfaced via the
 *  `un-bien:relay-state` custom message (see `_emitRelayState`). */
export type RelayConnectivity = "connected" | "reconnecting" | "disconnected"

/** Last `RelayConnectivity` emitted, for change-dedup. Starts "disconnected"
 *  (the process boots with the relay down). */
let _lastRelayStatus: RelayConnectivity | null = null

// ── Relay reconnect state ─────────────────────────────────────────────────────
// Backoffs in ms: 1s, 2s, 5s, 10s, 30s, then stays at 30s.
const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _reconnectAttempt = 0
// Every initial connect/reconnect candidate captures this generation. Stop,
// relay-off, and an unexpected close invalidate older async continuations.
let _relayLifecycleGeneration = 0

/** Relay-lifecycle generation (module-local). index.ts bumps it on
 *  session_shutdown and fronts it through the CommandDeps get/set pair. */
export function _getRelayLifecycleGeneration(): number {
  return _relayLifecycleGeneration
}

/** @see _getRelayLifecycleGeneration */
export function _setRelayLifecycleGeneration(value: number): void {
  _relayLifecycleGeneration = value
}

/** Pending reconnect timer (module-local) — the test-hooks reconnect probe. */
export function _getReconnectTimer(): ReturnType<typeof setTimeout> | null {
  return _reconnectTimer
}

// ── Multi-channel helpers ─────────────────────────────────────────────────────

/** Returns true when at least one owner is attached. Derived `paired` UX. */
export function _anyPeerActive(deps: RelayLifecycleDeps): boolean {
  return deps.activePeers.size > 0
}

/** Broadcast for the extension_ui bridge. The bridge only ever emits
 *  `extension_ui_request`, sent ENVELOPE-ONLY as a `{rpc}` frame (the wire
 *  shape mirrors the SDK rpc contract 1:1). No stock fallback. */
export function _uiBroadcast(
  deps: RelayLifecycleDeps,
  msg: ServerMessage,
): void {
  if (msg.type === "extension_ui_request")
    _broadcastEnvelope(deps, { rpc: msg })
}

/** Broadcast for the panel bridge. The bridge only ever emits `panel_update`,
 *  forwarded ENVELOPE-ONLY as `{evt:{channel:"panel", data}}` (the {evt} plane);
 *  the app folds it into its panel store. No stock fallback. */
export function _panelBroadcast(
  deps: RelayLifecycleDeps,
  msg: ServerMessage,
): void {
  if (msg.type === "panel_update")
    _broadcastEnvelope(deps, { evt: { channel: "panel", data: msg } })
}

/** Fan an rpc-envelope frame out to every attached peer (base64 ct via each
 *  channel) — the single owner-fanout path for `{ rpc | evt }` messages. */
export function _broadcastEnvelope(
  deps: RelayLifecycleDeps,
  env: EnvelopeMessage,
): void {
  {
    // Observability only (not a route gate): watch the {rpc|evt} wire during
    // e2e bring-up. Frame type only — payloads can be large / carry images.
    const kind = env.rpc
      ? `rpc:${(env.rpc as { type?: string }).type ?? "?"}`
      : `evt:${env.evt?.channel ?? "?"}`
    envLog(`envelope -> ${deps.activePeers.size} peer(s): ${kind}`)
  }
  for (const ch of deps.activePeers.values()) {
    try {
      ch.sendEnvelope(env)
    } catch {
      /* best-effort per channel */
    }
  }
}

/**
 * Adds an owner's channel to `_activePeers`. Also updates the UX hint
 * `_peerShort` (last-attached shortid) so the footer + status can pick
 * a representative device when only one is connected.
 */
function _attachPeerChannel(
  deps: RelayLifecycleDeps,
  appPeerId: string,
  channel: PlainPeerChannel,
): void {
  deps.activePeers.set(appPeerId, channel)
  deps.peerShort = appPeerId.slice(0, 8)
}

/** Detaches a single owner's channel + removes it from the map. Used by
 *  `_onPeerDisconnect`, `_cmdRevoke`, and the SelfRevoke callback. */
export function _detachPeerChannel(
  deps: RelayLifecycleDeps,
  appPeerId: string,
): void {
  const ch = deps.activePeers.get(appPeerId)
  if (!ch) return
  try {
    ch.detach()
  } catch {
    /* best-effort */
  }
  deps.activePeers.delete(appPeerId)
  if (deps.peerShort === appPeerId.slice(0, 8)) {
    // Pick a different remaining peer for the UX hint, or clear when none.
    const next = deps.activePeers.keys().next().value
    deps.peerShort = next ? next.slice(0, 8) : ""
  }
}

// ── Transition helpers ────────────────────────────────────────────────────────

/**
 * Full teardown: stop listener, detach channel, close relay → idle.
 */
export function _goIdle(deps: RelayLifecycleDeps): void {
  deps.rootLifecycleGeneration += 1
  _relayLifecycleGeneration += 1

  // Cancel any pending reconnect attempt. Critical: /unbien stop must
  // win the race against a scheduled reconnect.
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
  _reconnectAttempt = 0

  deps.stopAutoListener?.()
  deps.stopAutoListener = null

  // Tear down every per-owner channel and clear the map.
  for (const ch of deps.activePeers.values()) {
    try {
      ch.detach()
    } catch {
      /* best-effort */
    }
  }
  deps.activePeers.clear()
  deps.peerShort = ""
  deps.rootState().turnId = null
  clearPendingReceivedImagePreviews()

  // Invalidate async producers and bridge ownership before closing the host
  // Relay. A synchronous/delayed close callback must observe stale identity.
  const producer = deps.selfRevoke
  deps.selfRevoke = null
  deps.selfRevokeEpoch += 1
  deps.selfRevokeTopologyReadyEpoch = -1
  deps.selfRevokeTopology = null
  producer?.stop()

  deps.meshNode?.detachBridge()

  const relay = deps.relay
  deps.relay = null
  deps.relayUrl = null
  relay?.close()

  // Preserve _sessionStartedAt + _messageBuffer across stop/start cycles.
  // The Pi agent session outlives the relay connection — `message_end` keeps
  // firing for terminal turns even while idle, and the buffer must survive
  // so those turns appear in the next session_sync. Only a Pi process
  // restart resets these (init-time values).

  deps.state = "idle"
  deps.refreshFooter()
  _emitRelayState(deps) // → disconnected
}

/**
 * Called when the relay WS closes unexpectedly (network drop, relay restart,
 * etc.). Does a **partial** teardown — keeps `_sessionStartedAt`, `_messageBuffer`,
 * `_relayUrl`, `_cachedEd25519`, `_peerShort` so the session can resume on
 * reconnect — and schedules an `_attemptReconnect`.
 *
 * Peer (app) reconnect after a successful relay reconnect is handled by the
 * existing auto-listener via `peers.json` lookup, so we don't need to track
 * the prior peer here; we just go back to `started` and wait.
 */
export function _onRelayClose(
  deps: RelayLifecycleDeps,
  closedRelay: RelayClient,
): void {
  if (deps.relay !== closedRelay) return // delayed close from a replaced Relay
  if (deps.state === "idle") return // already torn down (e.g. /unbien stop)

  _relayLifecycleGeneration += 1
  deps.stopAutoListener?.()
  deps.stopAutoListener = null

  // Detach every per-owner channel — relay is gone, none can route. The
  // auto-listener re-attaches owners after `_attemptReconnect` succeeds
  // (via the same known-peer + pair_request paths used on first connect).
  for (const ch of deps.activePeers.values()) {
    try {
      ch.detach()
    } catch {
      /* best-effort */
    }
  }
  deps.activePeers.clear()
  deps.peerShort = ""
  deps.rootState().turnId = null

  deps.relay = null // _relayUrl preserved for retry

  // Cross-PC routing relies on _relay; bring it down. Will be re-instated
  // by _attemptReconnect on success.
  deps.meshNode?.detachBridge()

  deps.state = "started"
  deps.refreshFooter()
  _emitRelayState(deps) // → reconnecting

  const reconnectUrl = deps.relayUrl
  if (reconnectUrl) {
    _scheduleReconnect(deps, _relayLifecycleGeneration, reconnectUrl)
  }
}

function _isCurrentReconnect(
  deps: RelayLifecycleDeps,
  lifecycleGeneration: number,
  url: string,
): boolean {
  return (
    lifecycleGeneration === _relayLifecycleGeneration &&
    deps.state === "started" &&
    deps.relay === null &&
    deps.relayUrl === url
  )
}

function _scheduleReconnect(
  deps: RelayLifecycleDeps,
  lifecycleGeneration: number,
  url: string,
): void {
  if (_reconnectTimer !== null) return // already scheduled
  if (!deps.cachedEd25519) return // can't reconnect without the cached identity
  if (!_isCurrentReconnect(deps, lifecycleGeneration, url)) return

  const idx = Math.min(_reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1)
  const delay = RECONNECT_BACKOFFS_MS[idx]!
  _reconnectAttempt += 1

  // The timer belongs to the lifecycle that scheduled it. Re-check that exact
  // generation + URL before constructing a candidate so a dequeued old timer
  // cannot act on a newer stop/start lifecycle.
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null
    if (!_isCurrentReconnect(deps, lifecycleGeneration, url)) return
    void _attemptReconnect(deps, lifecycleGeneration, url)
  }, delay)
}

async function _attemptReconnect(
  deps: RelayLifecycleDeps,
  lifecycleGeneration: number,
  url: string,
): Promise<void> {
  if (!deps.cachedEd25519) return
  if (!_isCurrentReconnect(deps, lifecycleGeneration, url)) return

  const edKp = deps.cachedEd25519
  // _relayUrl is stored in canonical http(s):// form — convert at the
  // WS boundary, same as _cmdStart.
  const relay = new RelayClient(toWebSocketUrl(url), edKp)

  try {
    // Replay the same room identity from _cmdStart. Without this the relay
    // would log this WS as a default-room peer and the app would see a
    // phantom "legacy session" appear (regression of plano 17 + 18).
    await relay.connect({
      ...(deps.myRoomId ? { roomId: deps.myRoomId } : {}),
      ...(deps.myRoomMeta ? { roomMeta: deps.myRoomMeta } : {}),
    })
  } catch {
    // A reconnect candidate stays local until publication; every rejected
    // candidate is deterministically closed before stale-return or retry.
    try {
      relay.close()
    } catch {
      /* best-effort rejected candidate cleanup */
    }
    if (!_isCurrentReconnect(deps, lifecycleGeneration, url)) return
    _scheduleReconnect(deps, lifecycleGeneration, url)
    return
  }

  if (!_isCurrentReconnect(deps, lifecycleGeneration, url)) {
    try {
      relay.close()
    } catch {
      /* best-effort stale candidate cleanup */
    }
    return
  }

  deps.relay = relay
  _reconnectAttempt = 0

  relay.on("close", () => _onRelayClose(deps, relay))
  deps.stopAutoListener = _installAutoListener(deps, relay)

  // Plan/25 Wave B/C: relay is back; bring cross-PC routing back online.
  deps.attachBridgeIfReady()

  // _state stays "started"; peer reconnect (if previously paired) flows
  // through _installAutoListener → _findKnownPeer → _promoteToPaired
  // automatically when the app sends any inner.
  _emitRelayState(deps)
}

// ── Relay state event + transparent control channel (Cockpit toggle) ─────────

/** Current relay connectivity, derived from `_state` + `_relay`. */
export function _relayStatus(deps: RelayLifecycleDeps): RelayConnectivity {
  if (deps.getState() === "idle") return "disconnected"
  return deps.relay ? "connected" : "reconnecting"
}

/**
 * Emit the `un-bien:relay-state` custom message so an RPC client (Cockpit)
 * can render a relay on/off indicator. Pure data (`display:false`) — never
 * shown in the transcript. De-duped on the connectivity value; pass
 * `force=true` to answer an explicit `relay:status` query regardless.
 */
export function _emitRelayState(deps: RelayLifecycleDeps, force = false): void {
  const status = _relayStatus(deps)
  if (!force && status === _lastRelayStatus) return
  _lastRelayStatus = status
  // This can run inside a WebSocket 'close' callback (via _onRelayClose). After a
  // session replacement (newSession/fork/switchSession/reload) the module-level
  // `_pi` is stale, and `assertActive` throws synchronously inside `sendMessage`.
  // An uncaught throw from a WS event callback becomes a process-level
  // uncaughtException and exits pi. Swallow it here: the next relay-state
  // change re-emits, so connectivity is eventually consistent. See issue #55.
  try {
    deps.pi?.sendMessage({
      customType: "un-bien:relay-state",
      content: `Relay ${status}`,
      details: {
        status,
        connected: status === "connected",
        ...(deps.relayUrl ? { relayUrl: deps.relayUrl } : {}),
        ...(deps.myRoomId ? { room: deps.myRoomId } : {}),
      },
      display: false,
    })
  } catch {
    // _pi stale (session replaced) or extension runtime not yet bound.
  }
}

/** Minimal ctx for relay start/stop driven by a control message (no command
 *  ctx is available in the `input` hook). cwd matches the daemon's launch dir,
 *  so the derived relay room is identical to the one `_cmdStart` first used. */
export function _controlCtx(): Pick<ExtensionContext, "ui" | "cwd"> {
  // SAFETY: _headlessUi() implements every ui method the relay start/stop path
  // actually calls; the notify-forwarding shim is structurally narrower than the
  // full ExtensionContext["ui"] but complete for this headless control path.
  return {
    ui: _headlessUi(),
    cwd: process.cwd(),
  } as unknown as Pick<ExtensionContext, "ui" | "cwd">
}

/**
 * `ui.notify` for headless contexts (daemon auto-init + control channel). There
 * is no TUI, and the RPC client (Cockpit) already gets everything it needs via
 * structured events (`un-bien:relay-state`, `un-bien:name-assigned`,
 * room_meta) — so routine INFO chatter would just pollute the client's captured
 * stderr. We drop info and forward only warnings/errors (kept for the
 * supervisor's journal / genuine failures). The interactive Pi keeps its normal
 * footer/notify path — this only affects headless ctxs.
 */
export function _headlessUi(): {
  notify: (msg: string, type?: "info" | "warning" | "error") => void
} {
  return {
    notify: (msg: string, type?: "info" | "warning" | "error") => {
      if (type === "warning" || type === "error")
        process.stderr.write(`${msg}\n`)
    },
  }
}

/**
 * Handle a transparent control command from an RPC client (Cockpit), received
 * as a `CTRL_PREFIX`-tagged input the `input` hook swallowed. Toggles the relay
 * WITHOUT leaving the local mesh (relay-only: `_cmdStart` up / `_goIdle` down),
 * then emits the fresh state. `relay:status` just re-emits (no change) so the
 * client can sync its button after (re)attaching to the RPC stream.
 */
export async function _handleControl(
  deps: RelayLifecycleDeps,
  cmd: string,
): Promise<void> {
  // `rename:<new-name>` carries an argument, so it's matched before the
  // fixed-verb switch. Renames the agent live (broker re-register + relay room
  // swap) WITHOUT restarting the process or losing the SDK session.
  if (cmd.startsWith("rename:")) {
    await deps.renameAgent(cmd.slice("rename:".length).trim())
    return
  }
  switch (cmd) {
    case "relay:on":
      if (deps.getState() === "idle")
        await _cmdStart(deps.commandDeps, _controlCtx())
      _emitRelayState(deps, true)
      return
    case "relay:off":
      if (deps.getState() === "idle") {
        deps.rootLifecycleGeneration += 1
        _relayLifecycleGeneration += 1
      } else _goIdle(deps)
      _emitRelayState(deps, true)
      return
    case "relay:toggle":
      if (deps.getState() === "idle")
        await _cmdStart(deps.commandDeps, _controlCtx())
      else _goIdle(deps)
      _emitRelayState(deps, true)
      return
    case "relay:status":
      _emitRelayState(deps, true)
      return
    default:
      // Unknown control verb — ignore (forward-compat: a newer client may send
      // verbs an older extension doesn't know).
      return
  }
}

/**
 * Per-owner disconnect callback. Fires when one specific owner's channel
 * detaches (e.g. relay told us the peer is gone). Other owners' channels
 * keep running — relay stays "started".
 *
 * Exported so tests can trigger the disconnect path for a specific peer.
 *
 * Backward-compat: a no-arg call (legacy tests / pre-W2D callers) falls
 * back to detaching the most recently attached peer, mirroring the old
 * singleton semantics.
 */
export function _onPeerDisconnect(
  deps: RelayLifecycleDeps,
  appPeerId?: string,
): void {
  if (deps.state === "idle") return
  const target = appPeerId ?? [...deps.activePeers.keys()].pop()
  if (!target) return
  if (!deps.activePeers.has(target)) return

  _detachPeerChannel(deps, target)
  if (_anyPeerActive(deps)) {
    // Other owners still attached — keep _rootState().turnId so they continue
    // seeing the in-flight agent stream.
    deps.refreshFooter()
    return
  }

  // No owner left. Conservatively clear the turn so the next pair_request
  // starts cleanly.
  deps.rootState().turnId = null
  deps.refreshFooter()
  deps.safeNotify(
    "[un-bien] All app peers disconnected, listening for reconnect",
    "info",
  )
  // Auto-listener stays up — same listener catches the reconnect on any peer.
}

/**
 * Attaches a new owner channel to the multi-owner set. Replaces the
 * pre-W2D singleton `_promoteToPaired` which set `_state = "paired"` and
 * a single `_peerChannel`. The relay state remains `started`; pairing
 * status is derived from `_activePeers.size`.
 *
 * Idempotent for the same `appPeerId` (re-attaching tears down the prior
 * channel and installs a fresh one — covers reconnect from the same
 * device without leaking listeners).
 */
function _attachOwner(
  deps: RelayLifecycleDeps,
  relay: RelayClient,
  appPeerId: string,
  peerName: string,
  firstInner?: ClientMessage,
): PlainPeerChannel {
  const peerShort = appPeerId.slice(0, 8)

  // Drop any stale channel for this owner before re-attaching.
  if (deps.activePeers.has(appPeerId)) _detachPeerChannel(deps, appPeerId)

  // Prefer always-fresh session_start ctx for async relay routing — `_lastCtx`
  // is a captured command ctx that goes stale after session replacement (#55).
  const channel = new PlainPeerChannel(
    relay,
    appPeerId,
    deps.myRoomId ?? undefined,
    (msg) =>
      deps.routeClientMessageFrom(
        channel,
        msg,
        (deps.liveCtx() as typeof deps.noopCtx) ?? deps.noopCtx,
      ),
    () => _onPeerDisconnect(deps, appPeerId),
    (env) =>
      env.ub === undefined
        ? deps.routeRpcCommandFrom(channel, env)
        : deps.routeUnBienPlaneFrom(channel, env),
    () =>
      deps.rootState().sessionManager?.getSessionId() ??
      deps.rootSessionId ??
      undefined,
  )

  _attachPeerChannel(deps, appPeerId, channel)
  // Envelope-native capability handshake: advertise caps up front so the app can
  // enable the {rpc|evt} route + suppress stock before any session content
  // arrives. Additive to the stock session_history caps (parity transition).
  const _sid = deps.rootState().sessionManager?.getSessionId()
  channel.sendEnvelope(helloEnvelope(_capabilities(), _sid))
  envLog(
    `attach: peer=${appPeerId.slice(0, 8)} hello sent (caps + sessionId=${_sid ?? "?"}); active=${deps.activePeers.size}`,
  )
  // Reconstruction (transcript + panels + extension_ui) is request-driven: the
  // app issues session_sync — on fresh open AND on relay reconnect — and the
  // handler in _routeUnBienPlaneFrom replays all of it. Re-sync is idempotent
  // (stable identify ids + ns/id panel merge), so nothing is replayed
  // proactively here.
  deps.refreshFooter()

  deps.safeNotify(
    `[un-bien] Owner attached: peer=${peerShort}, name=${peerName} ` +
      `(${deps.activePeers.size} active)`,
    "info",
  )

  if (firstInner) {
    // The PlainPeerChannel listener fired on the same line that triggered
    // attachment in some flows; we route explicitly here too to ensure the
    // inner reaches the handler exactly once.
    void firstInner
  }
  return channel
}

// ── Auto-listener ─────────────────────────────────────────────────────────────
//
// Installed while in 'started' state. Decodes the outer envelope as
// base64(JSON) and dispatches per sender peer_id:
//   • Sender already in `_activePeers` → ignored here (the per-owner
//     PlainPeerChannel listens on the same relay event and handles its own
//     traffic via its `remotePeerId` filter)
//   • `pair_request` from a new peer → validate token, persist peer, send
//     pair_ok/pair_error, attach a new channel
//   • Non-pair message from a known peer (peers.json) without an active
//     channel yet → attach + route the inner (reconnect path)
//   • Anything else (unknown peer + non-pair) → emit `error: unknown_peer`

export function _installAutoListener(
  deps: RelayLifecycleDeps,
  relay: RelayClient,
): () => void {
  const listenerGeneration = _relayLifecycleGeneration
  const hasListenerAuthority = (): boolean =>
    !deps.disposed &&
    deps.state === "started" &&
    deps.relay === relay &&
    _relayLifecycleGeneration === listenerGeneration
  const onMsg = async (line: string) => {
    let outer: { peer?: string; ct?: string }
    try {
      outer = JSON.parse(line) as { peer?: string; ct?: string }
    } catch {
      return
    }

    if (!outer.peer || !outer.ct) return

    if (!hasListenerAuthority()) return
    // Already-attached owners: their PlainPeerChannel handles routing.
    if (deps.activePeers.has(outer.peer)) return

    // Decode inner envelope (base64 JSON)
    let inner: ClientMessage
    try {
      const plaintext = Buffer.from(outer.ct, "base64").toString("utf8")
      const parsed = JSON.parse(plaintext) as unknown
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as Record<string, unknown>).type !== "string"
      )
        return
      inner = parsed as ClientMessage
    } catch {
      return
    }

    const appPeerId = outer.peer

    if (inner.type === "pair_request") {
      await _handlePairRequest(
        deps,
        relay,
        appPeerId,
        inner,
        hasListenerAuthority,
      )
      return
    }

    // Reconnect path: known peer (peers.json) without an active channel
    // sends a non-pair message → attach + route through the new channel.
    // See pairing.md §Reconexão.
    const known = await _findKnownPeer(appPeerId)
    if (!hasListenerAuthority()) return
    if (known) {
      const channel = _attachOwner(deps, relay, appPeerId, known.name)
      // The channel listener didn't see the line that triggered the attach, so
      // route it explicitly — MIRRORING the channel's own dispatch (peer_channel
      // _onLine): a real-typed envelope ("rpc"/"evt"/"ub", legacy "env") or a
      // bare rpc/evt/ub body goes to the envelope dispatcher, a stock
      // ClientMessage to the stock switch. Everything is on the envelope proto
      // now, so the first message is normally the ub session_sync (or the rpc
      // get_entries) — routing that through the stock switch dropped it. Use
      // _liveCtx (session_start-fresh), not #55.
      const innerObj = inner as Record<string, unknown>
      if (isEnvelopeFrame(innerObj)) {
        {
          // SAFETY: isEnvelopeFrame confirmed rpc/evt/ub envelope keys are
          // present, so this ClientMessage is byte-compatible with EnvelopeMessage.
          const innerEnv = inner as unknown as EnvelopeMessage
          if (innerEnv.ub === undefined)
            deps.routeRpcCommandFrom(channel, innerEnv)
          else deps.routeUnBienPlaneFrom(channel, innerEnv)
        }
      } else {
        deps.routeClientMessageFrom(
          channel,
          inner,
          (deps.liveCtx() as typeof deps.noopCtx) ?? deps.noopCtx,
        )
      }
      return
    }

    // Unknown peer with non-pair_request inner — signal so the app can react
    // (peer was revoked / never paired). pair_request from unknown peer was
    // already handled above as a legitimate path. We never log inner contents,
    // only inner.type.
    const errReply: ServerMessage = {
      type: "error",
      code: "unknown_peer",
      message: "Peer not paired — re-scan QR",
    }
    const errCt = Buffer.from(JSON.stringify(errReply)).toString("base64")
    relay.send(JSON.stringify({ peer: appPeerId, ct: errCt }))
  }

  relay.on("message", onMsg)
  return () => relay.off("message", onMsg)
}

/**
 * Plan/27 Wave A: lazily resolve the pi-extension package version from
 * disk so the `pair_ok.harness.version` field reflects what's actually
 * shipped. The lookup is best-effort — a parse failure (or running this
 * file out-of-tree) falls back to "0.0.0" which is still semver-valid
 * and the app tolerates it. Cached at module load.
 */
function _readExtensionVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url)
    // dist/session/relay_lifecycle.js → ../../.. = the extension package
    // root. src/session/relay_lifecycle.ts under tsx → also three levels up.
    const pkgPath = join(here, "..", "..", "..", "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string
    }
    return typeof pkg.version === "string" ? pkg.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}
const _HARNESS = {
  name: "Pi coding agent",
  version: _readExtensionVersion(),
} as const
const _HOSTNAME = hostname()

// un-bien capability handshake. PROTOCOL_VERSION bumps on a HARD (breaking)
// wire change; the app gates UI on capability PRESENCE, not this number.
const PROTOCOL_VERSION = 1
// Features this extension supports, advertised on attach (session_history) + pair_ok.
// `remote_launch` is conditional (added only when local config opts in) — see
// `_capabilities()`. Passive server->app extras (images/panels) are listed so
// the app can also gate any future *controls* it grows for them.
const _BASE_CAPABILITIES = [
  "thinking",
  "models",
  "cancel",
  "queued_messages",
  "images",
  "tool_result_images",
  "panels",
  "rpc_envelope",
] as const

/** The capability set to advertise right now (config-dependent bits included). */
function _capabilities(): string[] {
  const caps: string[] = [..._BASE_CAPABILITIES]
  // `remote_launch` is advertised ONLY when the machine opts in via local
  // config — single choke point so the advertised set and honored behavior
  // can't drift. Read the session cwd's config (pi runs in the session cwd).
  if (effectiveAllowRemoteLaunch(loadLocalConfig(process.cwd()))) {
    caps.push("remote_launch")
  }
  return caps
}

async function _handlePairRequest(
  deps: RelayLifecycleDeps,
  relay: RelayClient,
  appPeerId: string,
  inner: Extract<ClientMessage, { type: "pair_request" }>,
  hasListenerAuthority: () => boolean,
): Promise<void> {
  const sendInner = (msg: ServerMessage) => {
    const ct = Buffer.from(JSON.stringify(msg)).toString("base64")
    relay.send(JSON.stringify({ peer: appPeerId, ct }))
  }

  const sendError = (code: PairErrorCode, message: string) => {
    sendInner({ type: "pair_error", in_reply_to: inner.id, code, message })
  }

  const status = qrSession.consumeToken(inner.token)
  if (status !== "ok") {
    const code: PairErrorCode =
      status === "expired"
        ? "token_expired"
        : status === "consumed"
          ? "token_consumed"
          : "token_unknown"
    const msg =
      code === "token_expired"
        ? "Ephemeral token expired. Generate a new QR with /unbien pair."
        : code === "token_consumed"
          ? "Token already consumed by another pair_request."
          : "Token was not issued by this Pi."
    sendError(code, msg)
    return
  }

  // A delayed signed revoke must lose authority before the same-process
  // re-pair enters storage; the replacement owns a fresh token snapshot.
  const producer = deps.selfRevoke
  const producerEpoch = deps.selfRevokeEpoch
  producer?.invalidateStorageAuthority()
  const pairedAt = new Date().toISOString()
  try {
    await addPeer({
      name: inner.device_name,
      remote_epk: appPeerId,
      paired_at: pairedAt,
    })
    if (!hasListenerAuthority()) return
    deps.refreshPairingsCache()
    if (
      producer &&
      deps.selfRevoke === producer &&
      deps.selfRevokeEpoch === producerEpoch
    ) {
      void producer.requestFreshCheck().catch(() => {
        // The regular cadence retries; pairing itself already succeeded.
      })
    }
  } catch (err) {
    if (!hasListenerAuthority()) return
    sendError("internal_error", `Failed to persist peer: ${String(err)}`)
    return
  }

  const cwd =
    deps.lastCtx && "cwd" in deps.lastCtx
      ? (deps.lastCtx as ExtensionCommandContext).cwd
      : process.cwd()
  // Prefer the user-configured agent_name (with broker suffix when on the
  // mesh) over the legacy parent/folder path — matches what the user sees
  // in the terminal title and in /unbien status.
  const sessionName = deps.displayName(cwd)

  _attachOwner(deps, relay, appPeerId, inner.device_name)

  sendInner({
    type: "pair_ok",
    in_reply_to: inner.id,
    session_name: sessionName,
    session_started_at: deps.sessionStartedAt ?? Date.now(),
    // App uses this to address subsequent inner messages to the right room
    // when this Pi runs alongside others with the same epk. Defensive fallback
    // to roomIdFor(cwd, name) covers the edge case where pair_request lands
    // before _cmdStart could set _myRoomId (shouldn't happen in practice) —
    // and stays plan/41-consistent (same (cwd, name) derivation as the announce).
    room_id: deps.myRoomId ?? deps.deriveRoomId(cwd, sessionName),
    // Plan/27 Wave A — surface the host coding-agent identity + machine
    // hostname so the app can render a meaningful device row (and tell
    // two PCs apart even when nicknames collide).
    harness: _HARNESS,
    hostname: _HOSTNAME,
    protocol_version: PROTOCOL_VERSION,
    capabilities: _capabilities(),
  })

  // Notify local RPC clients (e.g. Cockpit) that pairing completed, so they can
  // close the QR screen and show the new device. Pure data event (display:false)
  // — still emitted to the RPC stdout via the session stream.
  deps.pi?.sendMessage({
    customType: "un-bien:paired",
    content: `Paired with ${inner.device_name}`,
    details: { name: inner.device_name, peerId: appPeerId, pairedAt },
    display: false,
  })
}
