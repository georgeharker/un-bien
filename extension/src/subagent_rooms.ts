import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RelayClient } from "./transport/relay_client.js";
import { PlainPeerChannel } from "./transport/peer_channel.js";
import { getOrCreateEd25519Keypair } from "./pairing/storage.js";
import { _findKnownPeer } from "./pairing/peer_trust.js";
import { roomIdForSession } from "./rooms.js";
import { loadConfig, resolveRelayUrl } from "./config.js";
import {
  dispatchRpcCommand,
  type RpcCommandHandlers,
} from "./session/rpc_inbound.js";
import {
  createRpcEnvelope,
  helloEnvelope,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "./session/rpc_envelope.js";
import { envLog } from "./session/debug_log.js";
import type { ServerMessage } from "./protocol/types.js";

/**
 * Surface each Pi SUBAGENT as its OWN, separate app-facing session — a distinct
 * relay ROOM under the SAME machine identity.
 *
 * A subagent re-activates this extension IN-PROCESS with its own `pi` (its own
 * sessionId). The ROOT never builds a producer for it, so its transcript frames
 * are never produced. This module builds, per child session:
 *   - a per-child RelayClient connected to roomIdForSession(childSessionId) with
 *     room_meta.parent = the root room id (so the app NESTS it), reusing the
 *     machine keypair (pairing is machine-level — the app reaches it with no new
 *     pair, exactly like the presence control room);
 *   - a per-child createRpcEnvelope(childPi, …) that produces the child's
 *     transcript on THAT room;
 *   - owner attach (same _findKnownPeer gate as presence) + a READ-ONLY inbound
 *     surface (get_entries from the child's own sessionManager; session_sync
 *     terminator). No prompt/steer here — view-only (Phase 1).
 *
 * There is NO shared-stream demux: each child is its own room/connection, so the
 * app treats it as a separate session (its own view). Parent linkage is the
 * explicit room_meta.parent field, not correlation.
 *
 * Enablement is opt-in via the un-bien setting `subagents.rooms` (global config,
 * ~/.pi/extensions/un-bien.json). Absent/false ⇒ disabled (a no-op controller).
 *
 * childSessionId <-> subagent record binding is by ARRIVAL ORDER for now (a
 * created event is followed by the child's session_start); the exact key lands
 * when @tintinweb/pi-subagents adds sessionId to subagents:started.
 */

export function subagentRoomsEnabled(): boolean {
  return loadConfig().subagents?.rooms === true;
}

interface SubagentRecord {
  id: string;
  type?: string;
  description?: string;
  status?: string;
  startedAt?: number;
}

interface ChildRoom {
  sessionId: string;
  roomId: string;
  relay: RelayClient;
  channels: Map<string, PlainPeerChannel>;
  rpc: { dispose(): void };
  dispose(): void;
}

export interface SubagentRoomsController {
  /** Hook: called at a NON-root session_start with the child's pi + ctx. */
  onChildSession(childPi: ExtensionAPI, ctx: ExtensionContext | undefined): void;
  dispose(): void;
}

/** No-op controller when the feature is off — keeps the index.ts hooks trivial. */
const NOOP: SubagentRoomsController = {
  onChildSession() {},
  dispose() {},
};

/**
 * Root-side init. Subscribes to the subagents:* bus (record metadata) so a
 * child session_start can bind to the record that spawned it. `getParentRoomId`
 * returns the ROOT room id (roomIdForSession(rootSid)) captured fork-side.
 */
export function initSubagentRooms(
  rootPi: ExtensionAPI,
  opts: {
    getParentRoomId: () => string | null;
    /** The ROOT's pi sessionId — the parent link the app nests by (pi id). */
    getParentSessionId: () => string | null;
    /** Emit a panel_update to the ROOT's attached app channels (the subagents
     *  panel is a root-session surface). Wired to the fork's _panelBroadcast. */
    broadcastPanel: (panel: ServerMessage) => void;
  },
): SubagentRoomsController {
  if (!subagentRoomsEnabled()) return NOOP;

  const resolution = resolveRelayUrl();
  if (!resolution.url) return NOOP; // no relay → nothing to surface to
  const relayUrl: string = resolution.url;

  // FIFO of records seen but not yet bound to a child session (arrival-order
  // bind; see module header). fleet keeps the latest metadata per record id.
  const pendingRecords: string[] = [];
  const fleet = new Map<string, SubagentRecord>();
  const children = new Map<string, ChildRoom>();
  let disposed = false;

  // Subagents PANEL state, keyed by CHILD sessionId (pi data). The panel is
  // produced HERE from child detection (identity) and enriched by subagents:*
  // events (labels/status). Each item carries the child roomId so the app maps
  // a panel row -> session exactly, with NO record-id round-trip.
  const panelBySession = new Map<
    string,
    {
      roomId: string;
      type?: string;
      description?: string;
      status?: string;
      startedAt?: number;
    }
  >();
  const recordToSession = new Map<string, string>();

  function displayStatus(s?: string): string {
    const v = String(s ?? "").toLowerCase();
    if (v === "completed") return "done";
    if (v === "failed" || v === "error" || v === "aborted" || v === "stopped")
      return "failed";
    if (
      v === "running" ||
      v === "started" ||
      v === "in_progress" ||
      v === "steered"
    )
      return "in_progress";
    return "pending";
  }

  function emitPanel(): void {
    if (disposed) return;
    // Keyed by the child SESSIONID (pi data), NOT the roomId (relay value). The
    // app maps a panel row -> session by sessionId via its hello-sessionId index.
    const items = [...panelBySession.entries()].map(([sessionId, s]) => ({
      id: `agent:${sessionId}`,
      kind: "agent",
      title: s.description || s.type || sessionId,
      status: displayStatus(s.status),
      deps: [] as string[],
      meta: { agentType: s.type, startedAt: s.startedAt, sessionId },
    }));
    opts.broadcastPanel({
      type: "panel_update",
      key: "subagents",
      title: "Agents",
      icon: "person.2",
      data: { items },
    } as unknown as ServerMessage);
  }

  const events = (
    rootPi as unknown as {
      events?: { on(e: string, h: (d: unknown) => void): () => void };
    }
  ).events;

  const unsub: Array<() => void> = [];
  if (events) {
    // Adapter for the subagents:* event format (the de-facto standard, also
    // consumed by @geohar/pi-plan). Records supply LABELS (type/description) +
    // STATUS; identity/room come from child detection. created/started seed a
    // pending record for the next child session_start to bind; terminal events
    // update the bound child's status on the panel.
    const onRecord =
      (status: string) =>
      (data: unknown): void => {
        const p = (data ?? {}) as Record<string, unknown>;
        const id = typeof p.id === "string" ? p.id : undefined;
        if (!id) return;
        const type = typeof p.type === "string" ? p.type : undefined;
        const description =
          typeof p.description === "string" ? p.description : undefined;
        const prev = fleet.get(id);
        fleet.set(id, {
          id,
          type: type ?? prev?.type,
          description: description ?? prev?.description,
          status,
          startedAt: prev?.startedAt ?? Date.now(),
        });
        if (status === "created" || status === "started") {
          if (!pendingRecords.includes(id)) pendingRecords.push(id);
        }
        // Already bound to a child? reflect the status/labels on its panel row.
        const sid = recordToSession.get(id);
        const st = sid ? panelBySession.get(sid) : undefined;
        if (st) {
          st.status = status;
          if (type) st.type = type;
          if (description) st.description = description;
          emitPanel();
        }
      };
    unsub.push(events.on("subagents:created", onRecord("created")));
    unsub.push(events.on("subagents:started", onRecord("started")));
    unsub.push(events.on("subagents:completed", onRecord("completed")));
    unsub.push(events.on("subagents:failed", onRecord("failed")));
    unsub.push(events.on("subagents:steered", onRecord("steered")));
    unsub.push(events.on("subagents:compacted", onRecord("compacted")));
  }

  function nextRecord(): SubagentRecord | undefined {
    const id = pendingRecords.shift();
    return id ? fleet.get(id) : undefined;
  }

  function makeHandlers(ctx: ExtensionContext): RpcCommandHandlers {
    const ro = async (): Promise<never> => {
      throw new Error("subagent session is read-only");
    };
    return {
      prompt: ro,
      steer: ro,
      followUp: ro,
      abort: ro,
      setModel: ro,
      setThinkingLevel: ro,
      getEntries: async (since?: string) => {
        const sm = ctx.sessionManager;
        const all = sm.getEntries();
        const sliced =
          typeof since === "string"
            ? (() => {
                const i = all.findIndex((e) => e.id === since);
                return i === -1 ? all : all.slice(i + 1);
              })()
            : all;
        return { entries: sliced, leafId: sm.getLeafId() };
      },
    };
  }

  function onChildSession(
    childPi: ExtensionAPI,
    ctx: ExtensionContext | undefined,
  ): void {
    if (disposed || !ctx?.sessionManager) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId || children.has(sessionId)) return;
    const parentRoomId = opts.getParentRoomId();
    if (!parentRoomId) return; // root room not up yet — nothing to nest under

    const rec = nextRecord();
    const roomId = roomIdForSession(sessionId);
    const name = rec?.description ?? rec?.type ?? "subagent";

    // Register the panel row keyed by the CHILD sessionId (identity from
    // detection); labels/status enrich from the bound record + later events.
    if (rec?.id) recordToSession.set(rec.id, sessionId);
    panelBySession.set(sessionId, {
      roomId,
      type: rec?.type,
      description: rec?.description,
      status: rec?.status ?? "started",
      startedAt: rec?.startedAt ?? Date.now(),
    });
    emitPanel();

    void startChildRoom({
      relayUrl,
      childPi,
      ctx,
      sessionId,
      roomId,
      parentRoomId,
      parentSessionId: opts.getParentSessionId() ?? undefined,
      name,
      subagentId: rec?.id,
      makeHandlers,
      onClosed: () => children.delete(sessionId),
    }).then((room) => {
      if (disposed) {
        room.dispose();
        return;
      }
      children.set(sessionId, room);
    });
  }

  return {
    onChildSession,
    dispose() {
      disposed = true;
      for (const u of unsub) {
        try {
          u();
        } catch {
          /* best-effort */
        }
      }
      for (const room of children.values()) room.dispose();
      children.clear();
    },
  };
}

async function startChildRoom(args: {
  relayUrl: string;
  childPi: ExtensionAPI;
  ctx: ExtensionContext;
  sessionId: string;
  roomId: string;
  parentRoomId: string;
  parentSessionId?: string;
  name: string;
  subagentId?: string;
  makeHandlers: (ctx: ExtensionContext) => RpcCommandHandlers;
  onClosed: () => void;
}): Promise<ChildRoom> {
  const kp = await getOrCreateEd25519Keypair();
  const relay = new RelayClient(args.relayUrl, kp);
  const channels = new Map<string, PlainPeerChannel>();
  const handlers = args.makeHandlers(args.ctx);

  function broadcast(env: EnvelopeMessage): void {
    for (const ch of channels.values()) {
      try {
        ch.sendEnvelope(env);
      } catch {
        /* best-effort per channel */
      }
    }
  }

  function handleRpc(env: EnvelopeMessage, sender: PlainPeerChannel): void {
    if (env.rpc !== undefined) {
      void dispatchRpcCommand(env.rpc as Record<string, unknown>, handlers)
        .then((resp) => {
          if (resp) sender.sendEnvelope(resp);
        })
        .catch(() => {
          /* read-only rejections already shape success:false; ignore */
        });
      return;
    }
    if (env.ub !== undefined) {
      const f = env.ub as Record<string, unknown>;
      if (f.type === "session_sync") {
        // A child room has NO panels/pending-ui of its own; the transcript is
        // the app's native get_entries. Just terminate the sync.
        sender.sendEnvelope({
          ub: {
            type: "session_sync_end",
            ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
            session_started_at: 0,
          } as EnvelopeMessage["ub"],
        });
      }
    }
  }

  async function gateAndAttach(peer: string, firstInner: unknown): Promise<void> {
    if (channels.has(peer)) return;
    const known = await _findKnownPeer(peer);
    if (!known) return; // relay-verified but not a paired owner
    const channel = new PlainPeerChannel(
      relay,
      peer,
      args.roomId,
      () => {}, // stock ClientMessages unused — envelope plane only
      () => channels.delete(peer),
      (env) => handleRpc(env, channel),
      () => args.sessionId, // stamp the child's pi sessionId on every frame
    );
    channels.set(peer, channel);
    // Greet: caps + the child sessionId, so the app turns on the envelope route.
    channel.sendEnvelope(helloEnvelope(["rpc_envelope"], args.sessionId));
    if (isEnvelopeFrame(firstInner as Record<string, unknown>)) {
      handleRpc(firstInner as EnvelopeMessage, channel);
    }
  }

  function onLine(line: string): void {
    let outer: { peer?: string; ct?: string };
    try {
      outer = JSON.parse(line) as { peer?: string; ct?: string };
    } catch {
      return;
    }
    if (!outer.peer || !outer.ct) return;
    if (channels.has(outer.peer)) return; // its channel routes it
    let inner: unknown;
    try {
      inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"));
    } catch {
      return;
    }
    if (!inner || typeof inner !== "object") return;
    void gateAndAttach(outer.peer, inner);
  }

  relay.on("message", onLine);
  relay.on("close", () => {
    channels.clear();
    args.onClosed();
  });

  await relay.connect({
    roomId: args.roomId,
    roomMeta: {
      name: args.name,
      cwd: args.ctx.cwd,
      // Pi ids — the app nests + maps by these; parent (roomId) + subagentId are
      // kept as supplementary (not the logic keys).
      sessionId: args.sessionId,
      ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
      parent: args.parentRoomId,
      ...(args.subagentId ? { subagentId: args.subagentId } : {}),
    },
  });
  envLog(
    `subagent room ${args.roomId} up (child ${args.sessionId.slice(0, 8)}…, parent ${args.parentRoomId})`,
  );

  // Produce the child's transcript on this room (its own pi fires its own events).
  const rpc = createRpcEnvelope(args.childPi, broadcast);

  return {
    sessionId: args.sessionId,
    roomId: args.roomId,
    relay,
    channels,
    rpc,
    dispose() {
      try {
        rpc.dispose();
      } catch {
        /* best-effort */
      }
      for (const ch of channels.values()) {
        try {
          ch.detach();
        } catch {
          /* best-effort */
        }
      }
      channels.clear();
      relay.close();
    },
  };
}
