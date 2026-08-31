import { Buffer } from "node:buffer";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
 *     pair, exactly like the launcher control room);
 *   - a per-child createRpcEnvelope(childPi, …) that produces the child's
 *     transcript on THAT room;
 *   - owner attach (same _findKnownPeer gate as the launcher) + a READ-ONLY inbound
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
  /** Attach the transcript producer for an ACTUAL in-process launch (idempotent).
   *  A keeper created producer-less is upgraded in place — same connection. */
  attach(childPi: ExtensionAPI, ctx: ExtensionContext): void;
  /** Set parentage on the ALREADY-MADE room + re-advertise via room_meta_update
   *  (relay set-once). For a parent learned LATE (in-process, after attach) —
   *  never rebuilds, never re-announces. */
  setParent(parentRoomId: string, parentSessionId?: string): void;
  dispose(): void;
}

export interface SubagentRoomsController {
  /** Hook: called at a NON-root session_start with the child's pi + ctx. */
  onChildSession(
    childPi: ExtensionAPI,
    ctx: ExtensionContext | undefined,
  ): void;
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
 * returns the ROOT room id (roomIdForSession(rootSid)) captured extension-side.
 */
export function initSubagentRooms(
  rootPi: ExtensionAPI,
  opts: {
    getParentRoomId: () => string | null;
    /** The ROOT's pi sessionId — the parent link the app nests by (pi id). */
    getParentSessionId: () => string | null;
    /** Emit a panel_update to the ROOT's attached app channels (the subagents
     *  panel is a root-session surface). Wired to the extension's _panelBroadcast. */
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
  // In-flight keeper builds (async connect) reserved by child sessionId, so a
  // marker's keeper and an in-process session_start can't race into two rooms.
  const building = new Set<string>();
  const pendingAttach = new Map<
    string,
    { childPi: ExtensionAPI; ctx: ExtensionContext }
  >();
  // Parentage queued while a room is still building (race: the child attaches /
  // parent becomes known before the async connect finishes). Applied on build.
  const pendingParent = new Map<
    string,
    { parentRoomId: string; parentSessionId?: string }
  >();
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

  // Normalize a raw subagents:* status to un-bien's stable EXTENDED vocabulary
  // (docs/subagent-events.md §1). We forward the FULL vocab to the app rather
  // than collapsing to 3 states, so the app can render the richer states;
  // unknown values pass through (forward-compatible), empty -> "pending".
  function normalizeStatus(s?: string): string {
    const v = String(s ?? "").toLowerCase();
    switch (v) {
      case "completed":
      case "done":
        return "completed";
      case "running":
      case "started":
      case "in_progress":
      case "in-progress":
        return "running";
      case "failed":
      case "error":
      case "aborted":
      case "stopped":
      case "steered":
      case "compacted":
      case "queued":
      case "created":
        return v;
      default:
        return v || "pending";
    }
  }

  function emitPanel(): void {
    if (disposed) return;
    // Keyed by the child SESSIONID (pi data), NOT the roomId (relay value). The
    // app maps a panel row -> session by sessionId via its hello-sessionId index.
    const items = [...panelBySession.entries()].map(([sessionId, s]) => ({
      id: `agent:${sessionId}`,
      kind: "agent",
      title: s.description || s.type || sessionId,
      status: normalizeStatus(s.status),
      deps: [] as string[],
      meta: { agentType: s.type, startedAt: s.startedAt, sessionId },
    }));
    // SAFETY: this object literal IS a valid panel_update ServerMessage; the
    // ServerMessage union isn't narrowed to that variant at this call site.
    opts.broadcastPanel({
      type: "panel_update",
      key: "subagents",
      title: "Agents",
      icon: "person.2",
      data: { items },
    } as unknown as ServerMessage);
  }

  // Event-asserted child (docs/subagent-events.md §3B/§4): a child whose id is
  // supplied in an EVENT rather than detected via an in-process session_start.
  // CONTRACT (gotgenes' "subagent adapter convention", decision 0012 / CHANGELOG):
  // `subagents:child:session-created` carries `{ sessionId, parentSessionId? }`,
  // emitted synchronously BEFORE bindExtensions(). un-bien's own
  // `unbien:subagent:child` mirrors that shape (+ optional id/type/description/
  // status/cwd). We read those canonical fields; the extra spellings below are
  // defensive only. The child sessionId is REQUIRED. The expectation is the
  // child is un-bien-aware and joins the mesh ITSELF (owns its own transcript);
  // this folds it into the parent's fleet/panel/status + pre-creates the keeper.
  function onChildMarker(raw: unknown): void {
    if (disposed) return;
    const p = (raw ?? {}) as Record<string, unknown>;
    const sessionId =
      (typeof p.sessionId === "string" && p.sessionId) ||
      (typeof p.childSessionId === "string" && p.childSessionId) ||
      undefined;
    if (!sessionId) return; // no child id -> cannot key/track it
    const id = typeof p.id === "string" ? p.id : undefined;
    const type = typeof p.type === "string" ? p.type : undefined;
    const description =
      typeof p.description === "string" ? p.description : undefined;
    const status = typeof p.status === "string" ? p.status : undefined;
    // Enrich if an in-process room already owns this child (dedup on sessionId),
    // else register it fleet-side WITHOUT building a room (the child owns its own).
    const existing = panelBySession.get(sessionId);
    panelBySession.set(sessionId, {
      roomId: existing?.roomId ?? roomIdForSession(sessionId),
      type: type ?? existing?.type,
      description: description ?? existing?.description,
      status: status ?? existing?.status ?? "started",
      startedAt: existing?.startedAt ?? Date.now(),
    });
    if (id) {
      recordToSession.set(id, sessionId);
      const prev = fleet.get(id);
      fleet.set(id, {
        id,
        type: type ?? prev?.type,
        description: description ?? prev?.description,
        status: status ?? prev?.status ?? "started",
        startedAt: prev?.startedAt ?? Date.now(),
      });
    }
    emitPanel();

    // Pre-create the passive KEEPER (holds the room open + room_meta.parent) so
    // an event-asserted / out-of-process child NESTS immediately; an in-process
    // launch (if any) later attaches the producer to THIS same room via
    // ensureChildRoom. Keyed by child sessionId; needs the parent room up.
    const parentRoomId = opts.getParentRoomId();
    const parentSessionId =
      (typeof p.parentSessionId === "string" && p.parentSessionId) ||
      (typeof p.parentSession === "string" && p.parentSession) ||
      (typeof p.parent === "string" && p.parent) ||
      opts.getParentSessionId() ||
      undefined;
    if (parentRoomId) {
      ensureChildRoom(sessionId, {
        relayUrl,
        sessionId,
        roomId: existing?.roomId ?? roomIdForSession(sessionId),
        parentRoomId,
        parentSessionId,
        startedAt: existing?.startedAt ?? Date.now(),
        name: description ?? type ?? "subagent",
        subagentId: id,
        makeHandlers,
        getStatus: () => normalizeStatus(panelBySession.get(sessionId)?.status),
      });
    }
  }

  // Paired disposal (gotgenes `subagents:child:disposed` = `{ sessionId }`, fired
  // in the run's finally on success AND error; un-bien's own
  // `unbien:subagent:disposed` mirrors it). The child session is gone — release
  // our keeper/room + drop it from the panel. For an out-of-process child this
  // closes only OUR keeper conn; the child's own conn (if still up) keeps the
  // room until it leaves. Inert for tintinweb (never emits this).
  function onChildDisposed(raw: unknown): void {
    const p = (raw ?? {}) as Record<string, unknown>;
    const sessionId =
      (typeof p.sessionId === "string" && p.sessionId) ||
      (typeof p.childSessionId === "string" && p.childSessionId) ||
      undefined;
    if (!sessionId) return;
    children.get(sessionId)?.dispose();
    children.delete(sessionId);
    building.delete(sessionId);
    pendingAttach.delete(sessionId);
    pendingParent.delete(sessionId);
    panelBySession.delete(sessionId);
    emitPanel();
  }

  // SAFETY: the pi SDK exposes an `events` bus at runtime that isn't part of
  // its public typings; we read it defensively (optional) and guard below.
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
    // Event-asserted child markers (§3B): gotgenes' authoritative pre-bind event
    // and un-bien's own implementation-neutral marker. Additive — absent, only
    // in-process session_start detection runs.
    unsub.push(events.on("subagents:child:session-created", onChildMarker));
    unsub.push(events.on("unbien:subagent:child", onChildMarker));
    unsub.push(events.on("subagents:child:disposed", onChildDisposed));
    unsub.push(events.on("unbien:subagent:disposed", onChildDisposed));
  }

  function nextRecord(): SubagentRecord | undefined {
    const id = pendingRecords.shift();
    return id ? fleet.get(id) : undefined;
  }

  // Idempotent create-or-attach, keyed by child sessionId (the deterministic
  // roomId's key). The FIRST caller builds the room — a passive keeper when no
  // childPi, or serving when a childPi is supplied; a later in-process
  // session_start ATTACHES the producer to the SAME room. `building` is reserved
  // synchronously so a marker + session_start microseconds apart converge on one
  // room instead of racing into two.
  function ensureChildRoom(
    sessionId: string,
    buildArgs: Omit<Parameters<typeof startChildRoom>[0], "onClosed">,
  ): void {
    const launch =
      buildArgs.childPi && buildArgs.ctx
        ? { childPi: buildArgs.childPi, ctx: buildArgs.ctx }
        : undefined;
    // Parentage to advertise. Gate on parentSessionId — the app nests by it;
    // parentRoomId alone can't. gotgenes / out-of-process advertise EARLY (the
    // connect room_meta below already carries it); tintinweb advertises LATE via
    // setParent (re-advertise, relay set-once). Both funnel through here; the
    // room is NEVER rebuilt.
    const parent =
      buildArgs.parentSessionId && buildArgs.parentRoomId
        ? {
            parentRoomId: buildArgs.parentRoomId,
            parentSessionId: buildArgs.parentSessionId,
          }
        : undefined;
    const existing = children.get(sessionId);
    if (existing) {
      if (launch) existing.attach(launch.childPi, launch.ctx);
      if (parent)
        existing.setParent(parent.parentRoomId, parent.parentSessionId);
      return;
    }
    if (building.has(sessionId)) {
      if (launch) pendingAttach.set(sessionId, launch);
      if (parent) pendingParent.set(sessionId, parent);
      return;
    }
    building.add(sessionId);
    void startChildRoom({
      ...buildArgs,
      onClosed: () => children.delete(sessionId),
    }).then((room) => {
      building.delete(sessionId);
      if (disposed) {
        room.dispose();
        return;
      }
      children.set(sessionId, room);
      const pend = pendingAttach.get(sessionId);
      if (pend) {
        room.attach(pend.childPi, pend.ctx);
        pendingAttach.delete(sessionId);
      }
      // Re-advertise for the just-built room (set-once; harmless when the connect
      // room_meta already carried it) + any parent queued during the build race.
      const pp = pendingParent.get(sessionId);
      if (pp) {
        room.setParent(pp.parentRoomId, pp.parentSessionId);
        pendingParent.delete(sessionId);
      } else if (parent) {
        room.setParent(parent.parentRoomId, parent.parentSessionId);
      }
    });
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
    if (!sessionId) return;
    const parentRoomId = opts.getParentRoomId();
    if (!parentRoomId) return; // root room not up yet — nothing to nest under

    // UPSERT reconcile (deterministic roomId is the meeting point): if a child
    // MARKER (subagents:child:session-created / unbien:subagent:child) already
    // registered this child, that binding is AUTHORITATIVE — enrich it and SKIP
    // the arrival-order record pop (removes the mis-bind risk). Otherwise fall
    // back to arrival-order correlation. Either way we converge on ONE entry.
    const existing = panelBySession.get(sessionId);
    const rec = existing ? undefined : nextRecord();
    const roomId = existing?.roomId ?? roomIdForSession(sessionId);
    const name =
      existing?.description ??
      existing?.type ??
      rec?.description ??
      rec?.type ??
      "subagent";

    // Register/enrich the panel row keyed by the CHILD sessionId (identity from
    // detection); labels/status enrich from the bound record + later events.
    if (rec?.id) recordToSession.set(rec.id, sessionId);
    panelBySession.set(sessionId, {
      roomId,
      type: existing?.type ?? rec?.type,
      description: existing?.description ?? rec?.description,
      status: existing?.status ?? rec?.status ?? "started",
      startedAt: existing?.startedAt ?? rec?.startedAt ?? Date.now(),
    });
    emitPanel();

    // getParentSessionId() returns the PARENT session's bare sessionId directly —
    // exactly what the parent advertises as room_meta.sessionId, so the child
    // nests. (For the subagents that surface it resolves to the root, since
    // managers suppress nested subagents.) Do NOT use the SDK
    // `header.parentSession`: it is the parent's session FILE PATH
    // (…/<ts>_<id>.jsonl), not an id, and a path never equals the parent's
    // advertised sessionId — so every subagent would orphan (shows flat in the
    // home view). Depth-2 under-real-spawner, if ever needed, wants a
    // sessionFile->sessionId map, not filename parsing.
    const header = ctx.sessionManager.getHeader?.() ?? null;
    const parentSessionId = opts.getParentSessionId() ?? undefined;
    // DEBUG (keep until nesting confirmed): header.parentSession is a FILE PATH,
    // so we ignore it and use the root's bare sessionId directly.
    envLog(
      `subagent nest: child=${sessionId.slice(0, 8)} ` +
        `header.parentSession=${String(header?.parentSession)} ` +
        `-> parentSessionId=${String(parentSessionId)}`,
    );
    // The child's real start (session-header timestamp) so its room reports its
    // own start instead of 0; fall back to the panel stamp, then now.
    const startedAt =
      (header?.timestamp ? Date.parse(header.timestamp) : 0) ||
      panelBySession.get(sessionId)?.startedAt ||
      Date.now();

    ensureChildRoom(sessionId, {
      relayUrl,
      childPi,
      ctx,
      sessionId,
      roomId,
      parentRoomId,
      parentSessionId,
      startedAt,
      name,
      subagentId: rec?.id,
      makeHandlers,
      getStatus: () => normalizeStatus(panelBySession.get(sessionId)?.status),
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
  childPi?: ExtensionAPI;
  ctx?: ExtensionContext;
  sessionId: string;
  roomId: string;
  parentRoomId: string;
  parentSessionId?: string;
  startedAt: number;
  name: string;
  subagentId?: string;
  makeHandlers: (ctx: ExtensionContext) => RpcCommandHandlers;
  getStatus: () => string | undefined;
  onClosed: () => void;
}): Promise<ChildRoom> {
  const kp = await getOrCreateEd25519Keypair();
  const relay = new RelayClient(args.relayUrl, kp);
  const channels = new Map<string, PlainPeerChannel>();
  // Passive KEEPER by default: holds the room open + carries room_meta.parent,
  // subscribes to NO child events and answers NO owner RPCs. attach() is the
  // ONLY thing that reads the child / takes pi callbacks, and it runs only on an
  // ACTUAL in-process launch (immediately when built with a childPi, else
  // deferred to session_start).
  let handlers: RpcCommandHandlers | null = null;
  let rpc: { dispose(): void } = { dispose() {} };
  let serving = false;

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
    if (!serving || !handlers) return; // passive keeper answers nothing
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
            session_started_at: args.startedAt,
          } as EnvelopeMessage["ub"],
        });
      } else if (f.type === "get_session_info") {
        // Pull: the app asks this subagent for its own info (lifecycle status).
        // Answered from the extension's tracked state, so it survives app relaunch.
        sender.sendEnvelope({
          ub: {
            type: "session_info",
            status: args.getStatus(),
            ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
          } as EnvelopeMessage["ub"],
        });
      }
    }
  }

  async function gateAndAttach(
    peer: string,
    firstInner: unknown,
  ): Promise<void> {
    if (!serving) return; // keeper doesn't attach owners; the child's conn serves
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
      cwd: args.ctx?.cwd ?? "",
      // Pi ids — the app nests + maps by these; parent (roomId) + subagentId are
      // kept as supplementary (not the logic keys).
      sessionId: args.sessionId,
      ...(args.parentSessionId
        ? { parentSessionId: args.parentSessionId }
        : {}),
      parent: args.parentRoomId,
      ...(args.subagentId ? { subagentId: args.subagentId } : {}),
    },
  });
  envLog(
    `subagent room ${args.roomId} up (child ${args.sessionId.slice(0, 8)}…, parent ${args.parentRoomId})`,
  );

  // Attach the transcript PRODUCER — the ONLY pi.on subscription (child
  // callbacks). Called immediately when built WITH a child pi (in-process direct
  // launch), else deferred to session_start via the returned attach().
  function attach(childPi: ExtensionAPI, ctx: ExtensionContext): void {
    if (serving) return; // idempotent
    handlers = args.makeHandlers(ctx);
    rpc = createRpcEnvelope(childPi, broadcast);
    serving = true;
  }
  if (args.childPi && args.ctx) attach(args.childPi, args.ctx);

  // Re-advertise parentage on this already-open room via room_meta_update (the
  // relay merges it SET-ONCE, never overriding an existing parent). Lets a child
  // whose parent is learned LATE (in-process, after session_start) nest without
  // a re-announce or a rebuild — no dispose/teardown.
  function setParent(parentRoomId: string, parentSessionId?: string): void {
    relay.sendControl({
      type: "room_meta_update",
      room_id: args.roomId,
      meta: {
        parent: parentRoomId,
        ...(parentSessionId ? { parentSessionId } : {}),
      },
    });
  }

  return {
    sessionId: args.sessionId,
    roomId: args.roomId,
    relay,
    channels,
    attach,
    setParent,
    rpc: { dispose: () => rpc.dispose() },
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
