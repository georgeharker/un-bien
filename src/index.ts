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
import { buildQRUri, displayQR, qrSession, startQRRotation } from "./pairing/qr.js";
import {
  addPeer,
  getOrCreateEd25519Keypair,
  listPeers,
  removePeer,
  type PeerRecord,
} from "./pairing/storage.js";
import type {
  ClientMessage,
  PairErrorCode,
  ServerMessage,
  SessionHistoryEvent,
} from "./protocol/types.js";
import { RelayClient } from "./transport/relay_client.js";
import { PlainPeerChannel } from "./transport/peer_channel.js";
import {
  DEFAULT_RELAY_URL,
  getRelayUrl,
  setRelayUrl,
  validateRelayUrl,
} from "./settings.js";

// ── State machine ─────────────────────────────────────────────────────────────

export type RemoteState = "idle" | "started" | "paired";

let _state: RemoteState = "idle";
let _relay: RelayClient | null = null;
let _relayUrl: string | null = null;  // URL used by current _relay connection
let _peerChannel: PlainPeerChannel | null = null;
let _appPeerId: string | null = null;  // active app peer ID (Ed25519 pk base64 std)
let _peerShort = "";

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

// Per-turn messaging state
let _currentTurnId: string | null = null;

// Module-level pi reference
let _pi: ExtensionAPI | null = null;

let _stopAutoListener: (() => void) | null = null;

// Cached keypair (loaded once, reused across start/pair cycles)
let _cachedEd25519: Ed25519Keypair | null = null;

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

/** Exported for tests. */
export function _getState(): RemoteState { return _state; }


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
  if (_peerChannel && byeReason && _state !== "idle") {
    try {
      _peerChannel.send({ type: "bye", reason: byeReason });
    } catch {
      // peer already offline — fine
    }
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

  _peerChannel?.detach();
  _peerChannel = null;
  _appPeerId = null;
  _peerShort = "";
  _currentTurnId = null;

  _relay?.close();
  _relay = null;
  _relayUrl = null;
  // Preserve _sessionStartedAt + _messageBuffer across stop/start cycles.
  // The Pi agent session outlives the relay connection — `message_end` keeps
  // firing for terminal turns even while idle, and the buffer must survive
  // so those turns appear in the next session_sync. Only a Pi process
  // restart resets these (init-time values).

  _state = "idle";
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

  _peerChannel?.detach();
  _peerChannel = null;
  _appPeerId = null;
  _currentTurnId = null;

  _relay = null;  // _relayUrl preserved for retry
  _state = "started";

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
  const relay = new RelayClient(url, edKp);

  try {
    await relay.connect();
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
 * App-level peer disconnect (relay still up).
 * Transitions paired → started and re-installs the auto-listener.
 * Exported so tests can trigger it directly; in production it will be
 * called when the relay sends a peer-disconnect notification (future).
 */
export function _onPeerDisconnect(): void {
  if (_state !== "paired") return;

  _peerChannel?.detach();
  _peerChannel = null;
  _appPeerId = null;
  _peerShort = "";
  _currentTurnId = null;

  _state = "started";
  _lastCtx?.ui.notify("[remote-pi] App disconnected, listening for reconnect", "info");

  // Re-install auto-listener so reconnect works
  if (_relay) {
    _stopAutoListener?.();
    _stopAutoListener = _installAutoListener(_relay);
  }
}

/**
 * Promotes started → paired by installing a PlainPeerChannel for `appPeerId`.
 * Routes `firstInner` immediately so the message that triggered reconnection
 * isn't dropped.
 */
function _promoteToPaired(
  relay: RelayClient,
  appPeerId: string,
  peerName: string,
  firstInner?: ClientMessage,
): void {
  const peerShort = appPeerId.slice(0, 8);

  const channel = new PlainPeerChannel(
    relay,
    appPeerId,
    (msg) => routeClientMessage(msg, _lastCtx ?? _noopCtx),
    () => _onPeerDisconnect(),
  );

  _peerChannel = channel;
  _appPeerId = appPeerId;
  _peerShort = peerShort;
  _state = "paired";

  _lastCtx?.ui.notify(
    `[remote-pi] state: paired (peer=${peerShort}, name=${peerName})`,
    "info",
  );

  if (firstInner) {
    // Route the inner that triggered the reconnect — the channel listener
    // also saw it, but we route through routeClientMessage to be explicit.
    void firstInner;
  }
}

// ── Auto-reconnect listener ───────────────────────────────────────────────────
//
// Installed while in 'started' state. Decodes the outer envelope as
// base64(JSON) and dispatches based on inner type:
//   • pair_request from any peer → validate token, persist peer, send pair_ok/pair_error
//   • any inner from a known peer (peers.json) → promote to paired and route
//   • anything else → ignored

function _installAutoListener(relay: RelayClient): () => void {
  const onMsg = async (line: string) => {
    let outer: { peer?: string; ct?: string };
    try { outer = JSON.parse(line) as { peer?: string; ct?: string }; }
    catch { return; }

    if (!outer.peer || !outer.ct) return;

    // Once paired, the PlainPeerChannel handles application messages.
    if (_state === "paired") return;
    if (_state !== "started") return;

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

    // Reconnect path: known peer sends a non-pair message → promote to paired
    // and route through the new PlainPeerChannel. See pairing.md §Reconexão.
    const known = await _findKnownPeer(appPeerId);
    if (known) {
      _promoteToPaired(relay, appPeerId, known.name);
      // The PlainPeerChannel that was just installed will not have observed
      // the line we already consumed; route the inner directly.
      routeClientMessage(inner, _lastCtx ?? _noopCtx);
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
      code === "token_expired"  ? "Token efêmero expirou. Gere um novo QR com /remote-pi pair."
      : code === "token_consumed" ? "Token já consumido por outro pair_request."
      : "Token não foi emitido por este Pi.";
    sendError(code, msg);
    return;
  }

  try {
    await addPeer({
      name: inner.device_name,
      remote_epk: appPeerId,
      paired_at: new Date().toISOString(),
    });
  } catch (err) {
    sendError("internal_error", `Failed to persist peer: ${String(err)}`);
    return;
  }

  const cwd = _lastCtx && "cwd" in _lastCtx
    ? (_lastCtx as ExtensionCommandContext).cwd
    : process.cwd();
  const sessionName = cwd.split("/").slice(-2).join("/") || "remote";

  _promoteToPaired(relay, appPeerId, inner.device_name);

  sendInner({
    type: "pair_ok",
    in_reply_to: inner.id,
    session_name: sessionName,
    session_started_at: _sessionStartedAt ?? Date.now(),
  });
}

// ── Extension factory (default export) ───────────────────────────────────────

// Stores most recent command context so the auto-listener can use ui.notify
let _lastCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null = null;
const _noopCtx = { ui: { notify: () => undefined }, abort: () => undefined };

const extension: ExtensionFactory = (pi: ExtensionAPI): void => {
  _pi = pi;
  console.error(`[remote-pi] session sync limit: ${_getSyncLimit()}`);

  // Tool calls execute without prompting the remote user. The Pi SDK has no
  // native `requiresApproval` per tool, and a hardcoded gate (Bash/Edit/Write)
  // misfired on every custom tool from third-party packages. Approval will
  // come back when the Pi ecosystem ships a permissions convention. tool_result
  // is still forwarded so the app shows tool activity transparently.

  // Mirror input typed in the Pi terminal (or sent via RPC) to the remote app.
  // 'extension' source is our own sendUserMessage call from routeClientMessage,
  // which already set _currentTurnId — skip to avoid double turnId.
  pi.on("input", (event) => {
    if (!_peerChannel) return;
    if (event.source === "extension") return;
    const turnId = `local_${randomUUID()}`;
    _currentTurnId = turnId;
    _peerChannel.send({ type: "user_input", id: turnId, text: event.text });
  });

  pi.on("message_update", (event) => {
    if (!_peerChannel || !_currentTurnId) return;
    const ae = event.assistantMessageEvent;
    if (ae.type === "text_delta") {
      _peerChannel.send({ type: "agent_chunk", in_reply_to: _currentTurnId, delta: ae.delta });
    }
  });

  // Notify the app a tool is about to run (visibility only, NOT approval).
  // tool_execution_start fires before the tool executes; tool_execution_end
  // closes the loop with the result (success or error). Together they let
  // the app render a "Tool running… done" timeline without any gating.
  pi.on("tool_execution_start", (event) => {
    if (!_peerChannel) return;
    _peerChannel.send({
      type: "tool_request",
      tool_call_id: event.toolCallId,
      tool: event.toolName,
      args: event.args as Record<string, unknown>,
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (!_peerChannel) return;
    const msg: ServerMessage = event.isError
      ? { type: "tool_result", tool_call_id: event.toolCallId, error: String(event.result) }
      : { type: "tool_result", tool_call_id: event.toolCallId, result: event.result as unknown };
    _peerChannel.send(msg);
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
    // turn signal to the app. No buffer mutation.
    if (!_peerChannel || !_currentTurnId) return;
    _peerChannel.send({ type: "agent_done", in_reply_to: _currentTurnId });
    _currentTurnId = null;
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  pi.registerCommand("remote-pi", {
    description: "Show remote-pi status",
    getArgumentCompletions: async (prefix) => {
      // Support "revoke <shortid-prefix>" inline completion at the dispatcher
      // (fallback for SDKs that don't dispatch nested-command completions).
      if (prefix.startsWith("revoke ") || prefix === "revoke") {
        const shortPrefix = prefix === "revoke" ? "" : prefix.slice("revoke ".length);
        return _shortidCompletions(shortPrefix, "revoke ");
      }
      return ["start", "pair", "stop", "list", "revoke", "add-relay"]
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
    },
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      const sub = args.trim();
      if      (sub === "start")             { await _cmdStart(ctx); }
      else if (sub === "pair")              { await _cmdPair(ctx); }
      else if (sub === "stop")              { await _cmdStop(ctx); }
      else if (sub === "list")              { await _cmdList(ctx); }
      else if (sub.startsWith("revoke"))    { await _cmdRevoke(sub.slice("revoke".length).trim(), ctx); }
      else if (sub.startsWith("add-relay")) { await _cmdAddRelay(sub.slice("add-relay".length).trim(), ctx); }
      else                                  { await _cmdStatus(ctx); }
    },
  });

  pi.registerCommand("remote-pi start",  { description: "Connect to relay (idle → started)", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdStart(ctx); } });
  pi.registerCommand("remote-pi pair",   { description: "Show QR for new peer (started, async → paired)", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdPair(ctx); } });
  pi.registerCommand("remote-pi stop",   { description: "Disconnect (any → idle)", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdStop(ctx); } });
  pi.registerCommand("remote-pi list",   { description: "List paired remote devices", handler: async (_, ctx) => _cmdList(ctx) });
  pi.registerCommand("remote-pi revoke", {
    description: "Revoke a paired device by shortid",
    getArgumentCompletions: async (prefix) => _shortidCompletions(prefix),
    handler: async (args, ctx) => { _lastCtx = ctx; await _cmdRevoke(args.trim(), ctx); },
  });
  pi.registerCommand("remote-pi add-relay", {
    description: "Save relay URL to ~/.pi/remote/settings.json",
    handler: async (args, ctx) => { _lastCtx = ctx; await _cmdAddRelay(args.trim(), ctx); },
  });
};

export default extension;

// ── Command implementations ───────────────────────────────────────────────────

async function _cmdStatus(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const relayUrl = _relayUrl ?? (await getRelayUrl());
  let msg: string;
  if      (_state === "idle")   msg = `[remote-pi] state: idle — relay=${relayUrl}. Run /remote-pi start to connect.`;
  else if (_state === "started") msg = `[remote-pi] state: started (peer=${_peerShort || "?"}, relay=${relayUrl}) — run /remote-pi pair to show QR`;
  else                          msg = `[remote-pi] state: paired (peer=${_peerShort}, relay=${relayUrl}) — connected and ready`;
  ctx.ui.notify(msg, "info");
}

async function _cmdStart(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  if (_state !== "idle") {
    ctx.ui.notify("[remote-pi] Already started.", "warning");
    return;
  }

  const edKp = await getOrCreateEd25519Keypair();
  _cachedEd25519 = edKp;

  const relayUrl = await getRelayUrl();
  const myShort = Buffer.from(edKp.publicKey).toString("base64").slice(0, 8);
  ctx.ui.notify(`[remote-pi] Connecting to relay ${relayUrl}…`, "info");

  const relay = new RelayClient(relayUrl, edKp);
  try {
    await relay.connect();
  } catch (err) {
    ctx.ui.notify(`[remote-pi] relay connect failed: ${String(err)}`, "error");
    return;
  }

  _relay = relay;
  _relayUrl = relayUrl;
  _peerShort = myShort;
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

  ctx.ui.notify(`[remote-pi] state: started (peer=${myShort}) — Connected to relay ${relayUrl}`, "info");
}

async function _cmdPair(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
  if (_state === "idle") {
    ctx.ui.notify("[remote-pi] Run /remote-pi start first.", "warning");
    return;
  }
  if (_state === "paired") {
    ctx.ui.notify(`[remote-pi] Already paired with ${_peerShort}. Run /remote-pi stop first.`, "warning");
    return;
  }

  const edKp = _cachedEd25519!;
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : "";
  const sessionName = cwd.split("/").slice(-2).join("/") || "remote";
  const relayUrl = _relayUrl ?? (await getRelayUrl());

  const { token, expiresAt } = qrSession.issueToken();
  const qrUri = buildQRUri(token, edKp.publicKey, relayUrl, sessionName);
  displayQR(qrUri);

  ctx.ui.notify(
    `[remote-pi] QR ready — valid until ${new Date(expiresAt).toLocaleTimeString()}. Scan with the app.`,
    "info",
  );
  // Returns immediately; the auto-listener transitions to 'paired' on pair_request.
}

async function _cmdStop(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  if (_state === "idle") {
    ctx.ui.notify("[remote-pi] Already idle — nothing to stop.", "info");
    return;
  }
  _goIdle("peer_stop");
  ctx.ui.notify("[remote-pi] state: idle — Disconnected.", "info");
}

async function _cmdList(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const peers = await listPeers();
  if (peers.length === 0) { ctx.ui.notify("[remote-pi] No paired devices.", "info"); return; }
  const lines = peers.map((p) => {
    const shortid = p.remote_epk.slice(0, 8);
    const active = _state === "paired" && _appPeerId === p.remote_epk ? " (active)" : "";
    return `• ${shortid} — ${p.name}${active}`;
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

  if (_state === "paired" && _appPeerId === peer.remote_epk) {
    _goIdle("session_replaced");
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

async function _cmdAddRelay(arg: string, ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const url = arg.trim();
  if (!url) {
    ctx.ui.notify(
      `[remote-pi] Usage: /remote-pi add-relay <url> (ex: ws://192.168.1.10:3000). Default is ${DEFAULT_RELAY_URL}.`,
      "warning",
    );
    return;
  }
  const v = validateRelayUrl(url);
  if (!v.ok) {
    ctx.ui.notify(`[remote-pi] Invalid relay URL: ${v.reason}`, "warning");
    return;
  }
  await setRelayUrl(url);
  const suffix = _state === "idle"
    ? ""
    : " (restart with /remote-pi stop then /remote-pi start to take effect)";
  ctx.ui.notify(`[remote-pi] Relay saved: ${url}${suffix}`, "info");
}

// ── routeClientMessage ────────────────────────────────────────────────────────

export function routeClientMessage(
  msg: ClientMessage,
  ctx: Pick<ExtensionContext, "abort">,
): void {
  // session_sync has its own internal guards — handle before the strict
  // peer/pi guard so a missing _pi doesn't drop the reply.
  if (msg.type === "session_sync") {
    _handleSessionSync(msg);
    return;
  }
  if (!_peerChannel || !_pi) return;
  switch (msg.type) {
    case "user_message":
      _currentTurnId = msg.id;
      _pi.sendUserMessage(msg.text);
      break;
    case "approve_tool":
      // Approval gate was removed (plano 10.2 revisado). Type kept in
      // ClientMessage for forward-compat with a future permissions model;
      // ignore silently if the app still sends it from an older build.
      break;
    case "cancel":
      ctx.abort();
      _peerChannel.send({ type: "cancelled", in_reply_to: msg.id, target_id: msg.target_id });
      break;
    case "ping":
      _peerChannel.send({ type: "pong", in_reply_to: msg.id });
      break;
    case "pair_request":
      // Already paired — ignore subsequent pair_request to maintain idempotency.
      // (Token is already consumed and peer is in peers.json.)
      break;
  }
}

// ── session_sync handler + helpers ────────────────────────────────────────────

function _handleSessionSync(
  msg: Extract<ClientMessage, { type: "session_sync" }>,
): void {
  if (!_peerChannel) return;

  if (_sessionStartedAt === null) {
    _peerChannel.send({
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

  _peerChannel.send({
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
  if (subcmd === "list") {
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
  } else if (subcmd === "add-relay") {
    const url = (cliArgs[0] ?? "").trim();
    if (!url) {
      console.log(`Usage: add-relay <url> (default: ${DEFAULT_RELAY_URL})`);
    } else {
      const v = validateRelayUrl(url);
      if (!v.ok) console.log(`Invalid URL: ${v.reason}`);
      else {
        await setRelayUrl(url);
        console.log(`Relay saved: ${url}`);
      }
    }
  } else {
    const edKp = await getOrCreateEd25519Keypair();
    const sessionName = process.cwd().split("/").slice(-2).join("/");
    const relayUrl = await getRelayUrl();
    console.log(`[remote-pi] relay: ${relayUrl}`);
    void cliArgs;
    const stop = startQRRotation(edKp.publicKey, relayUrl, sessionName);
    process.once("SIGINT", () => { stop(); process.exit(0); });
  }
}
