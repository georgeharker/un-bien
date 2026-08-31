import { homedir } from "node:os"
import { join } from "node:path"
import { migrateLegacyStateOnce } from "./state_migration.js"

/**
 * Absolute root for un-bien on-disk STATE: `sessions/`, `skills/`, the
 * paired-identity/`peers.json` store, the daemon registries (`daemons.json`,
 * `cron.json`), the cron/audit logs, the supervisor socket, and the cwd lock
 * dir. Every state path in the codebase derives from this one resolver so a
 * relocated install can never split its state across two roots.
 *
 * The GLOBAL config is the one exception — it follows the coding-agent dir via
 * `unbienConfigHome()` (below) as `extensions/un-bien.json`, not this resolver
 * (design 01M1CB6Q: the config/state split).
 *
 * Precedence (resolved at CALL time so tests — and a relocated deployment —
 * can override via env without re-importing):
 *
 *   1. `UNBIEN_STATE_DIR` — an ABSOLUTE override of the state dir itself. This
 *      is the knob to reach for when relocating state.
 *   2. `UNBIEN_DIR`      — legacy absolute override, same semantics, lower
 *      precedence (kept because test suites use it).
 *   3. `UNBIEN_HOME`     — legacy stand-in `$HOME`; state lives at
 *      `<UNBIEN_HOME>/.pi/un-bien` (kept because test suites use it).
 *   4. `${XDG_STATE_HOME:-~/.local/state}/un-bien` — the XDG-style default.
 *      `XDG_STATE_HOME` unset (conventionally so on macOS) falls back to
 *      `$HOME/.local/state`.
 *
 * The resolver itself is pure — it returns a path and never touches the
 * filesystem. Writers create the root with mkdir -p on first use; the
 * one-time legacy migration (see `state_migration.ts`) is the first writer.
 */
export function resolveUnbienStateRoot(): string {
  const stateDir = process.env["UNBIEN_STATE_DIR"]
  if (stateDir && stateDir.length > 0) return stateDir
  const dir = process.env["UNBIEN_DIR"]
  if (dir && dir.length > 0) return dir
  const home = process.env["UNBIEN_HOME"]
  if (home && home.length > 0) return join(home, ".pi", "un-bien")
  const xdg = process.env["XDG_STATE_HOME"]
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state")
  return join(base, "un-bien")
}

/**
 * The state root, with the one-time legacy-state migration hooked in. Same
 * name/signature as ever (many callers); see `resolveUnbienStateRoot()` for
 * the precedence order. The migration hook is cheap after the first call and
 * is skipped entirely under vitest, so tests can call this freely.
 */
export function unbienStateHome(): string {
  const root = resolveUnbienStateRoot()
  migrateLegacyStateOnce()
  return root
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
  const agentDir = process.env["PI_CODING_AGENT_DIR"]
  const base =
    agentDir && agentDir.length > 0 ? agentDir : join(homedir(), ".pi")
  return join(base, "extensions")
}
