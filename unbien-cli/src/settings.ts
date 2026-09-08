import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * The CLI's own settings, kept separate from pi's: these are client display
 * preferences and have no meaning to the host session.
 */
/** pi-plan's widget states: hidden, a one-line summary, or the full panel. */
export type PanelMode = "hidden" | "collapsed" | "expanded"

export interface CliSettings {
  /** Theme name; falls back to pi's configured theme when unset. */
  theme?: string
  /** Render reasoning deltas live, not just in the settled message. */
  streamThinking: boolean
  /** Show the settled message's thinking block at all. */
  showThinking: boolean
  /** Persistent plan widget above the composer. */
  planMode: PanelMode
  /** Persistent subagents widget above the composer. */
  subagentsMode: PanelMode
  /** Include finished plan items (pi-plan's `filter done`). */
  planShowDone: boolean
  /** Include non-plan kinds — design/note context (pi-plan's `filter context`). */
  planShowContext: boolean
  /** Row cap before the panel trails off with "…N more". */
  planMaxRows: number
}

const DEFAULTS: CliSettings = {
  streamThinking: false,
  showThinking: true,
  planMode: "hidden",
  subagentsMode: "hidden",
  // pi-plan's own defaults: a plan should show what's actionable, not history.
  planShowDone: false,
  planShowContext: false,
  planMaxRows: 18,
}

const SETTINGS_PATH = join(homedir(), ".config", "unbien-cli", "settings.json")

export function settingsPath(): string {
  return SETTINGS_PATH
}

export function loadSettings(path = SETTINGS_PATH): CliSettings {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<CliSettings>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(
  settings: CliSettings,
  path = SETTINGS_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}
