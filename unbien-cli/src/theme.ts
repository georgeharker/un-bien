import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent"

const BUILTIN = ["dark", "light"]

/** pi's active theme is shared through this key so separate module copies agree. */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")

function customThemesDir(): string {
  return join(getAgentDir(), "themes")
}

/**
 * Themes can be contributed by pi PACKAGES, declared as a `pi.themes` array in
 * the package manifest (e.g. `@wierdbytes/pi-tokyo-night`). Resolving those by
 * hand would mean reimplementing pi's rules, so ask pi's own resource loader —
 * with every other resource disabled, so no extension code is loaded or run.
 */
async function contributedThemes(): Promise<Map<string, Theme>> {
  const agentDir = getAgentDir()
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager: SettingsManager.create(process.cwd(), agentDir),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  })
  await loader.reload()
  const found = new Map<string, Theme>()
  for (const theme of loader.getThemes().themes) {
    if (theme.name && !found.has(theme.name)) found.set(theme.name, theme)
  }
  return found
}

export async function availableThemes(): Promise<string[]> {
  const names = new Set(BUILTIN)
  const dir = customThemesDir()
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) names.add(file.slice(0, -".json".length))
    }
  }
  try {
    for (const name of (await contributedThemes()).keys()) names.add(name)
  } catch {
    // Package themes are a bonus; never block startup on resolving them.
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * pi's `theme` setting may be a single name or an auto pair `"<light>/<dark>"`.
 * pi resolves the pair by querying the terminal's real background; that
 * detector isn't exported, so fall back to the COLORFGBG hint.
 */
function configuredTheme(): string | undefined {
  let setting: string | undefined
  try {
    setting = SettingsManager.create(process.cwd()).getThemeSetting()
  } catch {
    return undefined
  }
  if (!setting) return undefined

  const slash = setting.indexOf("/")
  if (slash === -1) return setting
  const light = setting.slice(0, slash).trim()
  const dark = setting.slice(slash + 1).trim()
  if (!light || !dark) return undefined
  const bg = process.env["COLORFGBG"]?.split(";").pop()
  return bg !== undefined && Number(bg) >= 9 ? light : dark
}

/**
 * Explicit flag wins, then the theme configured in pi's settings, then pi's own
 * terminal-background default. Returns the theme actually applied, which may
 * differ from the request when a name cannot be resolved.
 */
export async function applyTheme(requested?: string): Promise<string> {
  const name = requested ?? configuredTheme()
  if (!name) {
    initTheme(undefined, false)
    return "auto"
  }

  // Anything pi can resolve on its own goes through the public API.
  if (
    BUILTIN.includes(name) ||
    existsSync(join(customThemesDir(), `${name}.json`))
  ) {
    initTheme(name, false)
    return name
  }

  try {
    const contributed = (await contributedThemes()).get(name)
    if (contributed) {
      ;(globalThis as Record<symbol, unknown>)[THEME_KEY] = contributed
      return name
    }
  } catch {
    // Fall through to the built-in fallback below.
  }

  // initTheme falls back to dark silently; be explicit that we did not comply.
  initTheme(name, false)
  return `dark (could not resolve "${name}")`
}
