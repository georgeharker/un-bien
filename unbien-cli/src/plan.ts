/**
 * Plan + subagents presentation, mirroring the app's `PlanModel` — itself a
 * port of pi-plan's `waveOrder`. Kept faithful on purpose: a plan should read
 * the same in the CLI, the app, and pi-plan's own widget.
 */
import type { PanelItem } from "./panels.js"

export interface PlanRow {
  item: PanelItem
  /** 0 = free now; N = behind N waves of unsatisfied deps; null = circular. */
  wave: number | null
  blockedCount: number
  circular: boolean
  /** A plan item, not done, wave 0 — the pick-up-now set. */
  actionable: boolean
}

export interface WaveSection {
  title: string
  rows: PlanRow[]
}

const isDone = (item: PanelItem): boolean => item.status === "done"

/**
 * Crib dep semantics: a note never blocks; a design blocks only while tainted;
 * a plan blocks until it is done.
 */
function isSatisfied(item: PanelItem): boolean {
  switch (item.kind) {
    case "note":
      return true
    case "design":
      return item.tainted !== true
    default:
      return isDone(item)
  }
}

function kindRank(kind: string): number {
  switch (kind) {
    case "plan":
      return 0
    case "design":
      return 1
    case "note":
      return 2
    default:
      return 3
  }
}

/**
 * Kahn-style layering: each pass places items whose unsatisfied deps are all
 * placed; whatever never places is a cycle. Ordered by (done, wave, kind, id).
 */
export function waveOrder(items: readonly PanelItem[]): PlanRow[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const blockers = new Map<string, PanelItem[]>(
    items.map((item) => [
      item.id,
      (item.deps ?? [])
        .map((dep) => byId.get(dep))
        .filter((dep): dep is PanelItem => !!dep)
        .filter((dep) => dep.id !== item.id && !isSatisfied(dep)),
    ]),
  )

  const wave = new Map<string, number>()
  const placed = new Set<string>()
  let remaining = [...items]
  let waveNum = 0
  while (remaining.length > 0) {
    const ready = remaining.filter((item) =>
      (blockers.get(item.id) ?? []).every((dep) => placed.has(dep.id)),
    )
    if (ready.length === 0) break // the rest form a cycle
    for (const item of ready) {
      wave.set(item.id, waveNum)
      placed.add(item.id)
    }
    remaining = remaining.filter((item) => !placed.has(item.id))
    waveNum += 1
  }

  const rows = items.map((item): PlanRow => {
    const circular = !placed.has(item.id)
    const waveValue = circular ? null : (wave.get(item.id) ?? null)
    return {
      item,
      wave: waveValue,
      blockedCount: (blockers.get(item.id) ?? []).length,
      circular,
      actionable: item.kind === "plan" && !isDone(item) && waveValue === 0,
    }
  })

  return rows.sort((a, b) => {
    const ad = isDone(a.item) ? 1 : 0
    const bd = isDone(b.item) ? 1 : 0
    if (ad !== bd) return ad - bd
    if (a.wave !== null && b.wave !== null && a.wave !== b.wave) {
      return a.wave - b.wave
    }
    if (a.wave === null && b.wave !== null) return 1
    if (a.wave !== null && b.wave === null) return -1
    const ak = kindRank(a.item.kind)
    const bk = kindRank(b.item.kind)
    if (ak !== bk) return ak - bk
    return a.item.id.localeCompare(b.item.id)
  })
}

/** Group into `Available now` → `Wave N` → `Cycle` → `Done`. */
export function waveSections(items: readonly PanelItem[]): WaveSection[] {
  const bucket = (row: PlanRow): string => {
    if (isDone(row.item)) return "Done"
    if (row.circular || row.wave === null) return "Cycle"
    return row.wave === 0 ? "Available now" : `Wave ${row.wave}`
  }
  const order: string[] = []
  const grouped = new Map<string, PlanRow[]>()
  for (const row of waveOrder(items)) {
    const key = bucket(row)
    if (!grouped.has(key)) {
      order.push(key)
      grouped.set(key, [])
    }
    grouped.get(key)!.push(row)
  }
  return order.map((title) => ({ title, rows: grouped.get(title) ?? [] }))
}

/** Subagents read chronologically (pi-plan's `sortAgents`), by `meta.startedAt`. */
export function agentItems(items: readonly PanelItem[]): PanelItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const at = startedAt(a.item) ?? a.index
      const bt = startedAt(b.item) ?? b.index
      return at - bt
    })
    .map((entry) => entry.item)
}

function meta(item: PanelItem): Record<string, unknown> {
  const value = (item as { meta?: unknown }).meta
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

export function startedAt(item: PanelItem): number | undefined {
  const value = meta(item)["startedAt"]
  return typeof value === "number" ? value : undefined
}

export function agentType(item: PanelItem): string | undefined {
  const value = meta(item)["agentType"]
  return typeof value === "string" ? value : undefined
}
