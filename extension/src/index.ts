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

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Ed25519Keypair } from "./pairing/crypto.js";
import {
  buildQRUri,
  qrSession,
  renderQRAscii,
  clampPairTtlMs,
  TOKEN_TTL_MS,
} from "./pairing/qr.js";
import {
  addPeer,
  getOrCreateEd25519Keypair,
  describeIdentity,
  KeyringUnavailableError,
  PairedIdentityMissingError,
  listPeers,
  removePeer,
  snapshotOwnerPubkeys,
  conditionalRemovePeer,
} from "./pairing/storage.js";
import { MeshClient } from "./mesh/client.js";
import { SelfRevoke } from "./mesh/self_revoke.js";
import type { MeshTopologySnapshot } from "./mesh/siblings.js";
import type {
  ClientMessage,
  PairErrorCode,
  ServerMessage,
  ThinkingLevel,
} from "./protocol/types.js";
import { RelayClient, RoomAlreadyOpenError } from "./transport/relay_client.js";
import { PlainPeerChannel } from "./transport/peer_channel.js";
import {
  createExtensionUiBridge,
  type ExtensionUiBridge,
  type ExtensionUiResponseWire,
} from "./extension_ui_bridge.js";
import { createPanelBridge, type PanelBridge } from "./panel_bridge.js";
import {
  initSubagentRooms,
  subagentRoomsEnabled,
  type SubagentRoomsController,
} from "./subagent_rooms.js";
import {
  createRpcEnvelope,
  isEnvelopeFrame,
  helloEnvelope,
  type EnvelopeMessage,
} from "./session/rpc_envelope.js";
import {
  dispatchRpcCommand,
  GET_ENTRIES_PAGE_BUDGET_BYTES,
  pageEntries,
  type RpcCommandHandlers,
} from "./session/rpc_inbound.js";
import { envLog } from "./session/debug_log.js";
import { roomIdFor, roomIdForSession } from "./rooms.js";
import { registerAgentTools } from "./session/tools.js";
import { formatPeerInventory } from "./session/peer_inventory.js";
import { MeshNode } from "./session/mesh_node.js";
import {
  wireFromModel,
  type ActionCtx,
  type ActionPi,
} from "./actions/handlers.js";
import { ensureModelRegistry } from "./actions/registry.js";
import {
  ensureGlobalDirs,
  LOCAL_SESSION_NAME,
  sessionAuditPath,
  sessionSockPath,
  skillsDir,
} from "./session/global_config.js";
import { acquireCwdLock, type AcquiredLock } from "./session/cwd_lock.js";
import {
  installService,
  uninstallService,
  linkCliBinaries,
  unlinkCliBinaries,
} from "./daemon/install.js";
import {
  defaultAgentName,
  effectiveAutoStartRelay,
  effectiveAllowRemoteLaunch,
  loadLocalConfig,
  localConfigExists,
  saveLocalConfig,
} from "./session/local_config.js";
import { runSetupWizard, type WizardUI } from "./session/setup_wizard.js";
import { updateFooter, type FooterState } from "./ui/footer.js";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import {
  resolveRelayUrl,
  loadConfig,
  saveConfig,
  isValidRelayUrl,
  isWebSocketScheme,
  toWebSocketUrl,
} from "./config.js";
import { _expandTilde, _launchSession } from "./launch.js";
import { _enrichToolArgs } from "./enrich_tool_args.js";
import {
  IMAGE_PREVIEW_MIME,
  _imageCacheRootDir,
  _imageExtension,
  _safeFilenameToken,
  _safePreviewPath,
  _cleanupPreviewFile,
  _renderablePngPathFromImage,
  _decodeImagePayload,
} from "./image_codec.js";
import {
  _findKnownPeer,
  _inspectPeerRecord,
  _runtimeOwnerFingerprint,
  type InspectedPeerRecord,
} from "./pairing/peer_trust.js";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";

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

/** Relay connectivity as seen by an RPC client (Cockpit). Derived from
 *  `_state` + `_relay`: "disconnected" = relay off (idle); "connected" = live
 *  WS; "reconnecting" = was on, WS dropped, retrying. Surfaced via the
 *  `un-bien:relay-state` custom message (see `_emitRelayState`). */
export type RelayConnectivity = "connected" | "reconnecting" | "disconnected";

/** Last `RelayConnectivity` emitted, for change-dedup. Starts "disconnected"
 *  (the process boots with the relay down). */
let _lastRelayStatus: RelayConnectivity | null = null;

/** Sentinel prefix for a transparent control message an RPC client sends on the
 *  `prompt` channel (stdin). The `input` hook intercepts it, runs the action,
 *  and swallows it (`action:"handled"`) so it never becomes an LLM turn or a
 *  transcript entry. Starts with NUL so it can't collide with real user input
 *  and doesn't begin with "/" (which would route to the command parser). */
export const CTRL_PREFIX = "\x00un-bien-ctrl:";
let _relayUrl: string | null = null; // URL used by current _relay connection
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
const _activePeers = new Map<string, PlainPeerChannel>();
let _peerShort = ""; // shortid of the most recently attached peer (UX hint only)

const UNBIEN_RECEIVED_IMAGE_TYPE = "un-bien:received-image";

type ReceivedImageDetails = {
  messageId: string;
  index: number;
  mime: string;
  size?: number;
  path?: string;
  previewPath?: string;
  text?: string;
  error?: string;
  reason?: string;
};

type ReceivedImagePreviewDelivery = "immediate" | "defer";
const _pendingReceivedImagePreviews: ReceivedImageDetails[] = [];

let _myRoomId: string | null = null; // this Pi's room id (derived from the session id)

/** THE App<->Pi room id for the current chat session. Prefers the STABLE pi
 *  session id (durable across resume) so the room can't drift when the assigned
 *  name changes on reconnect; falls back to the legacy (cwd, name) derivation
 *  only when no session id is available yet (pre-sessionManager edge). */
function _deriveRoomId(cwd: string, name: string): string {
  const sid = _rootState().sessionManager?.getSessionId();
  return sid ? roomIdForSession(sid) : roomIdFor(cwd, name);
}

// Plan/28 Wave D.1: `thinking` published alongside `model` so the app's
// Quick Actions sheet hydrates the thinking segmented control on first
// open instead of starting null. The SDK fires `thinking_level_select`
// on every change (initial load + user toggle), mirrored to room_meta
// the same way model is — apps subscribe to one channel for both.
let _myRoomMeta: {
  name: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  working?: boolean;
  sessionId?: string;
} | null = null;
let _currentModel: string | undefined; // last-known model name
let _currentThinking: ThinkingLevel | undefined; // last-known thinking level

// ── Agent-network session (plano 19) ──────────────────────────────────────────
// MeshNode owns both the local UDS mesh (SessionPeer) and the optional
// cross-PC relay bridge (BrokerRemote + PiForwardClient). The bridge is
// attached via `_meshNode.attachBridge()` once the relay WS is up and this
// Pi is the leader; MeshNode re-attaches it across UDS failovers.
let _meshNode: MeshNode | null = null;
let _sessionName: string | null = null;
let _sessionPeerCount = 0;
// Invalidates an in-flight MeshNode.connect() before it can publish globally.
let _meshJoinGeneration = 0;
// Set true by `session_shutdown`. Connecting is async, so shutdown can land
// while `_cmdRoot` has not published either candidate yet. `_disposed` blocks
// the outgoing continuation until a same-module `session_start` rearms it;
// relay/mesh generations below permanently distinguish the old candidates from
// that replacement lifecycle even after `_disposed` becomes false again.
let _disposed = false;
// True once the auto-init has run on the first session_start for this
// process. Prevents re-running on session replacements (those re-init via
// the _disposed re-arm path above). The session_start handler below auto-starts
// un-bien for ANY session whose local config has auto_start_relay (default
// true) — interactive AND daemon — instead of only UNBIEN_DAEMON=1.
let _autoInited = false;

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
    .catch(() => {
      /* keep prior cached value */
    });
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
      const peers = (reply.body as { peers?: string[] } | null)?.peers;
      if (Array.isArray(peers)) {
        _sessionPeerCount = peers.length;
        _refreshFooter(ctx);
      }
    })
    .catch(() => {
      /* older broker without list_peers — keep prior count */
    });
}

/** Friendly model name for room_meta (plano 18). undefined when SDK has none yet. */
function _currentModelName(): string | undefined {
  return _currentModel;
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
  _currentModel = name;
  if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, model: name };
  if (_relay && _myRoomId) {
    _relay.sendControl({
      type: "room_meta_update",
      room_id: _myRoomId,
      meta: { model: name },
    });
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
  if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, working };
  if (_relay && _myRoomId) {
    _relay.sendControl({
      type: "room_meta_update",
      room_id: _myRoomId,
      meta: { working },
    });
  }
}

function _sendReceivedImagePreviewNow(details: ReceivedImageDetails): void {
  if (!_pi) return;
  try {
    _pi.sendMessage<ReceivedImageDetails>({
      customType: UNBIEN_RECEIVED_IMAGE_TYPE,
      content: "",
      display: true,
      details,
    });
  } catch {
    // TUI preview is best-effort; skip on failure.
  }
}

function _shouldDeferReceivedImagePreview(): boolean {
  return _rootState().turnId !== null || _myRoomMeta?.working === true;
}

function _sendReceivedImagePreview(
  details: ReceivedImageDetails,
  delivery: ReceivedImagePreviewDelivery = "immediate",
): void {
  if (delivery === "defer" || _shouldDeferReceivedImagePreview()) {
    _pendingReceivedImagePreviews.push(details);
    return;
  }
  _sendReceivedImagePreviewNow(details);
}

function _flushPendingReceivedImagePreviews(): void {
  if (_pendingReceivedImagePreviews.length === 0) return;
  const pending = _pendingReceivedImagePreviews.splice(0);
  for (const details of pending) _sendReceivedImagePreviewNow(details);
}

async function _collectReceivedImagePreviews(
  msg: ClientUserMessage,
): Promise<ReceivedImageDetails[]> {
  if (!msg.images || msg.images.length === 0) return [];

  const previews: ReceivedImageDetails[] = [];
  const text = typeof msg.text === "string" ? msg.text : "";
  const dir = _imageCacheRootDir();

  for (let i = 0; i < msg.images.length; i += 1) {
    const image = msg.images[i];
    const mime = typeof image?.mime === "string" ? image.mime : "unknown";

    if (!image || typeof image.data !== "string") {
      console.error(
        `[un-bien] malformed image in message ${msg.id} index=${i}`,
      );
      previews.push({
        messageId: msg.id,
        index: i,
        mime,
        ...(text ? { text } : {}),
        error: "malformed image payload",
        reason: "missing mime/data payload fields",
      });
      continue;
    }

    const decoded = _decodeImagePayload(image.data, image.mime);
    if (!decoded.ok) {
      console.error(
        `[un-bien] skipped image id=${msg.id} index=${i}: ${decoded.reason}`,
      );
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        error: "invalid image payload",
        reason: decoded.reason,
      });
      continue;
    }

    const ext = _imageExtension(image.mime);
    if (!ext) {
      console.error(
        `[un-bien] unsupported image mime in message ${msg.id} index=${i}: ${image.mime}`,
      );
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        error: "invalid image payload",
        reason: `unsupported mime: ${image.mime}`,
      });
      continue;
    }

    const filename = `${_safeFilenameToken(msg.id)}-${i}.${ext}`;
    const path = join(dir, filename);

    try {
      writeFileSync(path, decoded.decoded, { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best-effort permission hardening */
      }

      const previewPath =
        image.mime === IMAGE_PREVIEW_MIME
          ? undefined
          : await _renderablePngPathFromImage(
              image.data,
              image.mime,
              _safePreviewPath(dir, msg.id, i),
            );

      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        size: decoded.size,
        path,
        ...(previewPath ? { previewPath } : {}),
        ...(text ? { text } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[un-bien] failed saving image id=${msg.id} index=${i}: ${detail}`,
      );
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        path,
        error: "failed to save image",
        reason: detail,
      });
    }
  }

  return previews;
}

async function _emitReceivedImagePreviews(
  msg: ClientUserMessage,
  delivery: ReceivedImagePreviewDelivery = "immediate",
): Promise<void> {
  const previews = await _collectReceivedImagePreviews(msg);
  for (const preview of previews) _sendReceivedImagePreview(preview, delivery);
}

function _registerReceivedImageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ReceivedImageDetails>(
    UNBIEN_RECEIVED_IMAGE_TYPE,
    (message, _options, theme) => {
      const details = (message.details ?? {}) as Partial<ReceivedImageDetails>;
      const path = typeof details.path === "string" ? details.path : "";
      const previewPath =
        typeof details.previewPath === "string" ? details.previewPath : "";
      const mime =
        typeof details.mime === "string"
          ? details.mime
          : "application/octet-stream";
      const inlineImagePath =
        previewPath.length > 0
          ? previewPath
          : mime === IMAGE_PREVIEW_MIME
            ? path
            : "";
      const size = typeof details.size === "number" ? details.size : undefined;
      const index =
        typeof details.index === "number" ? details.index : undefined;
      const text = typeof details.text === "string" ? details.text.trim() : "";
      const messageId =
        typeof details.messageId === "string" ? details.messageId : "unknown";
      const error =
        typeof details.error === "string" ? details.error : undefined;
      const reason =
        typeof details.reason === "string" ? details.reason : undefined;

      const label = `📷 Photo from Android (${messageId}${index === undefined ? "" : ` #${index}`})`;
      const lines = [
        theme.fg("customMessageLabel", label),
        theme.fg("customMessageText", `Saved: ${path || "(not saved)"}`),
      ];
      if (size !== undefined)
        lines.push(theme.fg("customMessageText", `Size: ${size} bytes`));
      if (mime) lines.push(theme.fg("customMessageText", `MIME: ${mime}`));
      if (error) lines.push(theme.fg("customMessageText", `Error: ${error}`));
      if (reason)
        lines.push(theme.fg("customMessageText", `Reason: ${reason}`));
      if (text) lines.push(theme.fg("customMessageText", `Text: ${text}`));

      const container = new Container();
      const metadata = new Box(1, 1, (line) =>
        theme.bg("customMessageBg", line),
      );
      metadata.addChild(new Text(lines.join("\n")));
      container.addChild(metadata);

      if (inlineImagePath && !error) {
        try {
          const imageData = readFileSync(inlineImagePath).toString("base64");
          if (imageData.length > 0) {
            const image = new Image(imageData, IMAGE_PREVIEW_MIME, {
              fallbackColor: (str) => theme.fg("customMessageText", str),
            });
            // Keep Kitty image rows out of Box padding/background so pi-tui can
            // preserve the empty reserved rows that make inline images visible.
            container.addChild(image);
          }
        } catch {
          // Keep the metadata-only fallback on any IO/terminal issue.
        }
      }

      return container;
    },
  );
}

function _isReceivedImageContextMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: unknown }).role === "custom" &&
    (message as { customType?: unknown }).customType ===
      UNBIEN_RECEIVED_IMAGE_TYPE
  );
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
  if (typeof message !== "object" || message === null) return false;
  const m = message as {
    role?: unknown;
    customType?: unknown;
    display?: unknown;
  };
  return (
    m.role === "custom" &&
    typeof m.customType === "string" &&
    m.customType.startsWith("un-bien:") &&
    m.display === false
  );
}

function _filterInternalMessagesFromContext<T>(messages: T[] | undefined): T[] {
  return Array.isArray(messages)
    ? messages.filter(
        (message) =>
          !_isReceivedImageContextMessage(message) &&
          !_isPureDataContextMessage(message),
      )
    : [];
}

function _contentFromUserMessage(
  msg: ClientUserMessage,
): Parameters<ExtensionAPI["sendUserMessage"]>[0] {
  return msg.images && msg.images.length > 0
    ? [
        ...msg.images.map((img) => ({
          type: "image" as const,
          data: img.data,
          mimeType: img.mime,
        })),
        { type: "text" as const, text: msg.text },
      ]
    : msg.text;
}

async function _deliverImageUserMessage(
  sender: PlainPeerChannel,
  msg: ClientUserMessage,
  shouldSteer: boolean,
): Promise<void> {
  const previewDelivery: ReceivedImagePreviewDelivery =
    shouldSteer || _rootState().turnId !== null || _myRoomMeta?.working === true
      ? "defer"
      : "immediate";
  const emitPreview = async () => {
    try {
      await _emitReceivedImagePreviews(msg, previewDelivery);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[un-bien] failed emitting image preview id=${msg.id}: ${detail}`,
      );
    }
  };
  if (previewDelivery === "immediate") {
    await emitPreview();
  } else {
    void emitPreview().finally(() => {
      if (!_shouldDeferReceivedImagePreview())
        _flushPendingReceivedImagePreviews();
    });
  }

  const previousTurnId = _rootState().turnId;
  const seededTurnId = !shouldSteer || _rootState().turnId === null;
  if (seededTurnId) _rootState().turnId = msg.id;

  const wake = _wakeAgent(
    _contentFromUserMessage(msg),
    `app user_message id=${msg.id} (+${msg.images?.length ?? 0} image)`,
    "steer",
  );
  if (!wake.ok) {
    if (seededTurnId) _rootState().turnId = previousTurnId;
    sender.send({
      type: "error",
      code: "internal_error",
      in_reply_to: msg.id,
      message: `Agent rejected incoming message: ${wake.detail}`,
    });
    return;
  }
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
  if (!_meshNode || !_relay || !_relayUrl || !_cachedEd25519) return;
  // A newly-created SelfRevoke producer must publish its own initial verified
  // or fallback snapshot before any retained topology is allowed to attach.
  if (_selfRevoke !== null) {
    if (
      _selfRevokeTopologyReadyEpoch !== _selfRevokeEpoch ||
      _selfRevokeTopology === null
    ) {
      return;
    }
    if (!_meshNode.hasTopology()) _meshNode.setTopology(_selfRevokeTopology);
  }
  void _meshNode
    .attachBridge({
      relay: _relay,
      relayUrl: _relayUrl,
      keypair: _cachedEd25519,
    })
    .catch(() => {
      /* best-effort — UDS mesh works regardless */
    });
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
  return preferred ?? _lastEventCtx ?? _lastCtx ?? null;
}

/**
 * Read `ctx.ui` without letting a stale-ctx getter become an uncaughtException.
 * Optional chaining does NOT protect against a throwing getter.
 */
function _ctxUi(preferred?: { ui?: unknown } | null): {
  setStatus?: (k: string, v: string | undefined) => void;
  setTitle?: (t: string) => void;
  notify?: (message: string, level?: string) => void;
} | null {
  const target = _liveCtx(preferred);
  if (!target) return null;
  try {
    return (
      (target.ui as
        | {
            setStatus?: (k: string, v: string | undefined) => void;
            setTitle?: (t: string) => void;
            notify?: (message: string, level?: string) => void;
          }
        | null
        | undefined) ?? null
    );
  } catch {
    // Stale after newSession/fork/switchSession/reload — caller no-ops.
    return null;
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
    const ui = _ctxUi(preferred);
    if (ui && typeof ui.notify === "function") ui.notify(message, level);
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
    setStatus?: (k: string, v: string | undefined) => void;
    setTitle?: (t: string) => void;
  } | null;
  try {
    ui = _ctxUi(ctx);
  } catch {
    return;
  }
  if (
    !ui ||
    typeof ui.setStatus !== "function" ||
    typeof ui.setTitle !== "function"
  )
    return;
  try {
    const state: FooterState = {
      session: _sessionName ?? undefined,
      peerCount: _sessionPeerCount,
      relayOn: _state !== "idle",
      // `devicePaired` now reflects "any owner currently attached" — picks one
      // shortid representatively (multi-owner UX detail surfaces in the
      // `/unbien status` line, not the footer slot).
      devicePaired: _anyPeerActive() ? _peerShort : undefined,
      hasPairings: _hasGlobalPairings,
      agentName: _meshNode?.name(),
    };
    updateFooter(
      {
        ui: {
          setStatus: ui.setStatus.bind(ui),
          setTitle: ui.setTitle.bind(ui),
        },
      },
      state,
    );
  } catch {
    // setStatus/setTitle can also throw if the runner went stale mid-call.
  }
}

// Epoch ms when the state machine entered 'started' (last /unbien start).
// Used by session_sync to let the app detect Pi restarts (and force a full
// replay). Cleared on _goIdle.
let _sessionStartedAt: number | null = null;

// _sessionManager lives PER-SESSION in _stateFor(sid); the root session's record
// backs reconstruction — the app reads the transcript via the native get_entries
// rpc over _rootState().sessionManager.getEntries() (captured from event ctx;
// survives extension restarts via the persisted session log).

type MeshEnvelope = {
  id: string;
  from: string;
  re: string | null;
  body: unknown;
};
let _pendingMeshMessages: MeshEnvelope[] = [];
// agent-run active/generation now live PER-SESSION in _stateFor(sid).agentRun;
// mesh delivery targets the ROOT run, so the drain reads _rootState().agentRun.
let _meshDrainScheduled = false;

/** Test-only override of the message buffer. */
/**
 * Test-only: emulate what `/unbien` does on the returning-user path
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

/** Test-only: tear everything down (mirrors `/unbien stop`). */
export async function _stopForTest(ctx: unknown): Promise<void> {
  await _cmdStop(ctx as Parameters<typeof _cmdStop>[0]);
}

/** Test-only: read/reset the `_disposed` flag. Production clears it only when
 *  a host reuses this module for a replacement session; tests share one module
 *  across cases, so they also reset it to avoid cross-test pollution. */
export function _getDisposedForTest(): boolean {
  return _disposed;
}
export function _setDisposedForTest(v: boolean): void {
  _disposed = v;
}

/** Test-only: reset the once-per-session auto-init gate so session_start re-runs it. */
export function _resetAutoInitedForTest(): void {
  _autoInited = false;
}

/** Test-only: clear the globalThis panel/ui bridge ownership so each fresh
 *  `extension(pi)` in a shared test process can (re)claim and rebuild bridges. */
export function _resetBridgeOwnersForTest(): void {
  const g = globalThis as typeof globalThis & {
    [_ROOT_SESSION_OWNER_KEY]?: ExtensionAPI;
  };
  delete g[_ROOT_SESSION_OWNER_KEY];
  _panelBridge?.dispose();
  _panelBridge = null;
  _rpcEnvelope?.dispose();
  _rpcEnvelope = null;
  _subagentRooms?.dispose();
  _subagentRooms = null;
  _extensionUiBridge?.dispose();
  _extensionUiBridge = null;
}

/** Test-only: reset the keyed per-session state at a TEST BOUNDARY (beforeEach).
 *  Must NOT be folded into _resetBridgeOwnersForTest — that fires mid-test on
 *  every captureEventHandler call and would wipe state a test seeds across two
 *  captures (e.g. input seeds turnId, message_update reads it). */
export function _resetSessionsForTest(): void {
  _sessions.clear();
  _rootSessionId = null;
}

/** Test-only: set the auto-init gate for lifecycle replacement tests. */
export function _setAutoInitedForTest(value: boolean): void {
  _autoInited = value;
}

/** Test-only: true when this instance holds a live local-mesh node. */
export function _hasMeshNodeForTest(): boolean {
  return _meshNode !== null;
}

/** Test-only: drive the current real SelfRevoke producer through one sweep. */
export async function _checkSelfRevokeForTest(): Promise<void> {
  await _selfRevoke?.checkOnce();
}

/** Test-only: the effective (possibly `#N`-suffixed) name the cwd-lock reserved. */
export function _getLockedNameForTest(): string | null {
  return _lockedName;
}

/** Test-only: release + clear the cwd lock (the lock normally survives stop). */
export function _resetCwdLockForTest(): void {
  try {
    _cwdLock?.release();
  } catch {
    /* ignored */
  }
  _cwdLock = null;
  _lockedName = null;
}

/**
 * Test-only: relay-only startup, no UDS mesh join. Replaces the old
 * `unbien relay start` handler that some tests captured to bring up
 * the relay in isolation (e.g. ping/pong tests that don't care about the
 * agent-network broker).
 */
export async function _startRelayForTest(ctx: unknown): Promise<void> {
  await _cmdStart(ctx as Parameters<typeof _cmdStart>[0]);
}

/** Test-only: public marker for canceled-keypair cache regression checks. */
export function _getCachedPublicKeyForTest(): string | null {
  return _cachedEd25519
    ? Buffer.from(_cachedEd25519.publicKey).toString("base64")
    : null;
}

/** Test-only override of session started timestamp. */
export function _setSessionStartedAtForTest(ts: number | null): void {
  _sessionStartedAt = ts;
}

/** Test-only: reset the cached model name (between tests). */
export function _setCurrentModelForTest(name: string | undefined): void {
  _currentModel = name;
}

/** Test-only: read the active turn id used for plain `cancel` routing. */
export function _getCurrentTurnIdForTest(): string | null {
  return _rootState().turnId;
}

/** Test-only: override the bound AgentSession so a spy can capture the
 *  content handed to `sendUserMessage` (plan/30 multimodal ingest). */
export function _setPiForTest(pi: unknown): void {
  _pi = pi as typeof _pi;
}

/**
 * Persist a model change to the PROJECT settings (`<cwd>/.pi/settings.json`) so
 * a model picked from the app survives a Pi/daemon restart. `pi.setModel` only
 * sets the LIVE model — on the next restart a fresh session reads the saved
 * default and reverts (the reported bug). We write the PROJECT scope, NOT
 * global, deliberately: the SDK merges global←project with PROJECT winning
 * (`SettingsManager`), so a folder that already has a project default (every
 * created daemon does) would shadow a global write like the TUI's. Project
 * scope is also correct for a fleet — each daemon keeps its own model rather
 * than leaking one default globally.
 *
 * Read-merge-write + best-effort: preserves other keys and never throws (a
 * settings write must not fail the live model change, which already applied).
 */
function _persistModelDefault(provider: string, modelId: string): void {
  try {
    const path = join(process.cwd(), ".pi", "settings.json");
    let obj: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object")
        obj = parsed as Record<string, unknown>;
    } catch {
      /* no existing/parseable file → start fresh */
    }
    obj["defaultProvider"] = provider;
    obj["defaultModel"] = modelId;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj, null, 2));
  } catch {
    /* best-effort — model change already applied live */
  }
}

type ClientUserMessage = Extract<ClientMessage, { type: "user_message" }>;

// ── Per-session state, keyed by pi sessionId ──────────────────────────────
// The extension re-activates IN-PROCESS for every subagent — each is its own pi
// AgentSession with its OWN sessionId. Turn/agent/buffer state is therefore
// PER-SESSION: every event handler records into its FIRING session's record
// (sid = ctx.sessionManager.getSessionId()); app-facing reads use the ROOT
// session's record. Subagent records accumulate (held for later surfacing);
// a root-only broadcast gate keeps app display identical for now. This mirrors
// pi's own per-AgentSession model rather than a flat extension-authored projection.
interface SessionState {
  turnId: string | null;
  working: boolean;
  agentRun: { active: boolean; generation: number };
  sessionManager: ExtensionContext["sessionManager"] | null;
  model: string | null;
  thinking: ThinkingLevel | null;
}
const _sessions = new Map<string, SessionState>();
// The session bound to the app room. null until the ROOT session_start fires;
// while null, everything is treated as root (single-session / test harness).
let _rootSessionId: string | null = null;
// Stable key for the root record even before _rootSessionId is known.
function _rootKey(): string {
  return _rootSessionId ?? "__root__";
}
function _stateFor(sid: string): SessionState {
  let st = _sessions.get(sid);
  if (!st) {
    st = {
      turnId: null,
      working: false,
      agentRun: { active: false, generation: 0 },
      sessionManager: null,
      model: null,
      thinking: null,
    };
    _sessions.set(sid, st);
  }
  return st;
}
/** The root session's record (always defined; lazily created). */
function _rootState(): SessionState {
  return _stateFor(_rootKey());
}
/** sessionId of the firing handler's ctx, defaulting to the root key. */
function _sidOf(
  ctx: { sessionManager?: { getSessionId(): string } } | undefined,
): string {
  return ctx?.sessionManager?.getSessionId() ?? _rootKey();
}
/** True only when the firing session is NOT the app-room root (subagent). */
function _isNonRootSid(sid: string): boolean {
  return _rootSessionId !== null && sid !== _rootSessionId;
}

// Module-level pi reference
let _pi: ExtensionAPI | null = null;

// Minimal structural views of pi SDK internals the extension reaches for but the
// public ExtensionAPI type does not surface. Each names exactly the member(s)
// known to exist on the concrete AgentSession at runtime.
interface PiEventBusInternals {
  events?: { emit(channel: string, data: unknown): void };
}
interface PiStreamingInternals {
  isStreaming?: boolean;
}
interface PiQueueControl {
  clearQueue(): { steering: string[]; followUp: string[] };
}

// Plan/57 — Bridge to pi-ask's clarification-flow events. null until the
// extension factory wires it (and null if the SDK exposes no events bus).
let _extensionUiBridge: ExtensionUiBridge | null = null;
// Mirror the in-process plan + subagents buses to the app as `panel_update`
// frames. null until the factory wires it (and null if the SDK has no events
// bus). Inert when no plan/subagents source is emitting.
let _panelBridge: PanelBridge | null = null;
// rpc-envelope producer (docs/rpc-on-event-map.md): reconstructs pi's --mode rpc
// event plane from pi.on() and fans {rpc} frames to attached peers. THE route
// (always on, advertised as the `rpc_envelope` capability); runs alongside the
// stock ServerMessage path only until M4 parity retirement.
let _rpcEnvelope: { dispose(): void } | null = null;

// Per-child subagent relay rooms — each subagent surfaced to the app as its own
// session, opt-in via the `subagents.rooms` un-bien setting (a no-op controller
// otherwise). Owned by the ROOT session; a child session_start calls
// onChildSession on this same instance.
let _subagentRooms: SubagentRoomsController | null = null;

let _stopAutoListener: (() => void) | null = null;

// Cached keypair (loaded once, reused across start/pair cycles)
let _cachedEd25519: Ed25519Keypair | null = null;

// Mesh-membership poller (plan/24 Wave 3). Lives across the relay
// connection lifecycle: started in _cmdStart after the WS is up, stopped
// in _goIdle when the relay is torn down.
let _selfRevoke: SelfRevoke | null = null;
let _selfRevokeEpoch = 0;
let _selfRevokeTopologyReadyEpoch = -1;
let _selfRevokeTopology: MeshTopologySnapshot | null = null;

// Per-cwd lock acquired by the first `/unbien` invocation in this
// process. Holds the UDS socket open until the process exits (OS auto-
// releases on crash too). Stays held across `/unbien stop` cycles —
// only released when the Node process itself dies.
let _cwdLock: AcquiredLock | null = null;
// Effective mesh name this instance locked. Equals the configured/derived name,
// OR a `#N`-suffixed variant when another agent already holds that (cwd, name)
// in this folder (same-name agents coexist instead of being refused). `_cmdJoin`
// registers under this name; the broker confirms it (and may bump it again under
// a live race). Null until the lock is acquired.
let _lockedName: string | null = null;

// ── Relay reconnect state ─────────────────────────────────────────────────────
// Backoffs in ms: 1s, 2s, 5s, 10s, 30s, then stays at 30s.
const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempt = 0;
// Every initial connect/reconnect candidate captures this generation. Stop,
// relay-off, and an unexpected close invalidate older async continuations.
let _relayLifecycleGeneration = 0;
// Root startup has pre-candidate awaits (cwd lock, wizard) that relay/mesh
// generations cannot safely represent: child startup intentionally advances
// those generations. Stop/off/session replacement advance this separate epoch
// so a queued root can never regain authority by creating a newer child.
let _rootLifecycleGeneration = 0;
// Coalesces concurrent `/unbien` startup paths inside ONE extension instance.
// Separate Pi processes still keep the existing #N behavior via the cwd lock.
let _cmdRootInFlight: Promise<void> | null = null;

type RootRestartAuthority = Readonly<{
  rootLifecycleGeneration: number;
}>;

function _isCurrentRootLifecycle(generation: number): boolean {
  return !_disposed && generation === _rootLifecycleGeneration;
}

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

/** Returns true when at least one owner is attached. Derived `paired` UX. */
function _anyPeerActive(): boolean {
  return _activePeers.size > 0;
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
).toString("base64");

function _emitTestBus(channel: string, data: unknown): void {
  try {
    (_pi as PiEventBusInternals | null)?.events?.emit(channel, data);
  } catch {
    /* bus absent — best effort */
  }
}

/** Run one canned UI-test scenario. Returns a short status for the notify. */
function _runTestScenario(scenario: string): string {
  const s = (scenario.trim().split(/\s+/)[0] || "help").toLowerCase();
  const id = `test-${Date.now()}`;
  switch (s) {
    case "ask-select":
      _broadcastEnvelope({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "select",
          title: "Pick one (test)",
          options: ["Alpha", "Beta", "Gamma"],
        },
      });
      return "sent ask-select";
    case "ask-confirm":
      _broadcastEnvelope({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "confirm",
          title: "Confirm (test)",
          message: "Proceed with the test action?",
        },
      });
      return "sent ask-confirm";
    case "ask-input":
      _broadcastEnvelope({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "input",
          title: "Input (test)",
          placeholder: "Type something…",
        },
      });
      return "sent ask-input";
    case "ask-editor":
      _broadcastEnvelope({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "editor",
          title: "Editor (test)",
          prefill: "edit me",
        },
      });
      return "sent ask-editor";
    case "ask-notify":
      _broadcastEnvelope({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "notify",
          message: "This is a test notice.",
          notify_type: "info",
        },
      });
      return "sent ask-notify";
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
      });
      return "emitted pi-ask:started (rich)";
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
      });
      return "emitted plan:snapshot";
    case "subagents":
      _emitTestBus("subagents:created", {
        id: "sa1",
        type: "explore",
        description: "Explore the codebase",
      });
      _emitTestBus("subagents:started", { id: "sa1" });
      _emitTestBus("subagents:created", {
        id: "sa2",
        type: "plan",
        description: "Draft an implementation plan",
      });
      _emitTestBus("subagents:completed", { id: "sa2" });
      return "emitted subagents lifecycle";
    case "svg": {
      // A TOOL card renders standalone; the app pulls tool-emitted images from
      // INSIDE the tool_execution_end `result` (imagesFromToolResult unwraps
      // `{content:[{type:"image",data,mimeType}]}`) and renders them below the
      // card (WireImageView -> SVGImageView). Deliver the SVG that way.
      const tc = `tc-svg-${Date.now()}`;
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "render_svg",
          args: { note: "test svg" },
        },
      });
      _broadcastEnvelope({
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
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent svg (envelope tool_execution_end + image)";
    }
    case "tool": {
      const tc = `tc-${Date.now()}`;
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "echo hello" },
        },
      });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "hello\n",
          isError: false,
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent tool pair (envelope)";
    }
    case "diff": {
      // Exercise the rich diff rendering: aux `{hunks}` (input Edit diff) rides
      // ALONGSIDE the raw edit `tool_execution_start`. OUTPUT is classified
      // app-side from the result, so no aux.output rides the end frame.
      const tc = `tc-diff-${Date.now()}`;
      const hunks = [
        {
          lines: [
            { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
            { kind: "remove", oldLine: 2, text: "const b = 2;" },
            { kind: "add", newLine: 2, text: "const b = 3;" },
            { kind: "context", oldLine: 3, newLine: 3, text: "const c = 4;" },
          ],
        },
      ];
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
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
      });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "edited demo.ts",
          isError: false,
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent diff (edit + aux hunks — shows the Diff⇄Content toggle)";
    }
    case "code-shell": {
      // bash-family result → the app classifies it into a `code` block (lang
      // shell), syntax-highlighted. OUTPUT is app-side now — no aux stamped.
      const tc = `tc-sh-${Date.now()}`;
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "ls -la" },
        },
      });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            "total 24\ndrwxr-xr-x  5 geo staff  160 Aug 29 10:00 .\n-rw-r--r--  1 geo staff 1024 index.ts\n-rw-r--r--  1 geo staff  512 README.md",
          isError: false,
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent code-shell (bash output → code block, lang shell)";
    }
    case "code-file": {
      // read-family with a *.swift path → `code` block, lang inferred from the
      // extension (swift) and highlighted.
      const tc = `tc-rd-${Date.now()}`;
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "read",
          args: { path: "/src/Greeter.swift" },
        },
      });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            'struct Greeter {\n    let name: String\n    func greet() -> String {\n        return "Hello, \\(name)!"\n    }\n}',
          isError: false,
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent code-file (read .swift → highlighted code block)";
    }
    case "diff-output": {
      // A tool whose RESULT already embeds a unified diff → the app parses it
      // into a `diff` block (re-reading persisted text; replay-safe).
      const tc = `tc-do-${Date.now()}`;
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "git diff" },
        },
      });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n const port = 3000;\n-const host = "127.0.0.1";\n+const host = "0.0.0.0";\n start(host, port);',
          isError: false,
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent diff-output (result embeds a unified diff → diff block)";
    }
    case "write": {
      // write carries the new file text in args.content; no live diff → the
      // card shows the Content view (new text as a code block, replay-safe).
      const tc = `tc-wr-${Date.now()}`;
      const content =
        "export function add(a: number, b: number): number {\n  return a + b;\n}";
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "write",
          args: { path: "/src/math.ts", content },
        },
      });
      _broadcastEnvelope({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "wrote /src/math.ts",
          isError: false,
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent write (args.content → content-as-code block)";
    }
    case "agent": {
      _broadcastEnvelope({ rpc: { type: "turn_start" } });
      _broadcastEnvelope({
        rpc: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "This is a ",
          },
        },
      });
      _broadcastEnvelope({
        rpc: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "test agent message.",
          },
        },
      });
      _broadcastEnvelope({
        rpc: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "This is a test agent message." }],
          },
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent agent message (envelope)";
    }
    case "error":
      _broadcastEnvelope({
        rpc: {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "This is a test error.",
          },
        },
      });
      _broadcastEnvelope({ rpc: { type: "agent_settled" } });
      return "sent error (envelope message_end/error)";
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
        _runTestScenario(sc);
      return "sent all (ask-notify, plan, subagents, svg, tool, diff, code-shell, code-file, diff-output, write, agent, error)";
    default:
      return "usage: /unbien test <ask-select|ask-confirm|ask-input|ask-editor|ask-notify|ask-rich|plan|subagents|svg|tool|diff|code-shell|code-file|diff-output|write|agent|error|all>";
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
  const frame = env.rpc;
  if (!frame || typeof frame !== "object") return; // no {evt} inbound today
  envLog(`rpc inbound: ${String((frame as Record<string, unknown>).type)}`);
  // extension_ui_response is a reply to an extension-issued dialog, not a command —
  // route it straight to the ui bridge (same target as the stock path).
  if ((frame as Record<string, unknown>).type === "extension_ui_response") {
    // SAFETY: the type-discriminator check directly above proves this frame is
    // an extension_ui_response envelope, which is the ExtensionUiResponseWire shape.
    _extensionUiBridge?.respond(frame as unknown as ExtensionUiResponseWire);
    return;
  }
  // session_sync (reconstruction) is un-bien's OWN protocol — dispatched on the
  // un plane by _routeUnBienPlaneFrom, NOT here. Only byte-faithful pi rpc
  // commands + extension_ui_response ride this rpc dispatch.
  const handlers: RpcCommandHandlers = {
    prompt: async (message, opts) => {
      // Full parity with the retired stock user_message handler:
      //  - ALWAYS hand off with deliverAs:"steer" — the SDK ignores it while idle
      //    but REQUIRES it when a turn is running or still settling right after
      //    agent return; without it the message is rejected as busy.
      //  - `shouldSteer` (echo label + steer tracking) = requested OR inferred
      //    busy-room send.
      //  - seed `_rootState().turnId` for a fresh (non-steer) turn so the agent's
      //    reply chunks/done have a target; restore it if the handoff fails.
      // The APP owns the steer-vs-followUp semantic switch (design 01M14T6J5W):
      // pass its chosen streamingBehavior straight through to pi. The extension does
      // NOT force steer over a followUp anymore. `shouldSteer` below is now only
      // BOOKKEEPING (turn-seeding + image-preview defer), not the delivery verb.
      const requestedSteer = opts.streamingBehavior === "steer";
      // Authoritative busy signal from pi's OWN state (AgentSession.isStreaming),
      // correct across subagent lifecycles (turnId/working stick busy after a
      // subagent run).
      const streaming =
        (_pi as PiStreamingInternals | null)?.isStreaming === true;
      const shouldSteer = requestedSteer || streaming;
      const msg: ClientUserMessage = {
        type: "user_message",
        id: opts.id ?? _rootState().turnId ?? String(Date.now()),
        text: message,
        images: opts.images as ClientUserMessage["images"],
      };
      // Image path mirrors the stock handler (SDK handoff WITH images + echo).
      if (msg.images && msg.images.length > 0) {
        await _deliverImageUserMessage(sender, msg, shouldSteer);
        return;
      }
      const previousTurnId = _rootState().turnId;
      const seededTurnId = !shouldSteer || _rootState().turnId === null;
      if (seededTurnId) _rootState().turnId = msg.id;
      // PASS-THROUGH the app's verb (design 01M14T6J5W). pi's prompt(): idle
      // ignores streamingBehavior (fresh run); streaming+"steer" -> _queueSteer;
      // streaming+"followUp" -> _queueFollowUp; streaming+none -> throws. The
      // `?? (streaming ? "steer" : undefined)` is a MECHANICAL safety net (not
      // semantic inference) so a racing/old client's no-behavior busy send
      // defensively steers instead of throwing (keeps plan/43).
      const wake = _wakeAgent(
        message,
        "app rpc prompt",
        opts.streamingBehavior === "followUp"
          ? "followUp"
          : opts.streamingBehavior === "steer" || streaming
            ? "steer"
            : undefined,
      );
      if (!wake.ok) {
        if (seededTurnId) _rootState().turnId = previousTurnId;
        throw new Error(wake.detail);
      }
    },
    steer: async (message) => {
      const wake = _wakeAgent(message, "app rpc steer", "steer");
      if (!wake.ok) throw new Error(wake.detail);
    },
    followUp: async (message) => {
      const wake = _wakeAgent(message, "app rpc follow_up", "followUp");
      if (!wake.ok) throw new Error(wake.detail);
    },
    abort: async () => {
      if (!_abortCurrentTurn()) throw new Error("no active turn to abort");
    },
    setModel: async (provider, modelId) => {
      if (!_pi) throw new Error("agent session not bound");
      const actionCtx = (_lastEventCtx ?? _lastCtx) as ActionCtx | null;
      const reg = actionCtx?.modelRegistry ?? ensureModelRegistry(actionCtx);
      reg.refresh();
      const model = reg.find(provider, modelId);
      if (!model)
        throw new Error(`model "${provider}/${modelId}" not in registry`);
      // Route via the minimal ActionPi view (matches handleModelSet): the
      // registry's `find` returns the minimal SdkModelLike, structurally fine
      // for setModel at runtime.
      // SAFETY: _pi (checked non-null above) is the concrete AgentSession; its
      // setModel accepts the minimal SdkModelLike the registry's find() returns,
      // matching handleModelSet's ActionPi view.
      const ok = await (_pi as unknown as ActionPi).setModel(model);
      if (!ok) throw new Error("no auth configured for this model");
      _persistModelDefault(model.provider, model.id); // survive restart, mirrors stock model_set
      return wireFromModel(model);
    },
    setThinkingLevel: async (level) => {
      if (!_pi) throw new Error("agent session not bound");
      _pi.setThinkingLevel(level as ThinkingLevel);
    },
    getAvailableModels: async () => {
      const actionCtx = (_lastEventCtx ?? _lastCtx) as ActionCtx | null;
      const reg = actionCtx?.modelRegistry ?? ensureModelRegistry(actionCtx);
      reg.refresh();
      const models = reg.getAvailable().map(wireFromModel);
      const current = actionCtx?.getModel?.();
      return { models, current: current ? wireFromModel(current) : undefined };
    },
    compact: async (customInstructions) => {
      const actionCtx = (_lastEventCtx ?? _lastCtx) as ActionCtx | null;
      if (!actionCtx?.compact)
        throw new Error("compact unavailable (no active session ctx)");
      actionCtx.compact(
        customInstructions ? { customInstructions } : undefined,
      );
      return {};
    },
    newSession: async () => {
      const actionCtx = (_lastEventCtx ?? _lastCtx) as ActionCtx | null;
      if (!actionCtx?.newSession) {
        throw new Error("new_session unavailable (no command ctx)");
      }
      await actionCtx.newSession({ withSession: async () => {} });
      // Restamp the session clock (parity with the retired stock session_new):
      // session_sync_end carries it so the app can detect the pi restart.
      _resetSessionForNew();
      return { cancelled: false };
    },
    clearQueue: async () => {
      if (!_pi) throw new Error("agent session not bound");
      // SAFETY: _pi (checked non-null above) is the concrete AgentSession,
      // which implements clearQueue(); the public ExtensionAPI type omits it.
      return (_pi as unknown as PiQueueControl).clearQueue();
    },
    getEntries: async (since?: string) => {
      // Native pi get_entries, PAGED (design: get_entries backfill paging): the
      // app reconstructs the transcript itself from the raw entry log (each
      // message entry carries an AgentMessage), one budget-bounded page per
      // reply so a long session's multi-MB log never blows a transport cap (the
      // single-frame reply exceeded URLSessionWebSocketTask's 1 MiB default and
      // was silently dropped). Frame shapes stay PI-FAITHFUL — no extra fields;
      // the app loops `since: leafId` until an empty page. The extension does
      // NOT replay these — see the app's SessionState.applyEntries (design
      // 01M15FMQ).
      const sm = _rootState().sessionManager;
      // Unbound → ERROR (pi always has a session here; a silent empty page on
      // the fork side reads as "no history" — make the failure visible).
      if (!sm) throw new Error("get_entries unavailable (no session bound)");
      const all = sm.getEntries();
      // pi-faithful `since` semantics (rpc-mode.js): unknown id → error, not a
      // silent restart from the beginning.
      if (
        typeof since === "string" &&
        all.findIndex((e) => e.id === since) === -1
      )
        throw new Error(`Entry not found: ${since}`);
      return pageEntries(all, since, sm.getLeafId());
    },
  };
  void dispatchRpcCommand(frame as Record<string, unknown>, handlers)
    .then((resp) => {
      // Envelope-native ONLY: no stock fallback. An unhandled rpc type is
      // ignored (forward-compat). un-bien's own commands (session_sync,
      // session_launch) ride the un plane via _routeUnBienPlaneFrom.
      if (resp) sender.sendEnvelope(resp);
    })
    .catch((err) => {
      console.error(`[un-bien] rpc inbound dispatch failed: ${String(err)}`);
    });
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
  const frame = env.ub;
  if (!frame || typeof frame !== "object") return;
  const type = (frame as Record<string, unknown>).type;
  envLog(`ub inbound: ${String(type)}`);

  if (type === "session_sync") {
    const f = frame as Record<string, unknown>;
    // session_sync now carries ONLY un-bien's NON-rpc display state: panels +
    // pending extension_ui. The TRANSCRIPT is the app's OWN native get_entries
    // rpc (reduced by SessionState.applyEntries) — NOT replayed here. Design
    // 01M15FMQ: separate the rpc transcript (get_entries) from un-bien panel/ui
    // state, each an independent app-driven request issued on open + reconnect.
    for (const req of _extensionUiBridge?.pendingRequests() ?? [])
      sender.send(req);
    const panels = _panelBridge?.pendingPanels() ?? [];
    for (const panel of panels)
      sender.sendEnvelope({ evt: { channel: "panel", data: panel } });
    envLog(
      `session_sync(ub): panels=${panels.length} + ui (transcript is the app's get_entries rpc)`,
    );
    // Terminator/ack on the ub plane; carries the session clock so the app can
    // detect a pi restart. `truncated`/`limit` are gone (a replay concern;
    // get_entries is unbounded / since-delta).
    sender.sendEnvelope({
      ub: {
        type: "session_sync_end",
        ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
        session_started_at: _sessionStartedAt ?? 0,
      } as EnvelopeMessage["ub"],
    });
    return;
  }

  if (type === "session_launch") {
    const f = frame as Record<string, unknown>;
    const cwd = _expandTilde(
      typeof f.cwd === "string" && f.cwd.length > 0 ? f.cwd : process.cwd(),
    );
    if (!effectiveAllowRemoteLaunch(loadLocalConfig(cwd))) {
      envLog("session_launch(ub): remote launch disabled on this machine");
      return;
    }
    // Backend is a MACHINE config choice (pick-one via launch.backend), not
    // app-chosen; rpc is a fast-follow so only tmux|herdr resolve here.
    const backend = loadConfig().launch?.backend === "herdr" ? "herdr" : "tmux";
    const launchError = _launchSession(
      backend,
      cwd,
      typeof f.name === "string" ? f.name : undefined,
    );
    if (launchError) envLog(`session_launch(ub) error: ${launchError}`);
    return;
  }
}

/** Broadcast for the extension_ui bridge. The bridge only ever emits
 *  `extension_ui_request`, sent ENVELOPE-ONLY as a `{rpc}` frame (the wire
 *  shape mirrors the SDK rpc contract 1:1). No stock fallback. */
function _uiBroadcast(msg: ServerMessage): void {
  if (msg.type === "extension_ui_request") _broadcastEnvelope({ rpc: msg });
}

/** Broadcast for the panel bridge. The bridge only ever emits `panel_update`,
 *  forwarded ENVELOPE-ONLY as `{evt:{channel:"panel", data}}` (the {evt} plane);
 *  the app folds it into its panel store. No stock fallback. */
function _panelBroadcast(msg: ServerMessage): void {
  if (msg.type === "panel_update")
    _broadcastEnvelope({ evt: { channel: "panel", data: msg } });
}

/** Fan an rpc-envelope frame out to every attached peer (base64 ct via each
 *  channel) — the single owner-fanout path for `{ rpc | evt }` messages. */
function _broadcastEnvelope(env: EnvelopeMessage): void {
  {
    // Observability only (not a route gate): watch the {rpc|evt} wire during
    // e2e bring-up. Frame type only — payloads can be large / carry images.
    const kind = env.rpc
      ? `rpc:${(env.rpc as { type?: string }).type ?? "?"}`
      : `evt:${env.evt?.channel ?? "?"}`;
    envLog(`envelope -> ${_activePeers.size} peer(s): ${kind}`);
  }
  for (const ch of _activePeers.values()) {
    try {
      ch.sendEnvelope(env);
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
  appPeerId: string,
  channel: PlainPeerChannel,
): void {
  _activePeers.set(appPeerId, channel);
  _peerShort = appPeerId.slice(0, 8);
}

/** Detaches a single owner's channel + removes it from the map. Used by
 *  `_onPeerDisconnect`, `_cmdRevoke`, and the SelfRevoke callback. */
function _detachPeerChannel(appPeerId: string): void {
  const ch = _activePeers.get(appPeerId);
  if (!ch) return;
  try {
    ch.detach();
  } catch {
    /* best-effort */
  }
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
  if (_meshNode) return _meshNode.name();
  const local = loadLocalConfig(cwd);
  return local.agent_name || defaultAgentName(cwd);
}

function _reportRevocationByFingerprint(canonicalOwnerPubkey: string): void {
  const fingerprint = _runtimeOwnerFingerprint(canonicalOwnerPubkey);
  _pi?.sendMessage({
    customType: "un-bien:mesh-revoked",
    content:
      `🔒 Revoked by Owner ${fingerprint}…\n\n` +
      `The mobile app for this Owner removed this PC from the mesh. ` +
      `Re-pair via /unbien pair if this was unexpected.`,
    display: true,
  });
}

function _revokeActiveOwnerRuntime(canonicalOwnerPubkey: string): void {
  if (!_activePeers.has(canonicalOwnerPubkey)) return;
  _refreshPairingsCache();
  _detachPeerChannel(canonicalOwnerPubkey);
  _refreshFooter();
  _reportRevocationByFingerprint(canonicalOwnerPubkey);
}

// ── Transition helpers ────────────────────────────────────────────────────────

/**
 * Full teardown: stop listener, detach channel, close relay → idle.
 */
function _goIdle(): void {
  _rootLifecycleGeneration += 1;
  _relayLifecycleGeneration += 1;

  // Cancel any pending reconnect attempt. Critical: /unbien stop must
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
    try {
      ch.detach();
    } catch {
      /* best-effort */
    }
  }
  _activePeers.clear();
  _peerShort = "";
  _rootState().turnId = null;
  _pendingReceivedImagePreviews.length = 0;

  // Invalidate async producers and bridge ownership before closing the host
  // Relay. A synchronous/delayed close callback must observe stale identity.
  const producer = _selfRevoke;
  _selfRevoke = null;
  _selfRevokeEpoch += 1;
  _selfRevokeTopologyReadyEpoch = -1;
  _selfRevokeTopology = null;
  producer?.stop();

  _meshNode?.detachBridge();

  const relay = _relay;
  _relay = null;
  _relayUrl = null;
  relay?.close();

  // Preserve _sessionStartedAt + _messageBuffer across stop/start cycles.
  // The Pi agent session outlives the relay connection — `message_end` keeps
  // firing for terminal turns even while idle, and the buffer must survive
  // so those turns appear in the next session_sync. Only a Pi process
  // restart resets these (init-time values).

  _state = "idle";
  _refreshFooter();
  _emitRelayState(); // → disconnected
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
function _onRelayClose(closedRelay: RelayClient): void {
  if (_relay !== closedRelay) return; // delayed close from a replaced Relay
  if (_state === "idle") return; // already torn down (e.g. /unbien stop)

  _relayLifecycleGeneration += 1;
  _stopAutoListener?.();
  _stopAutoListener = null;

  // Detach every per-owner channel — relay is gone, none can route. The
  // auto-listener re-attaches owners after `_attemptReconnect` succeeds
  // (via the same known-peer + pair_request paths used on first connect).
  for (const ch of _activePeers.values()) {
    try {
      ch.detach();
    } catch {
      /* best-effort */
    }
  }
  _activePeers.clear();
  _peerShort = "";
  _rootState().turnId = null;

  _relay = null; // _relayUrl preserved for retry

  // Cross-PC routing relies on _relay; bring it down. Will be re-instated
  // by _attemptReconnect on success.
  _meshNode?.detachBridge();

  _state = "started";
  _refreshFooter();
  _emitRelayState(); // → reconnecting

  const reconnectUrl = _relayUrl;
  if (reconnectUrl) {
    _scheduleReconnect(_relayLifecycleGeneration, reconnectUrl);
  }
}

function _isCurrentReconnect(
  lifecycleGeneration: number,
  url: string,
): boolean {
  return (
    lifecycleGeneration === _relayLifecycleGeneration &&
    _state === "started" &&
    _relay === null &&
    _relayUrl === url
  );
}

function _scheduleReconnect(lifecycleGeneration: number, url: string): void {
  if (_reconnectTimer !== null) return; // already scheduled
  if (!_cachedEd25519) return; // can't reconnect without the cached identity
  if (!_isCurrentReconnect(lifecycleGeneration, url)) return;

  const idx = Math.min(_reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1);
  const delay = RECONNECT_BACKOFFS_MS[idx]!;
  _reconnectAttempt += 1;

  // The timer belongs to the lifecycle that scheduled it. Re-check that exact
  // generation + URL before constructing a candidate so a dequeued old timer
  // cannot act on a newer stop/start lifecycle.
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (!_isCurrentReconnect(lifecycleGeneration, url)) return;
    void _attemptReconnect(lifecycleGeneration, url);
  }, delay);
}

async function _attemptReconnect(
  lifecycleGeneration: number,
  url: string,
): Promise<void> {
  if (!_cachedEd25519) return;
  if (!_isCurrentReconnect(lifecycleGeneration, url)) return;

  const edKp = _cachedEd25519;
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
    // A reconnect candidate stays local until publication; every rejected
    // candidate is deterministically closed before stale-return or retry.
    try {
      relay.close();
    } catch {
      /* best-effort rejected candidate cleanup */
    }
    if (!_isCurrentReconnect(lifecycleGeneration, url)) return;
    _scheduleReconnect(lifecycleGeneration, url);
    return;
  }

  if (!_isCurrentReconnect(lifecycleGeneration, url)) {
    try {
      relay.close();
    } catch {
      /* best-effort stale candidate cleanup */
    }
    return;
  }

  _relay = relay;
  _reconnectAttempt = 0;

  relay.on("close", () => _onRelayClose(relay));
  _stopAutoListener = _installAutoListener(relay);

  // Plan/25 Wave B/C: relay is back; bring cross-PC routing back online.
  _attachBridgeIfReady();

  // _state stays "started"; peer reconnect (if previously paired) flows
  // through _installAutoListener → _findKnownPeer → _promoteToPaired
  // automatically when the app sends any inner.
  _emitRelayState();
}

// ── Relay state event + transparent control channel (Cockpit toggle) ─────────

/** Current relay connectivity, derived from `_state` + `_relay`. */
function _relayStatus(): RelayConnectivity {
  if (_getState() === "idle") return "disconnected";
  return _relay ? "connected" : "reconnecting";
}

/**
 * Emit the `un-bien:relay-state` custom message so an RPC client (Cockpit)
 * can render a relay on/off indicator. Pure data (`display:false`) — never
 * shown in the transcript. De-duped on the connectivity value; pass
 * `force=true` to answer an explicit `relay:status` query regardless.
 */
function _emitRelayState(force = false): void {
  const status = _relayStatus();
  if (!force && status === _lastRelayStatus) return;
  _lastRelayStatus = status;
  // This can run inside a WebSocket 'close' callback (via _onRelayClose). After a
  // session replacement (newSession/fork/switchSession/reload) the module-level
  // `_pi` is stale, and `assertActive` throws synchronously inside `sendMessage`.
  // An uncaught throw from a WS event callback becomes a process-level
  // uncaughtException and exits pi. Swallow it here: the next relay-state
  // change re-emits, so connectivity is eventually consistent. See issue #55.
  try {
    _pi?.sendMessage({
      customType: "un-bien:relay-state",
      content: `Relay ${status}`,
      details: {
        status,
        connected: status === "connected",
        ...(_relayUrl ? { relayUrl: _relayUrl } : {}),
        ...(_myRoomId ? { room: _myRoomId } : {}),
      },
      display: false,
    });
  } catch {
    // _pi stale (session replaced) or extension runtime not yet bound.
  }
}

/** Minimal ctx for relay start/stop driven by a control message (no command
 *  ctx is available in the `input` hook). cwd matches the daemon's launch dir,
 *  so the derived relay room is identical to the one `_cmdStart` first used. */
function _controlCtx(): Pick<ExtensionContext, "ui" | "cwd"> {
  // SAFETY: _headlessUi() implements every ui method the relay start/stop path
  // actually calls; the notify-forwarding shim is structurally narrower than the
  // full ExtensionContext["ui"] but complete for this headless control path.
  return {
    ui: _headlessUi(),
    cwd: process.cwd(),
  } as unknown as Pick<ExtensionContext, "ui" | "cwd">;
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
function _headlessUi(): {
  notify: (msg: string, type?: "info" | "warning" | "error") => void;
} {
  return {
    notify: (msg: string, type?: "info" | "warning" | "error") => {
      if (type === "warning" || type === "error")
        process.stderr.write(`${msg}\n`);
    },
  };
}

/**
 * Handle a transparent control command from an RPC client (Cockpit), received
 * as a `CTRL_PREFIX`-tagged input the `input` hook swallowed. Toggles the relay
 * WITHOUT leaving the local mesh (relay-only: `_cmdStart` up / `_goIdle` down),
 * then emits the fresh state. `relay:status` just re-emits (no change) so the
 * client can sync its button after (re)attaching to the RPC stream.
 */
export async function _handleControl(cmd: string): Promise<void> {
  // `rename:<new-name>` carries an argument, so it's matched before the
  // fixed-verb switch. Renames the agent live (broker re-register + relay room
  // swap) WITHOUT restarting the process or losing the SDK session.
  if (cmd.startsWith("rename:")) {
    await _renameAgent(cmd.slice("rename:".length).trim());
    return;
  }
  switch (cmd) {
    case "relay:on":
      if (_getState() === "idle") await _cmdStart(_controlCtx());
      _emitRelayState(true);
      return;
    case "relay:off":
      if (_getState() === "idle") {
        _rootLifecycleGeneration += 1;
        _relayLifecycleGeneration += 1;
      } else _goIdle();
      _emitRelayState(true);
      return;
    case "relay:toggle":
      if (_getState() === "idle") await _cmdStart(_controlCtx());
      else _goIdle();
      _emitRelayState(true);
      return;
    case "relay:status":
      _emitRelayState(true);
      return;
    default:
      // Unknown control verb — ignore (forward-compat: a newer client may send
      // verbs an older extension doesn't know).
      return;
  }
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
  if (!newName) return; // empty rename → no-op
  const ctx = _controlCtx();
  const cwd = process.cwd();
  saveLocalConfig(cwd, { agent_name: newName });

  if (!_meshNode) {
    // Not on the mesh yet — config persisted; applies on the next join.
    return;
  }

  // Relay room is derived from the name → cycle it so it follows. Tear down
  // first (also detaches the bridge) so the broker re-register below starts
  // clean; bring it back up after with the new name.
  const wasStarted = _getState() !== "idle";
  if (wasStarted) _goIdle();

  let assigned = newName;
  try {
    assigned = await _meshNode.rename(newName); // broker soft rejoin
  } catch (err) {
    ctx.ui.notify(`[un-bien] rename failed: ${String(err)}`, "error");
  }

  if (wasStarted && !_disposed) await _cmdStart(ctx); // relay back up → roomIdFor(cwd, assigned)

  _pi?.sendMessage({
    customType: "un-bien:name-assigned",
    content:
      assigned === newName
        ? `Mesh name: ${assigned}`
        : `Mesh name reassigned: "${newName}" → "${assigned}" (collision)`,
    details: { requested: newName, assigned, changed: assigned !== newName },
    display: false,
  });
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
    // Other owners still attached — keep _rootState().turnId so they continue
    // seeing the in-flight agent stream.
    _refreshFooter();
    return;
  }

  // No owner left. Conservatively clear the turn so the next pair_request
  // starts cleanly.
  _rootState().turnId = null;
  _refreshFooter();
  _safeNotify(
    "[un-bien] All app peers disconnected, listening for reconnect",
    "info",
  );
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

  // Prefer always-fresh session_start ctx for async relay routing — `_lastCtx`
  // is a captured command ctx that goes stale after session replacement (#55).
  const channel = new PlainPeerChannel(
    relay,
    appPeerId,
    _myRoomId ?? undefined,
    (msg) =>
      _routeClientMessageFrom(
        channel,
        msg,
        (_liveCtx() as typeof _noopCtx) ?? _noopCtx,
      ),
    () => _onPeerDisconnect(appPeerId),
    (env) =>
      env.ub === undefined
        ? _routeRpcCommandFrom(channel, env)
        : _routeUnBienPlaneFrom(channel, env),
    () =>
      _rootState().sessionManager?.getSessionId() ??
      _rootSessionId ??
      undefined,
  );

  _attachPeerChannel(appPeerId, channel);
  // Envelope-native capability handshake: advertise caps up front so the app can
  // enable the {rpc|evt} route + suppress stock before any session content
  // arrives. Additive to the stock session_history caps (parity transition).
  const _sid = _rootState().sessionManager?.getSessionId();
  channel.sendEnvelope(helloEnvelope(_capabilities(), _sid));
  envLog(
    `attach: peer=${appPeerId.slice(0, 8)} hello sent (caps + sessionId=${_sid ?? "?"}); active=${_activePeers.size}`,
  );
  // Reconstruction (transcript + panels + extension_ui) is request-driven: the
  // app issues session_sync — on fresh open AND on relay reconnect — and the
  // handler in _routeUnBienPlaneFrom replays all of it. Re-sync is idempotent
  // (stable identify ids + ns/id panel merge), so nothing is replayed
  // proactively here.
  _refreshFooter();

  _safeNotify(
    `[un-bien] Owner attached: peer=${peerShort}, name=${peerName} ` +
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
  const listenerGeneration = _relayLifecycleGeneration;
  const hasListenerAuthority = (): boolean =>
    !_disposed &&
    _state === "started" &&
    _relay === relay &&
    _relayLifecycleGeneration === listenerGeneration;
  const onMsg = async (line: string) => {
    let outer: { peer?: string; ct?: string };
    try {
      outer = JSON.parse(line) as { peer?: string; ct?: string };
    } catch {
      return;
    }

    if (!outer.peer || !outer.ct) return;

    if (!hasListenerAuthority()) return;
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
      )
        return;
      inner = parsed as ClientMessage;
    } catch {
      return;
    }

    const appPeerId = outer.peer;

    if (inner.type === "pair_request") {
      await _handlePairRequest(relay, appPeerId, inner, hasListenerAuthority);
      return;
    }

    // Reconnect path: known peer (peers.json) without an active channel
    // sends a non-pair message → attach + route through the new channel.
    // See pairing.md §Reconexão.
    const known = await _findKnownPeer(appPeerId);
    if (!hasListenerAuthority()) return;
    if (known) {
      const channel = _attachOwner(relay, appPeerId, known.name);
      // The channel listener didn't see the line that triggered the attach, so
      // route it explicitly — MIRRORING the channel's own dispatch (peer_channel
      // _onLine): a real-typed envelope ("rpc"/"evt"/"ub", legacy "env") or a
      // bare rpc/evt/ub body goes to the envelope dispatcher, a stock
      // ClientMessage to the stock switch. Everything is on the envelope proto
      // now, so the first message is normally the ub session_sync (or the rpc
      // get_entries) — routing that through the stock switch dropped it. Use
      // _liveCtx (session_start-fresh), not #55.
      const innerObj = inner as Record<string, unknown>;
      if (isEnvelopeFrame(innerObj)) {
        {
          // SAFETY: isEnvelopeFrame confirmed rpc/evt/ub envelope keys are
          // present, so this ClientMessage is byte-compatible with EnvelopeMessage.
          const innerEnv = inner as unknown as EnvelopeMessage;
          if (innerEnv.ub === undefined)
            _routeRpcCommandFrom(channel, innerEnv);
          else _routeUnBienPlaneFrom(channel, innerEnv);
        }
      } else {
        _routeClientMessageFrom(
          channel,
          inner,
          (_liveCtx() as typeof _noopCtx) ?? _noopCtx,
        );
      }
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

/**
 * Plan/27 Wave A: lazily resolve the pi-extension package version from
 * disk so the `pair_ok.harness.version` field reflects what's actually
 * shipped. The lookup is best-effort — a parse failure (or running this
 * file out-of-tree) falls back to "0.0.0" which is still semver-valid
 * and the app tolerates it. Cached at module load.
 */
function _readExtensionVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // dist/index.js → ../package.json. src/index.ts under tsx → also one level up.
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const _HARNESS = {
  name: "Pi coding agent",
  version: _readExtensionVersion(),
} as const;
const _HOSTNAME = hostname();

// un-bien capability handshake. PROTOCOL_VERSION bumps on a HARD (breaking)
// wire change; the app gates UI on capability PRESENCE, not this number.
const PROTOCOL_VERSION = 1;
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
] as const;

/** The capability set to advertise right now (config-dependent bits included). */
function _capabilities(): string[] {
  const caps: string[] = [..._BASE_CAPABILITIES];
  // `remote_launch` is advertised ONLY when the machine opts in via local
  // config — single choke point so the advertised set and honored behavior
  // can't drift. Read the session cwd's config (pi runs in the session cwd).
  if (effectiveAllowRemoteLaunch(loadLocalConfig(process.cwd()))) {
    caps.push("remote_launch");
  }
  return caps;
}

async function _handlePairRequest(
  relay: RelayClient,
  appPeerId: string,
  inner: Extract<ClientMessage, { type: "pair_request" }>,
  hasListenerAuthority: () => boolean,
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
      status === "expired"
        ? "token_expired"
        : status === "consumed"
          ? "token_consumed"
          : "token_unknown";
    const msg =
      code === "token_expired"
        ? "Ephemeral token expired. Generate a new QR with /unbien pair."
        : code === "token_consumed"
          ? "Token already consumed by another pair_request."
          : "Token was not issued by this Pi.";
    sendError(code, msg);
    return;
  }

  // A delayed signed revoke must lose authority before the same-process
  // re-pair enters storage; the replacement owns a fresh token snapshot.
  const producer = _selfRevoke;
  const producerEpoch = _selfRevokeEpoch;
  producer?.invalidateStorageAuthority();
  const pairedAt = new Date().toISOString();
  try {
    await addPeer({
      name: inner.device_name,
      remote_epk: appPeerId,
      paired_at: pairedAt,
    });
    if (!hasListenerAuthority()) return;
    _refreshPairingsCache();
    if (
      producer &&
      _selfRevoke === producer &&
      _selfRevokeEpoch === producerEpoch
    ) {
      void producer.requestFreshCheck().catch(() => {
        // The regular cadence retries; pairing itself already succeeded.
      });
    }
  } catch (err) {
    if (!hasListenerAuthority()) return;
    sendError("internal_error", `Failed to persist peer: ${String(err)}`);
    return;
  }

  const cwd =
    _lastCtx && "cwd" in _lastCtx
      ? (_lastCtx as ExtensionCommandContext).cwd
      : process.cwd();
  // Prefer the user-configured agent_name (with broker suffix when on the
  // mesh) over the legacy parent/folder path — matches what the user sees
  // in the terminal title and in /unbien status.
  const sessionName = _displayName(cwd);

  _attachOwner(relay, appPeerId, inner.device_name);

  sendInner({
    type: "pair_ok",
    in_reply_to: inner.id,
    session_name: sessionName,
    session_started_at: _sessionStartedAt ?? Date.now(),
    // App uses this to address subsequent inner messages to the right room
    // when this Pi runs alongside others with the same epk. Defensive fallback
    // to roomIdFor(cwd, name) covers the edge case where pair_request lands
    // before _cmdStart could set _myRoomId (shouldn't happen in practice) —
    // and stays plan/41-consistent (same (cwd, name) derivation as the announce).
    room_id: _myRoomId ?? _deriveRoomId(cwd, sessionName),
    // Plan/27 Wave A — surface the host coding-agent identity + machine
    // hostname so the app can render a meaningful device row (and tell
    // two PCs apart even when nicknames collide).
    harness: _HARNESS,
    hostname: _HOSTNAME,
    protocol_version: PROTOCOL_VERSION,
    capabilities: _capabilities(),
  });

  // Notify local RPC clients (e.g. Cockpit) that pairing completed, so they can
  // close the QR screen and show the new device. Pure data event (display:false)
  // — still emitted to the RPC stdout via the session stream.
  _pi?.sendMessage({
    customType: "un-bien:paired",
    content: `Paired with ${inner.device_name}`,
    details: { name: inner.device_name, peerId: appPeerId, pairedAt },
    display: false,
  });
}

// ── Extension factory (default export) ───────────────────────────────────────

// Stores most recent command context so the auto-listener can use ui.notify.
// NOTE: this is a CAPTURED command ctx — the SDK marks it stale after a
// session replacement (newSession/fork/switch/reload). We re-capture it via
// `withSession` when WE drive a newSession (see the session_new dispatch).
let _lastCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null = null;
// Freshest base ExtensionContext, re-captured on EVERY `session_start`
// (startup/new/fork/reload/resume). The session_start ctx is always bound to
// the CURRENT session, so compact + cancel (base-ctx methods) routed through
// here never hit a stale ctx — regardless of who triggered the replacement
// (an app Quick Action OR a `/new` typed in the Pi TUI). It carries only
// base-ctx methods (no newSession — that's command-ctx only), so command ops
// keep using `_lastCtx`.
let _lastEventCtx: Pick<ExtensionContext, "compact" | "abort" | "ui"> | null =
  null;
const _noopCtx = { ui: { notify: () => undefined }, abort: () => undefined };

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
const _APPLIED_REGISTRY_KEY = Symbol.for("un-bien.extension.appliedRegistry");
function _appliedRegistry(): WeakSet<object> {
  const g = globalThis as typeof globalThis & {
    [_APPLIED_REGISTRY_KEY]?: WeakSet<object>;
  };
  return (g[_APPLIED_REGISTRY_KEY] ??= new WeakSet<object>());
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
const _ROOT_SESSION_OWNER_KEY = Symbol.for("un-bien.rootSession.owner");
/** True if `pi` owns the root slot (or just claimed a free one); false if another pi owns it. */
function _claimRootSession(pi: ExtensionAPI): boolean {
  const g = globalThis as typeof globalThis & {
    [_ROOT_SESSION_OWNER_KEY]?: ExtensionAPI;
  };
  if (g[_ROOT_SESSION_OWNER_KEY]) return g[_ROOT_SESSION_OWNER_KEY] === pi;
  g[_ROOT_SESSION_OWNER_KEY] = pi;
  return true;
}
function _isRootSession(pi: ExtensionAPI): boolean {
  const g = globalThis as typeof globalThis & {
    [_ROOT_SESSION_OWNER_KEY]?: ExtensionAPI;
  };
  return g[_ROOT_SESSION_OWNER_KEY] === pi;
}
function _releaseRootSession(pi: ExtensionAPI): void {
  const g = globalThis as typeof globalThis & {
    [_ROOT_SESSION_OWNER_KEY]?: ExtensionAPI;
  };
  if (g[_ROOT_SESSION_OWNER_KEY] === pi) delete g[_ROOT_SESSION_OWNER_KEY];
}

const extension: ExtensionFactory = (pi: ExtensionAPI): void => {
  const applied = _appliedRegistry();
  if (applied.has(pi)) return; // this session's pi was already wired
  applied.add(pi);

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
    _pi = pi;
    _extensionUiBridge?.dispose();
    _extensionUiBridge = createExtensionUiBridge(pi, _uiBroadcast);
    _panelBridge?.dispose();
    _panelBridge = createPanelBridge(pi, _panelBroadcast, {
      suppressAgents: subagentRoomsEnabled(),
    });
    _rpcEnvelope?.dispose();
    _rpcEnvelope = createRpcEnvelope(pi, _broadcastEnvelope, {
      enrichArgs: (tool, args) => {
        const e = _enrichToolArgs(tool, args, _resolveToolCwd()) as {
          hunks?: unknown[];
        };
        return Array.isArray(e.hunks) ? { hunks: e.hunks } : null;
      },
    });
    _subagentRooms?.dispose();
    _subagentRooms = initSubagentRooms(pi, {
      getParentRoomId: () => _myRoomId,
      getParentSessionId: () => _rootSessionId,
      broadcastPanel: _panelBroadcast,
    });
  }

  // Plano 19: ensure ~/.pi/un-bien/{sessions,skills}/ exist and deploy the
  // agent-network skill on first load. resources_discover lets Pi find it.
  try {
    ensureGlobalDirs();
    _deployAgentNetworkSkill();
  } catch {
    /* best-effort init */
  }

  // Seed the global-pairings cache from peers.json so the footer can show
  // 🟢/🟡 correctly the moment the relay is up (no race with first refresh).
  _refreshPairingsCache();

  pi.on("resources_discover", () => ({ skillPaths: [skillsDir()] }));

  // Plano 20: agent_send + agent_request tools so the LLM can drive the
  // session network natively. Getter captures `_meshNode` live so the
  // tool always sees the current state.
  registerAgentTools(pi, () => _meshNode?.peer() ?? null);
  _registerReceivedImageRenderer(pi);

  // Received-image preview entries are for local TUI display only. Pi's custom
  // messages normally become user-role LLM context, so strip this type before
  // every provider request; the actual Android image still reaches the model via
  // the paired sendUserMessage call.
  pi.on("context", (event) => ({
    messages: _filterInternalMessagesFromContext(event.messages),
  }));

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
      void _handleControl(event.text.slice(CTRL_PREFIX.length).trim());
      return { action: "handled" } as const;
    }
    if (!_anyPeerActive()) return;
    if (event.source === "extension") return;
    // Turn id still stamped for queue/turn correlation; the app renders the
    // user bubble from the envelope message_end (role:user), not a stock frame.
    _rootState().turnId = `local_${randomUUID()}`;
    return undefined;
  });

  // Track active model so the app can show it in the SessionTile (plano 18).
  // SDK fires model_select on settings load + every user switch. We cache the
  // friendly name and broadcast a room_meta_update so the relay can fan it
  // out to subscribed apps without needing a new pair.
  pi.on("model_select", (event, ctx) => {
    const m = event?.model as { name?: string; id?: string } | undefined;
    const modelName = m?.name ?? m?.id;
    if (!modelName) return;
    // Cache per-sid for THIS session (root + subagent) so a subagent's model is
    // queryable and never clobbers the root's. Only the ROOT projects to
    // _currentModel + room_meta (the app-room's model hello/update).
    const sid = _sidOf(ctx);
    _stateFor(sid).model = modelName;
    if (!_isNonRootSid(sid)) _setCurrentModel(modelName);
  });

  // Plan/28 Wave D.1: mirror model's room_meta_update path for thinking
  // level so the app hydrates the segmented control on first open instead
  // of starting null. SDK fires `thinking_level_select` on settings load
  // AND on every user toggle (matching `model_select`'s behavior), so
  // late-pairing apps see the current level via `room_meta_updated`.
  pi.on("thinking_level_select", (event, ctx) => {
    const level = event?.level as ThinkingLevel | undefined;
    if (!level) return;
    // Cache per-sid; only the ROOT projects to _currentThinking + room_meta.
    const sid = _sidOf(ctx);
    _stateFor(sid).thinking = level;
    if (_isNonRootSid(sid)) return;
    _currentThinking = level;
    if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, thinking: level };
    if (!_relay || !_myRoomId) return;
    _relay.sendControl({
      type: "room_meta_update",
      room_id: _myRoomId,
      meta: { thinking: level },
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    const st = _stateFor(_sidOf(ctx));
    st.agentRun.active = true;
    st.agentRun.generation += 1;
  });

  // Live transcript (assistant text/thinking deltas + tool_request/tool_result)
  // is produced by the rpc-envelope producer (createRpcEnvelope) from the same
  // pi.on(message_update / tool_execution_*) events — no stock broadcast here.

  pi.on("agent_end", (_event, ctx) => {
    const sid = _sidOf(ctx);
    const st = _stateFor(sid);
    // Clear THIS session's run flag on the next tick (generation guards a
    // queued continuation that started first).
    const endedGeneration = st.agentRun.generation;
    const settleRun = () =>
      setTimeout(() => {
        if (st.agentRun.generation !== endedGeneration) return;
        st.agentRun.active = false;
        if (!_isNonRootSid(sid)) _scheduleMeshMessageDrain();
      }, 0);
    if (_isNonRootSid(sid)) {
      settleRun();
      return; // subagent end has no app-facing effect
    }
    // Root: close the outbound turn. The app renders turn completion from the
    // envelope (turn_end / agent_settled), so no stock agent_done is sent; we
    // only clear the turn id used for queue/turn correlation.
    if (st.turnId) st.turnId = null;
    _flushPendingReceivedImagePreviews();
    settleRun();
  });

  // plan/34: the broker no longer gates delivery on busy state, so we no
  // longer notify it of turn lifecycle. Working state is still published as
  // room_meta over the relay (plan/32) below — that's independent of the
  // broker and drives the app's working indicator.
  pi.on("turn_start", (_event, ctx) => {
    const sid = _sidOf(ctx);
    const st = _stateFor(sid);
    // Each session records its OWN sessionManager (no cross-session clobber).
    if (ctx?.sessionManager) st.sessionManager = ctx.sessionManager;
    st.working = true;
    // Late model hydration for THIS session: if the model was unknown at
    // connect (SDK resolves it lazily), grab it on the first turn and cache
    // per-sid — root AND subagent, so a subagent's model is queryable and the
    // root's is never clobbered by a child.
    if (!st.model) {
      try {
        const m = (
          ctx as Partial<ExtensionContext> & {
            getModel?: () => { name?: string; id?: string } | undefined;
          }
        ).getModel?.();
        const name = m?.name ?? m?.id;
        if (name) st.model = name;
      } catch {
        /* defensive — never block a turn on a model lookup */
      }
    }
    if (_isNonRootSid(sid)) return; // room_meta projection is root-only
    // Root projection: seed the global model + room_meta hello from the root's
    // cached model, once.
    if (!_currentModel && st.model) _setCurrentModel(st.model);
    // Plan/32 Part B: publish working=true as room_meta (raw, no debounce —
    // the debounce lives in the app). Same shape as the model/thinking updates.
    // _myRoomMeta is the ROOM projection (driven only by the root session).
    if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, working: true };
    if (_relay && _myRoomId) {
      _relay.sendControl({
        type: "room_meta_update",
        room_id: _myRoomId,
        meta: { working: true },
      });
    }
  });
  pi.on("turn_end", (_event, ctx) => {
    const sid = _sidOf(ctx);
    _stateFor(sid).working = false;
    if (_isNonRootSid(sid)) return; // room_meta is root-only
    // Plan/32 Part B: publish working=false as room_meta (raw, no debounce).
    if (_myRoomMeta) _myRoomMeta = { ..._myRoomMeta, working: false };
    if (_relay && _myRoomId) {
      _relay.sendControl({
        type: "room_meta_update",
        room_id: _myRoomId,
        meta: { working: false },
      });
    }
  });

  // Plan/32: compaction feedback. compact() doesn't run a turn, so bracket it
  // with working=true/false here. Returning void = no veto → default
  // compaction proceeds.
  pi.on("session_before_compact", (event, ctx) => {
    if (event.preparation) {
      event.preparation.messagesToSummarize =
        _filterInternalMessagesFromContext(
          event.preparation.messagesToSummarize,
        );
      event.preparation.turnPrefixMessages = _filterInternalMessagesFromContext(
        event.preparation.turnPrefixMessages,
      );
    }
    // working=true brackets the ROOT room's compaction; the per-session message
    // filtering above always runs, but a subagent that compacts must not
    // flicker the root's working indicator.
    if (!_isNonRootSid(_sidOf(ctx))) _publishWorking(true);
  });
  pi.on("session_compact", (_event, ctx) => {
    // Live compaction result rides the rpc-envelope compaction_end (app applyRPC),
    // and the persisted CompactionEntry surfaces natively via get_entries. Only
    // the working=false bracket remains here — the ROOT room's, so guard it.
    if (!_isNonRootSid(_sidOf(ctx))) _publishWorking(false);
  });

  // Re-capture the freshest base ctx on every session replacement so compact
  // never operates on a stale captured ctx — this is the fix for the
  // "stale after session replacement" crash when the app taps Compact after a
  // New session. Fires on startup/new/fork/reload/resume; the ctx is always
  // bound to the current session.
  pi.on("session_start", (_event, ctx) => {
    // Register THIS session's record (root + every subagent get their own
    // session_start with their own ctx). Each records its OWN sessionManager —
    // no cross-session clobber (was the unguarded `_sessionManager = ...` bug).
    const sid = _sidOf(ctx);
    // The module BASE ctx (compact/notify fallback when no fresh ctx is passed)
    // is the ROOT's — a subagent child's ctx must NOT clobber it, same
    // no-cross-session-clobber rule as the per-sid sessionManager. Otherwise a
    // subagent steals the base ctx and root-scoped notifies silently drop.
    if (!_isNonRootSid(sid)) _lastEventCtx = ctx;
    if (ctx?.sessionManager) _stateFor(sid).sessionManager = ctx.sessionManager;
    // session_shutdown disposes per-session pi-ask subscriptions. A host that
    // reuses this module instance does NOT re-run the factory, so rebind the
    // bridge here; fresh-module hosts already created theirs in the factory.
    // Only the ROOT owner rebinds (re-claims a slot freed by its own shutdown);
    // a subagent child's session_start must not seize it. Covers both bridges.
    // The root claim also fixes _rootSessionId (re-captured across replacement);
    // only when a real sessionManager is present (ctx-less test events stay in
    // null-root mode where every event is treated as root).
    if (_claimRootSession(pi)) {
      if (ctx?.sessionManager) _rootSessionId = sid;
      if (!_extensionUiBridge)
        _extensionUiBridge = createExtensionUiBridge(pi, _uiBroadcast);
      if (!_panelBridge)
        _panelBridge = createPanelBridge(pi, _panelBroadcast, {
          suppressAgents: subagentRoomsEnabled(),
        });
      if (!_rpcEnvelope)
        _rpcEnvelope = createRpcEnvelope(pi, _broadcastEnvelope, {
          enrichArgs: (tool, args) => {
            const e = _enrichToolArgs(tool, args, _resolveToolCwd()) as {
              hunks?: unknown[];
            };
            return Array.isArray(e.hunks) ? { hunks: e.hunks } : null;
          },
        });
      if (!_subagentRooms)
        _subagentRooms = initSubagentRooms(pi, {
          getParentRoomId: () => _myRoomId,
          getParentSessionId: () => _rootSessionId,
          broadcastPanel: _panelBroadcast,
        });
    } else if (_isNonRootSid(sid)) {
      // A subagent child session (non-root) — surface it as its own relay room.
      // `pi` here is the CHILD's ExtensionAPI (per-activation).
      _subagentRooms?.onChildSession(pi, ctx);
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
      _disposed = false;
      const restartAuthority: RootRestartAuthority = {
        rootLifecycleGeneration: _rootLifecycleGeneration,
      };
      void _cmdRoot(ctx, restartAuthority);
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
      const isDaemon = process.env["UNBIEN_DAEMON"] === "1";
      // One-shot / non-interactive Pi (`pi -p` / `pi --print`) is documented as
      // "process the prompt and exit". Auto-starting the relay there opens a WS
      // that is never `.unref()`'d, so the idle Node event loop never drains and
      // the process hangs forever after printing its answer (issue #44). Daemon
      // mode (UNBIEN_DAEMON=1) and normal interactive sessions never pass
      // `-p`/`--print`, so they still auto-start the relay exactly as before.
      const isPrintMode =
        process.argv.includes("-p") || process.argv.includes("--print");
      const cwd = isDaemon ? process.cwd() : "cwd" in ctx ? ctx.cwd : undefined;
      if (
        !isPrintMode &&
        cwd &&
        localConfigExists(cwd) &&
        effectiveAutoStartRelay(loadLocalConfig(cwd))
      ) {
        _autoInited = true;
        const initCtx = isDaemon
          ? ({ ui: _headlessUi(), cwd: process.cwd() } as Pick<
              ExtensionContext,
              "ui" | "cwd"
            >)
          : ctx;
        void _cmdRoot(initCtx);
      }
    }
  });

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
    if (!_isRootSession(pi)) return;
    // Revoke async authority synchronously, before any teardown await. `_disposed`
    // blocks the outgoing continuation immediately; the root and candidate
    // generations keep queued work stale even if a same-module session_start
    // clears `_disposed` before its promises settle.
    _disposed = true;
    _rootLifecycleGeneration += 1;
    _relayLifecycleGeneration += 1;
    _meshJoinGeneration += 1;
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
      if (_anyPeerActive()) {
        _broadcastEnvelope({ rpc: { type: "session_shutdown" } });
      }
      _extensionUiBridge?.dispose();
      _extensionUiBridge = null;
      _panelBridge?.dispose();
      _panelBridge = null;
      _rpcEnvelope?.dispose();
      _rpcEnvelope = null;
      _subagentRooms?.dispose();
      _subagentRooms = null;
      _releaseRootSession(pi);
    }
    // Drop captured ctxs immediately. On module-reuse hosts the same instance
    // survives session replacement; leaving `_lastCtx` pointing at the now-
    // stale command ctx is what crashed pi in _refreshFooter on peer reconnect
    // (issue #55). session_start re-binds `_lastEventCtx` for the new session.
    _lastCtx = null;
    _lastEventCtx = null;
    // No bye reason: the process keeps running and the fresh instance re-joins
    // the SAME relay room, so an explicit offline→online flap would be wrong.
    // Revoke producer/Relay/bridge authority while the global node is still
    // visible, before close() can begin its asynchronous UDS leave.
    if (_state === "idle") {
      _meshNode?.detachBridge();
    } else {
      _goIdle();
    }

    const meshNode = _meshNode;
    _meshNode = null;
    _sessionName = null;
    _sessionPeerCount = 0;
    let meshClose: Promise<void> | null = null;
    try {
      meshClose = meshNode?.close() ?? null;
    } catch {
      /* best-effort */
    }

    if (_cwdLock) {
      try {
        _cwdLock.release();
      } catch {
        /* best-effort */
      }
      _cwdLock = null;
      _lockedName = null;
    }
    try {
      await meshClose;
    } catch {
      /* best-effort */
    }
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  //
  // Final surface: 8 commands. Pre-2026-05-23 we had 20 commands covering
  // multi-session UDS + granular relay control; in practice every install
  // converged on one session and the relay was always either fully on or
  // fully off. The simplified surface keeps the day-to-day path one-key
  // (`/unbien`) and exposes only the actions that have distinct user
  // intent: setup, status, stop, pair, devices, revoke, set-relay.
  pi.registerCommand("unbien", {
    description:
      "Connect (join local mesh + start relay), or run setup on first use",
    getArgumentCompletions: async (prefix) => {
      if (prefix.startsWith("revoke ") || prefix === "revoke") {
        const shortPrefix =
          prefix === "revoke" ? "" : prefix.slice("revoke ".length);
        return _shortidCompletions(shortPrefix, "revoke ");
      }
      return [
        "setup",
        "status",
        "stop",
        "pair",
        "devices",
        "revoke",
        "rename",
        "set-relay",
        "relay",
        "relay start",
        "relay stop",
        "relay status",
        "relay url",
        "config",
        "identity",
        "identity show",
        "test", // hidden e2e UI harness (dev-only)
        "peers", // plan/25 Wave D — local + cross-PC inventory
        "create",
        "remove",
        "daemons", // daemon registry (plan/26 W1)
        // Fleet ops use the `daemon` prefix so `/unbien stop` keeps
        // meaning "stop this local Pi" — the local UX shipped in plan/25.
        "daemon start",
        "daemon stop",
        "daemon restart",
        "daemon send",
        "daemon status",
        "cron",
        "cron add",
        "cron list",
        "cron remove",
        "cron enable",
        "cron disable",
        "cron run",
        "cron log",
        "install",
        "uninstall", // service install (plan/26 W3)
      ]
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
    },
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      const sub = args.trim();
      if (sub === "") {
        await _cmdRoot(ctx);
      } else if (sub === "setup") {
        await _cmdSetup(ctx);
      } else if (sub === "status") {
        _cmdStatus(ctx);
      } else if (sub === "stop") {
        await _cmdStop(ctx);
      } else if (sub === "pair" || sub.startsWith("pair ")) {
        await _cmdPair(ctx, sub.slice("pair".length).trim());
      } else if (sub === "devices") {
        await _cmdList(ctx);
      } else if (sub.startsWith("revoke")) {
        await _cmdRevoke(sub.slice("revoke".length).trim(), ctx);
      } else if (sub.startsWith("set-relay")) {
        _cmdSetRelay(sub.slice("set-relay".length).trim(), ctx);
      } else if (sub === "relay" || sub.startsWith("relay ")) {
        await _cmdRelay(sub.slice("relay".length).trim(), ctx);
      } else if (sub === "config") {
        _cmdConfig(ctx);
      } else if (sub === "identity" || sub.startsWith("identity ")) {
        await _cmdIdentity(ctx);
      } else if (sub === "test" || sub.startsWith("test ")) {
        // Hidden dev-only e2e UI harness: broadcast canned frames to paired apps.
        _safeNotify(
          `[un-bien test] ${_runTestScenario(sub.slice("test".length).trim())}`,
          "info",
          ctx,
        );
      } else if (sub === "rename" || sub.startsWith("rename ")) {
        await _renameAgent(sub.slice("rename".length).trim());
      } else if (sub === "peers") {
        await _cmdPeers(ctx);
      } else if (sub === "install") {
        _cmdInstall(ctx, { linkCli: true });
      } else if (sub === "uninstall") {
        _cmdUninstall(ctx, { linkCli: true });
      } else {
        await _cmdRoot(ctx);
      }
    },
  });

  // Nested registrations (one entry per public action). The flat handler
  // above already routes `/unbien <sub>` — these exist for the SDK's
  // command palette and slash-autocomplete in some UI modes.
  pi.registerCommand("unbien setup", {
    description: "Run the setup wizard and update local config",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      await _cmdSetup(ctx);
    },
  });
  pi.registerCommand("unbien status", {
    description: "Show local mesh + relay status",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      _cmdStatus(ctx);
    },
  });
  pi.registerCommand("unbien stop", {
    description: "Stop everything (leave local mesh + disconnect relay)",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      await _cmdStop(ctx);
    },
  });
  pi.registerCommand("unbien pair", {
    description:
      "Show a QR code to pair a new mobile device (optional: --ttl <seconds>)",
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      await _cmdPair(ctx, args.trim());
    },
  });
  pi.registerCommand("unbien devices", {
    description: "List paired mobile devices",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      await _cmdList(ctx);
    },
  });
  pi.registerCommand("unbien rename", {
    description:
      "Rename this agent in the current session (updates mesh + relay room)",
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      await _renameAgent(args.trim());
    },
  });
  pi.registerCommand("unbien revoke", {
    description: "Revoke a paired device by its shortid",
    getArgumentCompletions: async (prefix) => _shortidCompletions(prefix),
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      await _cmdRevoke(args.trim(), ctx);
    },
  });
  pi.registerCommand("unbien set-relay", {
    description: "Persist a new relay URL to user config",
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      _cmdSetRelay(args.trim(), ctx);
    },
  });
  pi.registerCommand("unbien config", {
    description: "Show the effective relay URL and where it came from",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      _cmdConfig(ctx);
    },
  });
  pi.registerCommand("unbien identity", {
    description:
      "Show this machine's identity: active EPK (public), backend, and source",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      await _cmdIdentity(ctx);
    },
  });
  pi.registerCommand("unbien identity show", {
    description:
      "Show this machine's identity (EPK/backend/source) — alias of `identity`",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      await _cmdIdentity(ctx);
    },
  });
  pi.registerCommand("unbien relay", {
    description:
      "Relay control: start | stop | status | url <http(s) url> (no arg toggles)",
    handler: async (args, ctx) => {
      _lastCtx = ctx;
      await _cmdRelay(args.trim(), ctx);
    },
  });

  // Plan/25 Wave D
  pi.registerCommand("unbien peers", {
    description: "List local + cross-PC mesh peers, grouped by PC label",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      await _cmdPeers(ctx);
    },
  });

  // Service install / uninstall — the launcher daemon as a system service.
  pi.registerCommand("unbien install", {
    description:
      "Install the un-bien launcher daemon as a system service + link the un-bien CLI (systemd/launchd/Task Scheduler; Windows prompts for admin)",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      _cmdInstall(ctx, { linkCli: true });
    },
  });
  pi.registerCommand("unbien uninstall", {
    description:
      "Remove the un-bien launcher daemon system service + the CLI shims (Windows prompts for admin)",
    handler: async (_, ctx) => {
      _lastCtx = ctx;
      _cmdUninstall(ctx, { linkCli: true });
    },
  });

  // Auto-init now runs from the session_start handler (above), AFTER the
  // SDK calls bindCore(). The original setTimeout(0) here fired before bindCore
  // replaced the throwing action-method stubs, so the first pi.sendMessage in
  // _emitRelayState crashed the headless pi process with "Extension runtime not
  // initialized" in a 5s supervisor crash-loop. The session_start handler now
  // auto-starts for ANY session with auto_start_relay (default true), so new
  // interactive pi sessions are on remote automatically — no /unbien needed.
};

export default extension;

// ── Command implementations ───────────────────────────────────────────────────

/**
 * `/unbien status` — full state snapshot. Two lines: local mesh + relay.
 *
 * Always callable; safe when nothing is up (renders the off variants).
 * Reuses the same icons as the footer so terminal + status output stay
 * visually consistent.
 */
function _cmdStatus(ctx: Pick<ExtensionContext, "ui">): void {
  const relayUrl = _relayUrl ?? resolveRelayUrl().url ?? "not configured";

  // Mesh line
  let meshLine: string;
  if (_meshNode) {
    const name = _meshNode.name();
    meshLine = `🟢 Local mesh: connected as "${name}" (${_sessionPeerCount} peer${_sessionPeerCount === 1 ? "" : "s"})`;
  } else {
    meshLine = "⚪ Local mesh: not connected";
  }

  // Relay line — paired state is derived from _activePeers.size now.
  let relayLine: string;
  if (_state === "idle") {
    relayLine = `⚪ Relay: off (${relayUrl}) — run /unbien to start`;
  } else if (_activePeers.size > 0) {
    const count = _activePeers.size;
    const shortids = [..._activePeers.keys()]
      .map((peerId) => peerId.slice(0, 8))
      .join(", ");
    relayLine = `🟢 Relay: ${count} owner${count === 1 ? "" : "s"} online (${shortids}) (${relayUrl})`;
  } else {
    relayLine = _hasGlobalPairings
      ? `🟢 Relay: on, waiting for an app to connect (${relayUrl})`
      : `🟡 Relay: on, waiting for first pairing (${relayUrl})`;
  }

  ctx.ui.notify(`[un-bien]\n  ${meshLine}\n  ${relayLine}`, "info");
}

/**
 * Plan/25 Wave D: `/unbien peers`.
 *
 * Queries the local broker for the aggregated peer inventory (`list_peers`
 * returns locals + cross-PC entries prefixed with `<pc_label>:`). Formats
 * the result grouped by source so users can see at a glance who's on
 * their machine vs. on a paired sibling Pi.
 */
async function _cmdPeers(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  if (!_meshNode) {
    ctx.ui.notify(
      "[un-bien] Not on the local mesh. Run /unbien to join.",
      "warning",
    );
    return;
  }
  let peers: string[];
  try {
    const reply = await _meshNode.request(
      "broker",
      { type: "list_peers" },
      2000,
    );
    peers = (reply.body as { peers?: string[] } | null)?.peers ?? [];
  } catch (err) {
    ctx.ui.notify(`[un-bien] peers list failed: ${String(err)}`, "error");
    return;
  }
  // Exclude self from the printed list — `list_peers` returns every peer
  // registered with the broker including the caller, which is noise here.
  const selfName = _meshNode.name();
  ctx.ui.notify(
    `[un-bien] peers:\n${formatPeerInventory(peers, selfName)}`,
    "info",
  );
}

/**
 * Root handler for `/unbien`. On first run (no local config) drops into
 * the wizard; on subsequent runs auto-joins the local mesh + starts the
 * relay (if opted in during setup), then prints the status.
 *
 * `/unbien` is intentionally the only command users need day-to-day:
 * idempotent connect + status display.
 */
async function _cmdRoot(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  restartAuthority?: RootRestartAuthority,
): Promise<void> {
  const rootLifecycleGeneration =
    restartAuthority?.rootLifecycleGeneration ?? _rootLifecycleGeneration;

  if (_cmdRootInFlight) {
    try {
      await _cmdRootInFlight;
    } catch (err) {
      // Stale authority stops here. A current normal duplicate preserves the
      // outgoing error, while a current replacement suppresses that old-session
      // failure and falls through to start one fresh root below.
      if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;
      if (!restartAuthority) throw err;
    }
    if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;
    if (!restartAuthority) {
      _cmdStatus(ctx);
      return;
    }
  }

  if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;

  const run = _cmdRootInner(ctx, rootLifecycleGeneration);
  _cmdRootInFlight = run;
  try {
    await run;
  } finally {
    if (_cmdRootInFlight === run) _cmdRootInFlight = null;
  }
}

async function _cmdRootInner(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  rootLifecycleGeneration: number,
): Promise<void> {
  // A root retains its startup epoch through every pre-candidate await. This is
  // stronger than `_disposed`, which a same-module session_start intentionally
  // clears while an outgoing continuation may still be pending.
  if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;

  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();
  // Lock identity is (cwd, name). Several agents may run in the SAME folder; the
  // requested name just has to be made unique. Derive the name the same way
  // `_cmdJoin` does so the lock and the mesh registration agree on identity.
  const requestedName =
    loadLocalConfig(cwd).agent_name || defaultAgentName(cwd);

  // Per-(cwd,name) lock. Interactive agents may coexist by auto-suffixing
  // (`name#2`, `name#3`, …), but supervised daemons must be singletons for their
  // registered cwd/name. If a daemon silently came up as `#2`, the supervisor
  // would report "running" while the mesh had duplicate peers for one repo.
  if (_cwdLock === null) {
    const isDaemon = process.env["UNBIEN_DAEMON"] === "1";
    const maxAttempts = isDaemon ? 1 : 1000;
    for (let n = 1; n <= maxAttempts; n++) {
      const candidate = n === 1 ? requestedName : `${requestedName}#${n}`;
      const result = await acquireCwdLock(cwd, candidate);
      if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) {
        if (result.ok) {
          try {
            result.release();
          } catch {
            /* best-effort stale lock cleanup */
          }
        }
        return;
      }
      if (result.ok) {
        _cwdLock = result;
        _lockedName = candidate;
        break;
      }
    }
    if (_cwdLock === null) {
      if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;
      ctx.ui.notify(
        process.env["UNBIEN_DAEMON"] === "1"
          ? `[un-bien] Daemon not started: another live agent already owns "${requestedName}" in this folder. Stop the old Pi process, then restart the daemon.`
          : `[un-bien] Could not start: too many agents named "${requestedName}" already running in this folder.`,
        "warning",
      );
      return;
    }
  }

  // First-time wizard: no local config in this cwd → run interactive setup.
  if (!localConfigExists(cwd)) {
    // SAFETY: ctx.ui MIGHT carry the wizard's select/input methods (interactive
    // Pi) or not (headless); the `typeof ui.select !== "function"` guard on the
    // next line validates the structural assumption before any method call.
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
    if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;
    if (!newConfig) {
      ctx.ui.notify("[un-bien] Setup cancelled.", "info");
      return;
    }
    saveLocalConfig(cwd, newConfig);
    ctx.ui.notify(
      `[un-bien] Config saved to ${cwd}/.pi/un-bien/config.json`,
      "info",
    );
    if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;
    await _cmdJoin(ctx);
    if (!_isCurrentRootLifecycle(rootLifecycleGeneration) || !_meshNode) return;
    if (effectiveAutoStartRelay(newConfig)) await _cmdStart(ctx);
    if (!_isCurrentRootLifecycle(rootLifecycleGeneration) || !_meshNode) return;
    _cmdStatus(ctx);
    return;
  }

  // Returning user with config: ALWAYS join the local UDS mesh on connect; the
  // relay is the only thing gated by auto_start_relay. So auto_start_relay:false
  // now means "local mesh, no relay" (matching the first-time/wizard path and
  // the field's documented intent) — previously a false flag skipped the mesh
  // join entirely, leaving the agent (incl. daemons) fully idle.
  const config = loadLocalConfig(cwd);
  if (!_isCurrentRootLifecycle(rootLifecycleGeneration)) return;
  if (!_meshNode) await _cmdJoin(ctx);
  // `_cmdJoin` returns void on a canceled/failed join, so recheck both the
  // root lifecycle and publication before bringing the Relay up.
  if (!_isCurrentRootLifecycle(rootLifecycleGeneration) || !_meshNode) return;
  if (effectiveAutoStartRelay(config) && _state === "idle")
    await _cmdStart(ctx);
  if (!_isCurrentRootLifecycle(rootLifecycleGeneration) || !_meshNode) return;
  _cmdStatus(ctx);
}

/**
 * `/unbien setup` — re-run the wizard. Defaults pre-fill from the
 * existing config so it doubles as an "edit" flow.
 */
async function _cmdSetup(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();
  // SAFETY: ctx.ui MIGHT carry the wizard's select/input methods (interactive
  // Pi) or not (headless); the `typeof ui.select !== "function"` guard on the
  // next line validates the structural assumption before any method call.
  const ui = ctx.ui as unknown as WizardUI;
  if (typeof ui.select !== "function") {
    ctx.ui.notify("[un-bien] Setup requires an interactive UI.", "warning");
    return;
  }
  const current = loadLocalConfig(cwd);
  const baseDefault = defaultAgentName(cwd);
  const newConfig = await runSetupWizard(ui, {
    agent_name: current.agent_name ?? baseDefault,
    use_relay: effectiveAutoStartRelay(current),
  });
  if (!newConfig) {
    ctx.ui.notify("[un-bien] Setup cancelled.", "info");
    return;
  }
  saveLocalConfig(cwd, newConfig);
  ctx.ui.notify("[un-bien] Config updated. Run /unbien to apply now.", "info");
}

async function _cmdStart(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  if (_state !== "idle") {
    ctx.ui.notify("[un-bien] Already started.", "warning");
    return;
  }
  const lifecycleGeneration = ++_relayLifecycleGeneration;
  const isCurrentCandidate = (): boolean =>
    !_disposed &&
    lifecycleGeneration === _relayLifecycleGeneration &&
    _state === "idle" &&
    _relay === null;

  let edKp: Awaited<ReturnType<typeof getOrCreateEd25519Keypair>>;
  try {
    edKp = await getOrCreateEd25519Keypair();
  } catch (err) {
    // Identity lookup is part of the candidate lifecycle. A later stop/off or
    // session replacement must silence its stale rejection before any UI or
    // error propagation touches the superseded context.
    if (!isCurrentCandidate()) return;
    if (err instanceof KeyringUnavailableError) {
      // The platform keyring (macOS Keychain / Windows Credential Manager) is
      // locked/denied and there's no file identity to fall back to. We refuse
      // to mint a new key (that's what silently broke pairing after idle), so
      // abort cleanly with an actionable message instead of crashing or
      // re-pairing. Unlocking the keychain and re-running fixes it.
      ctx.ui.notify(
        "[un-bien] Could not read this machine's identity: the system " +
          "keychain is locked or access was denied. Unlock it (open the app / " +
          "log in) and run /unbien again. Your pairing is NOT lost. " +
          '(For a headless host, set "identity": { "storage": "file" } in un-bien.json.)',
        "error",
      );
      return;
    }
    if (err instanceof PairedIdentityMissingError) {
      // Issues #95/#69: this process can't reach the keyring that holds the
      // paired identity (classically a `systemd --user` daemon vs. the desktop
      // session that paired). Minting a fresh key here would make SelfRevoke
      // wipe peers.json seconds later and take the phone offline, so storage
      // refuses. Surface the actionable fix instead of failing silently.
      ctx.ui.notify(
        "[un-bien] Could not read this machine's identity, but devices are " +
          "already paired — refusing to generate a new one (that would revoke " +
          "them). This process likely cannot reach the same keyring as the " +
          "session that paired (e.g. a systemd --user daemon). Give the service " +
          "keyring access, or copy the paired keypair to ~/.pi/un-bien/identity.json " +
          "(0600) so both contexts read the same identity.",
        "error",
      );
      return;
    }
    throw err;
  }
  // Re-check immediately after the first await, before cache/config/model/UI
  // mutation or Relay construction. `_disposed` alone is insufficient because
  // same-module session_start intentionally clears it for the replacement.
  if (!isCurrentCandidate()) return;
  _cachedEd25519 = edKp;

  const { url: relayUrl, source } = resolveRelayUrl();
  if (relayUrl === null) {
    ctx.ui.notify(
      "[un-bien] No relay configured — staying on the local mesh only. Set one " +
        "with `/unbien set-relay <url>` (or the UNBIEN_RELAY env var) to connect " +
        "the phone app.",
      "warning",
    );
    return;
  }
  const myShort = Buffer.from(edKp.publicKey).toString("base64").slice(0, 8);

  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();
  // Same name we send in pair_ok — keeps room_meta.name and the per-pair
  // session_name aligned so the app shows consistent labels.
  const sessionName = _displayName(cwd);
  // plan/41: derive the App↔Pi room from (cwd, name) so several agents in the
  // SAME folder get distinct rooms (the app renders one tile per agent). The
  // default/unnamed case preserves the legacy cwd-only id (no re-keying). Uses
  // the SAME name as room_meta.name / pair_ok below — the invariant that the
  // app pairs on the room the Pi actually announces.
  const roomId = _deriveRoomId(cwd, sessionName);

  // Seed the current model from the SDK's resolved selection so room_meta
  // carries it on connect. `model_select` only fires on an explicit set/cycle
  // (NOT on settings load), so a headless daemon that just runs its default
  // model never emits it — without this its room_meta would omit the model and
  // the app shows "unknown". `getModel()` returns the session's resolved model
  // in every mode (interactive + RPC daemon); turn_start hydrates it later if
  // the SDK resolves the model lazily.
  if (!_currentModel) {
    try {
      const c = ctx as Partial<ExtensionContext> & {
        model?: { name?: string; id?: string };
        getModel?: () => { name?: string; id?: string } | undefined;
      };
      // Prefer the live getModel() / ctx.model — populated for an interactive
      // Pi. For a HEADLESS DAEMON both are undefined at connect: the SDK only
      // resolves `this.model` lazily at the first turn, and `model_select`
      // never fires for a default-model session. So fall back to the CONFIGURED
      // default (defaultProvider/defaultModel in <cwd>/.pi/settings.json) — the
      // model the daemon will actually use. Without this an idle daemon (never
      // prompted → no turn) would never report its model and the app shows
      // "unknown". turn_start still hydrates a later override.
      const live = c.getModel?.() ?? c.model;
      if (live) {
        _currentModel = live.name ?? live.id ?? undefined;
      } else {
        const sm = SettingsManager.create(cwd);
        const provider = sm.getDefaultProvider();
        const modelId = sm.getDefaultModel();
        if (modelId) {
          // SAFETY: ensureModelRegistry only reads modelRegistry/getModel off
          // the ctx; c (and the _lastEventCtx/_lastCtx fallbacks) carry those
          // when present, and it tolerates null.
          const regCtx = (c ??
            _lastEventCtx ??
            _lastCtx) as unknown as ActionCtx | null;
          const found = provider
            ? ensureModelRegistry(regCtx).find(provider, modelId)
            : undefined;
          _currentModel = found?.name ?? modelId;
        }
      }
    } catch {
      /* defensive — never block start on a model lookup */
    }
  }

  // Plan/28 Wave D.1: seed thinking from the SDK's current level so the
  // first room_meta hello already carries it. `pi.getThinkingLevel()` is
  // safe at this point — extension factory has been bound by the SDK
  // before any command handler fires. Future toggles go through the
  // `thinking_level_select` event handler above.
  try {
    _currentThinking = _pi?.getThinkingLevel() as ThinkingLevel | undefined;
  } catch {
    /* defensive — never block /unbien start on this */
  }

  const roomMeta: {
    name: string;
    cwd: string;
    model?: string;
    thinking?: ThinkingLevel;
    sessionId?: string;
  } = { name: sessionName, cwd };
  const modelName = _currentModelName();
  if (modelName) roomMeta.model = modelName;
  if (_currentThinking) roomMeta.thinking = _currentThinking;
  // The room's OWN pi sessionId on the announce — so the app keys per-session
  // state by the pi id (wire identity), not the routing roomId. roomId stays
  // relay-routing only.
  const rootSid =
    _rootState().sessionManager?.getSessionId() ?? _rootSessionId ?? undefined;
  if (rootSid) roomMeta.sessionId = rootSid;
  // Persist so _attemptReconnect can replay the same hello payload — without
  // this, reconnect issues a bare hello and the relay creates a "default room"
  // entry that surfaces in the app as a phantom legacy session.
  _myRoomMeta = roomMeta;

  ctx.ui.notify(
    `[un-bien] Connecting to relay ${relayUrl} (source: ${source}, room: ${roomId})…`,
    "info",
  );

  // Transport opens WebSocket; convert the canonical http(s):// stored
  // form to ws(s):// at this boundary. The relayUrl variable keeps the
  // http(s):// form for logging + mesh client construction below.
  const relay = new RelayClient(toWebSocketUrl(relayUrl), edKp);
  try {
    await relay.connect({ roomId, roomMeta });
  } catch (err) {
    // A rejected local candidate is never published and must always be closed,
    // regardless of whether this lifecycle is still authoritative.
    try {
      relay.close();
    } catch {
      /* best-effort rejected candidate cleanup */
    }
    // A stop, shutdown/replacement, relay-off, or newer start may supersede a
    // candidate before its rejection arrives. Keep the outgoing context silent;
    // only the authoritative attempt may report an error.
    if (!isCurrentCandidate()) return;
    if (err instanceof RoomAlreadyOpenError) {
      ctx.ui.notify(
        "[un-bien] Already running in this cwd. Stop the other terminal first.",
        "error",
      );
      return;
    }
    ctx.ui.notify(`[un-bien] relay connect failed: ${String(err)}`, "error");
    return;
  }

  // The candidate is local until this publication point. Session shutdown,
  // stop/relay-off, or a newer start may have invalidated it while connect()
  // was pending; never let that stale continuation resurrect the Relay.
  if (!isCurrentCandidate()) {
    try {
      relay.close();
    } catch {
      /* best-effort stale candidate cleanup */
    }
    return;
  }

  _relay = relay;
  _relayUrl = relayUrl;
  _peerShort = myShort;
  _myRoomId = roomId;
  _state = "started";
  // Set _sessionStartedAt ONLY on first /unbien start since process boot.
  // Subsequent start cycles (after stop) preserve the original epoch so the
  // app keeps treating it as the same session (and merges new events from
  // the terminal turns that happened during the idle window). Pi process
  // restart is the only thing that produces a fresh session_started_at.
  if (_sessionStartedAt === null) _sessionStartedAt = Date.now();
  // _messageBuffer intentionally preserved across stop/start — it accumulates
  // message_end events for the lifetime of the Pi process, including turns
  // initiated from the terminal while the relay was disconnected.

  relay.on("close", () => _onRelayClose(relay));

  _stopAutoListener = _installAutoListener(relay);
  _refreshFooter(ctx);

  // SelfRevoke is the Pi path's single initial topology producer. Its first
  // coalesced sweep always publishes verified membership or a safe fallback
  // before the bridge may attach.
  let createdProducer = false;
  if (_selfRevoke === null) {
    createdProducer = true;
    const producerEpoch = ++_selfRevokeEpoch;
    _selfRevokeTopologyReadyEpoch = -1;
    _selfRevokeTopology = null;
    let producer!: SelfRevoke;
    producer = new SelfRevoke({
      client: new MeshClient(relayUrl),
      storage: { snapshotOwnerPubkeys, conditionalRemovePeer },
      myPubkey: edKp.publicKey,
      onRevoke: (rawOwnerPubkey, canonicalOwnerPubkey) => {
        if (_selfRevoke !== producer || producerEpoch !== _selfRevokeEpoch) {
          return;
        }
        _revokeActiveOwnerRuntime(canonicalOwnerPubkey);
        void rawOwnerPubkey; // exact storage removal already happened upstream
      },
      onAuthoritativeOwners: (canonicalOwnerPubkeys) => {
        if (_selfRevoke !== producer || producerEpoch !== _selfRevokeEpoch) {
          return;
        }
        const presentOwners = new Set(canonicalOwnerPubkeys);
        let effectFailed = false;
        for (const canonicalOwnerPubkey of [..._activePeers.keys()]) {
          if (_selfRevoke !== producer || producerEpoch !== _selfRevokeEpoch) {
            return;
          }
          if (presentOwners.has(canonicalOwnerPubkey)) continue;
          try {
            _revokeActiveOwnerRuntime(canonicalOwnerPubkey);
          } catch {
            effectFailed = true;
          }
        }
        if (effectFailed)
          throw new Error("Owner runtime reconciliation failed");
      },
      onTopologyChanged: (snapshot) => {
        if (_selfRevoke !== producer || producerEpoch !== _selfRevokeEpoch) {
          return;
        }
        _selfRevokeTopology = snapshot;
        _meshNode?.setTopology(snapshot);
        _selfRevokeTopologyReadyEpoch = producerEpoch;
        _attachBridgeIfReady();
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    _selfRevoke = producer;
    producer.start();
    await producer.checkOnce();
    if (
      _disposed ||
      _selfRevoke !== producer ||
      producerEpoch !== _selfRevokeEpoch ||
      _relay !== relay
    ) {
      return;
    }
  }

  // Relay reconnect reuses the current producer's retained snapshot. Initial
  // startup is callback-driven above, so it must not issue a second attach.
  if (!createdProducer) _attachBridgeIfReady();

  _emitRelayState(); // → connected
  ctx.ui.notify(
    `[un-bien] state: started (peer=${myShort}) — Connected to relay ${relayUrl}`,
    "info",
  );
}

/**
 * `/unbien pair` — always generates a fresh QR when the relay is up.
 *
 * Pre-W2D this rejected with "Already paired with X" once one owner was
 * connected, forcing /unbien stop to pair a second device — the
 * catch-22 the multi-channel refactor was designed to break. Now the new
 * device is **added** to `_activePeers` after scanning, while existing
 * owners keep their session.
 */
async function _cmdPair(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  args = "",
): Promise<void> {
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : "";

  // Auto-bootstrap when services are down. Before this, `/unbien pair`
  // on a fresh terminal forced the user to call `/unbien` first — every
  // session began with the same surprise warning + second command. Now we
  // do the join + relay-start inline so the common "I just opened a
  // terminal and want to pair my phone" flow is a single command.
  //
  // We don't run the first-time wizard here: pair is a focused operation
  // and the wizard prompts are wrong UX in that flow. If there's no local
  // config, the user truly needs to run `/unbien` first to configure.
  if (_state === "idle") {
    if (!localConfigExists(cwd)) {
      ctx.ui.notify(
        "[un-bien] First-time setup needed. Run /unbien to configure, then /unbien pair.",
        "warning",
      );
      return;
    }
    ctx.ui.notify("[un-bien] Starting mesh + relay before pairing…", "info");
    if (!_meshNode) await _cmdJoin(ctx);
    if (_state === "idle") await _cmdStart(ctx);
  }

  // Relay must be up — the QR carries a token the app exchanges through
  // the relay. Without a live WS there's nothing for the scan to land on.
  if (_state === "idle" || !_relay) {
    ctx.ui.notify(
      "[un-bien] Pair requires the relay to be connected. " +
        "Run /unbien to start it (or fix your relay URL via /unbien set-relay).",
      "warning",
    );
    return;
  }

  const edKp = _cachedEd25519!;
  // Embed the user-configured name in the QR so the app shows it on the
  // pairing screen before pair_ok lands (better UX than "remote" or a
  // raw path snippet).
  const sessionName = _displayName(cwd);

  // Optional `--ttl <seconds>` — RPC clients (e.g. Cockpit) pass a caller-
  // defined expiry. Defaults to TOKEN_TTL_MS, clamped to the safe window.
  const ttlMatch = /--ttl\s+(\d+)/.exec(args);
  const ttlMs = ttlMatch
    ? clampPairTtlMs(Number(ttlMatch[1]) * 1000)
    : TOKEN_TTL_MS;
  const { token, expiresAt } = qrSession.issueToken(ttlMs);
  // The QR room is the ISSUING session's room (session-id-derived `_myRoomId`).
  // Pairing is room-scoped to this session (it owns the QR token), so only this
  // session answers the pair_request — no fan-out race. Trust still lands on the
  // MACHINE: pair_ok persists a PairedMachine keyed by epk, and the app then
  // discovers all the machine's sessions via room_announced.
  const roomId = _myRoomId ?? _deriveRoomId(cwd, sessionName);
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
      customType: "un-bien:pair-code",
      content:
        `📱 Scan to pair:\n\n${qrAscii}\n` +
        `📋 Or copy this pairing code (camera-less devices):\n\n${qrUri}`,
      // Structured payload for RPC clients (e.g. Cockpit): render their own QR
      // from `uri` + show the expiry, without scraping the display string.
      details: { uri: qrUri, token, expiresAt, roomId, name: sessionName },
      display: true,
    });
  }

  ctx.ui.notify(
    `[un-bien] QR ready — valid until ${new Date(expiresAt).toLocaleTimeString()}. ` +
      `Scan with the app, or copy the pairing code printed above.`,
    "info",
  );
  // Returns immediately; the auto-listener transitions to 'paired' on pair_request.
}

/**
 * `/unbien stop` — full teardown. Leaves the local UDS mesh AND closes
 * the relay. Safe when one or both are already off. To resume, run
 * `/unbien` again.
 */
async function _cmdStop(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  // Invalidate queued root work and local async candidates even when none has
  // published yet.
  _rootLifecycleGeneration += 1;
  _meshJoinGeneration += 1;
  const meshUp = _meshNode !== null;
  const relayUp = _state !== "idle";
  if (!meshUp && !relayUp) {
    _relayLifecycleGeneration += 1;
    ctx.ui.notify("[un-bien] Already stopped — nothing to do.", "info");
    return;
  }

  // Revoke Relay/SelfRevoke/bridge authority while the global node is still
  // visible and before close() begins UDS leave.
  if (relayUp) {
    _goIdle();
  } else {
    _relayLifecycleGeneration += 1;
    _meshNode?.detachBridge();
  }

  const meshNode = _meshNode;
  _meshNode = null;
  _sessionName = null;
  _sessionPeerCount = 0;
  let meshClose: Promise<void> | null = null;
  try {
    meshClose = meshNode?.close() ?? null;
  } catch {
    /* best-effort */
  }
  try {
    await meshClose;
  } catch {
    /* best-effort */
  }

  ctx.ui.notify("[un-bien] Stopped (mesh + relay disconnected).", "info");
  _refreshFooter(ctx);
}

async function _cmdList(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const peers = await listPeers();
  if (peers.length === 0) {
    ctx.ui.notify("[un-bien] No paired devices.", "info");
    return;
  }
  // Multi-channel (W2D): each peer is either `online` (channel attached
  // right now) or `offline` (in peers.json but not connected). Replaces
  // the singleton " (active)" marker that only ever marked one peer.
  const lines = peers
    .flatMap((record) => {
      const inspected = _inspectPeerRecord(record);
      if (!inspected) return [];
      const tag =
        inspected.runtimeKey !== null && _activePeers.has(inspected.runtimeKey)
          ? " 🟢 online"
          : " ⚪ offline";
      return `• ${inspected.rawHandle.slice(0, 8)} — ${inspected.record.name}${tag}`;
    })
    .join("\n");
  ctx.ui.notify(`[un-bien] Paired devices:\n${lines}`, "info");
}

async function _cmdRevoke(
  arg: string,
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  const shortid = arg.trim();
  if (!shortid) {
    ctx.ui.notify(
      "[un-bien] Usage: /unbien revoke <shortid>. Run /unbien list to see shortids.",
      "warning",
    );
    return;
  }

  // Revoke needs the relay so the revoked device's live channel is torn down
  // — not just a silent peers.json edit. Auto-bootstrap the mesh + relay when
  // down, mirroring `_cmdPair`.
  const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : "";
  if (_state === "idle") {
    if (!localConfigExists(cwd)) {
      ctx.ui.notify(
        "[un-bien] First-time setup needed. Run /unbien to configure, then /unbien revoke.",
        "warning",
      );
      return;
    }
    ctx.ui.notify("[un-bien] Starting mesh + relay before revoking…", "info");
    if (!_meshNode) await _cmdJoin(ctx);
    if (_state === "idle") await _cmdStart(ctx);
  }
  if (_state === "idle" || !_relay) {
    ctx.ui.notify(
      "[un-bien] Revoke requires the relay to be connected. " +
        "Run /unbien to start it (or fix your relay URL via /unbien set-relay).",
      "warning",
    );
    return;
  }

  const matches = (await listPeers())
    .map(_inspectPeerRecord)
    .filter((peer): peer is InspectedPeerRecord => peer !== null)
    .filter((peer) => peer.rawHandle.startsWith(shortid));

  if (matches.length === 0) {
    ctx.ui.notify(
      "[un-bien] No peer matching that shortid. Run /unbien devices to see shortids.",
      "warning",
    );
    return;
  }

  if (matches.length > 1) {
    const collisions = matches
      .map((peer) => peer.rawHandle.slice(0, 8))
      .join(", ");
    ctx.ui.notify(
      `[un-bien] Ambiguous shortid — ${matches.length} matches: ${collisions}. Use mais chars.`,
      "warning",
    );
    return;
  }

  const peer = matches[0]!;
  await removePeer(peer.rawHandle);
  _refreshPairingsCache();

  // Storage removal uses the exact saved representation; the active channel
  // is indexed by its canonical identity.
  if (peer.runtimeKey !== null && _activePeers.has(peer.runtimeKey)) {
    _detachPeerChannel(peer.runtimeKey);
    _refreshFooter();
  }

  ctx.ui.notify(
    `[un-bien] Revoked: ${peer.record.name} (${peer.rawHandle.slice(0, 8)}…)`,
    "info",
  );
}

async function _shortidCompletions(
  prefix: string,
  valuePrefix = "",
): Promise<Array<{ value: string; label: string }>> {
  const peers = (await listPeers())
    .map(_inspectPeerRecord)
    .filter((peer): peer is InspectedPeerRecord => peer !== null);
  return peers
    .map((peer) => ({
      shortid: peer.rawHandle.slice(0, 8),
      name: peer.record.name,
    }))
    .filter((entry) => entry.shortid.startsWith(prefix))
    .map((entry) => ({
      value: `${valuePrefix}${entry.shortid}`,
      label: `${entry.shortid} (${entry.name})`,
    }));
}

function _cmdSetRelay(arg: string, ctx: Pick<ExtensionContext, "ui">): void {
  const raw = arg.trim();
  if (!raw) {
    ctx.ui.notify(
      "[un-bien] Usage: /unbien set-relay <http:// or https:// url>",
      "warning",
    );
    return;
  }
  if (isWebSocketScheme(raw)) {
    ctx.ui.notify(
      `[un-bien] Use http:// or https://. The extension converts to WebSocket automatically.`,
      "error",
    );
    return;
  }
  if (!isValidRelayUrl(raw)) {
    ctx.ui.notify(
      `[un-bien] Invalid URL: ${raw}. Must start with http:// or https://`,
      "error",
    );
    return;
  }
  saveConfig({ relay: raw });
  ctx.ui.notify(
    `[un-bien] Relay set to ${raw}. Run /unbien relay stop then /unbien relay start to apply.`,
    "info",
  );
}

/**
 * `/unbien config` — print the effective relay URL and where it came from.
 *
 * Documented in the README ("Verify the active URL and its source") and in
 * CLAUDE.md, but like the `relay` family (issue #119) it had no handler and
 * fell through to the status panel, which shows the URL but not the source —
 * so `env` vs `config` vs `default` was unverifiable without a restart.
 */
function _cmdConfig(ctx: Pick<ExtensionContext, "ui">): void {
  const { url, source } = resolveRelayUrl();
  const origin =
    source === "env"
      ? "UNBIEN_RELAY environment variable"
      : source === "config"
        ? "extensions/un-bien.json (set via /unbien set-relay)"
        : "not set — run /unbien set-relay <url> or set UNBIEN_RELAY";
  const live =
    _relayUrl && _relayUrl !== url
      ? `\n  ⚠ Live connection still on ${_relayUrl} — run /unbien relay stop then /unbien relay start to apply.`
      : "";
  ctx.ui.notify(
    `[un-bien]\n  Relay URL: ${url ?? "(none)"}\n  Source: ${source} — ${origin}${live}`,
    "info",
  );
}

/**
 * `/unbien identity` — report NON-SECRET identity state (active EPK, backend,
 * resolved source). The private seed is NEVER shown: command output is
 * LLM-visible, so extraction stays a manual `cat`/keychain op. Read-only
 * (never mints).
 */
async function _cmdIdentity(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
  const info = await describeIdentity();
  const backendLine =
    info.backend === "file" ? `file (${info.filePath})` : "keychain";
  const epkLine = info.epk ?? "(none yet — minted on first use)";
  const sourceLine = info.detail
    ? `${info.source} — ${info.detail}`
    : info.source;
  ctx.ui.notify(
    `[un-bien] identity\n  Backend: ${backendLine}\n  EPK (public): ${epkLine}\n  Source: ${sourceLine}`,
    info.source === "error" ? "error" : "info",
  );
}

/**
 * `/unbien relay [start|stop|status|url <url>]` — issue #119.
 *
 * The README has always documented this family (`relay url` to point at a
 * self-hosted relay, `relay stop` + `relay start` to apply the change), but no
 * handler existed: every `relay …` invocation fell through the `else` in the
 * flat dispatcher and silently reprinted the status panel. Users following the
 * README believed they had switched relays and stayed on the community relay —
 * exactly the case where our own docs warn the operator sees routed plaintext.
 *
 * Verbs map onto the same primitives the RPC control channel already uses
 * (`_handleControl`), so the slash command and the Cockpit button can't drift:
 * relay-only up (`_cmdStart`) / relay-only down (`_goIdle`), never touching
 * local-mesh membership — that stays `/unbien stop`'s job.
 */
async function _cmdRelay(arg: string, ctx: ExtensionContext): Promise<void> {
  const raw = arg.trim();
  const [verb, ...rest] = raw.split(/\s+/);
  const value = rest.join(" ").trim();

  switch (verb) {
    case "":
    case "toggle":
      await _handleControl("relay:toggle");
      ctx.ui.notify(`[un-bien] Relay ${_relayStatus()}.`, "info");
      _refreshFooter(ctx);
      return;
    case "start":
    case "on":
      if (_getState() === "idle") await _cmdStart(ctx);
      else ctx.ui.notify(`[un-bien] Relay already ${_relayStatus()}.`, "info");
      _emitRelayState(true);
      return;
    case "stop":
    case "off":
      if (_getState() === "idle") {
        ctx.ui.notify("[un-bien] Relay already disconnected.", "info");
      } else {
        _goIdle();
        ctx.ui.notify(
          "[un-bien] Relay disconnected (local mesh untouched).",
          "info",
        );
      }
      _emitRelayState(true);
      _refreshFooter(ctx);
      return;
    case "status":
      _cmdStatus(ctx);
      _emitRelayState(true);
      return;
    case "url":
      // Same writer as `set-relay` — one code path, so validation and the
      // "restart to apply" hint can never diverge between the two spellings.
      _cmdSetRelay(value, ctx);
      return;
    default:
      ctx.ui.notify(
        "[un-bien] Usage: /unbien relay [start|stop|status|url <http(s) url>]",
        "warning",
      );
      return;
  }
}

// ── Install/uninstall the launcher-daemon service ────────────────────────────
//
// Installs the un-bien launcher daemon as a user-level system service (systemd
// `--user` unit on Linux, launchd LaunchAgent on macOS, Task Scheduler on
// Windows). Once installed the launcher daemon starts at login + survives
// reboots. Uninstall is the inverse.

/**
 * `linkCli` controls whether we symlink `un-bien` into `~/.local/bin/`. The
 * slash-command path passes `true` (user is inside Pi's TUI — they installed
 * via `pi install npm:un-bien` and need us to expose the CLI for them). The
 * standalone-CLI path passes `false` because the user is already running our
 * binary from PATH (they did `npm install -g un-bien`), so re-linking would
 * point their `un-bien` at the Pi-extension copy and diverge on upgrades.
 */
/** Returns true on success, false when install failed (so the standalone CLI
 *  can exit non-zero — e.g. the Cockpit / CI detect failure by exit code).
 *  We do NOT process.exit here: this also runs inside the Pi TUI, where exiting
 *  would kill the session. */
function _cmdInstall(
  ctx: Pick<ExtensionContext, "ui">,
  opts: { linkCli?: boolean } = {},
): boolean {
  const linkCli = opts.linkCli ?? false;
  try {
    const result = installService();
    const sections = [
      `[un-bien] Launcher daemon service installed (${result.platform}).`,
      `  Unit: ${result.unitPath}`,
      `  Steps:\n${result.log.map((l) => "    " + l).join("\n")}`,
    ];
    if (linkCli) {
      const link = linkCliBinaries();
      sections.push(
        `  CLI bins linked into ${link.binDir}:`,
        link.links.map((l) => `    ${l.name} → ${l.target}`).join("\n"),
        `  Steps:\n${link.log.map((l) => "    " + l).join("\n")}`,
      );
      if (!link.onPath) {
        if (process.platform === "win32") {
          sections.push(
            `  ⚠ ${link.binDir} was just added to your user PATH (it wasn't there yet).`,
            `    Open a NEW terminal and run \`unbien status\` to verify.`,
          );
        } else {
          sections.push(
            `  ⚠ ${link.binDir} is not on $PATH yet. Add this line to ~/.zshrc / ~/.bashrc:`,
            `      export PATH="$HOME/.local/bin:$PATH"`,
            `    Then open a new terminal and run \`unbien status\` to verify.`,
          );
        }
      }
    }
    ctx.ui.notify(sections.join("\n"), "info");
    return true;
  } catch (err) {
    ctx.ui.notify(`[un-bien] install failed: ${String(err)}`, "error");
    return false;
  }
}

function _cmdUninstall(
  ctx: Pick<ExtensionContext, "ui">,
  opts: { linkCli?: boolean } = {},
): void {
  const linkCli = opts.linkCli ?? false;
  try {
    const result = uninstallService();
    const sections = [
      `[un-bien] Launcher daemon service uninstalled (${result.platform}).`,
      `  Unit: ${result.unitPath} (${result.removed ? "removed" : "not present"})`,
      `  Steps:\n${result.log.map((l) => "    " + l).join("\n")}`,
    ];
    if (linkCli) {
      const unlink = unlinkCliBinaries();
      sections.push(
        `  CLI bins cleanup (${unlink.binDir}):`,
        unlink.removed
          .map(
            (r) => `    ${r.name} (${r.existed ? "removed" : "not present"})`,
          )
          .join("\n"),
      );
    }
    ctx.ui.notify(sections.join("\n"), "info");
  } catch (err) {
    ctx.ui.notify(`[un-bien] uninstall failed: ${String(err)}`, "error");
  }
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
  const candidateB = join(parent, "skills"); // src → skills
  if (existsSync(candidateA)) return parent.replace(/\/dist$/, "");
  if (existsSync(candidateB)) return parent;
  return parent;
}

function _deployAgentNetworkSkill(): void {
  // Pi SDK spec (core/skills.js): every skill must live at
  //   <skillsRoot>/<skill-name>/SKILL.md
  // The skill `name:` frontmatter must equal the parent directory name. We
  // ship the source pre-arranged that way so deploy is a straight copy into
  // ~/.pi/un-bien/skills/agent-network/SKILL.md.
  const root = _resolveExtensionDir();
  const src1 = join(root, "skills", "agent-network", "SKILL.md");
  const src2 = join(root, "..", "skills", "agent-network", "SKILL.md");
  const src = existsSync(src1) ? src1 : existsSync(src2) ? src2 : null;
  if (!src) return;
  const dstDir = join(skillsDir(), "agent-network");
  const dst = join(dstDir, "SKILL.md");
  try {
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, dst);
    // Cleanup legacy deploy at ~/.pi/un-bien/skills/agent-network.md (flat
    // layout, fails the Pi SDK's name-vs-parent-dir validation).
    const legacy = join(skillsDir(), "agent-network.md");
    if (existsSync(legacy)) {
      try {
        unlinkSync(legacy);
      } catch {
        /* ignored */
      }
    }
  } catch {
    /* best-effort */
  }
}

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
>;

type WakeAgentResult = { ok: true } | { ok: false; detail: string };

function _wakeAgent(
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
  label: string,
  steeringBehavior?: SendUserMessageOptions["deliverAs"],
): WakeAgentResult {
  if (!_pi) {
    const detail = "agent session not bound yet";
    console.error(`[un-bien] ${label}: ${detail} — message dropped`);
    return { ok: false, detail };
  }
  try {
    const options = steeringBehavior
      ? { deliverAs: steeringBehavior }
      : undefined;
    _pi.sendUserMessage(content, options);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[un-bien] ${label}: agent rejected incoming message: ${detail}`,
    );
    _safeNotify(
      `[un-bien] failed to process incoming message: ${detail}`,
      "error",
    );
    return { ok: false, detail };
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
    typeof env.body === "string" ? env.body : JSON.stringify(env.body);
  const header = `[agent-network] message from "${env.from}" (id=${env.id}${env.re ? `, re=${env.re}` : ""}):`;
  const footer = env.re
    ? "(This is a reply to a previous message of yours.)"
    : `(If a reply is expected, call agent_send with to="${env.from}" and re="${env.id}".)`;
  return {
    customType: "un-bien:mesh-message",
    content: `${header}\n${bodyText}\n\n${footer}`,
    display: true,
  };
}

function _scheduleMeshMessageDrain(): void {
  if (_meshDrainScheduled || _pendingMeshMessages.length === 0) return;
  _meshDrainScheduled = true;
  queueMicrotask(() => {
    _meshDrainScheduled = false;
    const pi = _pi;
    if (
      _rootState().agentRun.active ||
      !pi ||
      _pendingMeshMessages.length === 0
    )
      return;

    const batch = _pendingMeshMessages.splice(0);
    let delivered = 0;
    _rootState().agentRun.active = true;
    try {
      batch.forEach((env, index) => {
        const isLast = index === batch.length - 1;
        pi.sendMessage(
          _meshMessageForAgent(env),
          isLast
            ? { triggerTurn: true, deliverAs: "followUp" }
            : { triggerTurn: false },
        );
        delivered += 1;
      });
    } catch (err) {
      _rootState().agentRun.active = false;
      _pendingMeshMessages = [
        ...batch.slice(delivered),
        ..._pendingMeshMessages,
      ];
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[un-bien] queued mesh delivery failed: ${detail}`);
      _safeNotify(
        `[un-bien] failed to process queued mesh messages: ${detail}`,
        "error",
      );
    }
  });
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
    );
    return;
  }
  _pendingMeshMessages.push(env);
  _scheduleMeshMessageDrain();
}

/** Test-only entry point for verifying mesh-to-agent delivery semantics. */
export function _deliverMeshMessageToAgentForTest(env: MeshEnvelope): void {
  _deliverMeshMessageToAgent(env);
}

/**
 * Joins the fixed local UDS mesh ("local" session — see LOCAL_SESSION_NAME).
 * Called by `_cmdRoot` on first run and on subsequent runs when the relay
 * is up and the user hasn't explicitly stopped. The session name is no
 * longer user-configurable: every Pi on the same machine joins the same
 * broker.
 */
async function _cmdJoin(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();
  const local = loadLocalConfig(cwd);
  const sessionName = LOCAL_SESSION_NAME;
  // What the user configured for this agent…
  const requestedName = local.agent_name || defaultAgentName(cwd);
  // …and what we actually register: the name the cwd-lock reserved, which is
  // `requestedName` or a `#N` variant when same-named agents share this folder.
  // Falls back to requestedName when join runs without a prior `_cmdRoot` lock
  // (e.g. legacy/test paths).
  const agentName = _lockedName ?? requestedName;

  if (_meshNode) {
    ctx.ui.notify("[un-bien] Already on the local mesh.", "warning");
    return;
  }
  const joinGeneration = ++_meshJoinGeneration;

  ensureGlobalDirs();
  mkdirSync(join(skillsDir(), "..", "sessions", sessionName), {
    recursive: true,
  });

  const sock = sessionSockPath(sessionName);
  const audit = sessionAuditPath(sessionName);
  // Forward the cwd so the broker keys this peer by (cwd, name): a same-folder
  // same-name reincarnation (switch_session re-eval, app restart) takes over the
  // name instead of registering behind a mute `name#N` ghost. Canonicalize via
  // realpath so symlinked cwds map to one identity (matches roomIdForCwd).
  let canonCwd = cwd;
  try {
    canonCwd = realpathSync(cwd);
  } catch {
    /* cwd missing — use raw path */
  }
  const peer = new MeshNode({
    sockPath: sock,
    name: agentName,
    cwd: canonCwd,
    auditPath: audit,
    takeoverExisting: process.env["UNBIEN_DAEMON"] === "1",
  });

  peer.onMessage((env) => {
    const body = env.body as { type?: string } | null;
    // Broker system events: re-query broker for authoritative count.
    // Incremental ±1 drifts when peer_left is missed (leader leaves cleanly,
    // failover, etc.) — querying list_peers makes the count self-healing.
    if (body && (body.type === "peer_joined" || body.type === "peer_left")) {
      _refreshSessionPeerCount(peer, ctx);
      // Plan/25 Wave B: push fresh peer list to all siblings so their
      // remotePeers cache stays current without polling.
      void peer
        .request("broker", { type: "list_peers" }, 2000)
        .then((reply) => {
          const body = reply.body as {
            peers?: string[];
            peers_detailed?: Array<{ pc?: string; address?: string }>;
          } | null;
          // onLocalPeersChanged wants LOCAL-only addresses (list_peers returns
          // the aggregated local + cross-PC roster). Prefer the structured
          // roster (plan/38): a local peer has no `pc`. This is drive-letter
          // safe — a Windows local address `C:\…@app` contains ':' but is NOT
          // remote, so the old naive `!p.includes(":")` misclassified it.
          let local: string[] | null = null;
          const detailed = body?.peers_detailed;
          if (Array.isArray(detailed)) {
            local = detailed
              .filter((p) => !p.pc && typeof p.address === "string")
              .map((p) => p.address as string);
          } else if (Array.isArray(body?.peers)) {
            // Fallback for a legacy broker without `peers_detailed`.
            local = body!.peers!.filter((p) => !p.includes(":"));
          }
          // No-op when the bridge isn't up (follower / relay down).
          if (local) peer.onLocalPeersChanged(local);
        })
        .catch(() => {
          /* bridge not bound yet, or list_peers failed */
        });
      return;
    }
    if (env.from === "broker") return; // other broker control messages — ignore

    // Real agent-to-agent message (SessionPeer already correlated replies via
    // env.re before this point). Show it in the app's TOOL timeline and wake
    // the agent as a CUSTOM message — never as the user's own message.
    _deliverMeshMessageToAgent(env);
  });

  // After failover (leader died, we re-elected): the new broker's peers map
  // starts fresh, but our cached `_sessionPeerCount` is stale. Re-seed it so
  // surviving peers don't carry the pre-failover count forever.
  //
  // The cross-PC bridge re-attach on failover (drop the stale broker ref,
  // re-wire against the fresh `localBroker()` if we were promoted to leader)
  // is handled INSIDE MeshNode — no manual teardown/ensure needed here.
  peer.onReconnect(() => {
    _refreshSessionPeerCount(peer, ctx);
  });

  const isCurrentCandidate = (): boolean =>
    !_disposed && joinGeneration === _meshJoinGeneration && _meshNode === null;

  try {
    const assigned = await peer.connect();
    // The candidate stays local until connect resolves. Shutdown, stop, or a
    // newer join invalidates its generation; close it instead of publishing a
    // ghost peer or allowing _cmdRoot to continue into Relay startup.
    if (!isCurrentCandidate()) {
      try {
        await peer.close();
      } catch {
        /* best-effort */
      }
      return;
    }
    _meshNode = peer;
    _sessionName = sessionName;
    _sessionPeerCount = 1; // optimistic — overwritten by list_peers below
    // Broker broadcasts `peer_joined` only to existing peers when a new one
    // arrives — the newcomer doesn't get retroactive joined events. Ask the
    // broker for the live peer list to seed the count correctly on join.
    _refreshSessionPeerCount(peer, ctx);
    // Tell RPC clients (e.g. Cockpit) the EFFECTIVE mesh name. The broker
    // appends a `#N` suffix only on a same-(cwd,name) collision, so the name we
    // requested and the one actually assigned can differ. Emit a pure-data event
    // (display:false) carrying both + a `changed` flag so the client can rename
    // the agent in its own UI to match what the mesh/relay will show. Fired on
    // every join (incl. failover re-elect, which can re-assign the name), so the
    // client always reflects the live name, not just the first one.
    //
    // plan/38 decision E: we deliberately DO NOT persist `assigned`. A `#N` is a
    // RUNTIME collision resolution; freezing it into `agent_name` fossilizes an
    // accident and causes cross-folder name ping-pong across restarts. The clean
    // name (wizard / explicit `agent_name`) already lives in config or re-derives
    // from `basename(cwd)`; the event above carries the live `#N` for the UI.
    _pi?.sendMessage({
      customType: "un-bien:name-assigned",
      content:
        assigned === requestedName
          ? `Mesh name: ${assigned}`
          : `Mesh name reassigned: "${requestedName}" → "${assigned}" (collision)`,
      details: {
        requested: requestedName,
        assigned,
        changed: assigned !== requestedName,
      },
      display: false,
    });
    ctx.ui.notify(
      `[un-bien] Joined local mesh as "${assigned}" (${peer.currentRole()})`,
      "info",
    );
    _refreshFooter(ctx);
    // Plan/25 Wave B/C: try to bring up cross-PC routing now that the
    // local broker exists. No-op if the relay isn't up yet (will fire
    // again from `_cmdStart`).
    _attachBridgeIfReady();
  } catch (err) {
    // A replacement/stop/newer join can invalidate this candidate before its
    // failure arrives. Clean it up and never notify the outgoing session ctx.
    if (!isCurrentCandidate()) {
      try {
        await peer.close();
      } catch {
        /* best-effort */
      }
      return;
    }
    ctx.ui.notify(`[un-bien] join failed: ${String(err)}`, "error");
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
 * Live-plane frames (message/tool/turn events) fan out as envelopes via
 * `_broadcastEnvelope` from the rpc-envelope producer; this router only
 * handles incoming app→pi requests.
 */
function _abortCurrentTurn(
  fallbackCtx?: Pick<ExtensionContext, "abort">,
): boolean {
  const candidates: Array<Pick<ExtensionContext, "abort"> | null | undefined> =
    [_lastEventCtx, _lastCtx, fallbackCtx];

  for (const candidate of candidates) {
    if (!candidate || candidate === _noopCtx) continue;
    if (typeof candidate.abort !== "function") continue;
    try {
      candidate.abort();
      return true;
    } catch (err) {
      // Only skip SDK stale-ctx throws and try the next candidate. Real abort
      // failures rethrow so the cancel handler can report action_error.
      const msg = err instanceof Error ? err.message : String(err);
      if (/stale|session replacement or reload/i.test(msg)) continue;
      throw err;
    }
  }

  return false;
}

export function _routeClientMessageFrom(
  sender: PlainPeerChannel,
  msg: ClientMessage,
  ctx: Pick<ExtensionContext, "abort">,
): void {
  if (msg.type === "cancel") {
    try {
      const aborted = _abortCurrentTurn(ctx);
      if (!aborted) {
        sender.send({
          type: "error",
          code: "internal_error",
          in_reply_to: msg.id,
          message: "No active Pi context to abort",
        });
        return;
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
      });
    }
    return;
  }
  // extension_ui_response is envelope-only now — handled in _routeRpcCommandFrom.
  if (!_pi) return;
  // Pre-attach / transport-control only. Every stock ACTION case (model_set,
  // thinking_set, list_models, session_compact, session_new → rpc plane;
  // session_launch → un plane; approve_tool → removed feature) is MIGRATED off
  // this switch. ping + pair_request stay: they must work before/independent of
  // an attached rpc peer.
  switch (msg.type) {
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

/**
 * Resets the Pi-side session view after a SUCCESSFUL `session_new`. The app's
 * New Session clears its local store on `action_ok`, but that alone isn't
 * durable: `_messageBuffer` (which answers `session_sync`) is append-only and
 * `_sessionStartedAt` is stamped once, so a later reconnect/restart would
 * replay the OLD history. We clear the buffer and restamp the clock so the
 * envelope `session_sync` reconstructs from a clean slate. The app drops the
 * stale conversation off the new-session `hello` (changed `sessionId`).
 */
function _resetSessionForNew(): void {
  // Restamp the session clock so the app detects the pi restart (session_sync_end
  // carries it). The transcript resets naturally: the app re-fetches via
  // get_entries against the fresh session and drops the old one on the new hello.
  _sessionStartedAt = Date.now();
}

/** Resolve the base dir for tool-arg file lookups from the last command ctx. */
function _resolveToolCwd(): string {
  return _lastCtx && "cwd" in _lastCtx ? _lastCtx.cwd : process.cwd();
}

// ── Standalone CLI ────────────────────────────────────────────────────────────

function _isDirectRun(): boolean {
  try {
    return (
      fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? "")
    );
  } catch {
    return false;
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
  const { createConnection } = await import("node:net");
  return new Promise<string[] | null>((resolve) => {
    const sock = createConnection({ path: sockPath });
    let buf = "";
    let settled = false;
    const done = (result: string[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify({ type: "list_peers" }) + "\n");
      } catch {
        done(null);
      }
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return; // wait for a full line
      const line = buf.slice(0, nl);
      try {
        const env = JSON.parse(line) as {
          body?: { type?: string; peers?: unknown };
        };
        const body = env.body;
        if (
          body &&
          body.type === "list_peers_reply" &&
          Array.isArray(body.peers)
        ) {
          done(body.peers.filter((p): p is string => typeof p === "string"));
          return;
        }
      } catch {
        /* fall through */
      }
      done(null); // a line arrived but it wasn't the reply we expected
    });
    sock.on("error", () => done(null)); // ECONNREFUSED / ENOENT → mesh offline
    sock.on("close", () => done(null));
  });
}

function _cliStubUi(): ExtensionContext["ui"] {
  // SAFETY: the CLI fleet/daemon/setup handlers only ever call ui.notify; the
  // other ExtensionContext["ui"] methods (select/input/editor/…) are never
  // reached on the direct-run path, so a notify-only console shim is safe.
  return {
    notify: (msg: string) => console.log(msg),
  } as unknown as ExtensionContext["ui"];
}

if (_isDirectRun()) {
  const [, , subcmd, ...cliArgs] = process.argv;
  if (subcmd === "devices" || subcmd === "list") {
    const peers = (await listPeers())
      .map(_inspectPeerRecord)
      .filter((peer): peer is InspectedPeerRecord => peer !== null);
    if (peers.length === 0) {
      console.log("[un-bien] No peers");
    } else {
      for (const peer of peers) {
        console.log(`• ${peer.rawHandle.slice(0, 8)} — ${peer.record.name}`);
      }
    }
  } else if (subcmd === "revoke") {
    const shortid = (cliArgs[0] ?? "").trim();
    if (shortid) {
      const matches = (await listPeers())
        .map(_inspectPeerRecord)
        .filter((peer): peer is InspectedPeerRecord => peer !== null)
        .filter((peer) => peer.rawHandle.startsWith(shortid));
      if (matches.length === 0) console.log("No peer matching that shortid");
      else if (matches.length > 1)
        console.log(
          `Ambiguous: ${matches.map((peer) => peer.rawHandle.slice(0, 8)).join(", ")}`,
        );
      else {
        const peer = matches[0]!;
        const { removePeer } = await import("./pairing/storage.js");
        await removePeer(peer.rawHandle);
        console.log(
          `Revoked: ${peer.record.name} (${peer.rawHandle.slice(0, 8)}…)`,
        );
      }
    } else {
      console.log("Usage: revoke <shortid>");
    }
  } else if (subcmd === "set-relay") {
    const raw = (cliArgs[0] ?? "").trim();
    if (!raw) {
      console.log(`Usage: set-relay <url>`);
    } else if (isWebSocketScheme(raw)) {
      console.log(
        `Use http:// or https://. The extension converts to WebSocket automatically.`,
      );
    } else if (isValidRelayUrl(raw)) {
      saveConfig({ relay: raw });
      console.log(`Relay set to ${raw}`);
    } else {
      console.log(`Invalid URL: ${raw}. Must start with http:// or https://`);
    }
  } else if (subcmd === "peers") {
    // Read-only roster of the local + cross-PC mesh. Unlike `devices` (which
    // reads paired phones from peers.json), the mesh roster lives only in the
    // running broker's memory, so we probe the UDS broker. The probe never
    // registers as a peer — it leaves no trace on the mesh (see
    // Broker._tryObserverProbe). Null = no broker reachable on this machine.
    const peers = await probeListPeers(sessionSockPath(LOCAL_SESSION_NAME));
    if (peers === null) {
      console.log(
        "[un-bien] Mesh offline — no agent is running on this machine.",
      );
    } else {
      console.log(`[un-bien] peers:\n${formatPeerInventory(peers)}`);
    }
  } else if (subcmd === "claude") {
    await _cmdClaudeCli(cliArgs);
  } else if (subcmd === "install") {
    // CLI mode = user installed via `npm install -g un-bien`, so the
    // `un-bien` bin is already on $PATH via npm's global prefix. Explicit
    // `linkCli: false` so we never stomp those with symlinks pointing at a
    // parallel Pi-extension install.
    const stubCtx = { ui: _cliStubUi() };
    // Propagate failure as a non-zero exit so callers (Cockpit / CI) detect it
    // — installService throws on a failed schtasks/launchctl/systemctl step.
    if (!_cmdInstall(stubCtx, { linkCli: false })) process.exit(1);
  } else if (subcmd === "uninstall") {
    const stubCtx = { ui: _cliStubUi() };
    // `linkCli: true` even from the CLI: unlinking is ALWAYS safe and must run
    // regardless of how install ran. `unlinkCliBinaries` only removes OUR
    // reserved `un-bien` symlink under `~/.local/bin`; npm-global bins live in
    // a different prefix and are never touched. So a user who installed via the
    // TUI (`/unbien install`, which links) and uninstalls from a shell still
    // gets the link cleaned up — the asymmetry that left an orphaned
    // `~/.local/bin/unbien` behind.
    _cmdUninstall(stubCtx, { linkCli: true });
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
    );
  }
}

// ── `unbien claude` — launch Claude Code connected to the mesh ─────────────

/**
 * Resolve the packaged agent-network skill path
 * (`<pkgRoot>/skills/agent-network/SKILL.md`). Single source of truth shared
 * by both runtimes: Pi discovers it via `resources_discover`, and the Claude
 * launcher injects it as a system prompt (see `_cmdClaudeCli`). Returns null
 * if the file is missing (e.g. running before `pnpm build`).
 */
function _agentNetworkSkillPath(): string | null {
  const here = fileURLToPath(import.meta.url); // dist/index.js (or src/index.ts via tsx)
  const pkgRoot = dirname(dirname(here)); // package root (dist → ..; src → ..)
  const skill = join(pkgRoot, "skills", "agent-network", "SKILL.md");
  return existsSync(skill) ? skill : null;
}

async function _cmdClaudeCli(args: string[]): Promise<void> {
  // Contract: `unbien claude [cwd] [claude-flags...]`. The optional cwd is
  // ONLY the leading positional (first token, not a flag); everything after it
  // is forwarded verbatim to the `claude` binary (e.g. `--resume`, `-c`,
  // `-p "prompt"`). Restricting cwd to the leading token avoids mistaking a
  // flag's value (e.g. the id in `--resume <id>`) for the cwd.
  const hasCwdArg = args.length > 0 && !args[0]!.startsWith("-");
  const targetCwd = hasCwdArg ? args[0]! : process.cwd();
  const passthroughArgs = hasCwdArg ? args.slice(1) : args;

  // Wizard when no local config exists
  if (!localConfigExists(targetCwd)) {
    const suggested = defaultAgentName(targetCwd);
    process.stdout.write(`\n[un-bien] No config found for ${targetCwd}\n`);
    process.stdout.write("Let's set up this agent.\n\n");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const agentName: string = await new Promise((res) =>
      rl.question(`Agent name [${suggested}]: `, (ans) => {
        rl.close();
        res(ans.trim() || suggested);
      }),
    );

    saveLocalConfig(targetCwd, {
      agent_name: agentName,
      auto_start_relay: true,
    });
    process.stdout.write(`[un-bien] Config saved: agent="${agentName}"\n\n`);
  }

  // Resolve mesh server script path (dist/mcp/mesh_server.js)
  const here = fileURLToPath(import.meta.url);
  const distRoot = dirname(here);
  const meshServerPath = resolve(distRoot, "mcp/mesh_server.js");

  if (!existsSync(meshServerPath)) {
    console.log(
      `[un-bien] mesh server not found at ${meshServerPath}. Run pnpm build first.`,
    );
    process.exit(1);
  }

  const absCwd = resolve(targetCwd);
  const SERVER_NAME = "un-bien-mesh";

  // The mesh MCP must be visible ONLY inside a `unbien claude` session — a
  // plain `claude` in the same repo must NOT inherit it (otherwise every
  // ordinary session silently joins the mesh as a stray agent).
  //
  // Older builds registered the server with `claude mcp add -s local`. That
  // scope lives in `~/.claude.json` keyed by the **git repo root** and is
  // inherited by EVERY claude session under that root — which is exactly the
  // leak we're closing. So we no longer write any persistent scope; we load
  // the server through an ephemeral `--mcp-config <tmpfile>` passed on the
  // launch command line (see below). That config is session-only: it is never
  // recorded in any scope `claude mcp list` enumerates, so a normal `claude`
  // sees nothing.
  //
  // Migration: best-effort scrub of the stale `-s local` entry that prior
  // versions left behind (and that is the source of the inherited-mesh bug).
  // Idempotent — a no-op (non-zero, ignored) when the entry is already gone.
  spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "local"], {
    cwd: absCwd,
    stdio: "ignore",
    shell: false,
  });

  // Ephemeral MCP config consumed by `--mcp-config` below. We do NOT bake a
  // `cwd` into it: the server resolves its folder from its own `process.cwd()`,
  // which Claude sets to the directory the session was launched in (verified
  // empirically — NOT the git root, NOT CLAUDE_PROJECT_DIR). We spawn claude
  // with `cwd: absCwd`, the MCP child inherits it, so the server self-identifies
  // as the right agent without leaking that path to any other session.
  // Unique per pid so concurrent `unbien claude` launches don't collide.
  const mcpConfigPath = join(tmpdir(), `un-bien-mesh-mcp-${process.pid}.json`);
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: { command: process.execPath, args: [meshServerPath] },
      },
    }),
  );

  // Inject the agent-network protocol as a system prompt instead of deploying a
  // skill file into ~/.claude. Anyone running `unbien claude` is here to use
  // the mesh, so load the protocol unconditionally — no lazy skill gating, no
  // global skills-dir pollution, and the packaged file is the single source of
  // truth shared with the Pi runtime. Skipped only if the file is missing.
  const skillPath = _agentNetworkSkillPath();

  // Launch flags:
  //   --mcp-config <tmpfile>                       — load the mesh server for
  //       THIS session only (never a persistent scope). We intentionally omit
  //       `--strict-mcp-config` so the user's own persistent MCP servers stay
  //       available alongside the mesh.
  //   --dangerously-load-development-channels TAG  — enable claude/channel push
  //       for our local (non-allowlisted) server, so incoming mesh messages
  //       wake Claude instead of waiting for a get_messages poll. Entries must
  //       be tagged: `server:<name>` for a manually configured MCP server
  //       (`plugin:<name>@<marketplace>` is the plugin form). Shows a one-time
  //       confirmation dialog at startup. Works against the `--mcp-config`
  //       server in current Claude Code; if a build ever fails to match it, the
  //       per-turn `get_messages` poll (mandated by the mesh protocol) still
  //       delivers — we lose the wake, not the messages.
  //   --dangerously-skip-permissions               — auto-approve tool calls
  //   --append-system-prompt-file=<skill>           — load the mesh protocol
  // `--append-system-prompt-file` uses the glued `--flag=value` form (a SINGLE
  // argv token) on purpose: tools that restore a session by capturing and
  // replaying the live process's argv (e.g. cmux) drop the TRAILING token,
  // which here was the skill path — leaving a dangling `--append-system-prompt-file`
  // → `claude` aborts with "argument missing" and the session never comes back.
  // As one token, the worst case is the whole flag being dropped: claude still
  // starts (just without the injected protocol), which is recoverable instead
  // of fatal. (The other flags stay separate pairs — never last, so unaffected,
  // and we don't risk a parser that may not accept `=`.)
  // Any extra args the user passed (e.g. `--resume`, `-c`) are appended last so
  // they reach the claude binary; ours come first as sensible defaults.
  try {
    spawnSync(
      "claude",
      [
        "--mcp-config",
        mcpConfigPath,
        "--dangerously-load-development-channels",
        `server:${SERVER_NAME}`,
        "--dangerously-skip-permissions",
        ...(skillPath ? [`--append-system-prompt-file=${skillPath}`] : []),
        ...passthroughArgs,
      ],
      {
        cwd: absCwd,
        stdio: "inherit",
        shell: false,
      },
    );
  } finally {
    // Session over — drop the ephemeral config so it never lingers as a stray
    // file. spawnSync blocks until claude exits, so claude has long since read
    // it. Best-effort: ignore if already gone.
    try {
      unlinkSync(mcpConfigPath);
    } catch {
      /* already removed */
    }
  }
}
