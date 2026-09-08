/**
 * Slash commands. Where pi has a first-class rpc verb we issue that verb and pi
 * acts; only fork/branch go over un-bien's own plane, because they need a pi
 * command context that the rpc dispatch path doesn't carry.
 */
import { SelectList, type SelectItem } from "@earendil-works/pi-tui"
import { getSelectListTheme } from "@earendil-works/pi-coding-agent"
import type { SessionClient } from "./client.js"
import type { CliSettings, PanelMode } from "./settings.js"
import type { PanelStore } from "./panels.js"

/** A session log entry, as `get_entries` returns it. */
export interface SessionEntry {
  id?: string
  parentId?: string | null
  type?: string
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> }
}

export interface CommandContext {
  client: SessionClient
  panels: PanelStore
  /**
   * The walked session log. The extension bridges only a subset of pi's rpc
   * verbs (`rpc_inbound.ts`) — `get_tree` and `get_fork_messages` are NOT
   * among them — but entries carry `id`/`parentId`, so the tree and the fork
   * points are derived here instead of asking for them.
   */
  entries: () => readonly SessionEntry[]
  settings: CliSettings
  saveSettings: () => void
  settingsPath: string
  /** Leave the client. The remote session keeps running. */
  quit: () => void
  /** Print lines into the transcript area. */
  print: (lines: string[]) => void
  /** Offer a highlighted chooser; resolves to the picked value or null. */
  choose: (
    title: string,
    items: SelectItem[],
  ) => Promise<SelectItem | null> | SelectItem | null
  /** Chooser whose rows carry per-key actions (fork vs branch). */
  chooseAction: (
    title: string,
    items: SelectItem[],
    hint: string,
    keys: readonly string[],
  ) => Promise<{ item: SelectItem; action: string } | null>
}

export interface Command {
  name: string
  summary: string
  run: (ctx: CommandContext, args: string) => Promise<void> | void
}

/**
 * pi-plan's `/plan` semantics: a bare call toggles, and the explicit verbs set
 * a state. The mode persists, so a pinned panel survives reconnects.
 */
function cyclePanel(
  ctx: CommandContext,
  key: "planMode" | "subagentsMode",
  label: string,
  args: string,
): void {
  const [verb = "toggle", arg] = args.trim().split(/\s+/)
  const current = ctx.settings[key]

  // pi-plan's filters + a row cap, on the plan panel only.
  if (key === "planMode") {
    if (verb === "filter") {
      if (arg === "done") ctx.settings.planShowDone = !ctx.settings.planShowDone
      else if (arg === "context")
        ctx.settings.planShowContext = !ctx.settings.planShowContext
      else {
        ctx.print(["  /plan filter done|context"])
        return
      }
      ctx.saveSettings()
      ctx.print([
        `  showDone=${ctx.settings.planShowDone} showContext=${ctx.settings.planShowContext}`,
      ])
      return
    }
    if (verb === "lines") {
      const rows = Number(arg)
      if (!Number.isFinite(rows) || rows < 1) {
        ctx.print([`  /plan lines <n>  (now: ${ctx.settings.planMaxRows})`])
        return
      }
      ctx.settings.planMaxRows = Math.floor(rows)
      ctx.saveSettings()
      ctx.print([`  plan rows → ${ctx.settings.planMaxRows}`])
      return
    }
  }

  let next: PanelMode
  switch (verb) {
    case "toggle":
      next = current === "hidden" ? "expanded" : "hidden"
      break
    case "expand":
    case "show":
      next = "expanded"
      break
    case "collapse":
      next = "collapsed"
      break
    case "hide":
      next = "hidden"
      break
    default:
      ctx.print([
        key === "planMode"
          ? `  /plan toggle|expand|collapse|hide|filter done|filter context|lines <n>  (now: ${current})`
          : `  /${label} toggle|expand|collapse|hide  (now: ${current})`,
      ])
      return
  }
  ctx.settings[key] = next
  ctx.saveSettings()
}

function oneLine(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function entryText(entry: SessionEntry): string {
  return (entry.message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ")
}

/** Fork points are the USER turns — the messages you can rewind to. */
function forkPoints(entries: readonly SessionEntry[]): SessionEntry[] {
  return entries.filter(
    (e) => e.type === "message" && e.message?.role === "user" && e.id,
  )
}

async function chooseEntry(
  ctx: CommandContext,
  title: string,
): Promise<string | null> {
  const points = forkPoints(ctx.entries())
  if (points.length === 0) {
    ctx.print(["  no fork points — no user messages in the walked history"])
    return null
  }
  const items = points.map((entry) => ({
    value: entry.id!,
    label: oneLine(entryText(entry)) || entry.id!.slice(0, 8),
  }))
  const picked = await ctx.choose(title, items)
  return picked?.value ?? null
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    summary: "list commands",
    run: (ctx) =>
      ctx.print(COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.summary}`)),
  },
  {
    name: "plan",
    summary: "pin the plan: toggle|expand|collapse|hide|filter|lines <n>",
    run: (ctx, args) => cyclePanel(ctx, "planMode", "plan", args),
  },
  {
    name: "subagents",
    summary: "pin the subagents fleet: toggle|expand|collapse|hide",
    run: (ctx, args) => cyclePanel(ctx, "subagentsMode", "subagents", args),
  },
  {
    name: "fork",
    summary: "fork a NEW session from an earlier message",
    run: async (ctx, args) => {
      const entryId = args.trim() || (await chooseEntry(ctx, "Fork from:"))
      if (!entryId) return
      // ctx.fork lives only on a pi COMMAND context, so this goes over ub.
      ctx.client.sendUb("session_fork", { entry_id: entryId })
      ctx.print([
        `  forking from ${entryId.slice(0, 8)}… (a new session opens)`,
      ])
    },
  },
  {
    name: "branch",
    summary: "branch IN PLACE from an earlier message",
    run: async (ctx, args) => {
      const entryId = args.trim() || (await chooseEntry(ctx, "Branch at:"))
      if (!entryId) return
      ctx.client.sendUb("session_navigate", { entry_id: entryId })
      ctx.print([`  branching at ${entryId.slice(0, 8)}…`])
    },
  },
  {
    name: "tree",
    summary: "browse turns; f forks a new session, b branches in place",
    run: async (ctx) => {
      const points = forkPoints(ctx.entries())
      if (points.length === 0) {
        ctx.print(["  no turns yet — has history finished replaying?"])
        return
      }
      const picked = await ctx.chooseAction(
        "Conversation turns:",
        points.map((entry) => ({
          value: entry.id!,
          label: oneLine(entryText(entry)) || entry.id!.slice(0, 8),
        })),
        "↑/↓ move  ·  f fork (new session)  ·  b branch (in place)  ·  esc",
        ["f", "b"],
      )
      if (!picked) return
      const entryId = picked.item.value
      if (picked.action === "b") {
        ctx.client.sendUb("session_navigate", { entry_id: entryId })
        ctx.print([`  branching at ${entryId.slice(0, 8)}…`])
      } else {
        ctx.client.sendUb("session_fork", { entry_id: entryId })
        ctx.print([
          `  forking from ${entryId.slice(0, 8)}… (a new session opens)`,
        ])
      }
    },
  },
  {
    name: "model",
    summary: "switch model",
    run: async (ctx) => {
      // The host answers `{ models, current }`, not a bare array.
      const data = await ctx.client.request<{
        models?: Array<{ provider: string; id: string; name?: string }>
        current?: { provider: string; id: string }
      }>("get_available_models")
      const models = data?.models ?? []
      if (models.length === 0) {
        ctx.print([
          "  no models reported by the host",
          data?.current
            ? `  current: ${data.current.provider}/${data.current.id}`
            : "  (the session may not have resolved its catalogue yet)",
        ])
        return
      }
      const picked = await ctx.choose(
        "Model:",
        models.map((m) => ({
          value: `${m.provider}/${m.id}`,
          label: m.name ?? m.id,
          description: m.provider,
        })),
      )
      if (!picked) return
      const [provider, ...rest] = picked.value.split("/")
      await ctx.client.request("set_model", {
        provider,
        modelId: rest.join("/"),
      })
      ctx.print([`  model → ${picked.value}`])
    },
  },
  {
    name: "thinking",
    summary: "set thinking level",
    run: async (ctx, args) => {
      // `get_available_thinking_levels` is not bridged, so offer pi's own set
      // and let the host reject a level the model doesn't support.
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      const level =
        args.trim() ||
        (
          await ctx.choose(
            "Thinking:",
            levels.map((l) => ({ value: l, label: l })),
          )
        )?.value
      if (!level) return
      await ctx.client.request("set_thinking_level", { level })
      ctx.print([`  thinking → ${level}`])
    },
  },
  {
    name: "compact",
    summary: "compact the session context",
    run: async (ctx) => {
      ctx.print(["  compacting…"])
      await ctx.client.request("compact", {}, 120_000)
      ctx.print(["  compacted"])
    },
  },
  {
    name: "abort",
    summary: "abort the current turn",
    run: (ctx) => {
      ctx.client.abort()
      ctx.print(["  abort sent"])
    },
  },
  {
    name: "set",
    summary: "toggle a client setting (e.g. /set streamThinking on)",
    run: (ctx, args) => {
      const [key, value] = args.trim().split(/\s+/)
      const toggles = ["streamThinking", "showThinking"] as const
      type Toggle = (typeof toggles)[number]
      const isToggle = (k: string | undefined): k is Toggle =>
        toggles.includes(k as Toggle)

      if (!isToggle(key)) {
        ctx.print([
          `  settings (${ctx.settingsPath}):`,
          ...toggles.map((t) => `    ${t} = ${ctx.settings[t]}`),
          `    theme = ${ctx.settings.theme ?? "(pi's setting)"}`,
          "  usage: /set <name> on|off",
        ])
        return
      }
      if (value !== "on" && value !== "off") {
        ctx.print([
          `  ${key} = ${ctx.settings[key]} — pass on or off to change`,
        ])
        return
      }
      ctx.settings[key] = value === "on"
      ctx.saveSettings()
      ctx.print([`  ${key} → ${ctx.settings[key]} (saved)`])
    },
  },
  {
    name: "quit",
    summary: "detach (the remote session keeps running)",
    run: (ctx) => ctx.quit(),
  },
]

export function findCommand(input: string): {
  command: Command
  args: string
} | null {
  if (!input.startsWith("/")) return null
  const [verb, ...rest] = input.slice(1).split(" ")
  const command = COMMANDS.find((c) => c.name === verb)
  return command ? { command, args: rest.join(" ") } : null
}

/** Chooser used when no TUI is available: prints a numbered list instead. */
export function selectListFor(
  items: SelectItem[],
  maxVisible = 10,
): SelectList {
  return new SelectList(items, maxVisible, getSelectListTheme())
}
