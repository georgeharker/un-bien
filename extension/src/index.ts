#!/usr/bin/env node
/**
 * pi-extension — un-bien slash commands + AgentBridge wiring
 *
 * Exported as ExtensionFactory (default export) to be loaded by Pi SDK:
 *   pi -e $(pwd)/dist/index.js
 *
 * State machine:  idle → started → paired
 *   /unbien start   connects to relay (idle → started)
 *   /unbien pair    shows QR for new peers (started, async → paired via auto-listener)
 *   /unbien stop    closes everything (any → idle)
 *
 * Pairing (post plano 06 — sem Noise XX):
 *   App envia inner `pair_request` (id, token, device_name) sobre canal opaco.
 *   Pi valida o token via qrSession.consumeToken, salva peer em peers.json
 *   {name, remote_epk, paired_at} e responde com `pair_ok` (ou `pair_error`).
 *   `ct` é base64(JSON.stringify(inner)) — sem cifra, sem MAC.
 *
 * Reconexão de peer conhecido:
 *   Se uma mensagem chega em estado `started` vinda de um epk presente em
 *   peers.json, o auto-listener promove direto pra `paired` sem novo
 *   pair_request, criando o PlainPeerChannel e roteando a mensagem.
 *
 * Architecture note — why we don't use AgentBridge directly here:
 *   AgentBridge.beforeToolCallHook is designed to be passed to createAgentSession().
 *   Inside an extension Pi already owns the AgentSession, so we can't re-bind
 *   beforeToolCall after the fact. The equivalent is pi.on("tool_call", …) which
 *   fires BEFORE execution and supports { block: true }.
 *   AgentBridge (src/session/agent_bridge.ts) remains the tested, mockable unit
 *   for integration tests.
 */

import { randomUUID } from "node:crypto"
import {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent"
import { Ed25519Keypair } from "./pairing/crypto.js"
import { listPeers, removePeer } from "./pairing/storage.js"
import { SelfRevoke } from "./mesh/self_revoke.js"
import { MeshTopologySnapshot } from "./mesh/siblings.js"
import {
  ClientMessage,
  ServerMessage,
  ThinkingLevel,
} from "./protocol/types.js"
import { RelayClient } from "./transport/relay_client.js"
import { PlainPeerChannel } from "./transport/peer_channel.js"
import {
  createExtensionUiBridge,
  type ExtensionUiBridge,
  type ExtensionUiResponseWire,
} from "./extension_ui_bridge.js"
import { createPanelBridge, type PanelBridge } from "./panel_bridge.js"
import {
  initSubagentRooms,
  subagentRoomsEnabled,
  type SubagentRoomsController,
} from "./subagent_rooms.js"
import {
  createRpcEnvelope,
  type EnvelopeMessage,
} from "./session/rpc_envelope.js"
import { dispatchRpcCommand } from "./session/rpc_inbound.js"
import { envLog } from "./session/debug_log.js"
import { roomIdForSession } from "./rooms.js"
import { registerAgentTools } from "./session/tools.js"
import { formatPeerInventory } from "./session/peer_inventory.js"
import { MeshNode } from "./session/mesh_node.js"
import {
  wireFromModel,
  type ActionCtx,
  type ActionPi,
} from "./actions/handlers.js"
import { ensureModelRegistry } from "./actions/registry.js"
import {
  ensureGlobalDirs,
  LOCAL_SESSION_NAME,
  sessionSockPath,
  skillsDir,
} from "./session/global_config.js"
import { type AcquiredLock } from "./session/cwd_lock.js"
import { installService, unlinkCliBinaries } from "./daemon/install.js"
import {
  defaultAgentName,
  effectiveAutoStartRelay,
  effectiveAllowRemoteLaunch,
  loadLocalConfig,
  localConfigExists,
  saveLocalConfig,
} from "./session/local_config.js"
import { updateFooter, type FooterState } from "./ui/footer.js"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"
import {
  loadConfig,
  saveConfig,
  isValidRelayUrl,
  isWebSocketScheme,
} from "./config.js"
import { _expandTilde, _launchSession } from "./launch.js"
import { _enrichToolArgs } from "./enrich_tool_args.js"
import {
  _findKnownPeer,
  _inspectPeerRecord,
  _runtimeOwnerFingerprint,
  type InspectedPeerRecord,
} from "./pairing/peer_trust.js"
import {
  _flushPendingReceivedImagePreviews,
  _isReceivedImageContextMessage,
  _registerReceivedImageRenderer,
  type ImagePipelineDeps,
} from "./session/received_images.js"
import { CommandDeps } from "./commands/deps.js"
import {
  type RootRestartAuthority,
  _cmdRoot,
  _cmdStart,
  _cmdStop,
  _cmdJoin,
} from "./commands/lifecycle.js"
import { _cmdRevoke } from "./commands/pairing.js"
import {
  _cmdClaudeCli,
  _cmdInstall,
  _cmdUninstall,
  _deployAgentNetworkSkill,
} from "./commands/housekeeping.js"
import { registerUnbienCommands } from "./commands/register.js"
import { createTestHooks } from "./test_hooks.js"
import {
  createRpcHandlers,
  type RpcHandlersDeps,
} from "./session/rpc_handlers.js"
import {
  CTRL_PREFIX,
  _anyPeerActive,
  _broadcastEnvelope,
  _controlCtx,
  _detachPeerChannel,
  _emitRelayState,
  _getReconnectTimer,
  _getRelayLifecycleGeneration,
  _goIdle,
  _handleControl as _handleControlImpl,
  _headlessUi,
  _installAutoListener,
  _onPeerDisconnect as _onPeerDisconnectImpl,
  _onRelayClose,
  _panelBroadcast,
  _relayStatus,
  _setRelayLifecycleGeneration,
  _uiBroadcast,
  type RelayConnectivity,
  type RelayLifecycleDeps,
} from "./session/relay_lifecycle.js"

// Relay-lifecycle seam re-exports: the control-channel sentinel + the
// connectivity type moved to ./session/relay_lifecycle.ts; these keep the
// exact export surface (tests import CTRL_PREFIX from here).
export { CTRL_PREFIX }
export type { RelayConnectivity }

// ── State machine ─────────────────────────────────────────────────────────────
//
// Pre-2026-05-23: `idle` → `started` → `paired` (one owner at a time, gate-kept
// by `_appPeerId`/`_peerChannel` singletons). The transition to `paired` was
// what unblocked the app from sending application messages.
//
// Now: `idle` → `started`. The `paired` state is a derived metric
// (`_activePeers.size > 0`) — N owners can be connected at once, each with
// its own `PlainPeerChannel` in `_activePeers`. Plan/24 W2D ("multi-channel
// broadcast"): pairing a second device no longer disconnects the first, and
// every connected owner receives the same agent stream in parallel.

export type RemoteState = "idle" | "started"

let _state: RemoteState = "idle"
let _relay: RelayClient | null = null

let _relayUrl: string | null = null // URL used by current _relay connection
/**
 * Owners currently connected via the relay. Key = app peer pubkey (Ed25519,
 * base64 standard); value = the dedicated PlainPeerChannel routing messages
 * to/from that owner.
 *
 * Operational notes:
 *   - Adding/removing entries is exclusively in `_attachPeerChannel` and
 *     `_detachPeerChannel` (or `_goIdle` for the bulk teardown). Don't mutate
 *     directly elsewhere — those helpers keep the footer/log/state in sync.
 *   - `paired` UX state is `_activePeers.size > 0`. The footer and the
 *     `/unbien status` output both derive from this.
 */
const _activePeers = new Map<string, PlainPeerChannel>()
let _peerShort = "" // shortid of the most recently attached peer (UX hint only)

let _myRoomId: string | null = null // this Pi's room id (derived from the session id)

/** True when a relay start was DEFERRED because no session id existed yet
 *  (design 01M1CAW0). The root session_start handler re-runs the start once
 *  the session id becomes available. */
let _relayStartDeferred = false

/** THE App<->Pi room id for the current chat session: ALWAYS derived from the
 *  STABLE pi session id (durable across resume) so the room can't drift when
 *  the assigned name changes on reconnect. Returns null when no session id
 *  exists yet — the legacy (cwd, name) fallback is RETIRED (design 01M1CAW0):
 *  it was identical for same-cwd processes, so a pre-session subprocess could
 *  announce the SAME room an earlier session occupies (and a parent's keeper
 *  then stamped set-once parentage onto that shared room). Callers must SKIP
 *  the room announce/join on null — never guess a cwd-derived room id.
 *  `cwd`/`name` are still accepted because callers derive them for room_meta
 *  labels, but they no longer key the room. */
function _deriveRoomId(_cwd: string, _name: string): string | null {
  const sid = _rootState().sessionManager?.getSessionId()
  return sid ? roomIdForSession(sid) : null
}

// Plan/28 Wave D.1: `thinking` published alongside `model` so the app's
// Quick Actions sheet hydrates the thinking segmented control on first
// open instead of starting null. The SDK fires `thinking_level_select`
// on every change (initial load + user toggle), mirrored to room_meta
// the same way model is — apps subscribe to one channel for both.
let _myRoomMeta: {
  name: string
  cwd: string
  model?: string
  thinking?: ThinkingLevel
  working?: boolean
  sessionId?: string
} | null = null
let _currentModel: string | undefined // last-known model name
let _currentThinking: ThinkingLevel | undefined // last-known thinking level

// ── Agent-network session (plano 19) ──────────────────────────────────────────
// MeshNode owns both the local UDS mesh (SessionPeer) and the optional
// cross-PC relay bridge (BrokerRemote + PiForwardClient). The bridge is
// attached via `_meshNode.attachBridge()` once the relay WS is up and this
// Pi is the leader; MeshNode re-attaches it across UDS failovers.
let _meshNode: MeshNode | null = null
let _sessionName: string | null = null
let _sessionPeerCount = 0
// Invalidates an in-flight MeshNode.connect() before it can publish globally.
let _meshJoinGeneration = 0
// Set true by `session_shutdown`. Connecting is async, so shutdown can land
// while `_cmdRoot` has not published either candidate yet. `_disposed` blocks
// the outgoing continuation until a same-module `session_start` rearms it;
// relay/mesh generations below permanently distinguish the old candidates from
// that replacement lifecycle even after `_disposed` becomes false again.
let _disposed = false
// True once the auto-init has run on the first session_start for this
// process. Prevents re-running on session replacements (those re-init via
// the _disposed re-arm path above). The session_start handler below auto-starts
// un-bien for ANY session whose local config has auto_start_relay (default
// true) — interactive AND daemon — instead of only UNBIEN_DAEMON=1.
let _autoInited = false

// Cached state of global pairings (`peers.json`). Pairing is per-machine, so a
// device paired in any Pi process is paired everywhere. Refreshed on boot,
// after addPeer (handle_pair_request), and after removePeer (revoke).
let _hasGlobalPairings = false

/** Reads peers.json and updates the global-pairings cache + footer. Fire and
 *  forget; failures keep the previous cached value. */
function _refreshPairingsCache(): void {
  void listPeers()
    .then((peers) => {
      _hasGlobalPairings = peers.length > 0
      _refreshFooter()
    })
    .catch(() => {
      /* keep prior cached value */
    })
}

/** Re-queries the broker for the authoritative peer list. The broker's map is
 *  the source of truth — incremental +1/-1 counters drift after failover, lost
 *  `peer_left` broadcasts (e.g., leader leaves), or any dropped event. Called
 *  on every `peer_joined`/`peer_left` and once on join. Fire-and-forget. */
function _refreshSessionPeerCount(
  peer: MeshNode,
  ctx?: Pick<ExtensionContext, "ui"> | null,
): void {
  void peer
    .request("broker", { type: "list_peers" }, 2000)
    .then((reply) => {
      const peers = (reply.body as { peers?: string[] } | null)?.peers
      if (Array.isArray(peers)) {
        _sessionPeerCount = peers.length
        _refreshFooter(ctx)
      }
    })
    .catch(() => {
      /* older broker without list_peers — keep prior count */
    })
}

/** Friendly model name for room_meta (plano 18). undefined when SDK has none yet. */
function _currentModelName(): string | undefined {
  return _currentModel
}

/**
 * Cache the active model name and fan it out to subscribed apps via a
 * `room_meta_update`. The relay push is a no-op when the room isn't up yet —
 * the next `room_meta` hello carries the cached value instead. Shared by the
 * `model_select` event and the connect/turn-start seeding, so a daemon that
 * just runs its DEFAULT model still reports it: `model_select` only fires on an
 * explicit set/cycle (never on settings load), so default-model daemons would
 * otherwise never surface their model.
 */
function _setCurrentModel(name: string): void {
  _currentModel = name
  if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, model: name }
  if (_relay && _myRoomId) {
    _relay.sendControl({
      type: "room_meta_update",
      room_id: _myRoomId,
      meta: { model: name },
    })
  }
}

/**
 * Plan/32: publish the `working` flag as room_meta (raw, no debounce — the
 * app debounces). Same shape as model/thinking updates. Used by turn_start/end
 * AND by the compaction handlers: `compact()` doesn't run a turn (it
 * disconnects the agent + aborts, emitting compaction_start, NOT turn_start),
 * so room_meta.working must be bracketed manually around compaction.
 */
function _publishWorking(working: boolean): void {
  if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, working }
  if (_relay && _myRoomId) {
    _relay.sendControl({
      type: "room_meta_update",
      room_id: _myRoomId,
      meta: { working },
    })
  }
}

/**
 * Issue #105 — pure-data events must not reach the model.
 *
 * `display: false` only suppresses TUI rendering. Pi still persists the message
 * as a `CustomMessageEntry`, and those DO participate in LLM context, so every
 * relay flap / name collision / pairing was being replayed to the model on
 * every subsequent call ("Relay connected", "Mesh name reassigned: …"). The
 * agent burned tokens on internal telemetry and sometimes reasoned about it as
 * if it were user input.
 *
 * The filter is non-destructive: the entries stay in the session (Cockpit and
 * any other RPC client still read them off the stream), the LLM just never sees
 * them. Keyed on `display === false` rather than a customType allowlist, so any
 * pure-data event we add later is covered by construction. Events meant for the
 * human (`un-bien:mesh-message`, `un-bien:mesh-revoked`, …) set
 * `display: true` and pass through untouched.
 */
function _isPureDataContextMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false
  const m = message as {
    role?: unknown
    customType?: unknown
    display?: unknown
  }
  return (
    m.role === "custom" &&
    typeof m.customType === "string" &&
    m.customType.startsWith("un-bien:") &&
    m.display === false
  )
}

function _filterInternalMessagesFromContext<T>(messages: T[] | undefined): T[] {
  return Array.isArray(messages)
    ? messages.filter(
        (message) =>
          !_isReceivedImageContextMessage(message) &&
          !_isPureDataContextMessage(message),
      )
    : []
}

// ── Cross-PC mesh wiring (plan/25 Wave B/C) ───────────────────────────────────

/**
 * Hand the live relay to MeshNode so it can bring up the cross-PC bridge
 * (BrokerRemote + sibling discovery) — but only when this Pi is the leader
 * (broker host). MeshNode is idempotent + re-attaches across UDS failovers,
 * so this is safe to call from `_cmdStart`, relay reconnect, or SelfRevoke.
 * No-op until the relay WS + cached identity are both present.
 */
function _attachBridgeIfReady(): void {
  if (!_meshNode || !_relay || !_relayUrl || !_cachedEd25519) return
  // A newly-created SelfRevoke producer must publish its own initial verified
  // or fallback snapshot before any retained topology is allowed to attach.
  if (_selfRevoke !== null) {
    if (
      _selfRevokeTopologyReadyEpoch !== _selfRevokeEpoch ||
      _selfRevokeTopology === null
    ) {
      return
    }
    if (!_meshNode.hasTopology()) _meshNode.setTopology(_selfRevokeTopology)
  }
  void _meshNode
    .attachBridge({
      relay: _relay,
      relayUrl: _relayUrl,
      keypair: _cachedEd25519,
    })
    .catch(() => {
      /* best-effort — UDS mesh works regardless */
    })
}

/**
 * Prefer an explicit ctx, then the always-fresh session_start ctx, then the
 * last command ctx. Relay/async paths must not rely on `_lastCtx` alone —
 * the SDK marks captured command ctxs stale after session replacement.
 * @see https://github.com/jacobaraujo7/remote_pi/issues/55
 */
function _liveCtx(
  preferred?: { ui?: unknown } | null,
): { ui?: unknown } | null {
  return preferred ?? _lastEventCtx ?? _lastCtx ?? null
}

/**
 * Read `ctx.ui` without letting a stale-ctx getter become an uncaughtException.
 * Optional chaining does NOT protect against a throwing getter.
 */
function _ctxUi(preferred?: { ui?: unknown } | null): {
  setStatus?: (k: string, v: string | undefined) => void
  setTitle?: (t: string) => void
  notify?: (message: string, level?: string) => void
} | null {
  const target = _liveCtx(preferred)
  if (!target) return null
  try {
    return (
      (target.ui as
        | {
            setStatus?: (k: string, v: string | undefined) => void
            setTitle?: (t: string) => void
            notify?: (message: string, level?: string) => void
          }
        | null
        | undefined) ?? null
    )
  } catch {
    // Stale after newSession/fork/switchSession/reload — caller no-ops.
    return null
  }
}

/** Best-effort TUI notify; never throws (relay reconnect must not crash pi). */
function _safeNotify(
  message: string,
  level: "info" | "warning" | "error" = "info",
  preferred?: { ui?: unknown } | null,
): void {
  try {
    // Prefer the caller's fresh ctx (e.g. a command ctx) over the module's
    // last-event ctx — a session_start ctx can be ui-less/stale and would
    // otherwise shadow it, silently dropping the notify.
    const ui = _ctxUi(preferred)
    if (ui && typeof ui.notify === "function") ui.notify(message, level)
  } catch {
    /* never let notify take down the process */
  }
}

/** Refreshes the Pi TUI footer slots from current module state. Safe no-op when ctx lacks ui. */
function _refreshFooter(
  ctx?: { ui?: { setStatus?: unknown; setTitle?: unknown } } | null,
): void {
  // Prefer live session_start ctx over capturable-stale command ctx (issue #55).
  let ui: {
    setStatus?: (k: string, v: string | undefined) => void
    setTitle?: (t: string) => void
  } | null
  try {
    ui = _ctxUi(ctx)
  } catch {
    return
  }
  if (
    !ui ||
    typeof ui.setStatus !== "function" ||
    typeof ui.setTitle !== "function"
  )
    return
  try {
    const state: FooterState = {
      session: _sessionName ?? undefined,
      peerCount: _sessionPeerCount,
      relayOn: _state !== "idle",
      // `devicePaired` now reflects "any owner currently attached" — picks one
      // shortid representatively (multi-owner UX detail surfaces in the
      // `/unbien status` line, not the footer slot).
      devicePaired: _anyPeerActive(relayDeps) ? _peerShort : undefined,
      hasPairings: _hasGlobalPairings,
      agentName: _meshNode?.name(),
    }
    updateFooter(
      {
        ui: {
          setStatus: ui.setStatus.bind(ui),
          setTitle: ui.setTitle.bind(ui),
        },
      },
      state,
    )
  } catch {
    // setStatus/setTitle can also throw if the runner went stale mid-call.
  }
}

// Epoch ms when the state machine entered 'started' (last /unbien start).
// Used by session_sync to let the app detect Pi restarts (and force a full
// replay). Cleared on _goIdle.
let _sessionStartedAt: number | null = null

// _sessionManager lives PER-SESSION in _stateFor(sid); the root session's record
// backs reconstruction — the app reads the transcript via the native get_entries
// rpc over _rootState().sessionManager.getEntries() (captured from event ctx;
// survives extension restarts via the persisted session log).

type MeshEnvelope = {
  id: string
  from: string
  re: string | null
  body: unknown
}
let _pendingMeshMessages: MeshEnvelope[] = []
// agent-run active/generation now live PER-SESSION in _stateFor(sid).agentRun;
// mesh delivery targets the ROOT run, so the drain reads _rootState().agentRun.
let _meshDrainScheduled = false

// ── Per-session state, keyed by pi sessionId ──────────────────────────────
// The extension re-activates IN-PROCESS for every subagent — each is its own pi
// AgentSession with its OWN sessionId. Turn/agent/buffer state is therefore
// PER-SESSION: every event handler records into its FIRING session's record
// (sid = ctx.sessionManager.getSessionId()); app-facing reads use the ROOT
// session's record. Subagent records accumulate (held for later surfacing);
// a root-only broadcast gate keeps app display identical for now. This mirrors
// pi's own per-AgentSession model rather than a flat extension-authored projection.
interface SessionState {
  turnId: string | null
  working: boolean
  agentRun: { active: boolean; generation: number }
  sessionManager: ExtensionContext["sessionManager"] | null
  model: string | null
  thinking: ThinkingLevel | null
}
const _sessions = new Map<string, SessionState>()
// The session bound to the app room. null until the ROOT session_start fires;
// while null, everything is treated as root (single-session / test harness).
let _rootSessionId: string | null = null
// Stable key for the root record even before _rootSessionId is known.
function _rootKey(): string {
  return _rootSessionId ?? "__root__"
}
function _stateFor(sid: string): SessionState {
  let st = _sessions.get(sid)
  if (!st) {
    st = {
      turnId: null,
      working: false,
      agentRun: { active: false, generation: 0 },
      sessionManager: null,
      model: null,
      thinking: null,
    }
    _sessions.set(sid, st)
  }
  return st
}
/** The root session's record (always defined; lazily created). */
function _rootState(): SessionState {
  return _stateFor(_rootKey())
}
/** sessionId of the firing handler's ctx, defaulting to the root key. */
function _sidOf(
  ctx: { sessionManager?: { getSessionId(): string } } | undefined,
): string {
  return ctx?.sessionManager?.getSessionId() ?? _rootKey()
}
/** True only when the firing session is NOT the app-room root (subagent). */
function _isNonRootSid(sid: string): boolean {
  return _rootSessionId !== null && sid !== _rootSessionId
}

// Module-level pi reference
let _pi: ExtensionAPI | null = null

// Minimal structural views of pi SDK internals the extension reaches for but the
// public ExtensionAPI type does not surface. Each names exactly the member(s)
// known to exist on the concrete AgentSession at runtime.
interface PiEventBusInternals {
  events?: { emit(channel: string, data: unknown): void }
}

// Plan/57 — Bridge to pi-ask's clarification-flow events. null until the
// extension factory wires it (and null if the SDK exposes no events bus).
let _extensionUiBridge: ExtensionUiBridge | null = null
// Mirror the in-process plan + subagents buses to the app as `panel_update`
// frames. null until the factory wires it (and null if the SDK has no events
// bus). Inert when no plan/subagents source is emitting.
let _panelBridge: PanelBridge | null = null
// rpc-envelope producer (docs/rpc-on-event-map.md): reconstructs pi's --mode rpc
// event plane from pi.on() and fans {rpc} frames to attached peers. THE route
// (always on, advertised as the `rpc_envelope` capability); runs alongside the
// stock ServerMessage path only until M4 parity retirement.
let _rpcEnvelope: { dispose(): void } | null = null

// Per-child subagent relay rooms — each subagent surfaced to the app as its own
// session, opt-in via the `subagents.rooms` un-bien setting (a no-op controller
// otherwise). Owned by the ROOT session; a child session_start calls
// onChildSession on this same instance.
let _subagentRooms: SubagentRoomsController | null = null

let _stopAutoListener: (() => void) | null = null

// Cached keypair (loaded once, reused across start/pair cycles)
let _cachedEd25519: Ed25519Keypair | null = null

// Mesh-membership poller (plan/24 Wave 3). Lives across the relay
// connection lifecycle: started in _cmdStart after the WS is up, stopped
// in _goIdle when the relay is torn down.
let _selfRevoke: SelfRevoke | null = null
let _selfRevokeEpoch = 0
let _selfRevokeTopologyReadyEpoch = -1
let _selfRevokeTopology: MeshTopologySnapshot | null = null

// Per-cwd lock acquired by the first `/unbien` invocation in this
// process. Holds the UDS socket open until the process exits (OS auto-
// releases on crash too). Stays held across `/unbien stop` cycles —
// only released when the Node process itself dies.
let _cwdLock: AcquiredLock | null = null
// Effective mesh name this instance locked. Equals the configured/derived name,
// OR a `#N`-suffixed variant when another agent already holds that (cwd, name)
// in this folder (same-name agents coexist instead of being refused). `_cmdJoin`
// registers under this name; the broker confirms it (and may bump it again under
// a live race). Null until the lock is acquired.
let _lockedName: string | null = null

// Root startup has pre-candidate awaits (cwd lock, wizard) that relay/mesh
// generations cannot safely represent: child startup intentionally advances
// those generations. Stop/off/session replacement advance this separate epoch
// so a queued root can never regain authority by creating a newer child.
let _rootLifecycleGeneration = 0

function _isCurrentRootLifecycle(generation: number): boolean {
  return !_disposed && generation === _rootLifecycleGeneration
}

/**
 * Public state-snapshot helper. Returns the derived UX state, not the raw
 * `_state` enum: the W2D refactor collapsed the internal machine to
 * `idle | started` and made `paired` a derived metric
 * (`_activePeers.size > 0`). Tests and the footer keep the three-state
 * mental model via this getter.
 */
export function _getState(): "idle" | "started" | "paired" {
  if (_state === "idle") return "idle"
  return _activePeers.size > 0 ? "paired" : "started"
}

// ── Hidden e2e UI test harness (dev-only, undocumented) ───────────────────
// Broadcasts CANNED frames to paired apps so the app UI can be exercised
// end-to-end without a real agent turn. For plan/subagents/rich-ask it EMITS the
// underlying BUS events and lets the REAL bridges produce the frames (faithful);
// the simple ExtensionUIPromptView methods (select/confirm/input/editor) + media
// have no bus producer, so they're broadcast directly. See design 01M152YD….
const _TEST_SVG_B64 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">' +
    '<rect width="120" height="60" rx="8" fill="#4c8bf5"/>' +
    '<text x="60" y="37" font-size="16" fill="white" text-anchor="middle"' +
    ' font-family="sans-serif">un-bien</text></svg>',
).toString("base64")

function _emitTestBus(channel: string, data: unknown): void {
  try {
    ;(_pi as PiEventBusInternals | null)?.events?.emit(channel, data)
  } catch {
    /* bus absent — best effort */
  }
}

/** Run one canned UI-test scenario. Returns a short status for the notify. */
function _runTestScenario(scenario: string): string {
  const s = (scenario.trim().split(/\s+/)[0] || "help").toLowerCase()
  const id = `test-${Date.now()}`
  switch (s) {
    case "ask-select":
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "extension_ui_request",
          id,
          method: "select",
          title: "Pick one (test)",
          options: ["Alpha", "Beta", "Gamma"],
        },
      })
      return "sent ask-select"
    case "ask-confirm":
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "extension_ui_request",
          id,
          method: "confirm",
          title: "Confirm (test)",
          message: "Proceed with the test action?",
        },
      })
      return "sent ask-confirm"
    case "ask-input":
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "extension_ui_request",
          id,
          method: "input",
          title: "Input (test)",
          placeholder: "Type something…",
        },
      })
      return "sent ask-input"
    case "ask-editor":
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "extension_ui_request",
          id,
          method: "editor",
          title: "Editor (test)",
          prefill: "edit me",
        },
      })
      return "sent ask-editor"
    case "ask-notify":
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "extension_ui_request",
          id,
          method: "notify",
          message: "This is a test notice.",
          notify_type: "info",
        },
      })
      return "sent ask-notify"
    case "ask-rich":
      _emitTestBus("@eko24ive/pi-ask:started", {
        version: 1,
        flowId: `test-flow-${Date.now()}`,
        source: "test",
        title: "Rich ask (test)",
        questions: [
          {
            id: "q1",
            prompt: "Which approach?",
            type: "single",
            options: [
              { value: "a", label: "Approach A", description: "the safe one" },
              { value: "b", label: "Approach B", preview: "preview text here" },
            ],
          },
          {
            id: "q2",
            prompt: "Anything to add?",
            type: "single",
            options: [{ value: "ok", label: "Looks good", freeform: true }],
          },
        ],
      })
      return "emitted pi-ask:started (rich)"
    case "plan":
      _emitTestBus("plan:snapshot", {
        ns: "test",
        seq: 1,
        items: [
          {
            id: "t1",
            kind: "plan",
            title: "Design the thing",
            status: "done",
            deps: [],
          },
          {
            id: "t2",
            kind: "plan",
            title: "Build the thing",
            status: "in_progress",
            deps: ["t1"],
          },
          {
            id: "t3",
            kind: "plan",
            title: "Test the thing",
            status: "pending",
            deps: ["t2"],
          },
        ],
      })
      return "emitted plan:snapshot"
    case "subagents":
      _emitTestBus("subagents:created", {
        id: "sa1",
        type: "explore",
        description: "Explore the codebase",
      })
      _emitTestBus("subagents:started", { id: "sa1" })
      _emitTestBus("subagents:created", {
        id: "sa2",
        type: "plan",
        description: "Draft an implementation plan",
      })
      _emitTestBus("subagents:completed", { id: "sa2" })
      return "emitted subagents lifecycle"
    case "svg": {
      // A TOOL card renders standalone; the app pulls tool-emitted images from
      // INSIDE the tool_execution_end `result` (imagesFromToolResult unwraps
      // `{content:[{type:"image",data,mimeType}]}`) and renders them below the
      // card (WireImageView -> SVGImageView). Deliver the SVG that way.
      const tc = `tc-svg-${Date.now()}`
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "render_svg",
          args: { note: "test svg" },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: {
            content: [
              { type: "text", text: "rendered a test SVG" },
              {
                type: "image",
                data: _TEST_SVG_B64,
                mimeType: "image/svg+xml",
              },
            ],
          },
          isError: false,
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent svg (envelope tool_execution_end + image)"
    }
    case "tool": {
      const tc = `tc-${Date.now()}`
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "echo hello" },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "hello\n",
          isError: false,
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent tool pair (envelope)"
    }
    case "diff": {
      // Exercise the rich diff rendering: aux `{hunks}` (input Edit diff) rides
      // ALONGSIDE the raw edit `tool_execution_start`. OUTPUT is classified
      // app-side from the result, so no aux.output rides the end frame.
      const tc = `tc-diff-${Date.now()}`
      const hunks = [
        {
          lines: [
            { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
            { kind: "remove", oldLine: 2, text: "const b = 2;" },
            { kind: "add", newLine: 2, text: "const b = 3;" },
            { kind: "context", oldLine: 3, newLine: 3, text: "const c = 4;" },
          ],
        },
      ]
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "edit",
          args: {
            path: "demo.ts",
            old_string: "const b = 2;",
            new_string: "const b = 3;",
          },
        },
        aux: { hunks },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "edited demo.ts",
          isError: false,
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent diff (edit + aux hunks — shows the Diff⇄Content toggle)"
    }
    case "code-shell": {
      // bash-family result → the app classifies it into a `code` block (lang
      // shell), syntax-highlighted. OUTPUT is app-side now — no aux stamped.
      const tc = `tc-sh-${Date.now()}`
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "ls -la" },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            "total 24\ndrwxr-xr-x  5 geo staff  160 Aug 29 10:00 .\n-rw-r--r--  1 geo staff 1024 index.ts\n-rw-r--r--  1 geo staff  512 README.md",
          isError: false,
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent code-shell (bash output → code block, lang shell)"
    }
    case "code-file": {
      // read-family with a *.swift path → `code` block, lang inferred from the
      // extension (swift) and highlighted.
      const tc = `tc-rd-${Date.now()}`
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "read",
          args: { path: "/src/Greeter.swift" },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            'struct Greeter {\n    let name: String\n    func greet() -> String {\n        return "Hello, \\(name)!"\n    }\n}',
          isError: false,
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent code-file (read .swift → highlighted code block)"
    }
    case "diff-output": {
      // A tool whose RESULT already embeds a unified diff → the app parses it
      // into a `diff` block (re-reading persisted text; replay-safe).
      const tc = `tc-do-${Date.now()}`
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "git diff" },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n const port = 3000;\n-const host = "127.0.0.1";\n+const host = "0.0.0.0";\n start(host, port);',
          isError: false,
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent diff-output (result embeds a unified diff → diff block)"
    }
    case "write": {
      // write carries the new file text in args.content; no live diff → the
      // card shows the Content view (new text as a code block, replay-safe).
      const tc = `tc-wr-${Date.now()}`
      const content =
        "export function add(a: number, b: number): number {\n  return a + b;\n}"
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "write",
          args: { path: "/src/math.ts", content },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "wrote /src/math.ts",
          isError: false,
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent write (args.content → content-as-code block)"
    }
    case "agent": {
      _broadcastEnvelope(relayDeps, { rpc: { type: "turn_start" } })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "This is a ",
          },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "test agent message.",
          },
        },
      })
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "This is a test agent message." }],
          },
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent agent message (envelope)"
    }
    case "error":
      _broadcastEnvelope(relayDeps, {
        rpc: {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "This is a test error.",
          },
        },
      })
      _broadcastEnvelope(relayDeps, { rpc: { type: "agent_settled" } })
      return "sent error (envelope message_end/error)"
    case "all":
      for (const sc of [
        "ask-notify",
        "plan",
        "subagents",
        "svg",
        "tool",
        "diff",
        "code-shell",
        "code-file",
        "diff-output",
        "write",
        "agent",
        "error",
      ])
        _runTestScenario(sc)
      return "sent all (ask-notify, plan, subagents, svg, tool, diff, code-shell, code-file, diff-output, write, agent, error)"
    default:
      return "usage: /unbien test <ask-select|ask-confirm|ask-input|ask-editor|ask-notify|ask-rich|plan|subagents|svg|tool|diff|code-shell|code-file|diff-output|write|agent|error|all>"
  }
}

/**
 * New-protocol inbound: dispatch an envelope-carried pi `RpcCommand` to the SDK
 * and answer with a `{ rpc: response }` envelope to the SENDER. Native to the
 * envelope wire — does NOT use the stock `_routeClientMessageFrom` switch. The
 * SDK primitives (`_wakeAgent`, `_abortCurrentTurn`) are pi, not old protocol.
 */
function _routeRpcCommandFrom(
  sender: PlainPeerChannel,
  env: EnvelopeMessage,
): void {
  const frame = env.rpc
  if (!frame || typeof frame !== "object") return // no {evt} inbound today
  envLog(`rpc inbound: ${String((frame as Record<string, unknown>).type)}`)
  // extension_ui_response is a reply to an extension-issued dialog, not a command —
  // route it straight to the ui bridge (same target as the stock path).
  if ((frame as Record<string, unknown>).type === "extension_ui_response") {
    // SAFETY: the type-discriminator check directly above proves this frame is
    // an extension_ui_response envelope, which is the ExtensionUiResponseWire shape.
    _extensionUiBridge?.respond(frame as unknown as ExtensionUiResponseWire)
    return
  }
  // session_sync (reconstruction) is un-bien's OWN protocol — dispatched on the
  // un plane by _routeUnBienPlaneFrom, NOT here. Only byte-faithful pi rpc
  // commands + extension_ui_response ride this rpc dispatch.
  const handlers = createRpcHandlers(rpcDeps, sender)
  void dispatchRpcCommand(frame as Record<string, unknown>, handlers)
    .then((resp) => {
      // Envelope-native ONLY: no stock fallback. An unhandled rpc type is
      // ignored (forward-compat). un-bien's own commands (session_sync,
      // session_launch) ride the un plane via _routeUnBienPlaneFrom.
      if (resp) sender.sendEnvelope(resp)
    })
    .catch((err) => {
      console.error(`[un-bien] rpc inbound dispatch failed: ${String(err)}`)
    })
}

/**
 * un-bien plane inbound (`type:"ub"`): dispatch un-bien's OWN protocol frames by
 * their inner `.type`. app->ext today: `session_sync` (reconstruction request)
 * and `session_launch` (mesh remote-launch). These are NOT pi rpc — the
 * EXTENSION acts. The reconstruction REPLAY frames it emits stay byte-faithful
 * pi rpc frames on the rpc plane; only the request + `session_sync_end`
 * terminator are un-plane frames.
 */
function _routeUnBienPlaneFrom(
  sender: PlainPeerChannel,
  env: EnvelopeMessage,
): void {
  const frame = env.ub
  if (!frame || typeof frame !== "object") return
  const type = (frame as Record<string, unknown>).type
  envLog(`ub inbound: ${String(type)}`)

  if (type === "session_sync") {
    const f = frame as Record<string, unknown>
    // session_sync now carries ONLY un-bien's NON-rpc display state: panels +
    // pending extension_ui. The TRANSCRIPT is the app's OWN native get_entries
    // rpc (reduced by SessionState.applyEntries) — NOT replayed here. Design
    // 01M15FMQ: separate the rpc transcript (get_entries) from un-bien panel/ui
    // state, each an independent app-driven request issued on open + reconnect.
    for (const req of _extensionUiBridge?.pendingRequests() ?? [])
      sender.send(req)
    const panels = _panelBridge?.pendingPanels() ?? []
    for (const panel of panels)
      sender.sendEnvelope({ evt: { channel: "panel", data: panel } })
    envLog(
      `session_sync(ub): panels=${panels.length} + ui (transcript is the app's get_entries rpc)`,
    )
    // Terminator/ack on the ub plane; carries the session clock so the app can
    // detect a pi restart. `truncated`/`limit` are gone (a replay concern;
    // get_entries is unbounded / since-delta).
    sender.sendEnvelope({
      ub: {
        type: "session_sync_end",
        ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
        session_started_at: _sessionStartedAt ?? 0,
      } as EnvelopeMessage["ub"],
    })
    return
  }

  if (type === "session_launch") {
    const f = frame as Record<string, unknown>
    const cwd = _expandTilde(
      typeof f.cwd === "string" && f.cwd.length > 0 ? f.cwd : process.cwd(),
    )
    if (!effectiveAllowRemoteLaunch(loadLocalConfig(cwd))) {
      envLog("session_launch(ub): remote launch disabled on this machine")
      return
    }
    // Backend is a MACHINE config choice (pick-one via launch.backend), not
    // app-chosen; rpc is a fast-follow so only tmux|herdr resolve here.
    const backend = loadConfig().launch?.backend === "herdr" ? "herdr" : "tmux"
    const launchError = _launchSession(
      backend,
      cwd,
      typeof f.name === "string" ? f.name : undefined,
    )
    if (launchError) envLog(`session_launch(ub) error: ${launchError}`)
    return
  }
}

// ── Display-name helpers ──────────────────────────────────────────────────────

/**
 * Resolves the name this Pi shows to the mobile app and the relay's
 * `room_meta.name`. Single source of truth for "what does this Pi call
 * itself when talking to others".
 *
 * Resolution order:
 *   1. Broker-assigned name (when this Pi is on the local UDS mesh) — may
 *      carry a `#N` suffix from a name collision. Matches what other
 *      agents see, so the mobile UI shows the exact same string.
 *   2. `agent_name` from `<cwd>/.pi/un-bien/config.json` — set by the
 *      wizard on first run; this is "the name the user configured".
 *   3. `defaultAgentName(cwd)` (parent/folder) — fallback when no config
 *      exists yet and the mesh hasn't been joined.
 *
 * Pre-2026-05-23 callers computed `cwd.split('/').slice(-2).join('/')`
 * inline at three different sites (pair_ok, room_meta, QR URI); this
 * helper consolidates them and lifts the user's configured name above
 * the raw cwd path.
 */
function _displayName(cwd: string): string {
  if (_meshNode) return _meshNode.name()
  const local = loadLocalConfig(cwd)
  return local.agent_name || defaultAgentName(cwd)
}

function _reportRevocationByFingerprint(canonicalOwnerPubkey: string): void {
  const fingerprint = _runtimeOwnerFingerprint(canonicalOwnerPubkey)
  _pi?.sendMessage({
    customType: "un-bien:mesh-revoked",
    content:
      `🔒 Revoked by Owner ${fingerprint}…\n\n` +
      `The mobile app for this Owner removed this PC from the mesh. ` +
      `Re-pair via /unbien pair if this was unexpected.`,
    display: true,
  })
}

function _revokeActiveOwnerRuntime(canonicalOwnerPubkey: string): void {
  if (!_activePeers.has(canonicalOwnerPubkey)) return
  _refreshPairingsCache()
  _detachPeerChannel(relayDeps, canonicalOwnerPubkey)
  _refreshFooter()
  _reportRevocationByFingerprint(canonicalOwnerPubkey)
}

/**
 * Rename the agent LIVE (plan/38/41), without restarting the process or losing
 * the SDK session/conversation. Touches two layers:
 *   1. **Broker (mesh)**: `MeshNode.rename` does a soft leave+rejoin → new
 *      address `<cwd>@<newName>` (broker may add `#N` on a same-(cwd,name)
 *      collision — we use the assigned result).
 *   2. **Relay room (App↔Pi)**: the room is keyed by `(cwd, name)`, so the new
 *      name = a new room. We cycle the relay (`_goIdle` → `_cmdStart`) so the
 *      room follows; the app re-keys the conversation onto the new tile (the
 *      inherent cost of room-per-name). Skipped when the relay was off.
 * Finally re-emits `un-bien:name-assigned` so the Cockpit updates its label.
 *
 * The explicit name IS persisted (decision E only skips the runtime `#N`).
 */
async function _renameAgent(newName: string): Promise<void> {
  if (!newName) return // empty rename → no-op
  const ctx = _controlCtx()
  const cwd = process.cwd()
  saveLocalConfig(cwd, { agent_name: newName })

  if (!_meshNode) {
    // Not on the mesh yet — config persisted; applies on the next join.
    return
  }

  // Relay room is derived from the name → cycle it so it follows. Tear down
  // first (also detaches the bridge) so the broker re-register below starts
  // clean; bring it back up after with the new name.
  const wasStarted = _getState() !== "idle"
  if (wasStarted) _goIdle(relayDeps)

  let assigned = newName
  try {
    assigned = await _meshNode.rename(newName) // broker soft rejoin
  } catch (err) {
    ctx.ui.notify(`[un-bien] rename failed: ${String(err)}`, "error")
  }

  if (wasStarted && !_disposed) await _cmdStart(deps, ctx) // relay back up → roomIdFor(cwd, assigned)

  _pi?.sendMessage({
    customType: "un-bien:name-assigned",
    content:
      assigned === newName
        ? `Mesh name: ${assigned}`
        : `Mesh name reassigned: "${newName}" → "${assigned}" (collision)`,
    details: { requested: newName, assigned, changed: assigned !== newName },
    display: false,
  })
}

// ── Extension factory (default export) ───────────────────────────────────────

// Stores most recent command context so the auto-listener can use ui.notify.
// NOTE: this is a CAPTURED command ctx — the SDK marks it stale after a
// session replacement (newSession/fork/switch/reload). We re-capture it via
// `withSession` when WE drive a newSession (see the session_new dispatch).
let _lastCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null = null
// Freshest base ExtensionContext, re-captured on EVERY `session_start`
// (startup/new/fork/reload/resume). The session_start ctx is always bound to
// the CURRENT session, so compact + cancel (base-ctx methods) routed through
// here never hit a stale ctx — regardless of who triggered the replacement
// (an app Quick Action OR a `/new` typed in the Pi TUI). It carries only
// base-ctx methods (no newSession — that's command-ctx only), so command ops
// keep using `_lastCtx`.
let _lastEventCtx: Pick<ExtensionContext, "compact" | "abort" | "ui"> | null =
  null
const _noopCtx = { ui: { notify: () => undefined }, abort: () => undefined }

// A single Pi process can load this extension TWICE in the SAME session:
// when it is launched as `pi -e <dist>/index.js` AND un-bien is ALSO installed
// as a pi-package (auto-discovered from ~/.pi/agent/extensions or
// <cwd>/.pi/extensions), Pi loads it a second time for that same session. Both
// loads receive the same session-scoped `pi` and would re-run
// registerTool/registerCommand for identical names — a hard
// duplicate-registration conflict that crashes the process on boot.
// Idempotent, first-load-wins: whichever load runs first
// does all the wiring; the duplicate is an inert no-op. A genuine session
// REPLACEMENT gets a FRESH `pi`, so re-registration for the new session still
// happens.
//
// We track "already wired" in a process-global WeakSet keyed by `pi` rather
// than by mutating the host SDK object. The two loads are DISTINCT module
// instances (the SDK's jiti loader uses moduleCache:false, and the `-e` path vs
// the installed path resolve to different files), so a module-level Set can't
// dedupe them; the WeakSet lives on `globalThis` under a `Symbol.for` key so
// both module instances resolve the SAME set. Keying weakly by `pi` records the
// fact without adding a foreign property to the API object and lets each `pi`
// be GC'd when its session ends (no leak).
const _APPLIED_REGISTRY_KEY = Symbol.for("un-bien.extension.appliedRegistry")
function _appliedRegistry(): WeakSet<object> {
  const g = globalThis as typeof globalThis & {
    [_APPLIED_REGISTRY_KEY]?: WeakSet<object>
  }
  return (g[_APPLIED_REGISTRY_KEY] ??= new WeakSet<object>())
}

// The panel bridge must bind to the ROOT session and never follow a subagent.
// Subagent sessions re-activate this extension IN-PROCESS (session.bindExtensions),
// and there can be MULTIPLE module instances, so a module-level guard isn't
// enough. Mirror pi-subagents' documented pattern for its manager: a globalThis
// `Symbol.for()` slot, "claim only if free — the first (root) activation wins,
// child activations leave it alone" (pi-packages#811 area / pi-subagents index.ts).
// The ROOT session owns every session-bound bridge (pi-ask UI + plan/subagents
// panels, and any future one). Subagent children re-activate this extension
// IN-PROCESS with a fresh `pi` (and there can be multiple module instances), so
// they must NOT create/dispose the root's bridges. Track the owner pi on a
// globalThis `Symbol.for()` slot — the sanctioned cross-instance pattern that
// pi-subagents uses for its manager: the root claims it, children see it owned
// and skip, and the root RELEASES it on its own shutdown so a replacement root
// session can re-claim. One owner gates all bridges (no per-bridge slots).
const _ROOT_SESSION_OWNER_KEY = Symbol.for("un-bien.rootSession.owner")
/** True if `pi` owns the root slot (or just claimed a free one); false if another pi owns it. */
function _claimRootSession(pi: ExtensionAPI): boolean {
  const g = globalThis as typeof globalThis & {
    [_ROOT_SESSION_OWNER_KEY]?: ExtensionAPI
  }
  if (g[_ROOT_SESSION_OWNER_KEY]) return g[_ROOT_SESSION_OWNER_KEY] === pi
  g[_ROOT_SESSION_OWNER_KEY] = pi
  return true
}
function _isRootSession(pi: ExtensionAPI): boolean {
  const g = globalThis as typeof globalThis & {
    [_ROOT_SESSION_OWNER_KEY]?: ExtensionAPI
  }
  return g[_ROOT_SESSION_OWNER_KEY] === pi
}
function _releaseRootSession(pi: ExtensionAPI): void {
  const g = globalThis as typeof globalThis & {
    [_ROOT_SESSION_OWNER_KEY]?: ExtensionAPI
  }
  if (g[_ROOT_SESSION_OWNER_KEY] === pi) delete g[_ROOT_SESSION_OWNER_KEY]
}

// ── Received-image pipeline seam ──────────────────────────────────────────
//
// The image-preview domain lives in ./session/received_images.ts and reaches
// this module's state + helpers ONLY through this object (that module never
// imports ../index.js — no circular imports). Same pattern as CommandDeps.
const imageDeps: ImagePipelineDeps = {
  get pi() {
    return _pi
  },
  rootState: _rootState,
  get myRoomMeta() {
    return _myRoomMeta
  },
  wakeAgent: _wakeAgent,
}

// ── Rpc-inbound handler seam ──────────────────────────────────────────────
//
// The rpc-command handler implementations live in ./session/rpc_handlers.ts
// (a factory this module's `_routeRpcCommandFrom` — which owns channel/sender
// routing — calls per dispatch). Same pattern as CommandDeps: that module
// never imports ../index.js — no circular imports.
const rpcDeps: RpcHandlersDeps = {
  get pi() {
    return _pi
  },
  rootState: _rootState,
  get lastEventCtx() {
    return _lastEventCtx
  },
  get lastCtx() {
    return _lastCtx
  },
  imageDeps,
  wakeAgent: _wakeAgent,
  abortCurrentTurn: () => _abortCurrentTurn(),
  set sessionStartedAt(v: number | null) {
    _sessionStartedAt = v
  },
}

// ── Relay lifecycle seam ──────────────────────────────────────────────────
//
// The relay lifecycle + owner-management code lives in
// ./session/relay_lifecycle.ts and reaches this module's state and helpers
// ONLY through this object (that module never imports ../index.js — no
// circular imports). Same pattern as CommandDeps. The two wrappers below
// preserve the exact `_handleControl` / `_onPeerDisconnect` export signatures
// the integration tests import.
const relayDeps: RelayLifecycleDeps = {
  get state() {
    return _state
  },
  set state(v) {
    _state = v
  },
  get relay() {
    return _relay
  },
  set relay(v) {
    _relay = v
  },
  get relayUrl() {
    return _relayUrl
  },
  set relayUrl(v) {
    _relayUrl = v
  },
  get peerShort() {
    return _peerShort
  },
  set peerShort(v) {
    _peerShort = v
  },
  get stopAutoListener() {
    return _stopAutoListener
  },
  set stopAutoListener(v) {
    _stopAutoListener = v
  },
  get selfRevoke() {
    return _selfRevoke
  },
  set selfRevoke(v) {
    _selfRevoke = v
  },
  get selfRevokeEpoch() {
    return _selfRevokeEpoch
  },
  set selfRevokeEpoch(v) {
    _selfRevokeEpoch = v
  },
  get selfRevokeTopologyReadyEpoch() {
    return _selfRevokeTopologyReadyEpoch
  },
  set selfRevokeTopologyReadyEpoch(v) {
    _selfRevokeTopologyReadyEpoch = v
  },
  get selfRevokeTopology() {
    return _selfRevokeTopology
  },
  set selfRevokeTopology(v) {
    _selfRevokeTopology = v
  },
  get rootLifecycleGeneration() {
    return _rootLifecycleGeneration
  },
  set rootLifecycleGeneration(v) {
    _rootLifecycleGeneration = v
  },
  get meshNode() {
    return _meshNode
  },
  get cachedEd25519() {
    return _cachedEd25519
  },
  get myRoomId() {
    return _myRoomId
  },
  get myRoomMeta() {
    return _myRoomMeta
  },
  get sessionStartedAt() {
    return _sessionStartedAt
  },
  get lastCtx() {
    return _lastCtx
  },
  get disposed() {
    return _disposed
  },
  get pi() {
    return _pi
  },
  get rootSessionId() {
    return _rootSessionId
  },
  get commandDeps() {
    return deps
  },
  activePeers: _activePeers,
  rootState: _rootState,
  getState: _getState,
  refreshFooter: _refreshFooter,
  safeNotify: _safeNotify,
  refreshPairingsCache: _refreshPairingsCache,
  displayName: _displayName,
  attachBridgeIfReady: _attachBridgeIfReady,
  routeClientMessageFrom: _routeClientMessageFrom,
  routeRpcCommandFrom: _routeRpcCommandFrom,
  routeUnBienPlaneFrom: _routeUnBienPlaneFrom,
  liveCtx: _liveCtx,
  noopCtx: _noopCtx,
  renameAgent: _renameAgent,
}

export async function _handleControl(cmd: string): Promise<void> {
  await _handleControlImpl(relayDeps, cmd)
}

export function _onPeerDisconnect(appPeerId?: string): void {
  _onPeerDisconnectImpl(relayDeps, appPeerId)
}

// ── Command seam ──────────────────────────────────────────────────────────────
//
// The /unbien handlers live in ./commands/ and reach this module's state
// and helpers ONLY through this object (command modules never import
// ../index.js — no circular imports). Mutable module state is exposed as
// accessor closures so handlers and this module always see the same
// variables.
const deps: CommandDeps = {
  get state() {
    return _state
  },
  set state(v) {
    _state = v
  },
  get relay() {
    return _relay
  },
  set relay(v) {
    _relay = v
  },
  get relayUrl() {
    return _relayUrl
  },
  set relayUrl(v) {
    _relayUrl = v
  },
  get meshNode() {
    return _meshNode
  },
  set meshNode(v) {
    _meshNode = v
  },
  get sessionName() {
    return _sessionName
  },
  set sessionName(v) {
    _sessionName = v
  },
  get sessionPeerCount() {
    return _sessionPeerCount
  },
  set sessionPeerCount(v) {
    _sessionPeerCount = v
  },
  get cachedEd25519() {
    return _cachedEd25519
  },
  set cachedEd25519(v) {
    _cachedEd25519 = v
  },
  get currentModel() {
    return _currentModel
  },
  set currentModel(v) {
    _currentModel = v
  },
  get currentThinking() {
    return _currentThinking
  },
  set currentThinking(v) {
    _currentThinking = v
  },
  get myRoomId() {
    return _myRoomId
  },
  set myRoomId(v) {
    _myRoomId = v
  },
  get myRoomMeta() {
    return _myRoomMeta
  },
  set myRoomMeta(v) {
    _myRoomMeta = v
  },
  get peerShort() {
    return _peerShort
  },
  set peerShort(v) {
    _peerShort = v
  },
  get sessionStartedAt() {
    return _sessionStartedAt
  },
  set sessionStartedAt(v) {
    _sessionStartedAt = v
  },
  get lastCtx() {
    return _lastCtx
  },
  set lastCtx(v) {
    _lastCtx = v
  },
  get cwdLock() {
    return _cwdLock
  },
  set cwdLock(v) {
    _cwdLock = v
  },
  get lockedName() {
    return _lockedName
  },
  set lockedName(v) {
    _lockedName = v
  },
  get relayLifecycleGeneration() {
    return _getRelayLifecycleGeneration()
  },
  set relayLifecycleGeneration(v) {
    _setRelayLifecycleGeneration(v)
  },
  get relayStartDeferred() {
    return _relayStartDeferred
  },
  set relayStartDeferred(v) {
    _relayStartDeferred = v
  },
  get rootLifecycleGeneration() {
    return _rootLifecycleGeneration
  },
  set rootLifecycleGeneration(v) {
    _rootLifecycleGeneration = v
  },
  get meshJoinGeneration() {
    return _meshJoinGeneration
  },
  set meshJoinGeneration(v) {
    _meshJoinGeneration = v
  },
  get selfRevoke() {
    return _selfRevoke
  },
  set selfRevoke(v) {
    _selfRevoke = v
  },
  get selfRevokeEpoch() {
    return _selfRevokeEpoch
  },
  set selfRevokeEpoch(v) {
    _selfRevokeEpoch = v
  },
  get selfRevokeTopologyReadyEpoch() {
    return _selfRevokeTopologyReadyEpoch
  },
  set selfRevokeTopologyReadyEpoch(v) {
    _selfRevokeTopologyReadyEpoch = v
  },
  get selfRevokeTopology() {
    return _selfRevokeTopology
  },
  set selfRevokeTopology(v) {
    _selfRevokeTopology = v
  },
  get stopAutoListener() {
    return _stopAutoListener
  },
  set stopAutoListener(v) {
    _stopAutoListener = v
  },
  get hasGlobalPairings() {
    return _hasGlobalPairings
  },
  get disposed() {
    return _disposed
  },
  get lastEventCtx() {
    return _lastEventCtx
  },
  get pi() {
    return _pi
  },
  get rootSessionId() {
    return _rootSessionId
  },
  activePeers: _activePeers,
  isCurrentRootLifecycle: _isCurrentRootLifecycle,
  displayName: _displayName,
  deriveRoomId: _deriveRoomId,
  currentModelName: _currentModelName,
  rootState: _rootState,
  goIdle: () => _goIdle(relayDeps),
  onRelayClose: (closedRelay) => _onRelayClose(relayDeps, closedRelay),
  installAutoListener: (relay) => _installAutoListener(relayDeps, relay),
  refreshFooter: _refreshFooter,
  revokeActiveOwnerRuntime: _revokeActiveOwnerRuntime,
  attachBridgeIfReady: _attachBridgeIfReady,
  emitRelayState: (force?) => _emitRelayState(relayDeps, force),
  refreshSessionPeerCount: _refreshSessionPeerCount,
  deliverMeshMessageToAgent: _deliverMeshMessageToAgent,
  refreshPairingsCache: _refreshPairingsCache,
  detachPeerChannel: (appPeerId) => _detachPeerChannel(relayDeps, appPeerId),
  handleControl: _handleControl,
  relayStatus: () => _relayStatus(relayDeps),
  getState: _getState,
  runTestScenario: _runTestScenario,
  safeNotify: _safeNotify,
  renameAgent: _renameAgent,
}

// ── Test-only hooks seam ──────────────────────────────────────────────────────
//
// The _xForTest surface lives in ./test_hooks.ts (a factory over this module's
// state + helpers — that module never imports ../index.js). The one-line
// re-exports below preserve the exact export names every existing test
// (extension.test.ts + the colocated command tests) imports.
const _testHooks = createTestHooks({
  commandDeps: deps,
  get disposed() {
    return _disposed
  },
  set disposed(v) {
    _disposed = v
  },
  set autoInited(v: boolean) {
    _autoInited = v
  },
  get panelBridge() {
    return _panelBridge
  },
  set panelBridge(v) {
    _panelBridge = v
  },
  get rpcEnvelope() {
    return _rpcEnvelope
  },
  set rpcEnvelope(v) {
    _rpcEnvelope = v
  },
  get subagentRooms() {
    return _subagentRooms
  },
  set subagentRooms(v) {
    _subagentRooms = v
  },
  get extensionUiBridge() {
    return _extensionUiBridge
  },
  set extensionUiBridge(v) {
    _extensionUiBridge = v
  },
  set rootSessionId(v: string | null) {
    _rootSessionId = v
  },
  get cwdLock() {
    return _cwdLock
  },
  set cwdLock(v) {
    _cwdLock = v
  },
  get lockedName() {
    return _lockedName
  },
  set lockedName(v: string | null) {
    _lockedName = v
  },
  set sessionStartedAt(v: number | null) {
    _sessionStartedAt = v
  },
  set currentModel(v: string | undefined) {
    _currentModel = v
  },
  set pi(v: ExtensionAPI | null) {
    _pi = v
  },
  set relayStartDeferred(v: boolean) {
    _relayStartDeferred = v
  },
  rootSessionOwnerKey: _ROOT_SESSION_OWNER_KEY,
  sessions: _sessions,
  get meshNode() {
    return _meshNode
  },
  get selfRevoke() {
    return _selfRevoke
  },
  get cachedEd25519() {
    return _cachedEd25519
  },
  get reconnectTimer() {
    return _getReconnectTimer()
  },
  activePeers: _activePeers,
  rootState: _rootState,
  seedRootSession(sid: string) {
    _rootSessionId = sid
    _stateFor(sid).sessionManager = {
      getSessionId: () => sid,
    } as ExtensionContext["sessionManager"]
  },
  deliverMeshMessageToAgent: _deliverMeshMessageToAgent,
})

export const _connectForTest = _testHooks.connectForTest
export const _stopForTest = _testHooks.stopForTest
export const _getDisposedForTest = _testHooks.getDisposedForTest
export const _setDisposedForTest = _testHooks.setDisposedForTest
export const _resetAutoInitedForTest = _testHooks.resetAutoInitedForTest
export const _resetBridgeOwnersForTest = _testHooks.resetBridgeOwnersForTest
export const _resetSessionsForTest = _testHooks.resetSessionsForTest
export const _seedRootSessionForTest = _testHooks.seedRootSessionForTest
export const _setAutoInitedForTest = _testHooks.setAutoInitedForTest
export const _hasMeshNodeForTest = _testHooks.hasMeshNodeForTest
export const _checkSelfRevokeForTest = _testHooks.checkSelfRevokeForTest
export const _getLockedNameForTest = _testHooks.getLockedNameForTest
export const _resetCwdLockForTest = _testHooks.resetCwdLockForTest
export const _startRelayForTest = _testHooks.startRelayForTest
export const _getCachedPublicKeyForTest = _testHooks.getCachedPublicKeyForTest
export const _setSessionStartedAtForTest = _testHooks.setSessionStartedAtForTest
export const _setCurrentModelForTest = _testHooks.setCurrentModelForTest
export const _getCurrentTurnIdForTest = _testHooks.getCurrentTurnIdForTest
export const _setPiForTest = _testHooks.setPiForTest
export const _hasPendingReconnect = _testHooks.hasPendingReconnect
export const _getActivePeerCountForTest = _testHooks.getActivePeerCountForTest
export const _hasActivePeerForTest = _testHooks.hasActivePeerForTest
export const _deliverMeshMessageToAgentForTest =
  _testHooks.deliverMeshMessageToAgentForTest

const extension: ExtensionFactory = (pi: ExtensionAPI): void => {
  const applied = _appliedRegistry()
  if (applied.has(pi)) return // this session's pi was already wired
  applied.add(pi)

  // Plan/57 — bridge @eko24ive/pi-ask clarification flows to the paired app.
  // Inert when pi-ask isn't installed (no events fire) or the SDK exposes no
  // events bus. ask_user without pi-ask doesn't exist, so this never breaks a
  // Pi that doesn't use the extension. Bind the session-bound bridges ONCE to
  // the root session (pi-ask UI + plan/subagents panels). A subagent child
  // re-runs this factory but must not tear down the root's bridges mid-turn;
  // only the root's ownership claim creates them, children skip.
  //
  // CRITICAL: `_pi` is set ONLY for the root session. A subagent re-activates
  // this extension IN-PROCESS with its OWN pi; letting it hijack `_pi` means
  // app prompts (sendUserMessage) + busy checks (isStreaming) target the
  // subagent's (dead, post-run) session — the 'prompt goes to the void
  // post-subagent' bug. Children skip; `_pi` stays the root's. (Turn/session
  // state no longer relies on a root-claim closure flag — handlers key by the
  // firing session's id via ctx.sessionManager.getSessionId(); see _sidOf /
  // _isNonRootSid.)
  if (_claimRootSession(pi)) {
    _pi = pi
    _extensionUiBridge?.dispose()
    _extensionUiBridge = createExtensionUiBridge(pi, (msg) =>
      _uiBroadcast(relayDeps, msg),
    )
    _panelBridge?.dispose()
    _panelBridge = createPanelBridge(
      pi,
      (msg) => _panelBroadcast(relayDeps, msg),
      {
        suppressAgents: subagentRoomsEnabled(),
      },
    )
    _rpcEnvelope?.dispose()
    _rpcEnvelope = createRpcEnvelope(
      pi,
      (env) => _broadcastEnvelope(relayDeps, env),
      {
        enrichArgs: (tool, args) => {
          const e = _enrichToolArgs(tool, args, _resolveToolCwd()) as {
            hunks?: unknown[]
          }
          return Array.isArray(e.hunks) ? { hunks: e.hunks } : null
        },
      },
    )
    _subagentRooms?.dispose()
    _subagentRooms = initSubagentRooms(pi, {
      getParentRoomId: () => _myRoomId,
      getParentSessionId: () => _rootSessionId,
      broadcastPanel: (msg) => _panelBroadcast(relayDeps, msg),
    })
  }

  // Plano 19: ensure ~/.pi/un-bien/{sessions,skills}/ exist and deploy the
  // agent-network skill on first load. resources_discover lets Pi find it.
  try {
    ensureGlobalDirs()
    _deployAgentNetworkSkill()
  } catch {
    /* best-effort init */
  }

  // Seed the global-pairings cache from peers.json so the footer can show
  // 🟢/🟡 correctly the moment the relay is up (no race with first refresh).
  _refreshPairingsCache()

  pi.on("resources_discover", () => ({ skillPaths: [skillsDir()] }))

  // Plano 20: agent_send + agent_request tools so the LLM can drive the
  // session network natively. Getter captures `_meshNode` live so the
  // tool always sees the current state.
  registerAgentTools(pi, () => _meshNode?.peer() ?? null)
  _registerReceivedImageRenderer(pi)

  // Received-image preview entries are for local TUI display only. Pi's custom
  // messages normally become user-role LLM context, so strip this type before
  // every provider request; the actual Android image still reaches the model via
  // the paired sendUserMessage call.
  pi.on("context", (event) => ({
    messages: _filterInternalMessagesFromContext(event.messages),
  }))

  // Tool calls execute without prompting the remote user. The Pi SDK has no
  // native `requiresApproval` per tool, and a hardcoded gate (Bash/Edit/Write)
  // misfired on every custom tool from third-party packages. Approval will
  // come back when the Pi ecosystem ships a permissions convention. tool_result
  // is still forwarded so the app shows tool activity transparently.

  // Mirror input typed in the Pi terminal (or sent via RPC) to every
  // connected owner. 'extension' source is our own sendUserMessage call
  // from routeClientMessage, which already set _rootState().turnId — skip to
  // avoid a double turnId.
  pi.on("input", (event) => {
    // Transparent control channel: a `CTRL_PREFIX`-tagged input from an RPC
    // client (Cockpit button) toggles the relay. Run it and SWALLOW the input
    // (`action:"handled"`) so it never reaches the LLM or the transcript.
    // Checked first, before the peer-broadcast path, and regardless of source.
    if (event.text.startsWith(CTRL_PREFIX)) {
      void _handleControl(event.text.slice(CTRL_PREFIX.length).trim())
      return { action: "handled" } as const
    }
    if (!_anyPeerActive(relayDeps)) return
    if (event.source === "extension") return
    // Turn id still stamped for queue/turn correlation; the app renders the
    // user bubble from the envelope message_end (role:user), not a stock frame.
    _rootState().turnId = `local_${randomUUID()}`
    return undefined
  })

  // Track active model so the app can show it in the SessionTile (plano 18).
  // SDK fires model_select on settings load + every user switch. We cache the
  // friendly name and broadcast a room_meta_update so the relay can fan it
  // out to subscribed apps without needing a new pair.
  pi.on("model_select", (event, ctx) => {
    const m = event?.model as { name?: string; id?: string } | undefined
    const modelName = m?.name ?? m?.id
    if (!modelName) return
    // Cache per-sid for THIS session (root + subagent) so a subagent's model is
    // queryable and never clobbers the root's. Only the ROOT projects to
    // _currentModel + room_meta (the app-room's model hello/update).
    const sid = _sidOf(ctx)
    _stateFor(sid).model = modelName
    if (!_isNonRootSid(sid)) _setCurrentModel(modelName)
  })

  // Plan/28 Wave D.1: mirror model's room_meta_update path for thinking
  // level so the app hydrates the segmented control on first open instead
  // of starting null. SDK fires `thinking_level_select` on settings load
  // AND on every user toggle (matching `model_select`'s behavior), so
  // late-pairing apps see the current level via `room_meta_updated`.
  pi.on("thinking_level_select", (event, ctx) => {
    const level = event?.level as ThinkingLevel | undefined
    if (!level) return
    // Cache per-sid; only the ROOT projects to _currentThinking + room_meta.
    const sid = _sidOf(ctx)
    _stateFor(sid).thinking = level
    if (_isNonRootSid(sid)) return
    _currentThinking = level
    if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, thinking: level }
    if (!_relay || !_myRoomId) return
    _relay.sendControl({
      type: "room_meta_update",
      room_id: _myRoomId,
      meta: { thinking: level },
    })
  })

  pi.on("agent_start", (_event, ctx) => {
    const st = _stateFor(_sidOf(ctx))
    st.agentRun.active = true
    st.agentRun.generation += 1
  })

  // Live transcript (assistant text/thinking deltas + tool_request/tool_result)
  // is produced by the rpc-envelope producer (createRpcEnvelope) from the same
  // pi.on(message_update / tool_execution_*) events — no stock broadcast here.

  pi.on("agent_end", (_event, ctx) => {
    const sid = _sidOf(ctx)
    const st = _stateFor(sid)
    // Clear THIS session's run flag on the next tick (generation guards a
    // queued continuation that started first).
    const endedGeneration = st.agentRun.generation
    const settleRun = () =>
      setTimeout(() => {
        if (st.agentRun.generation !== endedGeneration) return
        st.agentRun.active = false
        if (!_isNonRootSid(sid)) _scheduleMeshMessageDrain()
      }, 0)
    if (_isNonRootSid(sid)) {
      settleRun()
      return // subagent end has no app-facing effect
    }
    // Root: close the outbound turn. The app renders turn completion from the
    // envelope (turn_end / agent_settled), so no stock agent_done is sent; we
    // only clear the turn id used for queue/turn correlation.
    if (st.turnId) st.turnId = null
    _flushPendingReceivedImagePreviews(imageDeps)
    settleRun()
  })

  // plan/34: the broker no longer gates delivery on busy state, so we no
  // longer notify it of turn lifecycle. Working state is still published as
  // room_meta over the relay (plan/32) below — that's independent of the
  // broker and drives the app's working indicator.
  pi.on("turn_start", (_event, ctx) => {
    const sid = _sidOf(ctx)
    const st = _stateFor(sid)
    // Each session records its OWN sessionManager (no cross-session clobber).
    if (ctx?.sessionManager) st.sessionManager = ctx.sessionManager
    st.working = true
    // Late model hydration for THIS session: if the model was unknown at
    // connect (SDK resolves it lazily), grab it on the first turn and cache
    // per-sid — root AND subagent, so a subagent's model is queryable and the
    // root's is never clobbered by a child.
    if (!st.model) {
      try {
        const m = (
          ctx as Partial<ExtensionContext> & {
            getModel?: () => { name?: string; id?: string } | undefined
          }
        ).getModel?.()
        const name = m?.name ?? m?.id
        if (name) st.model = name
      } catch {
        /* defensive — never block a turn on a model lookup */
      }
    }
    if (_isNonRootSid(sid)) return // room_meta projection is root-only
    // Root projection: seed the global model + room_meta hello from the root's
    // cached model, once.
    if (!_currentModel && st.model) _setCurrentModel(st.model)
    // Plan/32 Part B: publish working=true as room_meta (raw, no debounce —
    // the debounce lives in the app). Same shape as the model/thinking updates.
    // _myRoomMeta is the ROOM projection (driven only by the root session).
    if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, working: true }
    if (_relay && _myRoomId) {
      _relay.sendControl({
        type: "room_meta_update",
        room_id: _myRoomId,
        meta: { working: true },
      })
    }
  })
  pi.on("turn_end", (_event, ctx) => {
    const sid = _sidOf(ctx)
    _stateFor(sid).working = false
    if (_isNonRootSid(sid)) return // room_meta is root-only
    // Plan/32 Part B: publish working=false as room_meta (raw, no debounce).
    if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, working: false }
    if (_relay && _myRoomId) {
      _relay.sendControl({
        type: "room_meta_update",
        room_id: _myRoomId,
        meta: { working: false },
      })
    }
  })

  // Plan/32: compaction feedback. compact() doesn't run a turn, so bracket it
  // with working=true/false here. Returning void = no veto → default
  // compaction proceeds.
  pi.on("session_before_compact", (event, ctx) => {
    if (event.preparation) {
      event.preparation.messagesToSummarize =
        _filterInternalMessagesFromContext(
          event.preparation.messagesToSummarize,
        )
      event.preparation.turnPrefixMessages = _filterInternalMessagesFromContext(
        event.preparation.turnPrefixMessages,
      )
    }
    // working=true brackets the ROOT room's compaction; the per-session message
    // filtering above always runs, but a subagent that compacts must not
    // flicker the root's working indicator.
    if (!_isNonRootSid(_sidOf(ctx))) _publishWorking(true)
  })
  pi.on("session_compact", (_event, ctx) => {
    // Live compaction result rides the rpc-envelope compaction_end (app applyRPC),
    // and the persisted CompactionEntry surfaces natively via get_entries. Only
    // the working=false bracket remains here — the ROOT room's, so guard it.
    if (!_isNonRootSid(_sidOf(ctx))) _publishWorking(false)
  })

  // Re-capture the freshest base ctx on every session replacement so compact
  // never operates on a stale captured ctx — this is the fix for the
  // "stale after session replacement" crash when the app taps Compact after a
  // New session. Fires on startup/new/fork/reload/resume; the ctx is always
  // bound to the current session.
  pi.on("session_start", (_event, ctx) => {
    // Register THIS session's record (root + every subagent get their own
    // session_start with their own ctx). Each records its OWN sessionManager —
    // no cross-session clobber (was the unguarded `_sessionManager = ...` bug).
    const sid = _sidOf(ctx)
    // The module BASE ctx (compact/notify fallback when no fresh ctx is passed)
    // is the ROOT's — a subagent child's ctx must NOT clobber it, same
    // no-cross-session-clobber rule as the per-sid sessionManager. Otherwise a
    // subagent steals the base ctx and root-scoped notifies silently drop.
    if (!_isNonRootSid(sid)) _lastEventCtx = ctx
    if (ctx?.sessionManager) _stateFor(sid).sessionManager = ctx.sessionManager
    // session_shutdown disposes per-session pi-ask subscriptions. A host that
    // reuses this module instance does NOT re-run the factory, so rebind the
    // bridge here; fresh-module hosts already created theirs in the factory.
    // Only the ROOT owner rebinds (re-claims a slot freed by its own shutdown);
    // a subagent child's session_start must not seize it. Covers both bridges.
    // The root claim also fixes _rootSessionId (re-captured across replacement);
    // only when a real sessionManager is present (ctx-less test events stay in
    // null-root mode where every event is treated as root).
    if (_claimRootSession(pi)) {
      if (ctx?.sessionManager) _rootSessionId = sid
      if (!_extensionUiBridge)
        _extensionUiBridge = createExtensionUiBridge(pi, (msg) =>
          _uiBroadcast(relayDeps, msg),
        )
      if (!_panelBridge)
        _panelBridge = createPanelBridge(
          pi,
          (msg) => _panelBroadcast(relayDeps, msg),
          {
            suppressAgents: subagentRoomsEnabled(),
          },
        )
      if (!_rpcEnvelope)
        _rpcEnvelope = createRpcEnvelope(
          pi,
          (env) => _broadcastEnvelope(relayDeps, env),
          {
            enrichArgs: (tool, args) => {
              const e = _enrichToolArgs(tool, args, _resolveToolCwd()) as {
                hunks?: unknown[]
              }
              return Array.isArray(e.hunks) ? { hunks: e.hunks } : null
            },
          },
        )
      if (!_subagentRooms)
        _subagentRooms = initSubagentRooms(pi, {
          getParentRoomId: () => _myRoomId,
          getParentSessionId: () => _rootSessionId,
          broadcastPanel: (msg) => _panelBroadcast(relayDeps, msg),
        })
    } else if (_isNonRootSid(sid)) {
      // A subagent child session (non-root) — surface it as its own relay room.
      // `pi` here is the CHILD's ExtensionAPI (per-activation).
      _subagentRooms?.onChildSession(pi, ctx)
    }
    // design 01M1CAW0 (announce waits for the session id): a relay start that
    // was deferred because no session id existed re-runs NOW — the root
    // session's sessionManager was captured above, so _deriveRoomId has an id
    // to announce. Root session_starts only (a child never owned the relay);
    // the flag stays armed when this session_start still carries no id.
    if (deps.relayStartDeferred && !_isNonRootSid(sid)) {
      if (_rootState().sessionManager?.getSessionId()) {
        deps.relayStartDeferred = false
        void _cmdStart(deps, ctx)
      }
    }
    // Rearm a reused-but-disposed instance. The session_shutdown teardown (below)
    // sets _disposed=true assuming the host re-evaluates THIS module fresh for the
    // replacement session, yielding a new instance with _disposed=false. Some hosts
    // instead REUSE the same module instance across ctx.newSession(). Rearm that
    // instance, but retain the shutdown generations as replacement authority:
    // `_cmdRoot` waits for any canceled outgoing root to drain, then starts exactly
    // one fresh lifecycle only if no later stop/shutdown superseded this session.
    // No-op when a fresh instance IS created and at first boot.
    if (_disposed) {
      _disposed = false
      const restartAuthority: RootRestartAuthority = {
        rootLifecycleGeneration: _rootLifecycleGeneration,
      }
      void _cmdRoot(deps, ctx, restartAuthority)
    }
    // Auto-start un-bien on a fresh boot when the cwd's local config has
    // auto_start_relay enabled (default true). Covers BOTH interactive
    // sessions (previously required typing /unbien each session) AND
    // headless daemons. We init here — on session_start — NOT via a
    // factory-return setTimeout(0): the SDK only calls bindCore() (which
    // replaces the throwing action-method stubs like pi.sendMessage) right
    // before emitting session_start, so a setTimeout(0) from the factory
    // raced it and crashed with "Extension runtime not initialized" inside
    // _emitRelayState -> sendMessage. session_start fires strictly AFTER
    // bindCore (agent-session bindExtensions), so pi.sendMessage is a real
    // function here. Guarded by _autoInited so session replacements re-init
    // only via the _disposed path above. Daemon mode has no interactive UI →
    // use the headless ctx; interactive sessions use the real session_start
    // ctx (has ui.notify + dialogs for the first-run wizard).
    if (!_autoInited) {
      // Daemon: always init (supervisor sets UNBIEN_DIRECT_CONFIG so a config
      // is present at process.cwd()). Interactive: only init when the
      // session_start ctx announces its cwd AND a local config already exists
      // there — never auto-pop the first-run wizard on session_start (a new dir
      // with no config stays idle until the user runs /unbien once). The
      // cwd guard also keeps tests with a minimal ctx (no cwd) from triggering
      // the wizard path.
      const isDaemon = process.env["UNBIEN_DAEMON"] === "1"
      // One-shot / non-interactive Pi (`pi -p` / `pi --print`) is documented as
      // "process the prompt and exit". Auto-starting the relay there opens a WS
      // that is never `.unref()`'d, so the idle Node event loop never drains and
      // the process hangs forever after printing its answer (issue #44). Daemon
      // mode (UNBIEN_DAEMON=1) and normal interactive sessions never pass
      // `-p`/`--print`, so they still auto-start the relay exactly as before.
      const isPrintMode =
        process.argv.includes("-p") || process.argv.includes("--print")
      const cwd = isDaemon ? process.cwd() : "cwd" in ctx ? ctx.cwd : undefined
      if (
        !isPrintMode &&
        cwd &&
        localConfigExists(cwd) &&
        effectiveAutoStartRelay(loadLocalConfig(cwd))
      ) {
        _autoInited = true
        const initCtx = isDaemon
          ? ({ ui: _headlessUi(), cwd: process.cwd() } as Pick<
              ExtensionContext,
              "ui" | "cwd"
            >)
          : ctx
        void _cmdRoot(deps, initCtx)
      }
    }
  })

  // Tear down THIS instance's live handles when the SDK replaces the session
  // (switch_session / new / fork / reload / quit). This is the fix for the
  // "double mesh connection" the Cockpit hits when it restores a saved
  // conversation via switch_session on boot.
  //
  // Why it happens: the Pi SDK loads extensions through jiti with
  // `moduleCache: false`, so every session replacement re-evaluates THIS module
  // FRESH — a brand-new instance whose `_meshNode`, `_relay`, and `_cwdLock`
  // start back at null. The OUTGOING instance's broker socket, relay WS, and
  // cwd-lock UDS keep running regardless (module state is gone, but the OS
  // handles aren't). In daemon mode (UNBIEN_DAEMON=1, set by the Cockpit) the
  // fresh instance re-runs `_cmdRoot` on load, so without releasing the old
  // handles first we end up with TWO mesh peers under the same name on the
  // broker + two rooms on the relay. The per-cwd lock is meant to stop the
  // second connect, but its 500 ms connect-probe can miss the still-bound old
  // socket while the event loop is saturated at boot, fall through to the
  // stale-socket unlink path, and let the fresh instance bind a second lock.
  //
  // `session_shutdown` fires on the OUTGOING extension runner and is AWAITED by
  // the SDK (`teardownCurrent`) BEFORE the replacement runtime — and thus the
  // fresh extension instance — is created. Closing the mesh node, relay, and
  // lock here guarantees the next instance starts from a clean slate and stands
  // up exactly ONE connection bound to the restored session. Idempotent +
  // best-effort: every step is guarded so a partially-initialised instance
  // (e.g. shutdown lands mid-`_cmdRoot`) tears down without throwing.
  pi.on("session_shutdown", async () => {
    // A subagent child's session_shutdown owns NOTHING at the module level: the
    // connection, mesh node, cwd lock, lifecycle generations, and base ctx are
    // the ROOT's, and its child room outlives the turn (reaped by the root's
    // _subagentRooms.dispose(), not here). So a non-root shutdown is a no-op.
    // Without this, a subagent ENDING poisoned _disposed + the generations AND
    // tore down the root's mesh node / cwd lock; the next root session_start's
    // `if (_disposed)` rearm then re-ran _cmdRoot, dropping and re-announcing
    // the root room — the "parent disappears while still running" flap. This is
    // root-lifecycle authority (Tier 2), NOT the per-sid data path, so an
    // early return is correct here — there is no session-local state to cache.
    if (!_isRootSession(pi)) return
    // Revoke async authority synchronously, before any teardown await. `_disposed`
    // blocks the outgoing continuation immediately; the root and candidate
    // generations keep queued work stale even if a same-module session_start
    // clears `_disposed` before its promises settle.
    _disposed = true
    _rootLifecycleGeneration += 1
    _setRelayLifecycleGeneration(_getRelayLifecycleGeneration() + 1)
    _meshJoinGeneration += 1
    // The bridge owns live pi.events subscriptions + flow TTLs. Dispose before
    // the outgoing session is replaced so stale listeners cannot leak or
    // double-broadcast. session_start rebinds it on module-reuse hosts; fresh
    // module instances create their bridge in the factory.
    // Guard on ownership: a subagent child's session_shutdown (when the subagent
    // ends) must NOT dispose the root's bridges mid-turn. The root disposes both
    // and releases ownership so a replacement root session can re-claim it.
    if (_isRootSession(pi)) {
      // Pi surfaces session end ONLY as this extension event — there is no
      // native rpc frame. Forward it faithfully on the rpc plane so a paired
      // app can mark the session ended. Emit EXPLICITLY here, BEFORE the
      // producer dispose below: `_rpcEnvelope` gates on its `disposed` flag,
      // so once disposed it can no longer build/broadcast this frame.
      if (_anyPeerActive(relayDeps)) {
        _broadcastEnvelope(relayDeps, { rpc: { type: "session_shutdown" } })
      }
      _extensionUiBridge?.dispose()
      _extensionUiBridge = null
      _panelBridge?.dispose()
      _panelBridge = null
      _rpcEnvelope?.dispose()
      _rpcEnvelope = null
      _subagentRooms?.dispose()
      _subagentRooms = null
      _releaseRootSession(pi)
    }
    // Drop captured ctxs immediately. On module-reuse hosts the same instance
    // survives session replacement; leaving `_lastCtx` pointing at the now-
    // stale command ctx is what crashed pi in _refreshFooter on peer reconnect
    // (issue #55). session_start re-binds `_lastEventCtx` for the new session.
    _lastCtx = null
    _lastEventCtx = null
    // No bye reason: the process keeps running and the fresh instance re-joins
    // the SAME relay room, so an explicit offline→online flap would be wrong.
    // Revoke producer/Relay/bridge authority while the global node is still
    // visible, before close() can begin its asynchronous UDS leave.
    if (_state === "idle") {
      _meshNode?.detachBridge()
    } else {
      _goIdle(relayDeps)
    }

    const meshNode = _meshNode
    _meshNode = null
    _sessionName = null
    _sessionPeerCount = 0
    let meshClose: Promise<void> | null = null
    try {
      meshClose = meshNode?.close() ?? null
    } catch {
      /* best-effort */
    }

    if (_cwdLock) {
      try {
        _cwdLock.release()
      } catch {
        /* best-effort */
      }
      _cwdLock = null
      _lockedName = null
    }
    try {
      await meshClose
    } catch {
      /* best-effort */
    }
  })

  registerUnbienCommands(pi, deps)

  // Auto-init now runs from the session_start handler (above), AFTER the
  // SDK calls bindCore(). The original setTimeout(0) here fired before bindCore
  // replaced the throwing action-method stubs, so the first pi.sendMessage in
  // _emitRelayState crashed the headless pi process with "Extension runtime not
  // initialized" in a 5s supervisor crash-loop. The session_start handler now
  // auto-starts for ANY session with auto_start_relay (default true), so new
  // interactive pi sessions are on remote automatically — no /unbien needed.
}

export default extension

/**
 * Inject text into the agent as a user message, waking a turn. The Pi SDK's
 * `ExtensionAPI.sendUserMessage` is fire-and-forget (returns `void`) and
 * "always triggers a turn" — the SDK runtime owns any *async* turn failure
 * (no model/API key, expired auth, provider error), which surfaces in the
 * agent's own output, not back to us. Two gaps this helper closes, both of
 * which previously failed silently:
 *
 *   1. `_pi` not bound yet (activation race / mesh joined before the session
 *      attached): the old code did `if (!_pi) return`, dropping the message
 *      with no trace. We log it (the daemon forwards child stderr to its log
 *      with a cwd prefix, so it's visible in `journalctl`).
 *   2. A *synchronous* throw from `sendUserMessage` (e.g. malformed content):
 *      the old fire-and-forget call let it propagate out of the `onMessage`
 *      callback, which could wedge the read loop and blackout every later
 *      message. We catch + surface it instead.
 *
 * NOTE: this does NOT make a wake that fails *inside* the SDK observable —
 * that requires a fix in the Pi runtime (no extension-level error event
 * exists for it). See `.orchestration/results/mesh-liveness-stale-peer.md`.
 */
type SendUserMessageOptions = NonNullable<
  Parameters<ExtensionAPI["sendUserMessage"]>[1]
>

type WakeAgentResult = { ok: true } | { ok: false; detail: string }

function _wakeAgent(
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
  label: string,
  steeringBehavior?: SendUserMessageOptions["deliverAs"],
): WakeAgentResult {
  if (!_pi) {
    const detail = "agent session not bound yet"
    console.error(`[un-bien] ${label}: ${detail} — message dropped`)
    return { ok: false, detail }
  }
  try {
    const options = steeringBehavior
      ? { deliverAs: steeringBehavior }
      : undefined
    _pi.sendUserMessage(content, options)
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(
      `[un-bien] ${label}: agent rejected incoming message: ${detail}`,
    )
    _safeNotify(
      `[un-bien] failed to process incoming message: ${detail}`,
      "error",
    )
    return { ok: false, detail }
  }
}

/**
 * Deliver an inbound agent-network (mesh) message to the agent + the app.
 *
 * Display: the app renders it in the TOOL timeline (a matched
 * tool_request/tool_result "agent-network" pair) — NOT as the user's own
 * message, which is what `sendUserMessage` used to produce (the reported bug).
 *
 * Wake: we inject a CUSTOM message (role:"custom"), not a user message. The
 * SDK's `convertToLlm` maps custom → a user-role LLM message, so the agent
 * still sees + replies to it, but `message_end` does NOT buffer role:"custom",
 * so it never replays as `user_input` on session_sync. Mesh messages are held
 * until the current `agent_end` listeners finish, then appended as one batch
 * before a single turn starts. This avoids calling `prompt()` during the gap
 * where Pi has stopped streaming but the current agent run is still active.
 * `id` lets the LLM echo it via
 * `agent_send(..., re=<id>)`.
 */
function _meshMessageForAgent(env: MeshEnvelope) {
  const bodyText =
    typeof env.body === "string" ? env.body : JSON.stringify(env.body)
  const header = `[agent-network] message from "${env.from}" (id=${env.id}${env.re ? `, re=${env.re}` : ""}):`
  const footer = env.re
    ? "(This is a reply to a previous message of yours.)"
    : `(If a reply is expected, call agent_send with to="${env.from}" and re="${env.id}".)`
  return {
    customType: "un-bien:mesh-message",
    content: `${header}\n${bodyText}\n\n${footer}`,
    display: true,
  }
}

function _scheduleMeshMessageDrain(): void {
  if (_meshDrainScheduled || _pendingMeshMessages.length === 0) return
  _meshDrainScheduled = true
  queueMicrotask(() => {
    _meshDrainScheduled = false
    const pi = _pi
    if (
      _rootState().agentRun.active ||
      !pi ||
      _pendingMeshMessages.length === 0
    )
      return

    const batch = _pendingMeshMessages.splice(0)
    let delivered = 0
    _rootState().agentRun.active = true
    try {
      batch.forEach((env, index) => {
        const isLast = index === batch.length - 1
        pi.sendMessage(
          _meshMessageForAgent(env),
          isLast
            ? { triggerTurn: true, deliverAs: "followUp" }
            : { triggerTurn: false },
        )
        delivered += 1
      })
    } catch (err) {
      _rootState().agentRun.active = false
      _pendingMeshMessages = [
        ...batch.slice(delivered),
        ..._pendingMeshMessages,
      ]
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[un-bien] queued mesh delivery failed: ${detail}`)
      _safeNotify(
        `[un-bien] failed to process queued mesh messages: ${detail}`,
        "error",
      )
    }
  })
}

function _deliverMeshMessageToAgent(env: MeshEnvelope): void {
  // The inbound mesh message is surfaced to the app via the agent message it is
  // delivered as (pi.sendMessage with display:true in _scheduleMeshMessageDrain
  // -> message_start/message_end forwarded by createRpcEnvelope as `{rpc}`), NOT
  // via a bespoke stock tool_request/tool_result card. Those stock transcript
  // frames were the last of the retired drive-stream producer.
  if (!_pi) {
    console.error(
      `[un-bien] agent-network message from "${env.from}": agent session not bound yet — message dropped`,
    )
    return
  }
  _pendingMeshMessages.push(env)
  _scheduleMeshMessageDrain()
}

// ── routeClientMessage ────────────────────────────────────────────────────────

/**
 * Per-channel router. Replaces the W2D-pre `routeClientMessage` which
 * implicitly used the `_peerChannel` singleton for replies. Each
 * PlainPeerChannel now carries its own `sender` and passes it here so
 * sender-specific responses (cancelled, pong, session_history) flow back
 * through the right wire instead of being broadcast.
 *
 * Live-plane frames (message/tool/turn events) fan out as envelopes via
 * `_broadcastEnvelope` from the rpc-envelope producer; this router only
 * handles incoming app→pi requests.
 */
function _abortCurrentTurn(
  fallbackCtx?: Pick<ExtensionContext, "abort">,
): boolean {
  const candidates: Array<Pick<ExtensionContext, "abort"> | null | undefined> =
    [_lastEventCtx, _lastCtx, fallbackCtx]

  for (const candidate of candidates) {
    if (!candidate || candidate === _noopCtx) continue
    if (typeof candidate.abort !== "function") continue
    try {
      candidate.abort()
      return true
    } catch (err) {
      // Only skip SDK stale-ctx throws and try the next candidate. Real abort
      // failures rethrow so the cancel handler can report action_error.
      const msg = err instanceof Error ? err.message : String(err)
      if (/stale|session replacement or reload/i.test(msg)) continue
      throw err
    }
  }

  return false
}

export function _routeClientMessageFrom(
  sender: PlainPeerChannel,
  msg: ClientMessage,
  ctx: Pick<ExtensionContext, "abort">,
): void {
  if (msg.type === "cancel") {
    try {
      const aborted = _abortCurrentTurn(ctx)
      if (!aborted) {
        sender.send({
          type: "error",
          code: "internal_error",
          in_reply_to: msg.id,
          message: "No active Pi context to abort",
        })
        return
      }
      // The cancel took effect (pi abort). No stock `cancelled` frame is
      // emitted — the app already sees the turn wind down via the envelope
      // turn_end/agent_settled. Kept the abort; dropped the redundant ack.
    } catch (err) {
      sender.send({
        type: "error",
        code: "internal_error",
        in_reply_to: msg.id,
        message: `Abort failed: ${String(err)}`,
      })
    }
    return
  }
  // extension_ui_response is envelope-only now — handled in _routeRpcCommandFrom.
  if (!_pi) return
  // Pre-attach / transport-control only. Every stock ACTION case (model_set,
  // thinking_set, list_models, session_compact, session_new → rpc plane;
  // session_launch → un plane; approve_tool → removed feature) is MIGRATED off
  // this switch. ping + pair_request stay: they must work before/independent of
  // an attached rpc peer.
  switch (msg.type) {
    case "ping":
      sender.send({ type: "pong", in_reply_to: msg.id })
      break
    case "pair_request":
      // Already paired — ignore subsequent pair_request to maintain idempotency.
      // (Token is already consumed and peer is in peers.json.)
      break
  }
}

/**
 * Backward-compatible shim for legacy callers + tests that didn't track
 * a specific sender channel. Routes to the most recently attached owner,
 * mirroring the pre-W2D singleton behavior.
 */
export function routeClientMessage(
  msg: ClientMessage,
  ctx: Pick<ExtensionContext, "abort">,
): void {
  const fallback = [..._activePeers.values()].pop()
  if (!fallback) return
  _routeClientMessageFrom(fallback, msg, ctx)
}

// ── session_sync handler + helpers ────────────────────────────────────────────

/**
 * `session_sync` is a per-sender query: the owner asking gets the reply,
 * not the whole broadcast. Otherwise a session_sync from owner A would
 * also dump history to owner B's wire — duplicate traffic + the wrong
 * `in_reply_to`.
 */

/** Resolve the base dir for tool-arg file lookups from the last command ctx. */
function _resolveToolCwd(): string {
  return _lastCtx && "cwd" in _lastCtx ? _lastCtx.cwd : process.cwd()
}

// ── Standalone CLI ────────────────────────────────────────────────────────────

function _isDirectRun(): boolean {
  try {
    return (
      fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? "")
    )
  } catch {
    return false
  }
}

/**
 * Read-only probe of the local UDS broker for the mesh roster, backing
 * `unbien peers`. Opens a raw connection to `sockPath`, sends a single
 * unregistered `list_peers` request, and resolves with the peer names from the
 * broker's reply (local UDS peers + cross-PC `<pc>:<peer>` entries).
 *
 * The probe deliberately does NOT register as a peer: the broker answers
 * observer probes without assigning a name or broadcasting peer_joined/left
 * (see Broker._tryObserverProbe), so a shell query never perturbs the mesh —
 * no phantom peer flashes in anyone's roster, local or cross-PC.
 *
 * Resolves null when no broker is reachable (connection refused / no socket
 * file — i.e. no Pi or daemon is leading the mesh on this machine), or on
 * timeout, so the caller can print an "offline" message instead of an empty
 * roster.
 */
export async function probeListPeers(
  sockPath: string,
  timeoutMs = 2000,
): Promise<string[] | null> {
  const { createConnection } = await import("node:net")
  return new Promise<string[] | null>((resolve) => {
    const sock = createConnection({ path: sockPath })
    let buf = ""
    let settled = false
    const done = (result: string[] | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      resolve(result)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    sock.setEncoding("utf8")
    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify({ type: "list_peers" }) + "\n")
      } catch {
        done(null)
      }
    })
    sock.on("data", (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf("\n")
      if (nl < 0) return // wait for a full line
      const line = buf.slice(0, nl)
      try {
        const env = JSON.parse(line) as {
          body?: { type?: string; peers?: unknown }
        }
        const body = env.body
        if (
          body &&
          body.type === "list_peers_reply" &&
          Array.isArray(body.peers)
        ) {
          done(body.peers.filter((p): p is string => typeof p === "string"))
          return
        }
      } catch {
        /* fall through */
      }
      done(null) // a line arrived but it wasn't the reply we expected
    })
    sock.on("error", () => done(null)) // ECONNREFUSED / ENOENT → mesh offline
    sock.on("close", () => done(null))
  })
}

function _cliStubUi(): ExtensionContext["ui"] {
  // SAFETY: the CLI fleet/daemon/setup handlers only ever call ui.notify; the
  // other ExtensionContext["ui"] methods (select/input/editor/…) are never
  // reached on the direct-run path, so a notify-only console shim is safe.
  return {
    notify: (msg: string) => console.log(msg),
  } as unknown as ExtensionContext["ui"]
}

if (_isDirectRun()) {
  const [, , subcmd, ...cliArgs] = process.argv
  if (subcmd === "devices" || subcmd === "list") {
    const peers = (await listPeers())
      .map(_inspectPeerRecord)
      .filter((peer): peer is InspectedPeerRecord => peer !== null)
    if (peers.length === 0) {
      console.log("[un-bien] No peers")
    } else {
      for (const peer of peers) {
        console.log(`• ${peer.rawHandle.slice(0, 8)} — ${peer.record.name}`)
      }
    }
  } else if (subcmd === "revoke") {
    const shortid = (cliArgs[0] ?? "").trim()
    if (shortid) {
      const matches = (await listPeers())
        .map(_inspectPeerRecord)
        .filter((peer): peer is InspectedPeerRecord => peer !== null)
        .filter((peer) => peer.rawHandle.startsWith(shortid))
      if (matches.length === 0) console.log("No peer matching that shortid")
      else if (matches.length > 1)
        console.log(
          `Ambiguous: ${matches.map((peer) => peer.rawHandle.slice(0, 8)).join(", ")}`,
        )
      else {
        const peer = matches[0]!
        const { removePeer } = await import("./pairing/storage.js")
        await removePeer(peer.rawHandle)
        console.log(
          `Revoked: ${peer.record.name} (${peer.rawHandle.slice(0, 8)}…)`,
        )
      }
    } else {
      console.log("Usage: revoke <shortid>")
    }
  } else if (subcmd === "set-relay") {
    const raw = (cliArgs[0] ?? "").trim()
    if (!raw) {
      console.log(`Usage: set-relay <url>`)
    } else if (isWebSocketScheme(raw)) {
      console.log(
        `Use http:// or https://. The extension converts to WebSocket automatically.`,
      )
    } else if (isValidRelayUrl(raw)) {
      saveConfig({ relay: raw })
      console.log(`Relay set to ${raw}`)
    } else {
      console.log(`Invalid URL: ${raw}. Must start with http:// or https://`)
    }
  } else if (subcmd === "peers") {
    // Read-only roster of the local + cross-PC mesh. Unlike `devices` (which
    // reads paired phones from peers.json), the mesh roster lives only in the
    // running broker's memory, so we probe the UDS broker. The probe never
    // registers as a peer — it leaves no trace on the mesh (see
    // Broker._tryObserverProbe). Null = no broker reachable on this machine.
    const peers = await probeListPeers(sessionSockPath(LOCAL_SESSION_NAME))
    if (peers === null) {
      console.log(
        "[un-bien] Mesh offline — no agent is running on this machine.",
      )
    } else {
      console.log(`[un-bien] peers:\n${formatPeerInventory(peers)}`)
    }
  } else if (subcmd === "claude") {
    await _cmdClaudeCli(cliArgs)
  } else if (subcmd === "install") {
    // CLI mode = user installed via `npm install -g un-bien`, so the
    // `un-bien` bin is already on $PATH via npm's global prefix. Explicit
    // `linkCli: false` so we never stomp those with symlinks pointing at a
    // parallel Pi-extension install.
    const stubCtx = { ui: _cliStubUi() }
    // Propagate failure as a non-zero exit so callers (Cockpit / CI) detect it
    // — installService throws on a failed schtasks/launchctl/systemctl step.
    if (!_cmdInstall(stubCtx, { linkCli: false })) process.exit(1)
  } else if (subcmd === "uninstall") {
    const stubCtx = { ui: _cliStubUi() }
    // `linkCli: true` even from the CLI: unlinking is ALWAYS safe and must run
    // regardless of how install ran. `unlinkCliBinaries` only removes OUR
    // reserved `un-bien` symlink under `~/.local/bin`; npm-global bins live in
    // a different prefix and are never touched. So a user who installed via the
    // TUI (`/unbien install`, which links) and uninstalls from a shell still
    // gets the link cleaned up — the asymmetry that left an orphaned
    // `~/.local/bin/unbien` behind.
    _cmdUninstall(stubCtx, { linkCli: true })
  } else {
    console.log(
      [
        "Usage: un-bien <command>",
        "",
        "Service:",
        "  install                         Install the un-bien launcher daemon as a system service",
        "  uninstall                       Remove the system service",
        "",
        "Devices:",
        "  devices                         List paired phones (peers.json)",
        "  revoke <shortid>                Revoke a paired device",
        "",
        "Config:",
        "  set-relay <url>                 Set the relay URL (http:// or https://)",
        "",
        "Agent mesh:",
        "  peers                           List agents on the local + cross-PC mesh",
        "  claude [cwd]                    Start Claude Code connected to the agent mesh",
      ].join("\n"),
    )
  }
}
