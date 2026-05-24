import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates and activates a system service for `pi-supervisord` so the
 * daemon fleet survives reboots (plan/26 W3).
 *
 * Platform support:
 *   - **macOS**: writes `~/Library/LaunchAgents/dev.remotepi.supervisord.plist`
 *     and runs `launchctl bootstrap gui/<uid> <plist>` (modern API) with a
 *     fallback to `launchctl load` for older macOS.
 *   - **Linux**: writes `~/.config/systemd/user/remote-pi-supervisord.service`
 *     and runs `systemctl --user daemon-reload && systemctl --user enable
 *     --now remote-pi-supervisord.service`.
 *
 * Uninstall reverses both. Idempotent — re-running install over an existing
 * unit refreshes it (paths could have changed if user moved node_modules).
 *
 * **What does NOT happen here**: the actual `npm install -g remote-pi` step.
 * The user has to make the supervisor bin reachable on disk before install
 * can wire up the service. The `findSupervisorScript` resolver detects
 * common cases (npm global, pnpm global, local dev clone) and yields a
 * clear error otherwise.
 */

// ── Platform detection ─────────────────────────────────────────────────────

export type SupervisorPlatform = "macos" | "linux" | "unsupported";

export function detectPlatform(): SupervisorPlatform {
  switch (platform()) {
    case "darwin": return "macos";
    case "linux": return "linux";
    default: return "unsupported";
  }
}

// ── Path resolution ────────────────────────────────────────────────────────

/**
 * Absolute path to the supervisor's compiled entry. We resolve from
 * `import.meta.url` (this file's location) since wherever the daemon
 * module lives, `bin/supervisord.js` is a sibling of `daemon/` under
 * `dist/`.
 *
 * After build: `dist/daemon/install.js` → `dist/bin/supervisord.js`.
 * In dev (`tsx`): same path resolution still lands inside `src/`, which
 * isn't directly runnable by `node` — dev install isn't expected.
 */
export function findSupervisorScript(): string {
  const here = fileURLToPath(import.meta.url);          // dist/daemon/install.js
  const daemonDir = dirname(here);                       // dist/daemon
  const distRoot = dirname(daemonDir);                   // dist
  return resolve(distRoot, "bin/supervisord.js");
}

export function findNodeBinary(): string {
  // `process.execPath` is always absolute and points at the current Node
  // binary. Embedding it in the service unit means the user gets the
  // exact same Node version they invoked `remote-pi install` with — no
  // PATH ambiguity at boot time.
  return process.execPath;
}

export function findTemplate(name: "systemd" | "launchd"): string {
  // Templates ship next to the compiled `dist/` (via `files` in package.json).
  // From `dist/daemon/install.js` go up two levels and into
  // `service-templates/`. In the published npm tarball the layout is the
  // same — `service-templates/` is sibling to `dist/`.
  const here = fileURLToPath(import.meta.url);          // dist/daemon/install.js
  const pkgRoot = resolve(dirname(dirname(dirname(here))));  // package root
  const file = name === "systemd"
    ? "systemd.service.template"
    : "launchd.plist.template";
  return resolve(pkgRoot, "service-templates", file);
}

// ── Service paths ──────────────────────────────────────────────────────────

export function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "remote-pi-supervisord.service");
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "dev.remotepi.supervisord.plist");
}

const LAUNCHD_LABEL = "dev.remotepi.supervisord";

// ── Template rendering ─────────────────────────────────────────────────────

export interface RenderVars {
  node: string;
  supervisor: string;
  home: string;
  user: string;
  /** PATH inherited so `pi --mode rpc` resolves the same way it does
   *  interactively. We snapshot `process.env.PATH` at install time. */
  path: string;
}

export function defaultRenderVars(): RenderVars {
  return {
    node: findNodeBinary(),
    supervisor: findSupervisorScript(),
    home: homedir(),
    user: userInfo().username,
    path: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
  };
}

/** Replace `{NODE}` / `{SUPERVISOR}` / `{USER}` / `{HOME}` / `{PATH}`. */
export function renderTemplate(template: string, vars: RenderVars): string {
  return template
    .replace(/\{NODE\}/g, vars.node)
    .replace(/\{SUPERVISOR\}/g, vars.supervisor)
    .replace(/\{USER\}/g, vars.user)
    .replace(/\{HOME\}/g, vars.home)
    .replace(/\{PATH\}/g, vars.path);
}

// ── Install / uninstall API ────────────────────────────────────────────────

export interface InstallResult {
  platform: SupervisorPlatform;
  unitPath: string;
  /** Lines describing each step taken — surfaced to the user via notify. */
  log: string[];
}

/**
 * Writes the unit/plist, runs the platform's activation command. Throws
 * on unsupported OS or when the supervisor script isn't found.
 *
 * Idempotent: re-running re-writes the unit (paths could have changed)
 * and re-activates via the platform tool's idempotent flag.
 */
export function installService(vars: RenderVars = defaultRenderVars()): InstallResult {
  const plat = detectPlatform();
  const log: string[] = [];

  if (plat === "unsupported") {
    throw new Error(`unsupported platform: ${platform()}. Only macOS and Linux.`);
  }

  // Sanity: supervisor script must exist on disk.
  if (!existsSync(vars.supervisor)) {
    throw new Error(
      `supervisor script not found at ${vars.supervisor}. ` +
      "Run `pnpm build` (dev) or `npm install -g remote-pi` (prod) first.",
    );
  }

  const templatePath = findTemplate(plat === "macos" ? "launchd" : "systemd");
  if (!existsSync(templatePath)) {
    throw new Error(`service template missing: ${templatePath}`);
  }
  const tpl = readFileSync(templatePath, "utf8");
  const rendered = renderTemplate(tpl, vars);

  const unitPath = plat === "macos" ? launchdPlistPath() : systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, rendered);
  log.push(`wrote ${unitPath}`);

  if (plat === "macos") {
    // Unload first in case a stale entry exists from a prior install —
    // `launchctl bootstrap` errors out otherwise. `bootout` is the modern
    // API; `unload` is the legacy fallback. Either may fail silently.
    const uid = userInfo().uid;
    _tryExec("launchctl", ["bootout", `gui/${uid}`, unitPath], log);
    _tryExec("launchctl", ["unload", unitPath], log);
    _exec("launchctl", ["bootstrap", `gui/${uid}`, unitPath], log);
    log.push(`activated via launchctl bootstrap gui/${uid}`);
  } else {
    _exec("systemctl", ["--user", "daemon-reload"], log);
    _exec("systemctl", ["--user", "enable", "--now", "remote-pi-supervisord.service"], log);
    log.push("activated via systemctl --user enable --now");
  }

  return { platform: plat, unitPath, log };
}

export interface UninstallResult {
  platform: SupervisorPlatform;
  unitPath: string;
  removed: boolean;
  log: string[];
}

export function uninstallService(): UninstallResult {
  const plat = detectPlatform();
  const log: string[] = [];

  if (plat === "unsupported") {
    throw new Error(`unsupported platform: ${platform()}. Only macOS and Linux.`);
  }

  const unitPath = plat === "macos" ? launchdPlistPath() : systemdUnitPath();

  if (plat === "macos") {
    const uid = userInfo().uid;
    _tryExec("launchctl", ["bootout", `gui/${uid}`, unitPath], log);
    _tryExec("launchctl", ["unload", unitPath], log);
    log.push("deactivated via launchctl bootout");
  } else {
    _tryExec("systemctl", ["--user", "disable", "--now", "remote-pi-supervisord.service"], log);
    log.push("deactivated via systemctl --user disable --now");
  }

  let removed = false;
  if (existsSync(unitPath)) {
    try { unlinkSync(unitPath); removed = true; log.push(`removed ${unitPath}`); }
    catch (e) { log.push(`failed to remove ${unitPath}: ${String(e)}`); }
  }

  if (plat === "linux") {
    _tryExec("systemctl", ["--user", "daemon-reload"], log);
  }

  // Hint about the label for users that want to verify manually.
  if (plat === "macos") log.push(`(label: ${LAUNCHD_LABEL})`);

  return { platform: plat, unitPath, removed, log };
}

// ── Internals ──────────────────────────────────────────────────────────────

function _exec(cmd: string, args: string[], log: string[]): void {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (out.trim()) log.push(`$ ${cmd} ${args.join(" ")}\n${out.trim()}`);
    else log.push(`$ ${cmd} ${args.join(" ")}`);
  } catch (e) {
    const err = e as { stderr?: Buffer | string; status?: number; message: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "";
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` exited ${err.status ?? "?"}\n${stderr.trim() || err.message}`,
    );
  }
}

/** Like _exec but swallows errors — used for cleanup steps where failure
 *  is expected (e.g., "unload" before "load" when nothing was loaded). */
function _tryExec(cmd: string, args: string[], log: string[]): void {
  try { _exec(cmd, args, log); } catch { /* expected, suppress */ }
}
