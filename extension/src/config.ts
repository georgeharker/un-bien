import fs from "node:fs";
import path from "node:path";
import { unbienConfigHome } from "./paths.js";

// Resolved at call time via `unbienConfigHome()` — the global config is a pi
// extension config at `<PI_CODING_AGENT_DIR|~/.pi>/extensions/un-bien.json`.
// See paths.ts.
const configDir = (): string => unbienConfigHome();
const configFile = (): string => path.join(unbienConfigHome(), "un-bien.json");

export type UnBienConfig = {
  relay?: string;
  /**
   * Debug prefs. Fields here gate the file-based diagnostic logs (see
   * `session/debug_log.ts` and `panel_bridge.ts`). Read from config — NOT env —
   * because the fork usually runs detached and doesn't inherit a shell's env, so
   * a persisted config field is the only reliable enable switch. Absent/false by
   * default: no logging.
   */
  debug?: { envelope?: boolean; panels?: boolean };
  /**
   * Machine-wide fallback defaults for a session's LOCAL config (the per-cwd
   * `.pi/un-bien/config.json`). A field here applies to every cwd that does
   * not set it via the inline `UNBIEN_DIRECT_CONFIG` env or its own file, so
   * you can pin `auto_start_relay` once — beside `relay` — instead of dropping a
   * file into every repo. See `session/local_config.ts`. Absent by default, so
   * omitting it preserves the historical per-cwd-only behaviour exactly.
   */
  defaults?: { auto_start_relay?: boolean };
};

export function loadConfig(): UnBienConfig {
  try {
    const raw = fs.readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as UnBienConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<UnBienConfig>): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
}

export type RelayResolution =
  { url: string; source: "env" | "config" } | { url: null; source: "unset" };

/**
 * Resolves the effective relay URL in **canonical http(s):// form**.
 *
 * Precedence:
 *   1. `UNBIEN_RELAY` env var (ops/CI escape hatch)
 *   2. `relay` field in the global config
 *      (`<PI_CODING_AGENT_DIR|~/.pi>/extensions/un-bien.json`, set via
 *      `/unbien set-relay`)
 *
 * There is NO built-in default. When neither is set, `url` is null and
 * `source` is `"unset"` — callers MUST refuse to connect and prompt the user
 * to configure a relay (un-bien ships pointing at nobody's infrastructure).
 *
 * Any ws(s):// values found (legacy configs or env overrides) are coerced
 * to http(s):// defensively — the canonical form across the codebase is
 * http(s)://, and the transport layer converts to ws(s):// at WS-open time.
 */
export function resolveRelayUrl(): RelayResolution {
  const env = process.env["UNBIEN_RELAY"];
  if (env && env.length > 0) return { url: toHttpUrl(env), source: "env" };
  const cfg = loadConfig();
  if (cfg.relay && cfg.relay.length > 0)
    return { url: toHttpUrl(cfg.relay), source: "config" };
  return { url: null, source: "unset" };
}

/**
 * Strict validator for **user-provided** relay URLs (via `/unbien
 * set-relay` or `/unbien relay url`).
 *
 * Only accepts `http://` and `https://`. `ws://`/`wss://` are deliberately
 * **rejected** — the canonical form stored in config is http(s):// and the
 * extension converts to ws(s):// internally when opening the WebSocket.
 * Forcing a single scheme at the user boundary avoids two-form drift.
 */
export function isValidRelayUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://"))
    return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL uses ws:// or wss:// scheme — for emitting a
 * targeted error message when the user pastes a WebSocket URL by mistake.
 */
export function isWebSocketScheme(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("ws://") || lower.startsWith("wss://");
}

/**
 * Converts an http(s):// URL to the corresponding ws(s):// form. Used by
 * the transport layer right before opening the WebSocket — config storage
 * and the mesh HTTP client both stay on http(s)://.
 *
 *   https://host  → wss://host
 *   http://host   → ws://host
 *   ws(s)://host  → pass-through (defensive — env overrides or legacy
 *                   configs may still carry ws(s)://)
 */
export function toWebSocketUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("https://"))
    return "wss://" + url.slice("https://".length);
  if (lower.startsWith("http://")) return "ws://" + url.slice("http://".length);
  return url;
}

/**
 * Inverse of `toWebSocketUrl`. Used by `resolveRelayUrl` to coerce any
 * ws(s):// values back to canonical http(s):// before returning them to
 * the rest of the codebase.
 */
export function toHttpUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("wss://"))
    return "https://" + url.slice("wss://".length);
  if (lower.startsWith("ws://")) return "http://" + url.slice("ws://".length);
  return url;
}
