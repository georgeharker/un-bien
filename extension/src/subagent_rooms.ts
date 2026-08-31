import { Buffer } from "node:buffer"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { RelayClient } from "./transport/relay_client.js"
import { PlainPeerChannel } from "./transport/peer_channel.js"
import { getOrCreateEd25519Keypair } from "./pairing/storage.js"
import { _findKnownPeer } from "./pairing/peer_trust.js"
import { roomIdForSession } from "./rooms.js"
import { loadConfig, resolveRelayUrl } from "./config.js"
import {
  dispatchRpcCommand,
  pageEntries,
  type RpcCommandHandlers,
} from "./session/rpc_inbound.js"
import {
  createRpcEnvelope,
  helloEnvelope,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "./session/rpc_envelope.js"
import { envLog } from "./session/debug_log.js"
import type { ServerMessage } from "./protocol/types.js"

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
  return loadConfig().subagents?.rooms === true
}

interface SubagentRecord {
  id: string
  type?: string
  description?: string
  status?: string
  startedAt?: number
}

interface ChildRoom {
  sessionId: string
  roomId: string
  relay: RelayClient
  channels: Map<string, PlainPeerChannel>
  rpc: { dispose(): void }
  /** Attach the transcript producer for an ACTUAL in-process launch (idempotent).
   *  A keeper created producer-less is upgraded in place — same connection. */
  attach(childPi: ExtensionAPI, ctx: ExtensionContext): void
  /** Set parentage on the ALREADY-MADE room + re-advertise via room_meta_update
   *  (relay set-once). For a parent learned LATE (in-process, after attach) —
   *  never rebuilds, never re-announces. */
  setParent(parentRoomId: string, parentSessionId?: string): void
  dispose(): void
}

export interface SubagentRoomsController {
  /** Hook: called at a NON-root session_start with the child's pi + ctx. */
  onChildSession(childPi: ExtensionAPI, ctx: ExtensionContext | undefined): void
  dispose(): void
}

/** No-op controller when the feature is off — keeps the index.ts hooks trivial. */
const NOOP: SubagentRoomsController = {
  onChildSession() {},
  dispose() {},
}

/**
 * Root-side init. Subscribes to the subagents:* bus (record metadata) so a
 * child session_start can bind to the record that spawned it. `getParentRoomId`
 * returns the ROOT room id (roomIdForSession(rootSid)) captured extension-side.
 */
export function initSubagentRooms(
  rootPi: ExtensionAPI,
  opts: {
    getParentRoomId: () => string | null
    /** The ROOT's pi sessionId — the parent link the app nests by (pi id). */
    getParentSessionId: () => string | null
    /** Emit a panel_update to the ROOT's attached app channels (the subagents
     *  panel is a root-session surface). Wired to the extension's _panelBroadcast. */
    broadcastPanel: (panel: ServerMessage) => void
  },
): SubagentRoomsController {
  if (!subagentRoomsEnabled()) return NOOP

  const resolution = resolveRelayUrl()
  if (!resolution.url) return NOOP // no relay → nothing to surface to
  const relayUrl: string = resolution.url

  // Correlation queues for record-id <-> child-session binding (arrival order;
  // no event carries both ids — see module header). PARTITIONED BINDING:
  // sessions (marker / session_start) only QUEUE — they never pop records;
  // `created` (background-only in gotgenes) does NOT bind — its id returns at
  // `started`, by which time its own session_start has tagged its entry; only
  // `started` / `resumed` pop, and only IN-PROCESS-tagged entries. This keeps a
  // concurrent foreground+background pair from consuming each other's half
  // (bg created stealing a queued fg session; fg session_start stealing a
  // queued bg record), and an out-of-process marker entry (never tagged) from
  // being stolen by an in-process started. Residual: two same-mode concurrent
  // spawns cross-bind only if started order diverges from session_start order
  // — both derive from the manager's admission sequence, so they align.
  const unboundSessions: string[] = []
  const unboundInProcess = new Set<string>()
  // The child's session JSONL path, captured at its session_start — the join
  // key for the authoritative service-match binding below.
  const sessionFileBySession = new Map<string, string>()
  const fleet = new Map<string, SubagentRecord>()
  const children = new Map<string, ChildRoom>()
  // In-flight keeper builds (async connect) reserved by child sessionId, so a
  // marker's keeper and an in-process session_start can't race into two rooms.
  const building = new Set<string>()
  const pendingAttach = new Map<
    string,
    { childPi: ExtensionAPI; ctx: ExtensionContext }
  >()
  // Parentage queued while a room is still building (race: the child attaches /
  // parent becomes known before the async connect finishes). Applied on build.
  const pendingParent = new Map<
    string,
    { parentRoomId: string; parentSessionId?: string }
  >()
  // IN-PROCESS children (a session_start arrived for this sid): disposal
  // LINGERS — room + panel row stay until parent teardown, the room keeps
  // serving the FINISHED transcript (§5: terminal status is a STAMP, not a
  // removal; gotgenes fires child:disposed on success AND error alike).
  const inProcess = new Set<string>()
  // KEEPER-ONLY children RELEASED by a disposal marker. Doubles as the tombstone
  // for the disposed-while-building race: a startChildRoom still connecting when
  // the marker lands checks this on completion and disposes instead of
  // registering a room nobody will ever attach to.
  const keeperReleased = new Set<string>()
  let disposed = false

  // Subagents PANEL state, keyed by CHILD sessionId (pi data). The panel is
  // produced HERE from child detection (identity) and enriched by subagents:*
  // events (labels/status). Each item carries the child roomId so the app maps
  // a panel row -> session exactly, with NO record-id round-trip.
  const panelBySession = new Map<
    string,
    {
      roomId: string
      type?: string
      description?: string
      status?: string
      startedAt?: number
    }
  >()
  const recordToSession = new Map<string, string>()

  // Normalize a raw subagents:* status to un-bien's stable EXTENDED vocabulary
  // (docs/subagent-events.md §1). We forward the FULL vocab to the app rather
  // than collapsing to 3 states, so the app can render the richer states;
  // unknown values pass through (forward-compatible), empty -> "pending".
  function normalizeStatus(s?: string): string {
    const v = String(s ?? "").toLowerCase()
    switch (v) {
      case "completed":
      case "done":
        return "completed"
      case "running":
      case "started":
      case "in_progress":
      case "in-progress":
        return "running"
      case "failed":
      case "error":
      case "aborted":
      case "stopped":
      case "steered":
      case "compacted":
      case "queued":
      case "created":
        return v
      default:
        return v || "pending"
    }
  }

  // Terminal statuses for disposal stamping (the §1 vocabulary's end states): a
  // disposal marker keeps an existing terminal stamp (usually landed via the
  // correlated subagents:completed/failed record event, fired before the run's
  // finally); anything else (running/queued/…) falls back to "stopped".
  const TERMINAL_STATUSES = new Set([
    "completed",
    "failed",
    "error",
    "aborted",
    "stopped",
  ])

  function emitPanel(): void {
    if (disposed) return
    // Keyed by the child SESSIONID (pi data), NOT the roomId (relay value). The
    // app maps a panel row -> session by sessionId via its hello-sessionId index.
    const items = [...panelBySession.entries()].map(([sessionId, s]) => ({
      id: `agent:${sessionId}`,
      kind: "agent",
      title: s.description || s.type || sessionId,
      status: normalizeStatus(s.status),
      deps: [] as string[],
      meta: { agentType: s.type, startedAt: s.startedAt, sessionId },
    }))
    // SAFETY: this object literal IS a valid panel_update ServerMessage; the
    // ServerMessage union isn't narrowed to that variant at this call site.
    opts.broadcastPanel({
      type: "panel_update",
      key: "subagents",
      title: "Agents",
      icon: "person.2",
      data: { items },
    } as unknown as ServerMessage)
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
    if (disposed) return
    const p = (raw ?? {}) as Record<string, unknown>
    const sessionId =
      (typeof p.sessionId === "string" && p.sessionId) ||
      (typeof p.childSessionId === "string" && p.childSessionId) ||
      undefined
    if (!sessionId) return // no child id -> cannot key/track it
    const id = typeof p.id === "string" ? p.id : undefined
    const type = typeof p.type === "string" ? p.type : undefined
    const description =
      typeof p.description === "string" ? p.description : undefined
    const status = typeof p.status === "string" ? p.status : undefined
    // Enrich if an in-process room already owns this child (dedup on sessionId),
    // else register it fleet-side WITHOUT building a room (the child owns its own).
    const existing = panelBySession.get(sessionId)
    panelBySession.set(sessionId, {
      roomId: existing?.roomId ?? roomIdForSession(sessionId),
      type: type ?? existing?.type,
      description: description ?? existing?.description,
      status: status ?? existing?.status ?? "started",
      startedAt: existing?.startedAt ?? Date.now(),
    })
    if (id) {
      bindRecord(id, sessionId)
      const prev = fleet.get(id)
      fleet.set(id, {
        id,
        type: type ?? prev?.type,
        description: description ?? prev?.description,
        status: status ?? prev?.status ?? "started",
        startedAt: prev?.startedAt ?? Date.now(),
      })
    } else if (
      ![...recordToSession.values()].includes(sessionId) &&
      !unboundSessions.includes(sessionId)
    ) {
      // No record id on the marker (gotgenes never carries one): queue the
      // session for the started/created record's symmetric pop.
      unboundSessions.push(sessionId)
    }
    emitPanel()
    envLog(
      `subagent marker: sid=${sessionId.slice(0, 8)} id=${id ?? "-"} queued=${unboundSessions.length}`,
    )

    // Pre-create the passive KEEPER (holds the room open + room_meta.parent) so
    // an event-asserted / out-of-process child NESTS immediately; an in-process
    // launch (if any) later attaches the producer to THIS same room via
    // ensureChildRoom. Keyed by child sessionId; needs the parent room up.
    const parentRoomId = opts.getParentRoomId()
    const parentSessionId =
      (typeof p.parentSessionId === "string" && p.parentSessionId) ||
      (typeof p.parentSession === "string" && p.parentSession) ||
      (typeof p.parent === "string" && p.parent) ||
      opts.getParentSessionId() ||
      undefined
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
      })
    }
  }

  // Paired disposal (gotgenes `subagents:child:disposed` = `{ sessionId }`, fired
  // in the run's finally on success AND error; un-bien's own
  // `unbien:subagent:disposed` mirrors it; inert for tintinweb). Disposal is a
  // TERMINAL STATUS STAMP on the panel row (kept — §5 "failure is a status
  // stamp, not a removal"), then splits on whether the child ever attached
  // in-process:
  //  - IN-PROCESS (session_start seen): LINGER — keep the room serving the
  //    finished transcript until parent teardown. It stays interactive-readable
  //    from the app; nothing is torn down here.
  //  - KEEPER-ONLY (out-of-process child, or one that died before attaching):
  //    release the keeper. An out-of-process child's own conn (if still up)
  //    keeps the room; a fast-fail had no transcript to lose. The stamped panel
  //    row stays either way — the error surface.
  function onChildDisposed(raw: unknown): void {
    const p = (raw ?? {}) as Record<string, unknown>
    const sessionId =
      (typeof p.sessionId === "string" && p.sessionId) ||
      (typeof p.childSessionId === "string" && p.childSessionId) ||
      undefined
    if (!sessionId) return
    envLog(
      `subagent disposed: sid=${sessionId.slice(0, 8)} inProcess=${inProcess.has(sessionId)}`,
    )
    // Stamp the row terminal: the correlated subagents:completed/failed record
    // event usually landed first (fired before the run's finally); "stopped" is
    // the honest fallback when nothing terminal did.
    const row = panelBySession.get(sessionId)
    if (row) {
      const cur = normalizeStatus(row.status)
      row.status = TERMINAL_STATUSES.has(cur) ? cur : "stopped"
    }
    if (!inProcess.has(sessionId)) {
      keeperReleased.add(sessionId)
      children.get(sessionId)?.dispose()
      children.delete(sessionId)
      building.delete(sessionId)
      pendingAttach.delete(sessionId)
      pendingParent.delete(sessionId)
    }
    emitPanel()
  }

  // SAFETY: the pi SDK exposes an `events` bus at runtime that isn't part of
  // its public typings; we read it defensively (optional) and guard below.
  const events = (
    rootPi as unknown as {
      events?: { on(e: string, h: (d: unknown) => void): () => void }
    }
  ).events

  const unsub: Array<() => void> = []
  if (events) {
    // Adapter for the subagents:* event format (the de-facto standard, also
    // consumed by @geohar/pi-plan). Records supply LABELS (type/description) +
    // STATUS; identity/room come from child detection. created/started seed a
    // pending record for the next child session_start to bind; terminal events
    // update the bound child's status on the panel.
    const onRecord =
      (status: string) =>
      (data: unknown): void => {
        const p = (data ?? {}) as Record<string, unknown>
        const id = typeof p.id === "string" ? p.id : undefined
        if (!id) return
        const type = typeof p.type === "string" ? p.type : undefined
        const description =
          typeof p.description === "string" ? p.description : undefined
        const prev = fleet.get(id)
        // `resumed` (gotgenes detached-resume) fires NO started — it jumps
        // straight to a terminal payload whose `status` discriminates. Use it
        // when it's terminal, else stamp the channel verbatim.
        let stamp = status
        if (status === "resumed" && typeof p.status === "string") {
          const s = normalizeStatus(p.status)
          if (TERMINAL_STATUSES.has(s)) stamp = s
        }
        fleet.set(id, {
          id,
          type: type ?? prev?.type,
          description: description ?? prev?.description,
          status: stamp,
          startedAt: prev?.startedAt ?? Date.now(),
        })
        if (!recordToSession.has(id)) {
          // FUTURE-PROOF direct bind — neither implementation emits this TODAY
          // (tintinweb 0.19.0 / gotgenes 21.x carry only the record id), but the
          // child sessionId on record events is the one-field upstream fix that
          // makes binding exact (our module-header TODO has waited for it). If a
          // release adds it, prefer it over every heuristic.
          const payloadSid =
            typeof p.sessionId === "string" ? p.sessionId : undefined
          if (payloadSid && panelBySession.has(payloadSid)) {
            bindRecord(id, payloadSid)
          } else {
            // Layer 1 — AUTHORITATIVE: service outputFile match (any event,
            // any time, no ordering assumptions). Falls through to the FIFO
            // when the service is absent or has no file yet.
            bindByServiceMatch(id)
          }
        }
        if (status === "started" || status === "resumed") {
          if (!recordToSession.has(id)) {
            // Layer 2 — BASE (partitioned FIFO): only started/resumed pop — and
            // only IN-PROCESS-tagged entries. `created` (background-only in
            // gotgenes) does NOT bind: its id returns at started, by which time
            // its own session_start has tagged its entry. Sessions never pop
            // records. This partitions the modes so a concurrent fg+bg pair
            // can't consume each other's half, and an out-of-process marker
            // entry (never tagged) can't be stolen by an in-process started.
            const idx = unboundSessions.findIndex((s) =>
              unboundInProcess.has(s),
            )
            if (idx !== -1) {
              const sid = unboundSessions.splice(idx, 1)[0]
              unboundInProcess.delete(sid)
              bindRecord(id, sid)
            }
          }
        }
        // Already bound to a child? reflect the status/labels on its panel row.
        const sid = recordToSession.get(id)
        const st = sid ? panelBySession.get(sid) : undefined
        if (st) {
          st.status = stamp
          if (type) st.type = type
          if (description) st.description = description
          emitPanel()
        }
        envLog(
          `subagents evt: ${status} id=${id} bound=${sid !== undefined} ` +
            `queued=${unboundSessions.length}(${unboundInProcess.size} ip)`,
        )
      }
    unsub.push(events.on("subagents:created", onRecord("created")))
    unsub.push(events.on("subagents:started", onRecord("started")))
    unsub.push(events.on("subagents:resumed", onRecord("resumed")))
    unsub.push(events.on("subagents:completed", onRecord("completed")))
    unsub.push(events.on("subagents:failed", onRecord("failed")))
    unsub.push(events.on("subagents:steered", onRecord("steered")))
    unsub.push(events.on("subagents:compacted", onRecord("compacted")))
    // Event-asserted child markers (§3B): gotgenes' authoritative pre-bind event
    // and un-bien's own implementation-neutral marker. Additive — absent, only
    // in-process session_start detection runs.
    unsub.push(events.on("subagents:child:session-created", onChildMarker))
    unsub.push(events.on("unbien:subagent:child", onChildMarker))
    unsub.push(events.on("subagents:child:disposed", onChildDisposed))
    unsub.push(events.on("unbien:subagent:disposed", onChildDisposed))
  } else {
    envLog(
      "subagent bus: pi.events MISSING — no marker/record/disposed events will arrive (rooms still work via session_start)",
    )
  }

  /** Bind record id <-> child session, draining the session from the unbound
   *  FIFO. Single binding per record and per session (both sides check first). */
  function bindRecord(recId: string, sessionId: string): void {
    recordToSession.set(recId, sessionId)
    const i = unboundSessions.indexOf(sessionId)
    if (i !== -1) unboundSessions.splice(i, 1)
  }

  // AUTHORITATIVE correlation, zero coupling (layer 1): gotgenes publishes its
  // typed SubagentsService on globalThis under Symbol.for — we probe it
  // STRUCTURALLY (getRecord -> outputFile only, no package import). The
  // record's outputFile is the child's session JSONL path, which we captured
  // at the child's session_start: an exact match binds record<->session with
  // NO ordering assumptions, on ANY event (even a terminal one arriving
  // unbound). Silent when the service is absent — tintinweb (different global,
  // a possible future adapter) and out-of-process children ride the FIFO base
  // layer / the marker-with-id convention instead.
  interface SubagentServiceLike {
    getRecord(id: string): { outputFile?: string } | undefined
  }
  function bindByServiceMatch(recId: string): boolean {
    let file: string | undefined
    try {
      const svc = (globalThis as Record<symbol, unknown>)[
        Symbol.for("@gotgenes/pi-subagents:service")
      ] as SubagentServiceLike | undefined
      file = svc?.getRecord(recId)?.outputFile
    } catch {
      return false
    }
    if (typeof file !== "string") return false
    const sid = unboundSessions.find(
      (s) => sessionFileBySession.get(s) === file,
    )
    if (!sid) return false
    const i = unboundSessions.indexOf(sid)
    if (i !== -1) unboundSessions.splice(i, 1)
    unboundInProcess.delete(sid)
    bindRecord(recId, sid)
    envLog(`subagent bind: service match id=${recId} sid=${sid.slice(0, 8)}`)
    return true
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
        : undefined
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
        : undefined
    const existing = children.get(sessionId)
    if (existing) {
      if (launch) existing.attach(launch.childPi, launch.ctx)
      if (parent)
        existing.setParent(parent.parentRoomId, parent.parentSessionId)
      return
    }
    if (building.has(sessionId)) {
      if (launch) pendingAttach.set(sessionId, launch)
      if (parent) pendingParent.set(sessionId, parent)
      return
    }
    building.add(sessionId)
    void startChildRoom({
      ...buildArgs,
      onClosed: () => children.delete(sessionId),
    }).then((room) => {
      building.delete(sessionId)
      // Controller teardown OR a disposal marker that landed while this build
      // was connecting (keeperReleased tombstone) — nobody will ever attach to
      // this room; dispose instead of registering it.
      if (disposed || keeperReleased.has(sessionId)) {
        room.dispose()
        return
      }
      children.set(sessionId, room)
      const pend = pendingAttach.get(sessionId)
      if (pend) {
        room.attach(pend.childPi, pend.ctx)
        pendingAttach.delete(sessionId)
      }
      // Re-advertise for the just-built room (set-once; harmless when the connect
      // room_meta already carried it) + any parent queued during the build race.
      const pp = pendingParent.get(sessionId)
      if (pp) {
        room.setParent(pp.parentRoomId, pp.parentSessionId)
        pendingParent.delete(sessionId)
      } else if (parent) {
        room.setParent(parent.parentRoomId, parent.parentSessionId)
      }
    })
  }

  function makeHandlers(ctx: ExtensionContext): RpcCommandHandlers {
    const ro = async (): Promise<never> => {
      throw new Error("subagent session is read-only")
    }
    // Capture the sessionManager ONCE, while the ctx is ACTIVE: the child
    // session's dispose() (fired by the manager when its run ends) invalidates
    // the ctx WRAPPER — a later `ctx.sessionManager` read would throw the
    // staleness error. The SessionManager itself stays readable (in-memory
    // entry log; the SDK even types a ReadonlySessionManager for this), which is
    // what lets a LINGERED room keep serving the finished transcript.
    const sm = ctx.sessionManager
    return {
      prompt: ro,
      steer: ro,
      followUp: ro,
      abort: ro,
      setModel: ro,
      setThinkingLevel: ro,
      getEntries: async (since?: string) => {
        // PAGED like the root room's handler (design: get_entries backfill
        // paging) — a lingered child's finished transcript can also exceed a
        // transport cap in one frame. pi-faithful `since` semantics: unknown
        // id → `Entry not found` error (dispatch turns a throw into
        // success:false + error on the response envelope).
        const all = sm.getEntries()
        if (
          typeof since === "string" &&
          all.findIndex((e) => e.id === since) === -1
        )
          throw new Error(`Entry not found: ${since}`)
        return pageEntries(all, since, sm.getLeafId())
      },
    }
  }

  function onChildSession(
    childPi: ExtensionAPI,
    ctx: ExtensionContext | undefined,
  ): void {
    if (disposed || !ctx?.sessionManager) return
    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return
    // In-process lifecycle: disposal of THIS sid lingers (see inProcess). A
    // resurrected session id (resume of the same session file) re-opens it.
    inProcess.add(sessionId)
    keeperReleased.delete(sessionId)
    // Capture the session file — the join key for service-match binding.
    const sessionFile = ctx.sessionManager.getSessionFile?.()
    if (typeof sessionFile === "string") {
      sessionFileBySession.set(sessionId, sessionFile)
    }
    const parentRoomId = opts.getParentRoomId()
    if (!parentRoomId) return // root room not up yet — nothing to nest under

    // UPSERT reconcile (deterministic roomId is the meeting point): if a child
    // MARKER (subagents:child:session-created / unbien:subagent:child) already
    // registered this child, that binding is AUTHORITATIVE — enrich it and SKIP
    // the arrival-order record pop for IDENTITY (removes the mis-bind risk).
    // BUT still BIND the next pending record unless this session already owns
    // one: the gotgenes marker carries no record id, so skipping the pop
    // entirely left the later subagents:completed/failed {id} events unbindable
    // — the row's status stuck on started/running forever (both the panel and
    // get_session_info answers, which read this same map). Identity stays
    // marker-authoritative; only the record BINDING falls back to arrival order.
    const existing = panelBySession.get(sessionId)
    const alreadyBound = [...recordToSession.values()].includes(sessionId)
    if (!alreadyBound) {
      // QUEUE + TAG, never pop (partitioned binding): the entry becomes
      // poppable by a later started/resumed record. The marker usually queued
      // it already; session_start is what TAGS it in-process.
      if (!unboundSessions.includes(sessionId)) unboundSessions.push(sessionId)
      unboundInProcess.add(sessionId)
    }
    const roomId = existing?.roomId ?? roomIdForSession(sessionId)
    const name = existing?.description ?? existing?.type ?? "subagent"

    // Register/enrich the panel row keyed by the CHILD sessionId (identity from
    // detection); labels enrich from a bound record's events once correlated.
    panelBySession.set(sessionId, {
      roomId,
      type: existing?.type,
      description: existing?.description,
      status: existing?.status ?? "started",
      startedAt: existing?.startedAt ?? Date.now(),
    })
    emitPanel()

    // getParentSessionId() returns the PARENT session's bare sessionId directly —
    // exactly what the parent advertises as room_meta.sessionId, so the child
    // nests. (For the subagents that surface it resolves to the root, since
    // managers suppress nested subagents.) Do NOT use the SDK
    // `header.parentSession`: it is the parent's session FILE PATH
    // (…/<ts>_<id>.jsonl), not an id, and a path never equals the parent's
    // advertised sessionId — so every subagent would orphan (shows flat in the
    // home view). Depth-2 under-real-spawner, if ever needed, wants a
    // sessionFile->sessionId map, not filename parsing.
    const header = ctx.sessionManager.getHeader?.() ?? null
    const parentSessionId = opts.getParentSessionId() ?? undefined
    // DEBUG (keep until nesting confirmed): header.parentSession is a FILE PATH,
    // so we ignore it and use the root's bare sessionId directly.
    envLog(
      `subagent nest: child=${sessionId.slice(0, 8)} ` +
        `header.parentSession=${String(header?.parentSession)} ` +
        `-> parentSessionId=${String(parentSessionId)}`,
    )
    // The child's real start (session-header timestamp) so its room reports its
    // own start instead of 0; fall back to the panel stamp, then now.
    const startedAt =
      (header?.timestamp ? Date.parse(header.timestamp) : 0) ||
      panelBySession.get(sessionId)?.startedAt ||
      Date.now()

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
      makeHandlers,
      getStatus: () => normalizeStatus(panelBySession.get(sessionId)?.status),
    })
  }

  return {
    onChildSession,
    dispose() {
      disposed = true
      for (const u of unsub) {
        try {
          u()
        } catch {
          /* best-effort */
        }
      }
      for (const room of children.values()) room.dispose()
      children.clear()
    },
  }
}

async function startChildRoom(args: {
  relayUrl: string
  childPi?: ExtensionAPI
  ctx?: ExtensionContext
  sessionId: string
  roomId: string
  parentRoomId: string
  parentSessionId?: string
  startedAt: number
  name: string
  subagentId?: string
  makeHandlers: (ctx: ExtensionContext) => RpcCommandHandlers
  getStatus: () => string | undefined
  onClosed: () => void
}): Promise<ChildRoom> {
  const kp = await getOrCreateEd25519Keypair()
  const relay = new RelayClient(args.relayUrl, kp)
  const channels = new Map<string, PlainPeerChannel>()
  // Passive KEEPER by default: holds the room open + carries room_meta.parent,
  // subscribes to NO child events and answers NO owner RPCs. attach() is the
  // ONLY thing that reads the child / takes pi callbacks, and it runs only on an
  // ACTUAL in-process launch (immediately when built with a childPi, else
  // deferred to session_start).
  let handlers: RpcCommandHandlers | null = null
  let rpc: { dispose(): void } = { dispose() {} }
  let serving = false

  function broadcast(env: EnvelopeMessage): void {
    for (const ch of channels.values()) {
      try {
        ch.sendEnvelope(env)
      } catch {
        /* best-effort per channel */
      }
    }
  }

  function handleRpc(env: EnvelopeMessage, sender: PlainPeerChannel): void {
    if (!serving || !handlers) return // passive keeper answers nothing
    if (env.rpc !== undefined) {
      void dispatchRpcCommand(env.rpc as Record<string, unknown>, handlers)
        .then((resp) => {
          if (resp) sender.sendEnvelope(resp)
        })
        .catch(() => {
          /* read-only rejections already shape success:false; ignore */
        })
      return
    }
    if (env.ub !== undefined) {
      const f = env.ub as Record<string, unknown>
      if (f.type === "session_sync") {
        // A child room has NO panels/pending-ui of its own; the transcript is
        // the app's native get_entries. Just terminate the sync.
        sender.sendEnvelope({
          ub: {
            type: "session_sync_end",
            ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
            session_started_at: args.startedAt,
          } as EnvelopeMessage["ub"],
        })
      } else if (f.type === "get_session_info") {
        // Pull: the app asks this subagent for its own info (lifecycle status).
        // Answered from the extension's tracked state, so it survives app relaunch.
        sender.sendEnvelope({
          ub: {
            type: "session_info",
            status: args.getStatus(),
            ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
          } as EnvelopeMessage["ub"],
        })
      }
    }
  }

  async function gateAndAttach(
    peer: string,
    firstInner: unknown,
  ): Promise<void> {
    if (!serving) return // keeper doesn't attach owners; the child's conn serves
    if (channels.has(peer)) return
    const known = await _findKnownPeer(peer)
    if (!known) return // relay-verified but not a paired owner
    const channel = new PlainPeerChannel(
      relay,
      peer,
      args.roomId,
      () => {}, // stock ClientMessages unused — envelope plane only
      () => channels.delete(peer),
      (env) => handleRpc(env, channel),
      () => args.sessionId, // stamp the child's pi sessionId on every frame
    )
    channels.set(peer, channel)
    // Greet: caps + the child sessionId, so the app turns on the envelope route.
    channel.sendEnvelope(helloEnvelope(["rpc_envelope"], args.sessionId))
    if (isEnvelopeFrame(firstInner as Record<string, unknown>)) {
      handleRpc(firstInner as EnvelopeMessage, channel)
    }
  }

  function onLine(line: string): void {
    let outer: { peer?: string; ct?: string }
    try {
      outer = JSON.parse(line) as { peer?: string; ct?: string }
    } catch {
      return
    }
    if (!outer.peer || !outer.ct) return
    if (channels.has(outer.peer)) return // its channel routes it
    let inner: unknown
    try {
      inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"))
    } catch {
      return
    }
    if (!inner || typeof inner !== "object") return
    void gateAndAttach(outer.peer, inner)
  }

  relay.on("message", onLine)
  relay.on("close", () => {
    channels.clear()
    args.onClosed()
  })

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
  })
  envLog(
    `subagent room ${args.roomId} up (child ${args.sessionId.slice(0, 8)}…, parent ${args.parentRoomId})`,
  )

  // Attach the transcript PRODUCER — the ONLY pi.on subscription (child
  // callbacks). Called immediately when built WITH a child pi (in-process direct
  // launch), else deferred to session_start via the returned attach().
  function attach(childPi: ExtensionAPI, ctx: ExtensionContext): void {
    if (serving) return // idempotent
    handlers = args.makeHandlers(ctx)
    rpc = createRpcEnvelope(childPi, broadcast)
    serving = true
  }
  if (args.childPi && args.ctx) attach(args.childPi, args.ctx)

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
    })
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
        rpc.dispose()
      } catch {
        /* best-effort */
      }
      for (const ch of channels.values()) {
        try {
          ch.detach()
        } catch {
          /* best-effort */
        }
      }
      channels.clear()
      relay.close()
    },
  }
}
