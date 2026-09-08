import { describe, expect, it } from "vitest"
import { COMMANDS, findCommand } from "./commands.js"
import { PanelStore, renderAgentsPanel, renderPlanPanel } from "./panels.js"
import { waveOrder, waveSections } from "./plan.js"

describe("slash command parsing", () => {
  it("resolves a bare command", () => {
    expect(findCommand("/plan")?.command.name).toBe("plan")
  })

  it("splits arguments from the verb", () => {
    const found = findCommand("/fork abc123 before")
    expect(found?.command.name).toBe("fork")
    expect(found?.args).toBe("abc123 before")
  })

  it("ignores plain prompts and unknown verbs", () => {
    expect(findCommand("write me a haiku")).toBeNull()
    expect(findCommand("/nope")).toBeNull()
  })

  it("every command has a unique name and a summary", () => {
    const names = COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    expect(COMMANDS.every((c) => c.summary.length > 0)).toBe(true)
  })
})

/** A `panel_update` frame as the extension emits it on the evt plane. */
const update = (key: string, items: unknown[]) => ({
  evt: {
    channel: "panel",
    data: { type: "panel_update", key, title: key, data: { items } },
  },
})

describe("panel store folds the evt plane", () => {
  it("keeps the latest snapshot per key", () => {
    const panels = new PanelStore()
    expect(
      panels.apply(update("plan", [{ id: "1", title: "first", status: null }])),
    ).toBe(true)
    panels.apply(update("plan", [{ id: "1", title: "second", status: "done" }]))
    expect(panels.get("plan")?.items).toHaveLength(1)
    expect(panels.get("plan")?.items[0]?.title).toBe("second")
  })

  it("ignores non-panel envelopes so they stay transcript", () => {
    const panels = new PanelStore()
    expect(panels.apply({ rpc: { type: "message_end" } })).toBe(false)
    expect(
      panels.apply({ evt: { channel: "subagents:started", data: {} } }),
    ).toBe(false)
    expect(panels.keys()).toEqual([])
  })

  // The extension normalises lifecycle status before it reaches the wire
  // (`displayStatus`: completed -> done), so these are the only values a client
  // can actually receive.
  it("renders agent status marks, and says so when empty", () => {
    const panels = new PanelStore()
    panels.apply(
      update("subagents", [
        { id: "a", title: "explore", status: "done" },
        { id: "b", title: "build", status: "failed" },
        { id: "c", title: "scan", status: "in_progress" },
      ]),
    )
    const lines = renderAgentsPanel(panels.get("subagents")).join("\n")
    expect(lines).toContain("✓ explore")
    expect(lines).toContain("✗ build")
    expect(lines).toContain("▶ scan")
    expect(lines).toContain("1 running")
    expect(lines).toContain("1 done")
    expect(lines).toContain("1 failed")
    expect(renderAgentsPanel(undefined)[0]).toContain("no subagents")
  })
})

describe("plan waves mirror pi-plan / the app", () => {
  const plan = (
    id: string,
    deps: string[] = [],
    status: string | null = null,
  ) => ({ id, kind: "plan", title: id, status, deps }) as const

  it("layers items behind their unsatisfied deps", () => {
    const rows = waveOrder([plan("a"), plan("b", ["a"]), plan("c", ["b"])])
    expect(rows.map((r) => [r.item.id, r.wave])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ])
    expect(rows[0]?.actionable).toBe(true)
    expect(rows[1]?.actionable).toBe(false)
  })

  it("a done dep stops blocking, freeing its dependant to wave 0", () => {
    const rows = waveOrder([plan("a", [], "done"), plan("b", ["a"])])
    expect(rows.find((r) => r.item.id === "b")?.wave).toBe(0)
    expect(rows.find((r) => r.item.id === "b")?.actionable).toBe(true)
  })

  it("applies crib dep semantics: notes never block, designs block while tainted", () => {
    const note = { id: "n", kind: "note", title: "n", status: null, deps: [] }
    const clean = {
      id: "d",
      kind: "design",
      title: "d",
      status: null,
      deps: [],
    }
    const tainted = { ...clean, id: "t", tainted: true }
    expect(
      waveOrder([note, plan("x", ["n"])]).find((r) => r.item.id === "x")?.wave,
    ).toBe(0)
    expect(
      waveOrder([clean, plan("y", ["d"])]).find((r) => r.item.id === "y")?.wave,
    ).toBe(0)
    expect(
      waveOrder([tainted, plan("z", ["t"])]).find((r) => r.item.id === "z")
        ?.wave,
    ).toBe(1)
  })

  it("marks a dependency cycle instead of looping forever", () => {
    const rows = waveOrder([plan("a", ["b"]), plan("b", ["a"])])
    expect(rows.every((r) => r.circular)).toBe(true)
    expect(rows.every((r) => r.wave === null)).toBe(true)
  })

  it("groups into Available now / Wave N / Done", () => {
    const sections = waveSections([
      plan("a"),
      plan("b", ["a"]),
      plan("old", [], "done"),
    ])
    expect(sections.map((s) => s.title)).toEqual([
      "Available now",
      "Wave 1",
      "Done",
    ])
  })

  it("renders the plan with wave headings and a summary", () => {
    const panels = new PanelStore()
    panels.apply(
      update("plan", [
        plan("first"),
        plan("second", ["first"]),
        plan("old", [], "done"),
      ]),
    )
    const out = renderPlanPanel(panels.get("plan")).join("\n")
    expect(out).toContain("3 items, 1 done")
    expect(out).toContain("Available now")
    expect(out).toContain("Wave 1")
    expect(out).toContain("blocked by 1")
  })
})
