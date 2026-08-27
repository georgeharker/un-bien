import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPanelBridge } from "./panel_bridge.js";
import type { ServerMessage } from "./protocol/types.js";

// ── Fake pi.events bus + optional pi.on ──────────────────────────────────────
interface FakeBus {
  on(name: string, cb: (data: unknown) => void): () => void;
  emit(name: string, data: unknown): void;
}

function fakeBus(): FakeBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(name, cb) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(cb);
      return () => void set?.delete(cb);
    },
    emit(name, data) {
      handlers.get(name)?.forEach((cb) => cb(data));
    },
  };
}

function fakePi(bus: FakeBus): ExtensionAPI {
  // include `on` so session_shutdown wiring exercises; it dispatches like the bus.
  return { events: bus, on: bus.on } as unknown as ExtensionAPI;
}

function panelOf(frames: ServerMessage[], key: string) {
  const frame = [...frames].reverse().find(
    (m): m is Extract<ServerMessage, { type: "panel_update" }> =>
      m.type === "panel_update" && m.key === key,
  );
  return frame;
}

function itemsOf(frame: Extract<ServerMessage, { type: "panel_update" }> | undefined) {
  return ((frame?.data as { items?: Array<Record<string, unknown>> })?.items) ?? [];
}

describe("panel_bridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns null when the SDK exposes no events bus (inert)", () => {
    expect(createPanelBridge({} as ExtensionAPI, () => {})).toBeNull();
  });

  it("broadcasts a coalesced plan panel from plan:snapshot", () => {
    const bus = fakeBus();
    const out: ServerMessage[] = [];
    const bridge = createPanelBridge(fakePi(bus), (m) => out.push(m));
    expect(bridge).not.toBeNull();

    bus.emit("plan:snapshot", {
      ns: "crib",
      seq: 1,
      items: [
        { id: "plan:a", title: "Do A", status: "todo", deps: [] },
        { id: "plan:b", title: "Do B", status: "todo", deps: ["plan:a"] },
      ],
    });
    // Coalesced: nothing until the tick fires.
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(60);

    const plan = panelOf(out, "plan");
    expect(plan?.title).toBe("Plan");
    const items = itemsOf(plan);
    expect(items.map((i) => i.id)).toEqual(["plan:a", "plan:b"]);
    expect(items[1]?.deps).toEqual(["plan:a"]);
    bridge?.dispose();
  });

  it("coalesces a snapshot + burst of updates into one frame", () => {
    const bus = fakeBus();
    const out: ServerMessage[] = [];
    const bridge = createPanelBridge(fakePi(bus), (m) => out.push(m));

    bus.emit("plan:snapshot", { ns: "crib", seq: 1, items: [{ id: "x", title: "X" }] });
    bus.emit("plan:update", { ns: "crib", seq: 2, upsert: [{ id: "y", title: "Y" }] });
    bus.emit("plan:update", { ns: "crib", seq: 3, remove: ["x"] });
    vi.advanceTimersByTime(60);

    const frames = out.filter((m) => m.type === "panel_update");
    expect(frames).toHaveLength(1); // one coalesced frame, not three
    expect(itemsOf(panelOf(out, "plan")).map((i) => i.id)).toEqual(["y"]);
    bridge?.dispose();
  });

  it("drops an out-of-order (stale seq) update", () => {
    const bus = fakeBus();
    const out: ServerMessage[] = [];
    const bridge = createPanelBridge(fakePi(bus), (m) => out.push(m));

    bus.emit("plan:snapshot", { ns: "crib", seq: 5, items: [{ id: "a", title: "A" }] });
    bus.emit("plan:update", { ns: "crib", seq: 2, upsert: [{ id: "z", title: "Z" }] }); // stale
    vi.advanceTimersByTime(60);

    expect(itemsOf(panelOf(out, "plan")).map((i) => i.id)).toEqual(["a"]);
    bridge?.dispose();
  });

  it("builds a subagents panel from lifecycle events, never downgrading status", () => {
    const bus = fakeBus();
    const out: ServerMessage[] = [];
    const bridge = createPanelBridge(fakePi(bus), (m) => out.push(m));

    bus.emit("subagents:started", { id: "s1", type: "Explore", description: "scan repo" });
    bus.emit("subagents:completed", { id: "s1" });
    // A late generic 'failed' must not overwrite a real 'completed'? No — completed
    // and failed are both terminal; a specific reason is only kept over generic
    // 'failed'. Here completed stays completed since a later event of equal rank
    // doesn't arrive. Verify the mapped display status.
    vi.advanceTimersByTime(60);

    const items = itemsOf(panelOf(out, "subagents"));
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("agent:s1");
    expect(items[0]?.kind).toBe("agent");
    expect(items[0]?.title).toBe("scan repo");
    expect(items[0]?.status).toBe("done");
    bridge?.dispose();
  });

  it("handles out-of-order subagent events (terminal status is never downgraded)", () => {
    const bus = fakeBus();
    const out: ServerMessage[] = [];
    const bridge = createPanelBridge(fakePi(bus), (m) => out.push(m));

    // `completed` arrives BEFORE `started` (pi can emit out of order).
    bus.emit("subagents:completed", { id: "s1", type: "Explore", description: "scan" });
    bus.emit("subagents:started", { id: "s1", type: "Explore", description: "scan" });
    vi.advanceTimersByTime(60);

    const items = itemsOf(panelOf(out, "subagents"));
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("done"); // not downgraded to in_progress
    bridge?.dispose();
  });

  it("keeps finished agents (no empty clobber) so done agents linger", () => {
    const bus = fakeBus();
    const out: ServerMessage[] = [];
    const bridge = createPanelBridge(fakePi(bus), (m) => out.push(m));

    bus.emit("subagents:started", { id: "s1", type: "Plan" });
    bus.emit("subagents:completed", { id: "s1", type: "Plan" });
    vi.advanceTimersByTime(60);
    // A session_shutdown must NOT wipe the panel — pendingPanels still replays.
    bus.emit("session_shutdown", {});
    vi.advanceTimersByTime(60);

    expect(itemsOf(panelOf(out, "subagents")).map((i) => i.id)).toEqual(["agent:s1"]);
    const pending = bridge?.pendingPanels() ?? [];
    expect(pending.some((m) => m.type === "panel_update" && m.key === "subagents")).toBe(true);
    bridge?.dispose();
  });

  it("pendingPanels replays the current plan + subagents snapshots", () => {
    const bus = fakeBus();
    const bridge = createPanelBridge(fakePi(bus), () => {});
    bus.emit("plan:snapshot", { ns: "crib", seq: 1, items: [{ id: "a", title: "A" }] });
    bus.emit("subagents:started", { id: "s1", type: "Plan" });

    const pending = bridge?.pendingPanels() ?? [];
    expect(pending.map((m) => (m.type === "panel_update" ? m.key : m.type)).sort()).toEqual([
      "plan",
      "subagents",
    ]);
    bridge?.dispose();
  });
});
