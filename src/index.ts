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

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { type Ed25519Keypair } from "./pairing/crypto.js";
import { buildQRUri, displayQR, qrSession, startQRRotation } from "./pairing/qr.js";
import {
  addPeer,
  getOrCreateEd25519Keypair,
  listPeers,
  type PeerRecord,
} from "./pairing/storage.js";
import { decide } from "./session/tool_gate.js";
import type {
  ClientMessage,
  PairErrorCode,
  ServerMessage,
} from "./protocol/types.js";
import { RelayClient } from "./transport/relay_client.js";
import { PlainPeerChannel } from "./transport/peer_channel.js";

const DEFAULT_RELAY_URL =
  process.env["REMOTE_PI_RELAY"] ?? "ws://localhost:3000";

// ── SDK tool-name mapping ─────────────────────────────────────────────────────
const SDK_TO_GATE: Record<string, string> = {
  bash: "Bash", read: "Read", edit: "Edit",
  write: "Write", grep: "Grep", find: "Glob", ls: "Ls",
};

// ── State machine ─────────────────────────────────────────────────────────────

export type RemoteState = "idle" | "started" | "paired";

let _state: RemoteState = "idle";
let _relay: RelayClient | null = null;
let _peerChannel: PlainPeerChannel | null = null;
let _peerShort = "";

// Per-turn messaging state
let _currentTurnId: string | null = null;
const _pendingApprovals = new Map<string, (d: "allow" | "deny") => void>();

// Module-level pi reference
let _pi: ExtensionAPI | null = null;

let _stopAutoListener: (() => void) | null = null;

// Cached keypair (loaded once, reused across start/pair cycles)
let _cachedEd25519: Ed25519Keypair | null = null;

/** Exported for tests. */
export function _getState(): RemoteState { return _state; }


// ── Peer lookup helpers ───────────────────────────────────────────────────────

async function _findKnownPeer(appPeerIdStd: string): Promise<PeerRecord | null> {
  const peers = await listPeers();
  return peers.find((p) => p.remote_epk === appPeerIdStd) ?? null;
}

// ── Transition helpers ────────────────────────────────────────────────────────

/** Full teardown: stop listener, detach channel, close relay → idle. */
function _goIdle(reason?: string): void {
  _stopAutoListener?.();
  _stopAutoListener = null;

  for (const resolve of _pendingApprovals.values()) resolve("deny");
  _pendingApprovals.clear();

  _peerChannel?.detach();
  _peerChannel = null;
  _peerShort = "";
  _currentTurnId = null;

  _relay?.close();
  _relay = null;

  _state = "idle";
  if (reason) console.error(`[remote-pi] ${reason}`);
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
  _peerShort = "";
  _currentTurnId = null;

  _state = "started";
  console.error("[remote-pi] App disconnected, listening for reconnect");

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
  _peerShort = peerShort;
  _state = "paired";

  console.error(`[remote-pi] state: paired (peer=${peerShort}, name=${peerName})`);

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

    // Lightweight wire log (no payload contents)
    const ctLen = outer.ct?.length ?? 0;
    const decodedLen = outer.ct ? Buffer.from(outer.ct, "base64").length : 0;
    console.error(
      `[WS-IN] raw.len=${line.length} ct.len=${ctLen} decoded=${decodedLen} peer=${(outer.peer ?? "").slice(0, 8)}`,
    );

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

    // Unknown peer outside of pair_request — ignore silently
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
    console.error(`[remote-pi] pair_request rejected: ${code} (peer=${appPeerId.slice(0, 8)})`);
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

  sendInner({ type: "pair_ok", in_reply_to: inner.id, session_name: sessionName });
}

// ── Extension factory (default export) ───────────────────────────────────────

// Stores most recent command context so the auto-listener can use ui.notify
let _lastCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null = null;
const _noopCtx = { ui: { notify: () => undefined }, abort: () => undefined };

const extension: ExtensionFactory = (pi: ExtensionAPI): void => {
  _pi = pi;

  // ── Tool interception ─────────────────────────────────────────────────────
  pi.on("tool_call", async (event): Promise<ToolCallEventResult | void> => {
    if (!_peerChannel) return;

    const gateToolName = SDK_TO_GATE[event.toolName] ?? event.toolName;
    if (decide(gateToolName) === "auto") return;

    _peerChannel.send({
      type: "tool_request",
      tool_call_id: event.toolCallId,
      tool: event.toolName,
      args: event.input as Record<string, unknown>,
    });

    const decision = await new Promise<"allow" | "deny">((resolve) => {
      let settled = false;
      const settle = (d: "allow" | "deny") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        _pendingApprovals.delete(event.toolCallId);
        resolve(d);
      };
      const timer = setTimeout(() => {
        _peerChannel?.send({ type: "error", code: "timeout", message: `tool approval timeout: ${event.toolCallId}` });
        settle("deny");
      }, 60_000);
      _pendingApprovals.set(event.toolCallId, settle);
    });

    return decision === "deny" ? { block: true, reason: "denied by remote user" } : undefined;
  });

  pi.on("message_update", (event) => {
    if (!_peerChannel || !_currentTurnId) return;
    const ae = event.assistantMessageEvent;
    if (ae.type === "text_delta") {
      _peerChannel.send({ type: "agent_chunk", in_reply_to: _currentTurnId, delta: ae.delta });
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (!_peerChannel) return;
    const msg: ServerMessage = event.isError
      ? { type: "tool_result", tool_call_id: event.toolCallId, error: String(event.result) }
      : { type: "tool_result", tool_call_id: event.toolCallId, result: event.result as unknown };
    _peerChannel.send(msg);
  });

  pi.on("agent_end", () => {
    if (!_peerChannel || !_currentTurnId) return;
    _peerChannel.send({ type: "agent_done", in_reply_to: _currentTurnId });
    _currentTurnId = null;
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  pi.registerCommand("remote-pi", {
    description: "Show remote-pi status",
    getArgumentCompletions: (prefix) =>
      ["start", "pair", "stop", "list", "revoke"]
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      const sub = args.trim();
      if      (sub === "start")           { await _cmdStart(ctx); }
      else if (sub === "pair")            { await _cmdPair(ctx); }
      else if (sub === "stop")            { await _cmdStop(ctx); }
      else if (sub === "list")            { await _cmdList(ctx); }
      else if (sub.startsWith("revoke"))  { _cmdRevoke(sub.slice("revoke".length).trim(), ctx); }
      else                               { _cmdStatus(ctx); }
    },
  });

  pi.registerCommand("remote-pi start",  { description: "Connect to relay (idle → started)", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdStart(ctx); } });
  pi.registerCommand("remote-pi pair",   { description: "Show QR for new peer (started, async → paired)", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdPair(ctx); } });
  pi.registerCommand("remote-pi stop",   { description: "Disconnect (any → idle)", handler: async (_, ctx) => { _lastCtx = ctx; await _cmdStop(ctx); } });
  pi.registerCommand("remote-pi list",   { description: "List paired remote devices", handler: async (_, ctx) => _cmdList(ctx) });
  pi.registerCommand("remote-pi revoke", { description: "Revoke pairing (TODO)", handler: async (args, ctx) => _cmdRevoke(args.trim(), ctx) });
};

export default extension;

// ── Command implementations ───────────────────────────────────────────────────

function _cmdStatus(ctx: Pick<ExtensionContext, "ui">): void {
  let msg: string;
  if      (_state === "idle")   msg = "[remote-pi] state: idle — run /remote-pi start to connect to relay";
  else if (_state === "started") msg = `[remote-pi] state: started (peer=${_peerShort || "?"}) — run /remote-pi pair to show QR`;
  else                          msg = `[remote-pi] state: paired (peer=${_peerShort}) — connected and ready`;
  ctx.ui.notify(msg, "info");
}

async function _cmdStart(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  if (_state !== "idle") {
    ctx.ui.notify("[remote-pi] Already started.", "warning");
    return;
  }

  const edKp = await getOrCreateEd25519Keypair();
  _cachedEd25519 = edKp;

  const myShort = Buffer.from(edKp.publicKey).toString("base64").slice(0, 8);
  ctx.ui.notify(`[remote-pi] Connecting to relay ${DEFAULT_RELAY_URL}…`, "info");

  const relay = new RelayClient(DEFAULT_RELAY_URL, edKp);
  try {
    await relay.connect();
  } catch (err) {
    ctx.ui.notify(`[remote-pi] relay connect failed: ${String(err)}`, "error");
    return;
  }

  _relay = relay;
  _peerShort = myShort;
  _state = "started";

  relay.on("close", () => _goIdle("Lost relay connection"));

  _stopAutoListener = _installAutoListener(relay);

  ctx.ui.notify(`[remote-pi] state: started (peer=${myShort}) — Connected to relay ${DEFAULT_RELAY_URL}`, "info");
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

  const { token, expiresAt } = qrSession.issueToken();
  const qrUri = buildQRUri(token, edKp.publicKey, DEFAULT_RELAY_URL, sessionName);
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
  _goIdle("Disconnected");
  ctx.ui.notify("[remote-pi] state: idle — Disconnected.", "info");
}

async function _cmdList(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const peers = await listPeers();
  if (peers.length === 0) { ctx.ui.notify("[remote-pi] No paired devices.", "info"); return; }
  const lines = peers.map((p) => `• ${p.name} — ${p.remote_epk.slice(0, 8)}…`).join("\n");
  ctx.ui.notify(`[remote-pi] Paired devices:\n${lines}`, "info");
}

function _cmdRevoke(name: string, ctx: Pick<ExtensionContext, "ui">): void {
  void name;
  ctx.ui.notify("[remote-pi] Revoke not implemented in MVP. Remove entry from ~/.pi/remote/peers.json manually.", "info");
}

// ── routeClientMessage ────────────────────────────────────────────────────────

export function routeClientMessage(
  msg: ClientMessage,
  ctx: Pick<ExtensionContext, "abort">,
): void {
  if (!_peerChannel || !_pi) return;
  switch (msg.type) {
    case "user_message":
      _currentTurnId = msg.id;
      _pi.sendUserMessage(msg.text);
      break;
    case "approve_tool": {
      const resolve = _pendingApprovals.get(msg.tool_call_id);
      if (resolve) resolve(msg.decision);
      break;
    }
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

// ── Standalone CLI ────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , subcmd, ...cliArgs] = process.argv;
  if (subcmd === "list") {
    const peers = await listPeers();
    if (peers.length === 0) { console.log("[remote-pi] No peers"); }
    else { for (const p of peers) console.log(`• ${p.name} — ${p.remote_epk.slice(0, 8)}…`); }
  } else if (subcmd === "revoke") {
    console.log("[remote-pi] revoke: not implemented in MVP");
  } else {
    const edKp = await getOrCreateEd25519Keypair();
    const sessionName = process.cwd().split("/").slice(-2).join("/");
    console.log(`[remote-pi] relay: ${DEFAULT_RELAY_URL}`);
    void cliArgs;
    const stop = startQRRotation(edKp.publicKey, DEFAULT_RELAY_URL, sessionName);
    process.once("SIGINT", () => { stop(); process.exit(0); });
  }
}
