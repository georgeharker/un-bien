// Bridge the in-process plan + subagents buses to the paired app as
// `panel_update` frames. pi-plan renders these same sources to a local TUI
// widget (render-only, process-local) and never puts them on the relay; this
// module mirrors that data over the wire so the app's side-panels populate
// from a live session.
//
// Two sources, ported from pi-plan (wire.ts + agents.ts):
//   plan:snapshot { ns, seq?, items }            — replace a source's whole set
//   plan:update   { ns, seq?, upsert?, remove? }  — part-by-part patch
//   subagents:*   { id, type?, description? }      — 6 lifecycle channels
//
// Each source accumulates and broadcasts `panel_update { key, title, data }`,
// coalesced so a burst of bus events yields one frame per tick. `data` is
// `{ items: [...] }`; the app decodes the plan panel's items through its own
// wave-order model, and renders others generically.
//
// Inert when the SDK exposes no events bus. Faithful to pi-plan so the two
// stay wire-compatible; kept self-contained (pi-plan is not a dependency).

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol/types.js";

/** Coalesce window: bus events often arrive in bursts (a plan snapshot + N
 *  updates); one frame per source per tick is plenty and spares the relay. */
const COALESCE_MS = 60;

const PLAN_KEY = "plan";
const AGENTS_KEY = "subagents";

/** One plan node — mirror of pi-plan's `PlanItem` wire shape. The wire display
 *  field is `title`; sources may still send `name`. */
interface PlanItem {
  id: string;
  kind: string;
  title: string;
  status: string | null;
  deps: string[];
  tainted?: boolean;
  meta?: Record<string, unknown>;
}

type EventBus = ExtensionAPI["events"];

export interface PanelBridge {
  /** Current panels as `panel_update` frames, for `session_sync` to replay to a
   *  late-joining peer (mirrors the ui bridge's `pendingRequests`). */
  pendingPanels(): ServerMessage[];
  /** Drop subscriptions, timers, and state. */
  dispose(): void;
}

/**
 * Subscribe the plan + subagents buses and broadcast `panel_update` frames.
 * Returns `null` when the SDK exposes no usable events bus (defensive — modern
 * Pi always has one); callers stay null-safe.
 */
export function createPanelBridge(
  pi: ExtensionAPI,
  broadcast: (msg: ServerMessage) => void,
): PanelBridge | null {
  const eventsRaw = (pi as { events?: EventBus }).events;
  if (
    !eventsRaw ||
    typeof eventsRaw.on !== "function"
  ) {
    return null;
  }
  const events: EventBus = eventsRaw;

  // Opt-in tracing: shows whether bus events land and whether a panel frame is
  // broadcast, to isolate capture vs render. `REMOTE_PI_DEBUG_PANELS=1` logs to
  // stderr AND appends to `$TMPDIR/remote-pi-panel-bridge.log`; set it to a path
  // (contains `/`) to choose the file. stderr scrolls too fast — tail the file.
  const debug: (msg: string) => void = (() => {
    const flag = process.env.REMOTE_PI_DEBUG_PANELS;
    if (!flag) return () => {};
    // Stable, findable location (tmpdir varies per process and was hard to
    // locate): ~/.pi/remote/panel-bridge.log. Override with a path in the flag.
    let logFile: string;
    if (flag.includes("/")) {
      logFile = flag;
    } else {
      const dir = join(homedir(), ".pi", "remote");
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
      logFile = join(dir, "panel-bridge.log");
    }
    return (msg: string) => {
      const line = `${new Date().toISOString()} [panel-bridge] ${msg}`;
      try {
        console.error(line);
      } catch {
        /* stderr closed */
      }
      try {
        appendFileSync(logFile, `${line}\n`);
      } catch {
        /* best-effort file log */
      }
    };
  })();

  // ── Plan accumulation (port of pi-plan wire.ts) ──────────────────────────
  // Per-source (`ns`) item maps + last-seen seq to drop out-of-order frames.
  const planByNs = new Map<string, Map<string, PlanItem>>();
  const planLastSeq = new Map<string, number>();

  const allPlanItems = (): PlanItem[] => {
    const out: PlanItem[] = [];
    for (const map of planByNs.values()) for (const it of map.values()) out.push(it);
    return out;
  };

  // ── Subagents fleet (port of pi-plan agents.ts) ──────────────────────────
  const fleet = new Map<string, AgentState>();

  // pi-plan's buildView SEPARATES agents from plans. A plan source can fold the
  // fleet into its snapshot as `kind:"agent"` nodes (pi-acp does), so route those
  // to the AGENTS panel and keep them out of the plan rows. Direct `subagents:*`
  // fleet + any agent-kind plan items are merged by id (live fleet wins status).
  const isAgent = (it: PlanItem): boolean => it.kind === "agent";
  const planPanelItems = (): PlanItem[] => allPlanItems().filter((it) => !isAgent(it));
  const agentItems = (): PlanItem[] => {
    const byId = new Map<string, PlanItem>();
    for (const it of allPlanItems()) if (isAgent(it)) byId.set(it.id, it);
    for (const a of fleet.values()) {
      const item = toAgentItem(a);
      byId.set(item.id, item); // live fleet status wins
    }
    return [...byId.values()];
  };

  // ── Coalesced broadcast ──────────────────────────────────────────────────
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const planFrame = (): ServerMessage => ({
    type: "panel_update",
    key: PLAN_KEY,
    title: "Plan",
    icon: "checklist",
    data: { items: planPanelItems() },
  });
  const agentsFrame = (): ServerMessage => ({
    type: "panel_update",
    key: AGENTS_KEY,
    title: "Agents",
    icon: "person.2",
    data: { items: agentItems() },
  });

  const scheduleBroadcast = (key: string, build: () => ServerMessage): void => {
    if (disposed) return;
    if (timers.has(key)) {
      debug(`schedule ${key} coalesced (timer pending)`);
      return;
    }
    debug(`schedule ${key}`);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (disposed) return;
        let frame: ServerMessage;
        try {
          frame = build();
        } catch (error) {
          debug(`build ${key} THREW: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        const fitems =
          frame.type === "panel_update" && frame.data && typeof frame.data === "object"
            ? ((frame.data as { items?: Array<{ kind?: string }> }).items ?? [])
            : [];
        const kinds = fitems.reduce<Record<string, number>>((acc, it) => {
          const k = typeof it?.kind === "string" ? it.kind : "?";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
        debug(`broadcast ${key} items=${fitems.length} kinds=${JSON.stringify(kinds)}`);
        broadcast(frame);
      }, COALESCE_MS),
    );
  };

  // Broadcast NOW (no coalesce). Subagent lifecycle events are infrequent and
  // discrete — coalescing them risks losing the frame if the bridge is disposed
  // (session replacement / name collision) within the coalesce window, which is
  // exactly what dropped the subagents panel. Plan stays coalesced (it bursts).
  const broadcastNow = (key: string, build: () => ServerMessage): void => {
    if (disposed) return;
    let frame: ServerMessage;
    try {
      frame = build();
    } catch (error) {
      debug(`build ${key} THREW: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const items =
      frame.type === "panel_update" && frame.data && typeof frame.data === "object"
        ? ((frame.data as { items?: unknown[] }).items?.length ?? 0)
        : 0;
    debug(`broadcast ${key} now items=${items}`);
    broadcast(frame);
  };

  // ── Plan subscriptions ───────────────────────────────────────────────────
  const onSnapshot = (raw: unknown): void => {
    const snap = parseSnapshot(raw);
    if (!snap) return;
    const last = planLastSeq.get(snap.ns);
    if (last != null && snap.seq < last) return; // stale
    planLastSeq.set(snap.ns, snap.seq);
    const next = new Map<string, PlanItem>();
    for (const it of snap.items) next.set(it.id, it);
    planByNs.set(snap.ns, next);
    scheduleBroadcast(PLAN_KEY, planFrame);
    // Refresh the agents panel only when agents exist — never broadcast an empty
    // agents frame off a plain plan update (that would spawn a bogus subagents icon).
    if (agentItems().length > 0) broadcastNow(AGENTS_KEY, agentsFrame);
  };
  const onUpdate = (raw: unknown): void => {
    const up = parseUpdate(raw);
    if (!up) return;
    const last = planLastSeq.get(up.ns);
    if (last != null && up.seq < last) return; // stale
    planLastSeq.set(up.ns, up.seq);
    const map = planByNs.get(up.ns) ?? new Map<string, PlanItem>();
    let changed = false;
    for (const it of up.upsert) {
      map.set(it.id, it);
      changed = true;
    }
    for (const id of up.remove) changed = map.delete(id) || changed;
    if (!changed) return;
    planByNs.set(up.ns, map);
    scheduleBroadcast(PLAN_KEY, planFrame);
    if (agentItems().length > 0) broadcastNow(AGENTS_KEY, agentsFrame);
  };

  const unsubPlan = [
    events.on("plan:snapshot", onSnapshot),
    events.on("plan:update", onUpdate),
  ];

  // ── Subagents subscriptions ──────────────────────────────────────────────
  const recordAgent =
    (status: string) =>
    (data: unknown): void => {
      const p = (data ?? {}) as { id?: unknown; type?: unknown; description?: unknown };
      const id = str(p.id);
      debug(`event ${status} id=${id ?? "<none>"}`);
      if (!id) return;
      const prev = fleet.get(id);
      const incoming: AgentState = {
        id,
        type: str(p.type),
        description: str(p.description),
        status,
        startedAt: prev?.startedAt ?? (IN_PROGRESS.has(status) ? Date.now() : undefined),
      };
      fleet.set(id, mergeAgentState(prev, incoming));
      debug(`fleet=${fleet.size} after ${status} ${id}`);
      broadcastNow(AGENTS_KEY, agentsFrame);
    };

  const unsubAgents = Object.entries(LIFECYCLE).map(([channel, status]) =>
    events.on(channel, recordAgent(status)),
  );

  // NB: unlike pi-plan's TUI (which clears its fleet on session_shutdown to reset
  // the widget), we deliberately KEEP finished agents. Broadcasting an empty
  // frame on shutdown would clobber the app's panel the instant a fast agent
  // completes — the user expects done agents to linger for a while. The fleet
  // resets naturally when the pi process restarts (a new session = a fresh
  // bridge), and `pendingPanels` still replays the last fleet to a reconnecting
  // app.

  return {
    pendingPanels() {
      const out: ServerMessage[] = [];
      if (planPanelItems().length > 0) out.push(planFrame());
      if (agentItems().length > 0) out.push(agentsFrame());
      return out;
    },
    dispose() {
      disposed = true;
      for (const u of unsubPlan) safeUnsub(u);
      for (const u of unsubAgents) safeUnsub(u);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      planByNs.clear();
      planLastSeq.clear();
      fleet.clear();
    },
  };
}

// ── Plan parsing (lenient — shapes come from third-party plan sources) ───────

interface PlanSnapshot {
  ns: string;
  seq: number;
  items: PlanItem[];
}
interface PlanUpdate {
  ns: string;
  seq: number;
  upsert: PlanItem[];
  remove: string[];
}

function parseItem(raw: unknown): PlanItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const display =
    typeof r.title === "string" ? r.title : typeof r.name === "string" ? r.name : r.id;
  return {
    id: r.id,
    kind: typeof r.kind === "string" ? r.kind : "plan",
    title: display,
    status: typeof r.status === "string" ? r.status : null,
    deps: Array.isArray(r.deps) ? r.deps.filter((x): x is string => typeof x === "string") : [],
    tainted: typeof r.tainted === "boolean" ? r.tainted : undefined,
    meta: r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : undefined,
  };
}

/** Parse `plan:snapshot`. Accepts `source` as a legacy alias for `ns`. */
function parseSnapshot(data: unknown): PlanSnapshot | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ns = typeof d.ns === "string" ? d.ns : typeof d.source === "string" ? d.source : null;
  if (!ns || !Array.isArray(d.items)) return null;
  const items = d.items.map(parseItem).filter((x): x is PlanItem => x !== null);
  return { ns, seq: typeof d.seq === "number" ? d.seq : 0, items };
}

/** Parse `plan:update`. Returns null when unusable or a no-op. */
function parseUpdate(data: unknown): PlanUpdate | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ns = typeof d.ns === "string" ? d.ns : null;
  if (!ns) return null;
  const upsert = Array.isArray(d.upsert)
    ? d.upsert.map(parseItem).filter((x): x is PlanItem => x !== null)
    : [];
  const remove = Array.isArray(d.remove)
    ? d.remove.filter((x): x is string => typeof x === "string")
    : [];
  if (upsert.length === 0 && remove.length === 0) return null;
  return { ns, seq: typeof d.seq === "number" ? d.seq : 0, upsert, remove };
}

// ── Subagents (port of pi-plan agents.ts) ────────────────────────────────────

interface AgentState {
  id: string;
  type?: string;
  description?: string;
  status?: string;
  startedAt?: number;
}

const IN_PROGRESS = new Set(["started", "running", "steered", "compacted"]);
const FAILED = new Set(["failed", "stopped", "aborted", "error"]);

const LIFECYCLE: Record<string, string> = {
  "subagents:created": "created",
  "subagents:started": "started",
  "subagents:completed": "completed",
  "subagents:failed": "failed",
  "subagents:steered": "steered",
  "subagents:compacted": "compacted",
};

/** Lifecycle rank: pending(0) < in_progress(1) < terminal(2). */
function statusRank(status: string | undefined): number {
  const s = String(status ?? "").toLowerCase();
  if (s === "completed" || FAILED.has(s)) return 2;
  if (IN_PROGRESS.has(s)) return 1;
  return 0;
}

/** Merge a lifecycle event into kept state: never downgrade status, keep a
 *  specific terminal reason over a generic `failed`. */
function mergeAgentState(prev: AgentState | undefined, incoming: AgentState): AgentState {
  const merged: AgentState = { ...prev, ...incoming };
  if (prev?.type && !incoming.type) merged.type = prev.type;
  if (prev?.description && !incoming.description) merged.description = prev.description;
  if (prev) {
    const prevStatus = String(prev.status ?? "").toLowerCase();
    const inStatus = String(incoming.status ?? "").toLowerCase();
    const prevRank = statusRank(prevStatus);
    const inRank = statusRank(inStatus);
    if (prevRank > inRank) merged.status = prev.status;
    else if (prevRank === 2 && inRank === 2 && inStatus === "failed" && prevStatus !== "failed")
      merged.status = prev.status;
  }
  return merged;
}

/** Map a raw lifecycle status to the display status the app renders. */
function displayStatus(status: string | undefined): string {
  const s = String(status ?? "").toLowerCase();
  if (s === "completed") return "done";
  if (FAILED.has(s)) return "failed";
  if (IN_PROGRESS.has(s)) return "in_progress";
  return "pending";
}

/** An AgentState → a `kind:"agent"` plan item for the Agents panel. */
function toAgentItem(a: AgentState): PlanItem {
  const title = a.description?.trim() || a.type || a.id;
  return {
    id: `agent:${a.id}`,
    kind: "agent",
    title,
    status: displayStatus(a.status),
    deps: [],
    meta: { agentType: a.type, startedAt: a.startedAt },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Unsubscribe handles may be `() => void` or undefined; tolerate both. */
function safeUnsub(u: unknown): void {
  if (typeof u === "function") {
    try {
      (u as () => void)();
    } catch {
      /* best-effort teardown */
    }
  }
}
