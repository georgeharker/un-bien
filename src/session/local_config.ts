import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCAL_DIR = ".pi/remote-pi";
const LOCAL_FILE = "config.json";

export interface LocalConfig {
  agent_name?: string;
  /**
   * If true (default), `/remote-pi` with no args auto-joins the local UDS
   * mesh and starts the relay on a fresh terminal. The field name is
   * historical (plano 21); the UX wording was reworked to "use the relay
   * on this terminal to connect to the remote mesh (mobile + PCs)". Legacy
   * configs without this field are treated as `true` for backward compat.
   */
  auto_start_relay?: boolean;
}

function pathFor(cwd: string): string {
  return join(cwd, LOCAL_DIR, LOCAL_FILE);
}

/** Returns true when `<cwd>/.pi/remote-pi/config.json` exists on disk. */
export function localConfigExists(cwd: string): boolean {
  return existsSync(pathFor(cwd));
}

export function loadLocalConfig(cwd: string): LocalConfig {
  const p = pathFor(cwd);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    // Only surface known fields. Legacy `session_name` from pre-refactor
    // configs is silently dropped — the local UDS mesh is now always a
    // single fixed session, so the field has no meaning.
    const src = parsed as Record<string, unknown>;
    const cfg: LocalConfig = {};
    if (typeof src["agent_name"] === "string") cfg.agent_name = src["agent_name"];
    if (typeof src["auto_start_relay"] === "boolean") cfg.auto_start_relay = src["auto_start_relay"];
    return cfg;
  } catch {
    return {};
  }
}

export function saveLocalConfig(cwd: string, patch: Partial<LocalConfig>): void {
  const p = pathFor(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const current = loadLocalConfig(cwd);
  const next: LocalConfig = { ...current, ...patch };
  // Always persist auto_start_relay explicitly (default true) so future reads
  // never need to guess. Backward-compat: legacy files without the field
  // are treated as true on read; we lock that intent in on first save.
  if (typeof next.auto_start_relay !== "boolean") next.auto_start_relay = true;
  writeFileSync(p, JSON.stringify(next, null, 2));
}

/**
 * Default agent name when none is configured: `<parent>/<folder>` of the
 * given cwd. Falls back gracefully when the parent isn't meaningful
 * (root, current dir, single-segment paths) — in those cases just the
 * folder name. Purpose: surface a non-empty string the user can accept
 * by pressing enter in the wizard.
 */
export function defaultAgentName(cwd: string): string {
  const folder = basename(cwd);
  const parent = basename(dirname(cwd));
  if (!folder) return "agent";
  if (!parent || parent === "/" || parent === folder || parent === ".") return folder;
  return `${parent}/${folder}`;
}

/** Resolves auto_start_relay with backward-compat (undefined → true). */
export function effectiveAutoStartRelay(cfg: LocalConfig): boolean {
  return cfg.auto_start_relay !== false;
}
