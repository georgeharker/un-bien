import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Absolute root for un-bien on-disk STATE: `sessions/`, `skills/`, the
 * paired-identity/`peers.json` store, the daemon registries (`daemons.json`,
 * `cron.json`), the cron/audit logs, the supervisor socket, and the cwd lock
 * dir. Every state path in the codebase derives from this one resolver so a
 * relocated install can never split its state across two roots.
 *
 * The GLOBAL config is the one exception — it follows the coding-agent dir via
 * `unbienConfigHome()` (below) as `extensions/un-bien.json`, not this resolver.
 *
 * Precedence (resolved at CALL time so tests — and a relocated deployment —
 * can override via env without re-importing):
 *
 *   1. `UNBIEN_DIR`  — an ABSOLUTE override of the state dir itself. Lets the
 *      state live at an arbitrary path (e.g. an XDG-style `~/.config/pi/un-bien`)
 *      with no forced `.pi/un-bien` suffix. This is the knob to reach for when
 *      relocating; `UNBIEN_HOME` cannot express it.
 *   2. `UNBIEN_HOME` — a stand-in `$HOME`; state lives at
 *      `<UNBIEN_HOME>/.pi/un-bien`. Long-standing test/override knob.
 *   3. `os.homedir()`   — the default, `~/.pi/un-bien`.
 */
export function unbienStateHome(): string {
  const dir = process.env["UNBIEN_DIR"];
  if (dir && dir.length > 0) return dir;
  return join(process.env["UNBIEN_HOME"] || homedir(), ".pi", "un-bien");
}

/**
 * Root for un-bien's global config specifically — the machine-wide relay URL,
 * the `defaults` block, and the `debug` prefs. The Pi host keeps its own global
 * settings under `PI_CODING_AGENT_DIR`, and un-bien's config is a pi extension
 * config: `<PI_CODING_AGENT_DIR|~/.pi>/extensions/un-bien.json`. This resolver
 * returns the `extensions` dir; `config.ts` appends `un-bien.json`.
 *
 * Precedence (resolved at CALL time):
 *
 *   1. `PI_CODING_AGENT_DIR` — the Pi host's settings root (default `~/.pi`).
 *      Config lives at `<PI_CODING_AGENT_DIR>/extensions/un-bien.json`.
 *   2. otherwise `~/.pi/extensions` — the default agent-dir location.
 *
 * State (sessions, daemon registries, cwd locks, identity) is unaffected — only
 * the global config honours `PI_CODING_AGENT_DIR` this way.
 */
export function unbienConfigHome(): string {
  const agentDir = process.env["PI_CODING_AGENT_DIR"];
  const base =
    agentDir && agentDir.length > 0 ? agentDir : join(homedir(), ".pi");
  return join(base, "extensions");
}
