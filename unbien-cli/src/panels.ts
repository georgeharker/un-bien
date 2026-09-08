/**
 * Plan and subagent panels ride the `{evt}` plane as `panel_update` frames the
 * extension already produces from the in-process plan/subagents buses. They are
 * ephemeral view state, never transcript, so they are held here rather than
 * folded into the reducer.
 */
import { agentItems, agentType, waveOrder, waveSections } from "./plan.js"
import type { EnvelopeMessage } from "./reduce.js"

export interface PanelItem {
  id: string
  kind: string
  title: string
  status: string | null
  deps?: string[]
  tainted?: boolean
}

export interface Panel {
  key: string
  title: string
  items: PanelItem[]
}

export class PanelStore {
  private readonly panels = new Map<string, Panel>()

  /** Returns true when the envelope was a panel update. */
  apply(env: EnvelopeMessage): boolean {
    const evt = env.evt as { channel?: string; data?: unknown } | undefined
    if (!evt || evt.channel !== "panel") return false
    const frame = evt.data as
      | {
          type?: string
          key?: string
          title?: string
          data?: { items?: PanelItem[] }
        }
      | undefined
    if (frame?.type !== "panel_update" || !frame.key) return false
    this.panels.set(frame.key, {
      key: frame.key,
      title: frame.title ?? frame.key,
      items: frame.data?.items ?? [],
    })
    return true
  }

  get(key: string): Panel | undefined {
    return this.panels.get(key)
  }

  keys(): string[] {
    return [...this.panels.keys()]
  }
}

/** Mirrors the app's status glyphs: done / running / everything else. */
function statusMark(status: string | null | undefined): string {
  switch (status) {
    case "done":
    case "completed":
      return "✓"
    case "failed":
    case "error":
      return "✗"
    case "in_progress":
    case "in-progress":
    case "started":
    case "running":
      return "▶"
    default:
      return "○"
  }
}

const isRunning = (status: string | null | undefined): boolean =>
  status === "in_progress" ||
  status === "in-progress" ||
  status === "started" ||
  status === "running"

/**
 * The plan as the app shows it: dependency waves, an `Available now` group you
 * can pick up immediately, and a trailing `Done` — the layering pi-plan's own
 * widget conveys by order, surfaced here as titled sections.
 */
export interface PlanViewOptions {
  /** Include finished items. */
  showDone?: boolean
  /** Include non-plan kinds (design / note context). */
  showContext?: boolean
  /** Cap on rendered rows before a "…N more" trailer. */
  maxRows?: number
}

export function renderPlanPanel(
  panel: Panel | undefined,
  options: PlanViewOptions = {},
): string[] {
  const {
    showDone = false,
    showContext = false,
    maxRows = Number.POSITIVE_INFINITY,
  } = options
  const items = panel?.items ?? []
  if (items.length === 0) return ["  no plan items yet"]

  const done = items.filter((i) => i.status === "done").length
  const active = items.filter((i) => isRunning(i.status)).length
  const hidden: string[] = []
  if (!showDone && done > 0) hidden.push(`${done} done`)
  const contextCount = items.filter((i) => i.kind !== "plan").length
  if (!showContext && contextCount > 0) hidden.push(`${contextCount} context`)

  const header = `  Plan — ${items.length} items, ${done} done${active > 0 ? `, ${active} active` : ""}${
    hidden.length > 0 ? `  (hiding ${hidden.join(", ")})` : ""
  }`
  const lines = [header]

  // Filter as pi-plan does, then cap: the point of the panel is what to pick up
  // next, so history and context are opt-in and long plans trail off.
  let budget = maxRows
  let dropped = 0
  for (const section of waveSections(items)) {
    const rows = section.rows.filter(
      (row) =>
        (showDone || row.item.status !== "done") &&
        (showContext || row.item.kind === "plan"),
    )
    if (rows.length === 0) continue
    const shown = budget > 0 ? rows.slice(0, budget) : []
    dropped += rows.length - shown.length
    budget -= shown.length
    if (shown.length === 0) continue
    lines.push("", `  ${section.title}`)
    for (const row of shown) {
      const kind =
        row.item.kind && row.item.kind !== "plan" ? ` (${row.item.kind})` : ""
      const taint = row.item.tainted ? " ⚠ tainted" : ""
      const blocked =
        row.blockedCount > 0 && !row.actionable
          ? ` · blocked by ${row.blockedCount}`
          : ""
      lines.push(
        `    ${statusMark(row.item.status)} ${row.item.title}${kind}${blocked}${taint}`,
      )
    }
  }
  if (dropped > 0) lines.push(`    …${dropped} more`)
  if (lines.length === 1) lines.push("    (nothing to show with these filters)")
  return lines
}

/** pi-plan's collapsed form: one line of counts, and how to expand. */
export function summarisePlan(panel: Panel | undefined): string[] {
  const items = panel?.items ?? []
  if (items.length === 0) return []
  const rows = waveOrder(items)
  const ready = rows.filter((r) => r.actionable).length
  const active = items.filter((i) => isRunning(i.status)).length
  const blocked = rows.filter(
    (r) => !r.circular && (r.wave ?? 0) > 0 && r.item.status !== "done",
  ).length
  const circular = rows.filter((r) => r.circular).length

  const parts: string[] = []
  if (ready > 0) parts.push(`${ready} ready`)
  if (active > 0) parts.push(`${active} active`)
  if (blocked > 0) parts.push(`${blocked} blocked`)
  if (circular > 0) parts.push(`${circular} circular`)
  const body = parts.length > 0 ? parts.join(" · ") : "(empty)"
  return [`  ▸ Plan  ${body}   /plan to expand`]
}

export function summariseAgents(panel: Panel | undefined): string[] {
  const items = panel?.items ?? []
  if (items.length === 0) return []
  const running = items.filter((i) => isRunning(i.status)).length
  const parts = [`${items.length} agent${items.length === 1 ? "" : "s"}`]
  if (running > 0) parts.push(`${running} running`)
  return [`  ▸ Agents  ${parts.join(" · ")}   /subagents to expand`]
}

/** Subagents chronologically, with type badge — the app's agents panel. */
export function renderAgentsPanel(panel: Panel | undefined): string[] {
  const items = agentItems(panel?.items ?? [])
  if (items.length === 0) return ["  no subagents yet"]

  const running = items.filter((i) => isRunning(i.status)).length
  const done = items.filter((i) => i.status === "done").length
  const failed = items.filter(
    (i) => i.status === "failed" || i.status === "error",
  ).length
  const summary = [`${items.length} agents`]
  if (running > 0) summary.push(`${running} running`)
  if (done > 0) summary.push(`${done} done`)
  if (failed > 0) summary.push(`${failed} failed`)

  return [
    `  Agents — ${summary.join(", ")}`,
    "",
    ...items.map((item) => {
      const type = agentType(item)
      return `    ${statusMark(item.status)} ${item.title}${type ? ` · ${type}` : ""}`
    }),
  ]
}
