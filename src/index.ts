/**
 * pi-extension — remote-pi slash commands + AgentBridge wiring
 *
 * Exported as ExtensionFactory (default export) to be loaded by Pi SDK:
 *   pi -e $(pwd)/dist/index.js
 *
 * State machine:  idle → started → paired
 *   /remote-pi start   connects to relay (idle → started)
 *   /remote-pi pair    shows QR for new peers (started, async → paired via auto-listener)
 *   /remote-pi stop    closes everything (any → idle)
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

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { type Ed25519Keypair } from "./pairing/crypto.js";
import { buildQRUri, qrSession, renderQRAscii, startQRRotation } from "./pairing/qr.js";
import {
  addPeer,
  getOrCreateEd25519Keypair,
  listOwnerPubkeys,
  listPeers,
  removePeer,
  type PeerRecord,
} from "./pairing/storage.js";
import { MeshClient } from "./mesh/client.js";
import { SelfRevoke } from "./mesh/self_revoke.js";
import type {
  ClientMessage,
  PairErrorCode,
  ServerMessage,
  SessionHistoryEvent,
} from "./protocol/types.js";
import { RelayClient, RoomAlreadyOpenError } from "./transport/relay_client.js";
import { PlainPeerChannel } from "./transport/peer_channel.js";
import { roomIdForCwd } from "./rooms.js";
import { SessionPeer } from "./session/peer.js";
import { registerAgentTools } from "./session/tools.js";
import {
  ensureGlobalDirs,
  LOCAL_SESSION_NAME,
  sessionAuditPath,
  sessionSockPath,
  skillsDir,
} from "./session/global_config.js";
import { acquireCwdLock, type AcquiredLock } from "./session/cwd_lock.js";
import {
  defaultAgentName,
  effectiveAutoStartRelay,
  loadLocalConfig,
  localConfigExists,
  saveLocalConfig,
} from "./session/local_config.js";
import { runSetupWizard, type WizardUI } from "./session/setup_wizard.js";
import { updateFooter, type FooterState } from "./ui/footer.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import {
  kDefaultRelayUrl,
  resolveRelayUrl,
  saveConfig,
  isValidRelayUrl,
  isWebSocketScheme,
  toWebSocketUrl,
} from "./config.js";

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

export type RemoteState = "idle" | "started";

let _state: RemoteState = "idle";
let _relay: RelayClient | null = null;
let _relayUrl: string | null = null;  // URL used by current _relay connection
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
 *     `/remote-pi status` output both derive from this.
 */
const _activePeers = new Map<string, PlainPeerChannel>();
let _peerShort = "";  // shortid of the most recently attached peer (UX hint only)

let _myRoomId: string | null = null;   // this Pi's room id (derived from cwd)
let _myRoomMeta: { name: string; cwd: string; model?: string } | null = null;
let _currentModel: string | undefined = undefined;  // last-known model name

// ── Agent-network session (plano 19) ──────────────────────────────────────────
let _sessionPeer: SessionPeer | null = null;
let _sessionName: string | null = null;
let _sessionPeerCount = 0;

// Cached state of global pairings (`peers.json`). Pairing is per-machine, so a
// device paired in any Pi process is paired everywhere. Refreshed on boot,
// after addPeer (handle_pair_request), and after removePeer (revoke).
let _hasGlobalPairings = false;

/** Reads peers.json and updates the global-pairings cache + footer. Fire and
 *  forget; failures keep the previous cached value. */
function _refreshPairingsCache(): void {
  void listPeers()
    .then((peers) => {
      _hasGlobalPairings = peers.length > 0;
      _refreshFooter();
    })
    .catch(() => { /* keep prior cached value */ });
}

/** Re-queries the broker for the authoritative peer list. The broker's map is
 *  the source of truth — incremental +1/-1 counters drift after failover, lost
 *  `peer_left` broadcasts (e.g., leader leaves), or any dropped event. Called
 *  on every `peer_joined`/`peer_left` and once on join. Fire-and-forget. */
function _refreshSessionPeerCount(
  peer: SessionPeer,
  ctx?: Pick<ExtensionContext, "ui"> | null,
): void {
  void peer.request("broker", { type: "list_peers" }, 2000)
    .then((reply) => {
      const peers = (reply.body as { peers?: string[] } | null)?.peers;
      if (Array.isArray(peers)) {
        _sessionPeerCount = peers.length;
        _refreshFooter(ctx);
      }
    })
    .catch(() => { /* older broker without list_peers — keep prior count */ });
}

/** Friendly model name for room_meta (plano 18). undefined when SDK has none yet. */
function _currentModelName(): string | undefined {
  return _currentModel;
}

/** Refreshes the Pi TUI footer slots from current module state. Safe no-op when ctx lacks ui. */
function _refreshFooter(ctx?: { ui?: { setStatus?: unknown; setTitle?: unknown } } | null): void {
  const target = ctx ?? _lastCtx;
  const ui = target?.ui as (
    { setStatus?: (k: string, v: string | undefined) => void; setTitle?: (t: string) => void } | undefined
  );
  if (!ui || typeof ui.setStatus !== "function" || typeof ui.setTitle !== "function") return;
  const state: FooterState = {
    session: _sessionName ?? undefined,
    peerCount: _sessionPeerCount,
    relayOn: _state !== "idle",
    // `devicePaired` now reflects "any owner currently attached" — picks one
    // shortid representatively (multi-owner UX detail surfaces in the
    // `/remote-pi status` line, not the footer slot).
    devicePaired: _anyPeerActive() ? _peerShort : undefined,
    hasPairings: _hasGlobalPairings,
    agentName: _sessionPeer?.name(),
  };
  updateFooter(
    { ui: { setStatus: ui.setStatus.bind(ui), setTitle: ui.setTitle.bind(ui) } },
    state,
  );
}

// Epoch ms when the state machine entered 'started' (last /remote-pi start).
// Used by session_sync to let the app detect Pi restarts (and force a full
// replay). Cleared on _goIdle.
let _sessionStartedAt: number | null = null;

// Snapshot of agent messages, captured on every agent_end event. Used to
// answer session_sync. Cleared on _goIdle.
type BufferMsg = {
  role: "user" | "assistant" | "toolResult" | string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: { input?: number; output?: number };
};
let _messageBuffer: BufferMsg[] = [];

/** Test-only override of the message buffer. */
/**
 * Test-only: emulate what `/remote-pi` does on the returning-user path
 * (join the local mesh, then start the relay) without touching the FS for
 * a `localConfigExists()` lookup. Lets tests bring the relay up without
 * mocking the wizard or the local config storage.
 *
 * Typed loosely to accept any ctx shape with `ui.notify` + `cwd` — the
 * unit tests use minimal mocks that don't satisfy the full
 * `ExtensionContext` interface.
 */
export async function _connectForTest(ctx: unknown): Promise<void> {
  const real = ctx as Parameters<typeof _cmdJoin>[0];
  await _cmdJoin(real);
  await _cmdStart(real);
}

/** Test-only: tear everything down (mirrors `/remote-pi stop`). */
export async function _stopForTest(ctx: unknown): Promise<void> {
  await _cmdStop(ctx as Parameters<typeof _cmdStop>[0]);
}

/**
 * Test-only: relay-only startup, no UDS mesh join. Replaces the old
 * `remote-pi relay start` handler that some tests captured to bring up
 * the relay in isolation (e.g. ping/pong tests that don't care about the
 * agent-network broker).
 */
export async function _startRelayForTest(ctx: unknown): Promise<void> {
  await _cmdStart(ctx as Parameters<typeof _cmdStart>[0]);
}

export function _setMessageBufferForTest(msgs: unknown[]): void {
  _messageBuffer = msgs as BufferMsg[];
}

/** Test-only accessor: returns a defensive copy of the buffer. */
export function _getMessageBufferForTest(): unknown[] {
  return [..._messageBuffer];
}

/** Test-only override of session started timestamp. */
export function _setSessionStartedAtForTest(ts: number | null): void {
  _sessionStartedAt = ts;
}

/** Test-only: reset the cached model name (between tests). */
export function _setCurrentModelForTest(name: string | undefined): void {
  _currentModel = name;
}

// Per-turn messaging state
let _currentTurnId: string | null = null;

// Module-level pi reference
let _pi: ExtensionAPI | null = null;

let _stopAutoListener: (() => void) | null = null;

// Cached keypair (loaded once, reused across start/pair cycles)
let _cachedEd25519: Ed25519Keypair | null = null;

// Mesh-membership poller (plan/24 Wave 3). Lives across the relay
// connection lifecycle: started in _cmdStart after the WS is up, stopped
// in _goIdle when the relay is torn down.
let _selfRevoke: SelfRevoke | null = null;

// Per-cwd lock acquired by the first `/remote-pi` invocation in this
// process. Holds the UDS socket open until the process exits (OS auto-
// releases on crash too). Stays held across `/remote-pi stop` cycles —
// only released when the Node process itself dies.
let _cwdLock: AcquiredLock | null = null;

// ── Session sync limit (mirror cache cap) ─────────────────────────────────────
//
// Configurable via REMOTE_PI_SYNC_LIMIT env var (positive int, default 30).
// Read on every session_sync so QA can `export REMOTE_PI_SYNC_LIMIT=N` between
// runs without restarting the extension. The value is also clamped against
// the client-provided `limit` (server is authoritative).
const SYNC_LIMIT_DEFAULT = 30;
function _getSyncLimit(): number {
  const raw = process.env["REMOTE_PI_SYNC_LIMIT"];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SYNC_LIMIT_DEFAULT;
}

// ── Relay reconnect state ─────────────────────────────────────────────────────
// Backoffs in ms: 1s, 2s, 5s, 10s, 30s, then stays at 30s.
const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempt = 0;

/** Test-only: exposes pending reconnect timer state. */
export function _hasPendingReconnect(): boolean {
  return _reconnectTimer !== null;
}

/**
 * Public state-snapshot helper. Returns the derived UX state, not the raw
 * `_state` enum: the W2D refactor collapsed the internal machine to
 * `idle | started` and made `paired` a derived metric
 * (`_activePeers.size > 0`). Tests and the footer keep the three-state
 * mental model via this getter.
 */
export function _getState(): "idle" | "started" | "paired" {
  if (_state === "idle") return "idle";
  return _activePeers.size > 0 ? "paired" : "started";
}

/** Test-only: number of owners currently attached via PlainPeerChannel. */
export function _getActivePeerCountForTest(): number {
  return _activePeers.size;
}

/** Test-only: true if a specific peer (base64 std) has an attached channel. */
export function _hasActivePeerForTest(appPeerIdStd: string): boolean {
  return _activePeers.has(appPeerIdStd);
}


// ── Multi-channel helpers ─────────────────────────────────────────────────────

/**
 * Sends `msg` to every currently-attached owner channel. The default
 * dispatch for application-level events that are part of "the agent
 * session is doing X" (agent_chunk, tool_request, tool_result, agent_done,
 * user_input mirror, room_meta_update, etc.) — all paired devices see the
 * same stream.
 *
 * Per-request responses (e.g. `session_history` answering a specific
 * `session_sync` query, or `pair_ok` answering `pair_request`) must NOT
 * use this — they go to the sender channel directly.
 */
function _broadcastToActive(msg: ServerMessage): void {
  for (const ch of _activePeers.values()) {
    try { ch.send(msg); } catch { /* best-effort per channel */ }
  }
}

/** Returns true when at least one owner is attached. Derived `paired` UX. */
function _anyPeerActive(): boolean {
  return _activePeers.size > 0;
}

/**
 * Adds an owner's channel to `_activePeers`. Also updates the UX hint
 * `_peerShort` (last-attached shortid) so the footer + status can pick
 * a representative device when only one is connected.
 */
function _attachPeerChannel(appPeerId: string, channel: PlainPeerChannel): void {
  _activePeers.set(appPeerId, channel);
  _peerShort = appPeerId.slice(0, 8);
}

/** Detaches a single owner's channel + removes it from the map. Used by
 *  `_onPeerDisconnect`, `_cmdRevoke`, and the SelfRevoke callback. */
function _detachPeerChannel(appPeerId: string): void {
  const ch = _activePeers.get(appPeerId);
  if (!ch) return;
  try { ch.detach(); } catch { /* best-effort */ }
  _activePeers.delete(appPeerId);
  if (_peerShort === appPeerId.slice(0, 8)) {
    // Pick a different remaining peer for the UX hint, or clear when none.
    const next = _activePeers.keys().next().value;
    _peerShort = next ? next.slice(0, 8) : "";
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
 *   2. `agent_name` from `<cwd>/.pi/remote-pi/config.json` — set by the
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
  if (_sessionPeer) return _sessionPeer.name();
  const local = loadLocalConfig(cwd);
  return local.agent_name || defaultAgentName(cwd);
}

// ── Peer lookup helpers ───────────────────────────────────────────────────────

async function _findKnownPeer(appPeerIdStd: string): Promise<PeerRecord | null> {
  const peers = await listPeers();
  return peers.find((p) => p.remote_epk === appPeerIdStd) ?? null;
}

// ── Transition helpers ────────────────────────────────────────────────────────

/**
 * Full teardown: stop listener, detach channel, close relay → idle.
 *
 * `byeReason` (optional): when present and the channel is up, sends a
 * `{type:"bye", reason}` to the app before detaching so it sees offline
 * immediately instead of waiting ~50s for a ping miss. Fire-and-forget —
 * if the WS already failed (e.g., `relay.on("close")` callback) skip it
 * by omitting the reason; app falls back to ping miss naturally.
 */
function _goIdle(byeReason?: import("./protocol/types.js").ByeReason): void {
  // Broadcast bye to every still-attached owner so each app surfaces
  // "offline" immediately instead of waiting ~50s for a ping miss.
  if (byeReason && _state !== "idle" && _anyPeerActive()) {
    _broadcastToActive({ type: "bye", reason: byeReason });
  }

  // Cancel any pending reconnect attempt. Critical: /remote-pi stop must
  // win the race against a scheduled reconnect.
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _reconnectAttempt = 0;

  _stopAutoListener?.();
  _stopAutoListener = null;

  // Tear down every per-owner channel and clear the map.
  for (const ch of _activePeers.values()) {
    try { ch.detach(); } catch { /* best-effort */ }
  }
  _activePeers.clear();
  _peerShort = "";
  _currentTurnId = null;

  _relay?.close();
  _relay = null;
  _relayUrl = null;

  // Stop the mesh poller — it's bound to the relay-up lifecycle so a new
  // _cmdStart will spin up a fresh instance (with potentially a new relay
  // URL if the user changed it via /remote-pi relay url).
  _selfRevoke?.stop();
  _selfRevoke = null;

  // Preserve _sessionStartedAt + _messageBuffer across stop/start cycles.
  // The Pi agent session outlives the relay connection — `message_end` keeps
  // firing for terminal turns even while idle, and the buffer must survive
  // so those turns appear in the next session_sync. Only a Pi process
  // restart resets these (init-time values).

  _state = "idle";
  _refreshFooter();
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
function _onRelayClose(): void {
  if (_state === "idle") return;  // already torn down (e.g. /remote-pi stop)

  _stopAutoListener?.();
  _stopAutoListener = null;

  // Detach every per-owner channel — relay is gone, none can route. The
  // auto-listener re-attaches owners after `_attemptReconnect` succeeds
  // (via the same known-peer + pair_request paths used on first connect).
  for (const ch of _activePeers.values()) {
    try { ch.detach(); } catch { /* best-effort */ }
  }
  _activePeers.clear();
  _peerShort = "";
  _currentTurnId = null;

  _relay = null;  // _relayUrl preserved for retry
  _state = "started";
  _refreshFooter();

  _scheduleReconnect();
}

function _scheduleReconnect(): void {
  if (_reconnectTimer !== null) return;  // already scheduled
  if (!_cachedEd25519 || !_relayUrl) return;  // can't reconnect without these
  if (_getState() === "idle") return;  // stopped while we were here

  const idx = Math.min(_reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1);
  const delay = RECONNECT_BACKOFFS_MS[idx]!;
  _reconnectAttempt += 1;

  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    void _attemptReconnect();
  }, delay);
}

async function _attemptReconnect(): Promise<void> {
  // `_state` may transition to "idle" between awaits via _goIdle; read via
  // _getState() to defeat TS narrowing on the module-level let.
  if (_getState() === "idle") return;
  if (!_cachedEd25519 || !_relayUrl) return;

  const edKp = _cachedEd25519;
  const url = _relayUrl;
  // _relayUrl is stored in canonical http(s):// form — convert at the
  // WS boundary, same as _cmdStart.
  const relay = new RelayClient(toWebSocketUrl(url), edKp);

  try {
    // Replay the same room identity from _cmdStart. Without this the relay
    // would log this WS as a default-room peer and the app would see a
    // phantom "legacy session" appear (regression of plano 17 + 18).
    await relay.connect({
      ...(_myRoomId ? { roomId: _myRoomId } : {}),
      ...(_myRoomMeta ? { roomMeta: _myRoomMeta } : {}),
    });
  } catch {
    if (_getState() === "idle") return;
    _scheduleReconnect();
    return;
  }

  if (_getState() === "idle") {
    // Stop fired while connect was succeeding — drop the new relay.
    relay.close();
    return;
  }

  _relay = relay;
  _reconnectAttempt = 0;

  relay.on("close", _onRelayClose);
  _stopAutoListener = _installAutoListener(relay);

  // _state stays "started"; peer reconnect (if previously paired) flows
  // through _installAutoListener → _findKnownPeer → _promoteToPaired
  // automatically when the app sends any inner.
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
export function _onPeerDisconnect(appPeerId?: string): void {
  if (_state === "idle") return;
  const target = appPeerId ?? [..._activePeers.keys()].pop();
  if (!target) return;
  if (!_activePeers.has(target)) return;

  _detachPeerChannel(target);
  if (_anyPeerActive()) {
    // Other owners still attached — keep _currentTurnId so they continue
    // seeing the in-flight agent stream.
    _refreshFooter();
    return;
  }

  // No owner left. Conservatively clear the turn so the next pair_request
  // starts cleanly.
  _currentTurnId = null;
  _refreshFooter();
  _lastCtx?.ui.notify("[remote-pi] All app peers disconnected, listening for reconnect", "info");
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
  relay: RelayClient,
  appPeerId: string,
  peerName: string,
  firstInner?: ClientMessage,
): PlainPeerChannel {
  const peerShort = appPeerId.slice(0, 8);

  // Drop any stale channel for this owner before re-attaching.
  if (_activePeers.has(appPeerId)) _detachPeerChannel(appPeerId);

  const channel = new PlainPeerChannel(
    relay,
    appPeerId,
    _myRoomId ?? undefined,
    (msg) => _routeClientMessageFrom(channel, msg, _lastCtx ?? _noopCtx),
    () => _onPeerDisconnect(appPeerId),
  );

  _attachPeerChannel(appPeerId, channel);
  _refreshFooter();

  _lastCtx?.ui.notify(
    `[remote-pi] Owner attached: peer=${peerShort}, name=${peerName} ` +
    `(${_activePeers.size} active)`,
    "info",
  );

  if (firstInner) {
    // The PlainPeerChannel listener fired on the same line that triggered
    // attachment in some flows; we route explicitly here too to ensure the
    // inner reaches the handler exactly once.
    void firstInner;
  }
  return channel;
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

function _installAutoListener(relay: RelayClient): () => void {
  const onMsg = async (line: string) => {
    let outer: { peer?: string; ct?: string };
    try { outer = JSON.parse(line) as { peer?: string; ct?: string }; }
    catch { return; }

    if (!outer.peer || !outer.ct) return;

    if (_state !== "started") return;
    // Already-attached owners: their PlainPeerChannel handles routing.
    if (_activePeers.has(outer.peer)) return;

    // Decode inner envelope (base64 JSON)
    let inner: ClientMessage;
    try {
      const plaintext = Buffer.from(outer.ct, "base64").toString("utf8");
      const parsed = JSON.parse(plaintext) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as Record<string, unknown>).type !== "string"
      ) return;
      inner = parsed as ClientMessage;
    } catch { return; }

    const appPeerId = outer.peer;

    if (inner.type === "pair_request") {
      await _handlePairRequest(relay, appPeerId, inner);
      return;
    }

    // Reconnect path: known peer (peers.json) without an active channel
    // sends a non-pair message → attach + route through the new channel.
    // See pairing.md §Reconexão.
    const known = await _findKnownPeer(appPeerId);
    if (known) {
      const channel = _attachOwner(relay, appPeerId, known.name);
      // The PlainPeerChannel listener for this owner won't have seen the
      // line that triggered the attach (we already consumed it); route
      // it explicitly via the new channel so the sender gets a reply.
      _routeClientMessageFrom(channel, inner, _lastCtx ?? _noopCtx);
      return;
    }

    // Unknown peer with non-pair_request inner — signal so the app can react
    // (peer was revoked / never paired). pair_request from unknown peer was
    // already handled above as a legitimate path. We never log inner contents,
    // only inner.type.
    const errReply: ServerMessage = {
      type: "error",
      code: "unknown_peer",
      message: "Peer not paired — re-scan QR",
    };
    const errCt = Buffer.from(JSON.stringify(errReply)).toString("base64");
    relay.send(JSON.stringify({ peer: appPeerId, ct: errCt }));
  };

  relay.on("message", onMsg);
  return () => relay.off("message", onMsg);
}

async function _handlePairRequest(
  relay: RelayClient,
  appPeerId: string,
  inner: Extract<ClientMessage, { type: "pair_request" }>,
): Promise<void> {
  const sendInner = (msg: ServerMessage) => {
    const ct = Buffer.from(JSON.stringify(msg)).toString("base64");
    relay.send(JSON.stringify({ peer: appPeerId, ct }));
  };

  const sendError = (code: PairErrorCode, message: string) => {
    sendInner({ type: "pair_error", in_reply_to: inner.id, code, message });
  };

  const status = qrSession.consumeToken(inner.token);
  if (status !== "ok") {
    const code: PairErrorCode =
      status === "expired"  ? "token_expired"
      : status === "consumed" ? "token_consumed"
      : "token_unknown";
    const msg =
      code === "token_expired"  ? "Ephemeral token expired. Generate a new QR with /remote-pi pair."
      : code === "token_consumed" ? "Token already consumed by another pair_request."
      : "Token was not issued by this Pi.";
    sendError(code, msg);
    return;
  }

  try {
    await addPeer({
      name: inner.device_name,
      remote_epk: appPeerId,
      paired_at: new Date().toISOString(),
    });
    _refreshPairingsCache();
  } catch (err) {
    sendError("internal_error", `Failed to persist peer: ${String(err)}`);
    return;
  }

  const cwd = _lastCtx && "cwd" in _lastCtx
    ? (_lastCtx as ExtensionCommandContext).cwd
    : process.cwd();
  // Prefer the user-configured agent_name (with broker suffix when on the
  // mesh) over the legacy parent/folder path — matches what the user sees
  // in the terminal title and in /remote-pi status.
  const sessionName = _displayName(cwd);

  _attachOwner(relay, appPeerId, inner.device_name);

  sendInner({
    type: "pair_ok",
    in_reply_to: inner.id,
    session_name: sessionName,
    session_started_at: _sessionStartedAt ?? Date.now(),
    // App uses this to address subsequent inner messages to the right room
    // when this Pi runs alongside others with the same epk. Defensive fallback
    // to roomIdForCwd(cwd) covers the edge case where pair_request lands
    // before _cmdStart could set _myRoomId (shouldn't happen in practice).
    room_id: _myRoomId ?? roomIdForCwd(cwd),
  });
}

// ── Extension factory (default export) ───────────────────────────────────────

// Stores most recent command context so the auto-listener can use ui.notify
let _lastCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null = null;
const _noopCtx = { ui: { notify: () => undefined }, abort: () => undefined };

const extension: ExtensionFactory = (pi: ExtensionAPI): void => {
  _pi = pi;
  console.error(`[remote-pi] session sync limit: ${_getSyncLimit()}`);

  // Plano 19: ensure ~/.pi/remote/{sessions,skills}/ exist and deploy the
  // agent-network skill on first load. resources_discover lets Pi find it.
  try {
    ensureGlobalDirs();
    _deployAgentNetworkSkill();
  } catch { /* best-effort init */ }

  // Seed the global-pairings cache from peers.json so the footer can show
  // 🟢/🟡 correctly the moment the relay is up (no race with first refresh).
  _refreshPairingsCache();

  pi.on("resources_discover", () => ({ skillPaths: [skillsDir()] }));

  // Plano 20: agent_send + agent_request tools so the LLM can drive the
  // session network natively. Getter captures `_sessionPeer` live so the
  // tool always sees the current state.
  registerAgentTools(pi, () => _sessionPeer);

  // Tool calls execute without prompting the remote user. The Pi SDK has no
  // native `requiresApproval` per tool, and a hardcoded gate (Bash/Edit/Write)
  // misfired on every custom tool from third-party packages. Approval will
  // come back when the Pi ecosystem ships a permissions convention. tool_result
  // is still forwarded so the app shows tool activity transparently.

  // Mirror input typed in the Pi terminal (or sent via RPC) to every
  // connected owner. 'extension' source is our own sendUserMessage call
  // from routeClientMessage, which already set _currentTurnId — skip to
  // avoid a double turnId.
  pi.on("input", (event) => {
    if (!_anyPeerActive()) return;
    if (event.source === "extension") return;
    const turnId = `local_${randomUUID()}`;
    _currentTurnId = turnId;
    _broadcastToActive({ type: "user_input", id: turnId, text: event.text });
  });

  // Track active model so the app can show it in the SessionTile (plano 18).
  // SDK fires model_select on settings load + every user switch. We cache the
  // friendly name and broadcast a room_meta_update so the relay can fan it
  // out to subscribed apps without needing a new pair.
  pi.on("model_select", (event) => {
    const m = event?.model as { name?: string; id?: string } | undefined;
    const modelName = m?.name ?? m?.id;
    if (!modelName) return;
    _currentModel = modelName;
    // Keep the cached room_meta fresh so a future reconnect carries the
    // current model in its hello (otherwise the post-reconnect hello would
    // ship the stale model that was active at _cmdStart time).
    if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, model: modelName };
    if (!_relay || !_myRoomId) return;
    console.error(`[remote-pi] model_select → ${modelName}`);
    _relay.sendControl({
      type: "room_meta_update",
      room_id: _myRoomId,
      meta: { model: modelName },
    });
  });

  pi.on("message_update", (event) => {
    if (!_anyPeerActive() || !_currentTurnId) return;
    const ae = event.assistantMessageEvent;
    if (ae.type === "text_delta") {
      _broadcastToActive({ type: "agent_chunk", in_reply_to: _currentTurnId, delta: ae.delta });
    }
  });

  // Notify every connected owner that a tool is about to run (visibility
  // only, NOT approval). tool_execution_start fires before the tool
  // executes; tool_execution_end closes the loop with the result. Together
  // they render a "Tool running… done" timeline in each paired app.
  pi.on("tool_execution_start", (event) => {
    if (!_anyPeerActive()) return;
    _broadcastToActive({
      type: "tool_request",
      tool_call_id: event.toolCallId,
      tool: event.toolName,
      args: event.args as Record<string, unknown>,
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (!_anyPeerActive()) return;
    const msg: ServerMessage = event.isError
      ? { type: "tool_result", tool_call_id: event.toolCallId, error: String(event.result) }
      : { type: "tool_result", tool_call_id: event.toolCallId, result: event.result as unknown };
    _broadcastToActive(msg);
  });

  // Cumulative session buffer fed via `message_end`, which fires once per
  // persisted message (user, assistant, toolResult) — same hook the SDK uses
  // to persist to sessionManager (see agent-session.js:298-309). Pushing here
  // accumulates the whole session over time, so session_sync can replay every
  // turn — including turns initiated from the Pi terminal (source:"interactive")
  // or RPC. Previous impl overwrote on `agent_end` and lost everything but the
  // last turn (see diagnostics 14, 15).
  pi.on("message_end", (event) => {
    const m = event?.message as { role?: string } | undefined;
    if (!m) return;
    if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
      _messageBuffer.push(m as unknown as BufferMsg);
    }
  });

  pi.on("agent_end", () => {
    // Buffer is fed by `message_end`; here we only finalize the outbound
    // turn signal to every connected owner. No buffer mutation.
    if (!_anyPeerActive() || !_currentTurnId) return;
    _broadcastToActive({ type: "agent_done", in_reply_to: _currentTurnId });
    _currentTurnId = null;
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  //
  // Final surface: 8 commands. Pre-2026-05-23 we had 20 commands covering
  // multi-session UDS + granular relay control; in practice every install
  // converged on one session and the relay was always either fully on or
  // fully off. The simplified surface keeps the day-to-day path one-key
  // (`/remote-pi`) and exposes only the actions that have distinct user
  // intent: setup, status, stop, pair, devices, revoke, set-relay.
  pi.registerCommand("remote-pi", {
    description: "Connect (join local mesh + start relay), or run setup on first use",
    getArgumentCompletions: async (prefix) => {
      if (prefix.startsWith("revoke ") || prefix === "revoke") {
        const shortPrefix = prefix === "revoke" ? "" : prefix.slice("revoke ".length);
        return _shortidCompletions(shortPrefix, "revoke ");
      }
      return [
        "setup", "status", "stop",
        "pair", "devices", "revoke",
        "set-relay",
      ]
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
    },
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      const sub = args.trim();
      if      (sub === "")                  { await _cmdRoot(ctx); }
      else if (sub === "setup")             { await _cmdSetup(ctx); }
      else if (sub === "status")            { _cmdStatus(ctx); }
      else if (sub === "stop")              { await _cmdStop(ctx); }
      else if (sub === "pair")              { await _cmdPair(ctx); }
      else if (sub === "devices")           { await _cmdList(ctx); }
      else if (sub.startsWith("revoke"))    { await _cmdRevoke(sub.slice("revoke".length).trim(), ctx); }
      else if (sub.startsWith("set-relay")) { _cmdSetRelay(sub.slice("set-relay".length).trim(), ctx); }
      else                                  { await _cmdRoot(ctx); }
    },
  });

  // Nested registrations (one entry per public action). The flat handler
  // above already routes `/remote-pi <sub>` — these exist for the SDK's
  // command palette and slash-autocomplete in some UI modes.
  pi.registerCommand("remote-pi setup",    { description: "Run the setup wizard and update local config", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdSetup(ctx); } });
  pi.registerCommand("remote-pi status",   { description: "Show local mesh + relay status", handler: async (_, ctx) => { _lastCtx = ctx; _cmdStatus(ctx); } });
  pi.registerCommand("remote-pi stop",     { description: "Stop everything (leave local mesh + disconnect relay)", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdStop(ctx); } });
  pi.registerCommand("remote-pi pair",     { description: "Show a QR code to pair a new mobile device", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdPair(ctx); } });
  pi.registerCommand("remote-pi devices",  { description: "List paired mobile devices", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdList(ctx); } });
  pi.registerCommand("remote-pi revoke", {
    description: "Revoke a paired device by its shortid",
    getArgumentCompletions: async (prefix) => _shortidCompletions(prefix),
    handler: async (args, ctx) => { _lastCtx = ctx; await _cmdRevoke(args.trim(), ctx); },
  });
  pi.registerCommand("remote-pi set-relay", { description: "Persist a new relay URL to user config", handler: async (args, ctx) => { _lastCtx = ctx; _cmdSetRelay(args.trim(), ctx); } });
};

export default extension;

// ── Command implementations ───────────────────────────────────────────────────

/**
 * `/remote-pi status` — full state snapshot. Two lines: local mesh + relay.
 *
 * Always callable; safe when nothing is up (renders the off variants).
 * Reuses the same icons as the footer so terminal + status output stay
 * visually consistent.
 */
function _cmdStatus(ctx: Pick<ExtensionContext, "ui">): void {
  const relayUrl = _relayUrl ?? resolveRelayUrl().url;

  // Mesh line
  let meshLine: string;
  if (_sessionPeer) {
    const name = _sessionPeer.name();
    meshLine = `🟢 Local mesh: connected as "${name}" (${_sessionPeerCount} peer${_sessionPeerCount === 1 ? "" : "s"})`;
  } else {
    meshLine = "⚪ Local mesh: not connected";
  }

  // Relay line — paired state is derived from _activePeers.size now.
  let relayLine: string;
  if (_state === "idle") {
    relayLine = `⚪ Relay: off (${relayUrl}) — run /remote-pi to start`;
  } else if (_activePeers.size > 0) {
    const count = _activePeers.size;
    const shortids = [..._activePeers.keys()].map((k) => k.slice(0, 8)).join(", ");
    relayLine = `🟢 Relay: ${count} owner${count === 1 ? "" : "s"} online (${shortids}) (${relayUrl})`;
  } else {
    relayLine = _hasGlobalPairings
      ? `🟢 Relay: on, waiting for an app to connect (${relayUrl})`
      : `🟡 Relay: on, waiting for first pairing (${relayUrl})`;
  }

  ctx.ui.notify(`[remote-pi]\n  ${meshLine}\n  ${relayLine}`, "info");
}

/**
 * Root handler for `/remote-pi`. On first run (no local config) drops into
 * the wizard; on subsequent runs auto-joins the local mesh + starts the
 * relay (if opted in during setup), then prints the status.
 *
 * `/remote-pi` is intentionally the only command users need day-to-day:
 * idempotent connect + status display.
 */
async function _cmdRoot(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();

  // Per-cwd singleton: at most one Pi process per folder may run /remote-pi.
  // Bind a UDS socket as the lock (kernel auto-releases on process exit, even
  // crash); a second invocation in the same cwd sees the live socket and is
  // refused here, before any wizard / mesh / relay side-effect can run.
  // Once acquired, the lock is bound to the lifetime of THIS process — repeat
  // calls to /remote-pi from the same terminal are idempotent (no re-acquire).
  if (_cwdLock === null) {
    const result = await acquireCwdLock(cwd);
    if (!result.ok) {
      ctx.ui.notify(
        "[remote-pi] Another agent is already running in this folder. " +
        "Use the existing terminal or run from a different folder.",
        "warning",
      );
      return;
    }
    _cwdLock = result;
  }

  // First-time wizard: no local config in this cwd → run interactive setup.
  if (!localConfigExists(cwd)) {
    const ui = ctx.ui as unknown as WizardUI;
    if (typeof ui.select !== "function") {
      _cmdStatus(ctx);
      return;
    }
    const baseDefault = defaultAgentName(cwd);
    const newConfig = await runSetupWizard(ui, {
      agent_name: baseDefault,
      use_relay: true,
    });
    if (!newConfig) {
      ctx.ui.notify("[remote-pi] Setup cancelled.", "info");
      return;
    }
    saveLocalConfig(cwd, newConfig);
    ctx.ui.notify(
      `[remote-pi] Config saved to ${cwd}/.pi/remote-pi/config.json`,
      "info",
    );
    await _cmdJoin(ctx);
    if (effectiveAutoStartRelay(newConfig)) await _cmdStart(ctx);
    _cmdStatus(ctx);
    return;
  }

  // Returning user with config: auto-start if requested + currently inactive.
  const config = loadLocalConfig(cwd);
  if (effectiveAutoStartRelay(config) && !_sessionPeer) {
    await _cmdJoin(ctx);
    if (_state === "idle") await _cmdStart(ctx);
  }
  _cmdStatus(ctx);
}

/**
 * `/remote-pi setup` — re-run the wizard. Defaults pre-fill from the
 * existing config so it doubles as an "edit" flow.
 */
async function _cmdSetup(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();
  const ui = ctx.ui as unknown as WizardUI;
  if (typeof ui.select !== "function") {
    ctx.ui.notify("[remote-pi] Setup requires an interactive UI.", "warning");
    return;
  }
  const current = loadLocalConfig(cwd);
  const baseDefault = defaultAgentName(cwd);
  const newConfig = await runSetupWizard(ui, {
    agent_name: current.agent_name ?? baseDefault,
    use_relay: effectiveAutoStartRelay(current),
  });
  if (!newConfig) {
    ctx.ui.notify("[remote-pi] Setup cancelled.", "info");
    return;
  }
  saveLocalConfig(cwd, newConfig);
  ctx.ui.notify(
    "[remote-pi] Config updated. Run /remote-pi to apply now.",
    "info",
  );
}

async function _cmdStart(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
  if (_state !== "idle") {
    ctx.ui.notify("[remote-pi] Already started.", "warning");
    return;
  }

  const edKp = await getOrCreateEd25519Keypair();
  _cachedEd25519 = edKp;

  const { url: relayUrl, source } = resolveRelayUrl();
  const myShort = Buffer.from(edKp.publicKey).toString("base64").slice(0, 8);

  // Derive room from cwd so N parallel `pi -e` in different directories can
  // share the same Ed25519 identity without colliding on the relay.
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();
  const roomId = roomIdForCwd(cwd);
  // Same name we send in pair_ok — keeps room_meta.name and the per-pair
  // session_name aligned so the app shows consistent labels.
  const sessionName = _displayName(cwd);

  // Initial model from ctx (ExtensionContext.model is the SDK's current
  // selection — set by user settings or last-used). May be undefined on
  // first boot before any model_select; that's fine, room_meta omits the
  // field then.
  const ctxModelName = (ctx as Partial<ExtensionContext> & { model?: { name?: string; id?: string } }).model;
  if (ctxModelName) _currentModel = ctxModelName.name ?? ctxModelName.id ?? undefined;

  const roomMeta: { name: string; cwd: string; model?: string } = { name: sessionName, cwd };
  const modelName = _currentModelName();
  if (modelName) roomMeta.model = modelName;
  // Persist so _attemptReconnect can replay the same hello payload — without
  // this, reconnect issues a bare hello and the relay creates a "default room"
  // entry that surfaces in the app as a phantom legacy session.
  _myRoomMeta = roomMeta;

  ctx.ui.notify(`[remote-pi] Connecting to relay ${relayUrl} (source: ${source}, room: ${roomId})…`, "info");

  // Transport opens WebSocket; convert the canonical http(s):// stored
  // form to ws(s):// at this boundary. The relayUrl variable keeps the
  // http(s):// form for logging + mesh client construction below.
  const relay = new RelayClient(toWebSocketUrl(relayUrl), edKp);
  try {
    await relay.connect({ roomId, roomMeta });
  } catch (err) {
    if (err instanceof RoomAlreadyOpenError) {
      ctx.ui.notify(
        "[remote-pi] Already running in this cwd. Stop the other terminal first.",
        "error",
      );
      return;
    }
    ctx.ui.notify(`[remote-pi] relay connect failed: ${String(err)}`, "error");
    return;
  }

  _relay = relay;
  _relayUrl = relayUrl;
  _peerShort = myShort;
  _myRoomId = roomId;
  _state = "started";
  // Set _sessionStartedAt ONLY on first /remote-pi start since process boot.
  // Subsequent start cycles (after stop) preserve the original epoch so the
  // app keeps treating it as the same session (and merges new events from
  // the terminal turns that happened during the idle window). Pi process
  // restart is the only thing that produces a fresh session_started_at.
  if (_sessionStartedAt === null) _sessionStartedAt = Date.now();
  // _messageBuffer intentionally preserved across stop/start — it accumulates
  // message_end events for the lifetime of the Pi process, including turns
  // initiated from the terminal while the relay was disconnected.

  relay.on("close", _onRelayClose);

  _stopAutoListener = _installAutoListener(relay);
  _refreshFooter(ctx);

  // Plan/24 Wave 3: poll mesh_versions to detect remote revocation. The
  // poller is independent of WS (uses HTTP) and self-heals across relay
  // reconnects, so a single start here per relay-up cycle is enough.
  if (_selfRevoke === null) {
    _selfRevoke = new SelfRevoke({
      client: new MeshClient(relayUrl),
      storage: { listOwnerPubkeys, removePeer },
      myPubkey: edKp.publicKey,
      onRevoke: (ownerEpk) => {
        // Multi-channel (W2D): drop only the revoked owner's channel.
        // Other owners keep their session. Only fall back to full idle
        // when there are zero attached owners left.
        _refreshPairingsCache();
        if (_activePeers.has(ownerEpk)) {
          _detachPeerChannel(ownerEpk);
          _refreshFooter();
        }
      },
    });
    _selfRevoke.start();
  }

  ctx.ui.notify(`[remote-pi] state: started (peer=${myShort}) — Connected to relay ${relayUrl}`, "info");
}

/**
 * `/remote-pi pair` — always generates a fresh QR when the relay is up.
 *
 * Pre-W2D this rejected with "Already paired with X" once one owner was
 * connected, forcing /remote-pi stop to pair a second device — the
 * catch-22 the multi-channel refactor was designed to break. Now the new
 * device is **added** to `_activePeers` after scanning, while existing
 * owners keep their session.
 */
async function _cmdPair(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
  if (_state === "idle") {
    ctx.ui.notify("[remote-pi] Run /remote-pi first.", "warning");
    return;
  }

  const edKp = _cachedEd25519!;
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : "";
  // Embed the user-configured name in the QR so the app shows it on the
  // pairing screen before pair_ok lands (better UX than "remote" or a
  // raw path snippet).
  const sessionName = _displayName(cwd);

  const { token, expiresAt } = qrSession.issueToken();
  const roomId = _myRoomId ?? roomIdForCwd(cwd);
  const qrUri = buildQRUri(token, edKp.publicKey, sessionName, roomId);
  // Render both the QR ASCII and the copy-paste URI inside the Pi TUI's
  // chat panel via `pi.sendMessage` — the same channel the SDK uses for
  // agent responses + tool results. `process.stderr.write` (the old QR
  // path via `displayQR`) broke the TUI layout because it bypassed the
  // chat widget and bled into the prompt area. qrcode-terminal v0.12
  // small mode is pure Unicode (█ ▀ ▄ space, no ANSI escapes — see
  // `lib/main.js:48-53`), so embedding the ASCII inside a sendMessage
  // content string renders correctly without raw escape bytes.
  if (_pi) {
    const qrAscii = renderQRAscii(qrUri);
    _pi.sendMessage({
      customType: "remote-pi:pair-code",
      content:
        `📱 Scan to pair:\n\n${qrAscii}\n` +
        `📋 Or copy this pairing code (camera-less devices):\n\n${qrUri}`,
      display: true,
    });
  }

  ctx.ui.notify(
    `[remote-pi] QR ready — valid until ${new Date(expiresAt).toLocaleTimeString()}. ` +
    `Scan with the app, or copy the pairing code printed above.`,
    "info",
  );
  // Returns immediately; the auto-listener transitions to 'paired' on pair_request.
}

/**
 * `/remote-pi stop` — full teardown. Leaves the local UDS mesh AND closes
 * the relay. Safe when one or both are already off. To resume, run
 * `/remote-pi` again.
 */
async function _cmdStop(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const meshUp = _sessionPeer !== null;
  const relayUp = _state !== "idle";
  if (!meshUp && !relayUp) {
    ctx.ui.notify("[remote-pi] Already stopped — nothing to do.", "info");
    return;
  }

  if (meshUp) {
    try {
      await _sessionPeer!.leave();
    } catch { /* best-effort */ }
    _sessionPeer = null;
    _sessionName = null;
    _sessionPeerCount = 0;
  }

  if (relayUp) _goIdle("peer_stop");

  ctx.ui.notify("[remote-pi] Stopped (mesh + relay disconnected).", "info");
  _refreshFooter(ctx);
}

async function _cmdList(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const peers = await listPeers();
  if (peers.length === 0) { ctx.ui.notify("[remote-pi] No paired devices.", "info"); return; }
  // Multi-channel (W2D): each peer is either `online` (channel attached
  // right now) or `offline` (in peers.json but not connected). Replaces
  // the singleton " (active)" marker that only ever marked one peer.
  const lines = peers.map((p) => {
    const shortid = p.remote_epk.slice(0, 8);
    const tag = _activePeers.has(p.remote_epk) ? " 🟢 online" : " ⚪ offline";
    return `• ${shortid} — ${p.name}${tag}`;
  }).join("\n");
  ctx.ui.notify(`[remote-pi] Paired devices:\n${lines}`, "info");
}

async function _cmdRevoke(arg: string, ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const shortid = arg.trim();
  if (!shortid) {
    ctx.ui.notify(
      "[remote-pi] Usage: /remote-pi revoke <shortid>. Run /remote-pi list to see shortids.",
      "warning",
    );
    return;
  }

  const peers = await listPeers();
  const matches = peers.filter((p) => p.remote_epk.startsWith(shortid));

  if (matches.length === 0) {
    ctx.ui.notify(
      `[remote-pi] No peer matching '${shortid}'. Run /remote-pi list to see shortids.`,
      "warning",
    );
    return;
  }

  if (matches.length > 1) {
    const collisions = matches.map((p) => p.remote_epk.slice(0, 8)).join(", ");
    ctx.ui.notify(
      `[remote-pi] Ambiguous shortid — ${matches.length} matches: ${collisions}. Use mais chars.`,
      "warning",
    );
    return;
  }

  const peer = matches[0]!;
  await removePeer(peer.remote_epk);
  _refreshPairingsCache();

  // Multi-channel (W2D): close just this owner's channel. Other connected
  // owners keep their session — the relay stays `started`.
  if (_activePeers.has(peer.remote_epk)) {
    // Notify the revoked device explicitly before tearing the channel
    // down — otherwise it would only know via ping miss.
    const ch = _activePeers.get(peer.remote_epk);
    try { ch?.send({ type: "bye", reason: "session_replaced" }); } catch { /* best-effort */ }
    _detachPeerChannel(peer.remote_epk);
    _refreshFooter();
  }

  ctx.ui.notify(
    `[remote-pi] Revoked: ${peer.name} (${peer.remote_epk.slice(0, 8)}…)`,
    "info",
  );
}

async function _shortidCompletions(
  prefix: string,
  valuePrefix = "",
): Promise<Array<{ value: string; label: string }>> {
  const peers = await listPeers();
  return peers
    .map((p) => ({ shortid: p.remote_epk.slice(0, 8), name: p.name }))
    .filter((x) => x.shortid.startsWith(prefix))
    .map((x) => ({ value: `${valuePrefix}${x.shortid}`, label: `${x.shortid} (${x.name})` }));
}

function _cmdSetRelay(arg: string, ctx: Pick<ExtensionContext, "ui">): void {
  const raw = arg.trim();
  if (!raw) {
    ctx.ui.notify(
      "[remote-pi] Usage: /remote-pi set-relay <http:// or https:// url>",
      "warning",
    );
    return;
  }
  if (isWebSocketScheme(raw)) {
    ctx.ui.notify(
      `[remote-pi] Use http:// or https://. The extension converts to WebSocket automatically.`,
      "error",
    );
    return;
  }
  if (!isValidRelayUrl(raw)) {
    ctx.ui.notify(
      `[remote-pi] Invalid URL: ${raw}. Must start with http:// or https://`,
      "error",
    );
    return;
  }
  saveConfig({ relay: raw });
  ctx.ui.notify(
    `[remote-pi] Relay set to ${raw}. Run /remote-pi start (or restart) to apply.`,
    "info",
  );
}

// ── Agent-network commands (plano 19) ─────────────────────────────────────────

function _resolveExtensionDir(): string {
  // dist/index.js → dist; skills sit at <extensionRoot>/skills/. When we run
  // from src/ via tsx (dev), index.ts is in src/ and skills/ is sibling. We
  // detect by checking both locations.
  const here = fileURLToPath(import.meta.url);
  // dist/index.js or src/index.ts → parent = <dist or src>; sibling = ../skills
  const parent = here.replace(/\/[^/]+$/, "");
  const candidateA = join(parent, "..", "skills"); // dist → ../skills
  const candidateB = join(parent, "skills");        // src → skills
  if (existsSync(candidateA)) return parent.replace(/\/dist$/, "");
  if (existsSync(candidateB)) return parent;
  return parent;
}

function _deployAgentNetworkSkill(): void {
  // Pi SDK spec (core/skills.js): every skill must live at
  //   <skillsRoot>/<skill-name>/SKILL.md
  // The skill `name:` frontmatter must equal the parent directory name. We
  // ship the source pre-arranged that way so deploy is a straight copy into
  // ~/.pi/remote/skills/agent-network/SKILL.md.
  const root = _resolveExtensionDir();
  const src1 = join(root, "skills", "agent-network", "SKILL.md");
  const src2 = join(root, "..", "skills", "agent-network", "SKILL.md");
  const src = existsSync(src1) ? src1 : (existsSync(src2) ? src2 : null);
  if (!src) return;
  const dstDir = join(skillsDir(), "agent-network");
  const dst = join(dstDir, "SKILL.md");
  try {
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, dst);
    // Cleanup legacy deploy at ~/.pi/remote/skills/agent-network.md (flat
    // layout, fails the Pi SDK's name-vs-parent-dir validation).
    const legacy = join(skillsDir(), "agent-network.md");
    if (existsSync(legacy)) {
      try { unlinkSync(legacy); } catch { /* ignored */ }
    }
  } catch { /* best-effort */ }
}

/**
 * Joins the fixed local UDS mesh ("local" session — see LOCAL_SESSION_NAME).
 * Called by `_cmdRoot` on first run and on subsequent runs when the relay
 * is up and the user hasn't explicitly stopped. The session name is no
 * longer user-configurable: every Pi on the same machine joins the same
 * broker.
 */
async function _cmdJoin(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();
  const local = loadLocalConfig(cwd);
  const sessionName = LOCAL_SESSION_NAME;
  const agentName = local.agent_name || defaultAgentName(cwd);

  if (_sessionPeer) {
    ctx.ui.notify("[remote-pi] Already on the local mesh.", "warning");
    return;
  }

  ensureGlobalDirs();
  mkdirSync(join(skillsDir(), "..", "sessions", sessionName), { recursive: true });

  const sock = sessionSockPath(sessionName);
  const audit = sessionAuditPath(sessionName);
  const peer = new SessionPeer({ sockPath: sock, name: agentName, auditPath: audit });

  peer.onMessage((env) => {
    const body = env.body as { type?: string } | null;
    // Broker system events: re-query broker for authoritative count.
    // Incremental ±1 drifts when peer_left is missed (leader leaves cleanly,
    // failover, etc.) — querying list_peers makes the count self-healing.
    if (body && (body.type === "peer_joined" || body.type === "peer_left")) {
      _refreshSessionPeerCount(peer, ctx);
      return;
    }
    if (env.from === "broker") return;  // other broker control messages — ignore

    // Anything else is a real agent-to-agent message. SessionPeer already
    // correlated replies (env.re matched a pending request) before reaching
    // here — what arrives now is unsolicited and needs the LLM to react.
    // Inject as a user message so the model sees it as a turn input. Include
    // the `id` so the LLM can echo it via `agent_send(..., re=<id>)` when
    // replying (otherwise the sender's agent_request times out).
    if (!_pi) return;
    const bodyText = typeof env.body === "string" ? env.body : JSON.stringify(env.body);
    const header = `[agent-network] message from "${env.from}" (id=${env.id}${env.re ? `, re=${env.re}` : ""}):`;
    const footer = env.re
      ? "(This is a reply to a previous message of yours.)"
      : `(If a reply is expected, call agent_send with to="${env.from}" and re="${env.id}".)`;
    _pi.sendUserMessage(`${header}\n${bodyText}\n\n${footer}`);
  });

  // After failover (leader died, we re-elected): the new broker's peers map
  // starts fresh, but our cached `_sessionPeerCount` is stale. Re-seed it so
  // surviving peers don't carry the pre-failover count forever.
  peer.onReconnect(() => {
    _refreshSessionPeerCount(peer, ctx);
  });

  try {
    const assigned = await peer.start();
    _sessionPeer = peer;
    _sessionName = sessionName;
    _sessionPeerCount = 1;  // optimistic — overwritten by list_peers below
    // Broker broadcasts `peer_joined` only to existing peers when a new one
    // arrives — the newcomer doesn't get retroactive joined events. Ask the
    // broker for the live peer list to seed the count correctly on join.
    _refreshSessionPeerCount(peer, ctx);
    saveLocalConfig(cwd, { agent_name: assigned });
    ctx.ui.notify(
      `[remote-pi] Joined local mesh as "${assigned}" (${peer.currentRole()})`,
      "info",
    );
    _refreshFooter(ctx);
  } catch (err) {
    ctx.ui.notify(`[remote-pi] join failed: ${String(err)}`, "error");
  }
}

// ── routeClientMessage ────────────────────────────────────────────────────────

/**
 * Per-channel router. Replaces the W2D-pre `routeClientMessage` which
 * implicitly used the `_peerChannel` singleton for replies. Each
 * PlainPeerChannel now carries its own `sender` and passes it here so
 * sender-specific responses (cancelled, pong, session_history) flow back
 * through the right wire instead of being broadcast.
 *
 * Broadcast messages (user_input mirror, agent_chunk, tool_*) still use
 * `_broadcastToActive` from the SDK event handlers; this router only
 * handles incoming app→pi requests.
 */
export function _routeClientMessageFrom(
  sender: PlainPeerChannel,
  msg: ClientMessage,
  ctx: Pick<ExtensionContext, "abort">,
): void {
  // session_sync has its own internal guards — handle before the strict
  // pi-binding guard so a missing _pi doesn't drop the reply.
  if (msg.type === "session_sync") {
    _handleSessionSync(sender, msg);
    return;
  }
  if (!_pi) return;
  switch (msg.type) {
    case "user_message": {
      // Reverse-lookup of the sender's appPeerId from `_activePeers` (the
      // PlainPeerChannel's `remotePeerId` is private). Purely diagnostic.
      const senderId =
        [..._activePeers.entries()].find(([, ch]) => ch === sender)?.[0] ?? "unknown";
      console.error(
        `[remote-pi] user_message from ${senderId.slice(0, 8)} ` +
        `id=${msg.id} text=${JSON.stringify(msg.text).slice(0, 60)} ` +
        `activePeers=[${[..._activePeers.keys()].map((k) => k.slice(0, 8)).join(", ")}]`,
      );
      // Source-of-truth rebroadcast (plan/24 W2D fix). Echo the message
      // back to every attached owner (sender included) BEFORE handing it
      // off to the agent — so that:
      //   1. The sender's app waits for this echo to render (no eager
      //      local store), keeping all owners visually consistent.
      //   2. Other owners see what was said, not just the agent's reply.
      //   3. `id` is preserved verbatim, so future dedup logic on the app
      //      side can key off it.
      // The user_message is also recorded in _messageBuffer indirectly
      // via `pi.on("message_end")` after the SDK persists the turn — so
      // a later `session_sync` returns it in the history events.
      _broadcastToActive({ type: "user_message", id: msg.id, text: msg.text });
      _currentTurnId = msg.id;
      _pi.sendUserMessage(msg.text);
      break;
    }
    case "approve_tool":
      // Approval gate was removed (plano 10.2 revisado). Type kept in
      // ClientMessage for forward-compat with a future permissions model;
      // ignore silently if the app still sends it from an older build.
      break;
    case "cancel":
      ctx.abort();
      // Reply to the sender that asked to cancel — broadcasting would tell
      // every owner about a cancellation they didn't request.
      sender.send({ type: "cancelled", in_reply_to: msg.id, target_id: msg.target_id });
      break;
    case "ping":
      sender.send({ type: "pong", in_reply_to: msg.id });
      break;
    case "pair_request":
      // Already paired — ignore subsequent pair_request to maintain idempotency.
      // (Token is already consumed and peer is in peers.json.)
      break;
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
  const fallback = [..._activePeers.values()].pop();
  if (!fallback) return;
  _routeClientMessageFrom(fallback, msg, ctx);
}

// ── session_sync handler + helpers ────────────────────────────────────────────

/**
 * `session_sync` is a per-sender query: the owner asking gets the reply,
 * not the whole broadcast. Otherwise a session_sync from owner A would
 * also dump history to owner B's wire — duplicate traffic + the wrong
 * `in_reply_to`.
 */
function _handleSessionSync(
  sender: PlainPeerChannel,
  msg: Extract<ClientMessage, { type: "session_sync" }>,
): void {
  if (_sessionStartedAt === null) {
    sender.send({
      type: "session_history",
      in_reply_to: msg.id,
      session_started_at: 0,
      events: [],
      eos: true,
      truncated: false,
    });
    return;
  }

  // Mirror semantics: always return the last N events. App SUBSTITUTES its
  // local cache with this response — no delta/since_ts logic.
  const serverLimit = _getSyncLimit();
  const requested = msg.limit ?? serverLimit;
  const effectiveLimit = Math.min(requested, serverLimit);  // server clamps

  const allEvents = _mapAgentMessagesToEvents(_messageBuffer);
  const slice = effectiveLimit > 0 ? allEvents.slice(-effectiveLimit) : [];
  const truncated = allEvents.length > effectiveLimit;

  sender.send({
    type: "session_history",
    in_reply_to: msg.id,
    session_started_at: _sessionStartedAt,
    events: slice,
    eos: true,
    truncated,
  });
}

function _stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const block = c as { type?: string; text?: unknown };
      return block.type === "text" ? String(block.text ?? "") : "";
    })
    .join("");
}

/**
 * Maps SDK AgentMessage[] (UserMessage / AssistantMessage / ToolResultMessage)
 * into the flat SessionHistoryEvent[] shape consumed by the app.
 *
 * Caveats (see report): in_reply_to of agent_message is the *last* user_input
 * id seen in a linear scan — fine for typical conversational flow but not
 * a perfect reconstruction of multi-turn ordering when tools interleave.
 * Stable id for user_input is `sync_<timestamp>`.
 */
export function _mapAgentMessagesToEvents(
  messages: BufferMsg[],
): SessionHistoryEvent[] {
  const events: SessionHistoryEvent[] = [];
  let lastUserId: string | null = null;

  for (const m of messages) {
    const ts = typeof m.timestamp === "number" ? m.timestamp : 0;

    if (m.role === "user") {
      const id = `sync_${ts}`;
      lastUserId = id;
      events.push({
        ts,
        type: "user_input",
        id,
        text: _stringifyContent(m.content),
      });
    } else if (m.role === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [];
      const usage = m.usage
        ? { input_tokens: m.usage.input ?? 0, output_tokens: m.usage.output ?? 0 }
        : undefined;
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const block = raw as { type?: string; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (block.type === "text") {
          const text = String(block.text ?? "");
          if (!text) continue;
          const ev: SessionHistoryEvent = {
            ts,
            type: "agent_message",
            in_reply_to: lastUserId ?? `sync_${ts}`,
            text,
            ...(usage ? { usage } : {}),
          };
          events.push(ev);
        } else if (block.type === "toolCall") {
          events.push({
            ts,
            type: "tool_request",
            tool_call_id: String(block.id ?? ""),
            tool: String(block.name ?? ""),
            args: (block.arguments as Record<string, unknown>) ?? {},
          });
        }
      }
    } else if (m.role === "toolResult") {
      const text = _stringifyContent(m.content);
      const tcid = String(m.toolCallId ?? "");
      events.push(
        m.isError
          ? { ts, type: "tool_result", tool_call_id: tcid, error: text }
          : { ts, type: "tool_result", tool_call_id: tcid, result: text },
      );
    }
  }

  return events;
}

// ── Standalone CLI ────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , subcmd, ...cliArgs] = process.argv;
  if (subcmd === "devices" || subcmd === "list") {
    const peers = await listPeers();
    if (peers.length === 0) { console.log("[remote-pi] No peers"); }
    else { for (const p of peers) console.log(`• ${p.remote_epk.slice(0, 8)} — ${p.name}`); }
  } else if (subcmd === "revoke") {
    const shortid = (cliArgs[0] ?? "").trim();
    if (!shortid) {
      console.log("Usage: revoke <shortid>");
    } else {
      const peers = await listPeers();
      const matches = peers.filter((p) => p.remote_epk.startsWith(shortid));
      if (matches.length === 0) console.log(`No peer matching '${shortid}'`);
      else if (matches.length > 1) console.log(`Ambiguous: ${matches.map((p) => p.remote_epk.slice(0, 8)).join(", ")}`);
      else {
        const peer = matches[0]!;
        const { removePeer } = await import("./pairing/storage.js");
        await removePeer(peer.remote_epk);
        console.log(`Revoked: ${peer.name} (${peer.remote_epk.slice(0, 8)}…)`);
      }
    }
  } else if (subcmd === "set-relay") {
    const raw = (cliArgs[0] ?? "").trim();
    if (!raw) {
      console.log(`Usage: set-relay <url> (default: ${kDefaultRelayUrl})`);
    } else if (isWebSocketScheme(raw)) {
      console.log(`Use http:// or https://. The extension converts to WebSocket automatically.`);
    } else if (!isValidRelayUrl(raw)) {
      console.log(`Invalid URL: ${raw}. Must start with http:// or https://`);
    } else {
      saveConfig({ relay: raw });
      console.log(`Relay set to ${raw}`);
    }
  } else {
    const edKp = await getOrCreateEd25519Keypair();
    const sessionName = process.cwd().split("/").slice(-2).join("/");
    const { url: relayUrl, source } = resolveRelayUrl();
    const roomId = roomIdForCwd(process.cwd());
    console.log(`[remote-pi] relay: ${relayUrl} (source: ${source}), room: ${roomId}`);
    void cliArgs;
    const stop = startQRRotation(edKp.publicKey, sessionName, roomId);
    process.once("SIGINT", () => { stop(); process.exit(0); });
  }
}
