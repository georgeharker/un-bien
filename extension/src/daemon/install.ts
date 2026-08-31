import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { delimiter } from "node:path"
import { homedir, platform, tmpdir, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { unbienStateHome } from "../paths.js"

/**
 * Generates and activates a system service for the un-bien launcher daemon so
 * it survives reboots.
 *
 * Platform support:
 *   - **macOS**: writes `~/Library/LaunchAgents/dev.unbien.launcher.plist`
 *     and runs `launchctl bootstrap gui/<uid> <plist>` (modern API) with a
 *     fallback to `launchctl load` for older macOS.
 *   - **Linux**: writes `~/.config/systemd/user/unbien-launcher.service`
 *     and runs `systemctl --user daemon-reload && systemctl --user enable
 *     --now unbien-launcher.service`.
 *
 * Uninstall reverses both. Idempotent — re-running install over an existing
 * unit refreshes it (paths could have changed if user moved node_modules).
 *
 * **What does NOT happen here**: the actual `npm install -g un-bien` step.
 * The user has to make the launcher bin reachable on disk before install
 * can wire up the service. The `findLauncherScript` resolver detects
 * common cases (npm global, pnpm global, local dev clone) and yields a
 * clear error otherwise.
 */

// ── Platform detection ─────────────────────────────────────────────────────

export type SupervisorPlatform = "macos" | "linux" | "windows" | "unsupported"

export function detectPlatform(): SupervisorPlatform {
  switch (platform()) {
    case "darwin":
      return "macos"
    case "linux":
      return "linux"
    case "win32":
      return "windows"
    default:
      return "unsupported"
  }
}

// ── Path resolution ────────────────────────────────────────────────────────

/**
 * Absolute path to the launcher daemon's compiled entry. We resolve from
 * `import.meta.url` (this file's location) since wherever the daemon
 * module lives, `bin/launcher.js` is a sibling of `daemon/` under
 * `dist/`.
 *
 * After build: `dist/daemon/install.js` → `dist/bin/launcher.js`.
 * In dev (`tsx`): same path resolution still lands inside `src/`, which
 * isn't directly runnable by `node` — dev install isn't expected.
 */
export function findLauncherScript(): string {
  const here = fileURLToPath(import.meta.url) // dist/daemon/install.js
  const daemonDir = dirname(here) // dist/daemon
  const distRoot = dirname(daemonDir) // dist
  return resolve(distRoot, "bin/launcher.js")
}

/**
 * Absolute path to the extension's CLI entry (`dist/index.js`). This is
 * the file we symlink to `~/.local/bin/unbien` so the user can run
 * `un-bien <subcommand>` from any shell after installing the extension
 * through Pi (`pi install npm:un-bien`).
 *
 * Same resolution strategy as `findLauncherScript`: from
 * `dist/daemon/install.js` → `dist/index.js`.
 */
export function findRemotePiScript(): string {
  const here = fileURLToPath(import.meta.url) // dist/daemon/install.js
  const daemonDir = dirname(here) // dist/daemon
  const distRoot = dirname(daemonDir) // dist
  return resolve(distRoot, "index.js")
}

export function findNodeBinary(): string {
  // `process.execPath` is always absolute and points at the current Node
  // binary. Embedding it in the service unit means the user gets the
  // exact same Node version they invoked `unbien install` with — no
  // PATH ambiguity at boot time.
  return process.execPath
}

export function findTemplate(
  name: "systemd" | "launchd" | "taskscheduler" | "vbs-launcher",
): string {
  // Templates ship next to the compiled `dist/` (via `files` in package.json).
  // From `dist/daemon/install.js` go up two levels and into
  // `service-templates/`. In the published npm tarball the layout is the
  // same — `service-templates/` is sibling to `dist/`.
  const here = fileURLToPath(import.meta.url) // dist/daemon/install.js
  const pkgRoot = resolve(dirname(dirname(dirname(here)))) // package root
  const file =
    name === "systemd"
      ? "systemd.service.template"
      : name === "launchd"
        ? "launchd.plist.template"
        : name === "vbs-launcher"
          ? "task-launcher.vbs.template"
          : "task-scheduler.xml.template"
  return resolve(pkgRoot, "service-templates", file)
}

// ── Service paths ──────────────────────────────────────────────────────────

export function systemdUnitPath(): string {
  return join(
    homedir(),
    ".config",
    "systemd",
    "user",
    "unbien-launcher.service",
  )
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "dev.unbien.launcher.plist")
}

export const LAUNCHD_LABEL = "dev.unbien.launcher"
/** systemd --user unit name (with `.service`) for the launcher daemon. */
export const SYSTEMD_UNIT = "unbien-launcher.service"
/** Windows Task Scheduler task name. */
export const WINDOWS_TASK_NAME = "RemotePiLauncher"

/** Path of the rendered Task Scheduler XML (input to `schtasks /Create /XML`). */
export function taskXmlPath(): string {
  return join(unbienStateHome(), "RemotePiLauncher.xml")
}

/**
 * Path of the rendered VBScript launcher the Task Scheduler action invokes
 * via `wscript.exe` (Windows). Launching node through this hidden wrapper is
 * what keeps the launcher daemon from flashing a console window.
 */
export function vbsLauncherPath(): string {
  return join(unbienStateHome(), "RemotePiLauncherRun.vbs")
}

/**
 * Combined stdout/stderr log for the Windows launcher daemon. The Task
 * Scheduler launches it hidden via wscript, so without this redirect its output
 * would vanish — mirrors launchd/systemd, which already log to
 * `<state root>/launcher.log` (default `~/.local/state/un-bien/`).
 */
export function launcherLogPath(): string {
  return join(unbienStateHome(), "launcher.log")
}

// ── Template rendering ─────────────────────────────────────────────────────

export interface RenderVars {
  node: string
  launcher: string
  home: string
  user: string
  /** PATH inherited so `pi --mode rpc` resolves the same way it does
   *  interactively. We snapshot `process.env.PATH` at install time. */
  path: string
  /** Windows only: absolute path of the VBScript launcher the Task Scheduler
   *  action runs via `wscript.exe`. Empty on POSIX (templates ignore `{VBS}`). */
  vbs: string
  /** Windows only: combined stdout/stderr log the hidden launcher daemon
   *  appends to. Empty on POSIX (templates ignore `{LOG}`). */
  logPath: string
}

export function defaultRenderVars(): RenderVars {
  return {
    node: findNodeBinary(),
    launcher: findLauncherScript(),
    home: homedir(),
    user: userInfo().username,
    path: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    vbs: vbsLauncherPath(),
    logPath: launcherLogPath(),
  }
}

/** Replace `{NODE}` / `{PRESENCE}` / `{USER}` / `{HOME}` / `{PATH}` / `{VBS}` / `{LOG}`. */
export function renderTemplate(template: string, vars: RenderVars): string {
  return template
    .replace(/\{NODE\}/g, vars.node)
    .replace(/\{PRESENCE\}/g, vars.launcher)
    .replace(/\{USER\}/g, vars.user)
    .replace(/\{HOME\}/g, vars.home)
    .replace(/\{PATH\}/g, vars.path)
    .replace(/\{VBS\}/g, vars.vbs)
    .replace(/\{LOG\}/g, vars.logPath)
}

// ── Install / uninstall API ────────────────────────────────────────────────

export interface InstallResult {
  platform: SupervisorPlatform
  unitPath: string
  /** Lines describing each step taken — surfaced to the user via notify. */
  log: string[]
}

/**
 * Writes the unit/plist, runs the platform's activation command. Throws
 * on unsupported OS or when the supervisor script isn't found.
 *
 * Idempotent: re-running re-writes the unit (paths could have changed)
 * and re-activates via the platform tool's idempotent flag.
 */
export function installService(
  vars: RenderVars = defaultRenderVars(),
): InstallResult {
  const plat = detectPlatform()
  const log: string[] = []

  if (plat === "unsupported") {
    throw new Error(
      `unsupported platform: ${platform()}. Only macOS, Linux, and Windows.`,
    )
  }

  // Sanity: launcher script must exist on disk.
  if (!existsSync(vars.launcher)) {
    throw new Error(
      `launcher script not found at ${vars.launcher}. ` +
        "Run `pnpm build` (dev) or `npm install -g un-bien` (prod) first.",
    )
  }

  const templateName =
    plat === "macos"
      ? "launchd"
      : plat === "linux"
        ? "systemd"
        : "taskscheduler"
  const templatePath = findTemplate(templateName)
  if (!existsSync(templatePath)) {
    throw new Error(`service template missing: ${templatePath}`)
  }
  const tpl = readFileSync(templatePath, "utf8")
  const rendered = renderTemplate(tpl, vars)

  const unitPath =
    plat === "macos"
      ? launchdPlistPath()
      : plat === "linux"
        ? systemdUnitPath()
        : taskXmlPath()
  mkdirSync(dirname(unitPath), { recursive: true })
  if (plat === "windows") {
    // `schtasks /Create /XML` requires UTF-16LE + BOM. A UTF-8 file fails with
    // "(1,40)::ERROR: unable to switch the encoding" — the bytes must match the
    // template's `encoding="UTF-16"` declaration. (plan/40 risk #5.)
    const bom = Buffer.from([0xff, 0xfe]) // UTF-16LE byte-order mark
    writeFileSync(
      unitPath,
      Buffer.concat([bom, Buffer.from(rendered, "utf16le")]),
    )
  } else {
    writeFileSync(unitPath, rendered) // launchd/systemd → UTF-8
  }
  log.push(`wrote ${unitPath}`)

  if (plat === "macos") {
    // Unload first in case a stale entry exists from a prior install —
    // `launchctl bootstrap` errors out otherwise. `bootout` is the modern
    // API; `unload` is the legacy fallback. Either may fail silently.
    const uid = userInfo().uid
    _tryExec("launchctl", ["bootout", `gui/${uid}`, unitPath], log)
    _tryExec("launchctl", ["unload", unitPath], log)
    _exec("launchctl", ["bootstrap", `gui/${uid}`, unitPath], log)
    log.push(`activated via launchctl bootstrap gui/${uid}`)
  } else if (plat === "linux") {
    _exec("systemctl", ["--user", "daemon-reload"], log)
    _exec("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], log)
    log.push("activated via systemctl --user enable --now")
  } else {
    // windows — Task Scheduler. The action runs `wscript.exe
    // <launcher.vbs>` (not node directly) so the launcher daemon starts hidden,
    // with no console window. Render + write that launcher first.
    const vbsTpl = findTemplate("vbs-launcher")
    if (!existsSync(vbsTpl))
      throw new Error(`vbs launcher template missing: ${vbsTpl}`)
    const vbsPath = vars.vbs
    writeFileSync(vbsPath, renderTemplate(readFileSync(vbsTpl, "utf8"), vars))
    log.push(`wrote ${vbsPath}`)

    // Only `schtasks /Create` modifies the root task store → that single op
    // needs admin (elevate it via UAC). `/End` (stop a prior instance) and
    // `/Run` (start it) act on a task we already own and work un-elevated — the
    // very ops `unbien restart-supervisor` runs without elevation. Keeping
    // them un-elevated narrows the admin surface to the one operation that
    // truly requires it.
    _tryExec("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME], log)
    _execElevatedWindows(
      [`schtasks /Create /XML "${unitPath}" /TN ${WINDOWS_TASK_NAME} /F`],
      log,
    )
    _exec("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME], log)
    log.push(
      `activated via schtasks /Create (elevated) + /Run (${WINDOWS_TASK_NAME})`,
    )
  }

  return { platform: plat, unitPath, log }
}

export interface UninstallResult {
  platform: SupervisorPlatform
  unitPath: string
  removed: boolean
  log: string[]
}

export function uninstallService(): UninstallResult {
  const plat = detectPlatform()
  const log: string[] = []

  if (plat === "unsupported") {
    throw new Error(
      `unsupported platform: ${platform()}. Only macOS, Linux, and Windows.`,
    )
  }

  const unitPath =
    plat === "macos"
      ? launchdPlistPath()
      : plat === "linux"
        ? systemdUnitPath()
        : taskXmlPath()

  if (plat === "macos") {
    const uid = userInfo().uid
    _tryExec("launchctl", ["bootout", `gui/${uid}`, unitPath], log)
    _tryExec("launchctl", ["unload", unitPath], log)
    log.push("deactivated via launchctl bootout")
  } else if (plat === "linux") {
    _tryExec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], log)
    log.push("deactivated via systemctl --user disable --now")
  } else {
    // windows — Task Scheduler (plan/40): stop + delete the task. Only
    // `/Delete` modifies the root task store → that's the op that needs admin.
    // `/End` stops the running task and works un-elevated (own task), like
    // restart-supervisor. `exit /b 0` keeps uninstall best-effort: a missing
    // task (already removed) is success, not an error.
    _tryExec("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME], log)
    _execElevatedWindows(
      [`schtasks /Delete /TN ${WINDOWS_TASK_NAME} /F`, `exit /b 0`],
      log,
    )
    log.push(`deactivated via elevated schtasks /Delete (${WINDOWS_TASK_NAME})`)
  }

  let removed = false
  if (existsSync(unitPath)) {
    try {
      unlinkSync(unitPath)
      removed = true
      log.push(`removed ${unitPath}`)
    } catch (e) {
      log.push(`failed to remove ${unitPath}: ${String(e)}`)
    }
  }

  // Windows: also drop the hidden VBScript launcher we wrote alongside the XML.
  if (plat === "windows") {
    const vbsPath = vbsLauncherPath()
    if (existsSync(vbsPath)) {
      try {
        unlinkSync(vbsPath)
        log.push(`removed ${vbsPath}`)
      } catch (e) {
        log.push(`failed to remove ${vbsPath}: ${String(e)}`)
      }
    }
  }

  if (plat === "linux") {
    _tryExec("systemctl", ["--user", "daemon-reload"], log)
  }

  // Hint about the label for users that want to verify manually.
  if (plat === "macos") log.push(`(label: ${LAUNCHD_LABEL})`)

  return { platform: plat, unitPath, removed, log }
}

// ── Internals ──────────────────────────────────────────────────────────────

function _exec(cmd: string, args: string[], log: string[]): void {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (out.trim()) log.push(`$ ${cmd} ${args.join(" ")}\n${out.trim()}`)
    else log.push(`$ ${cmd} ${args.join(" ")}`)
  } catch (e) {
    const err = e as {
      stderr?: Buffer | string
      status?: number
      message: string
    }
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : (err.stderr?.toString() ?? "")
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` exited ${err.status ?? "?"}\n${stderr.trim() || err.message}`,
    )
  }
}

/** Like _exec but swallows errors — used for cleanup steps where failure
 *  is expected (e.g., "unload" before "load" when nothing was loaded). */
function _tryExec(cmd: string, args: string[], log: string[]): void {
  try {
    _exec(cmd, args, log)
  } catch {
    /* expected, suppress */
  }
}

// ── Windows elevation (plan/40) ────────────────────────────────────────────
//
// `schtasks /Create` and `/Delete` register/remove the task in the root folder,
// which requires administrator rights. We can't elevate the current Node
// process, so we render the schtasks sequence into a temp `.cmd`, run it
// through an elevated `cmd.exe` via PowerShell `Start-Process -Verb RunAs`
// (one UAC prompt), and read the output back from a log file the script
// redirects into.

/**
 * Build the batch script run elevated. Each command line redirects its output
 * to `logFile` so the (separate, elevated) process's output can be read back by
 * the parent. Control-flow lines (`if`/`exit`/`rem`/`@`) run bare — redirecting
 * them would swallow the exit code. Pure + exported for tests.
 */
export function buildElevatedCmd(lines: string[], logFile: string): string {
  const redirect = ` >> "${logFile}" 2>&1`
  const body = lines.map((ln) =>
    /^\s*(if|exit|rem|@)/i.test(ln) ? ln : ln + redirect,
  )
  return ["@echo off", ...body].join("\r\n") + "\r\n"
}

function _readIfExists(p: string): string {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

/**
 * Run a schtasks command sequence elevated (UAC). Throws a clear error when the
 * prompt is declined or the task operation fails (`Start-Process -Verb RunAs`
 * throws → PowerShell exits non-zero → `execFileSync` throws). Captured schtasks
 * output is appended to `log` either way.
 */
function _execElevatedWindows(lines: string[], log: string[]): void {
  const base = join(tmpdir(), `un-bien-elevate-${process.pid}`)
  const cmdPath = `${base}.cmd`
  const logFile = `${base}.log`
  writeFileSync(cmdPath, buildElevatedCmd(lines, logFile))
  try {
    unlinkSync(logFile)
  } catch {
    /* none yet */
  }

  let thrown: unknown = null
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','"${cmdPath}"' ` +
          "-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
  } catch (e) {
    thrown = e
  }

  const out = _readIfExists(logFile).trim()
  if (out) log.push(out)
  try {
    unlinkSync(cmdPath)
  } catch {
    /* best-effort */
  }
  try {
    unlinkSync(logFile)
  } catch {
    /* best-effort */
  }

  if (thrown) {
    throw new Error(
      "administrator privileges required — the UAC prompt was declined or the " +
        "schtasks operation failed. Run the command again and accept the Windows " +
        `elevation prompt.${out ? `\n${out}` : ""}`,
    )
  }
}

// ── CLI bin linking (plan/27) ─────────────────────────────────────────────────
//
// When the user installs Remote Pi through Pi (`pi install npm:un-bien`),
// the extension's `bin` entries in package.json never reach `$PATH` — Pi's
// installer ignores them. Without `npm install -g un-bien` a second time,
// the user can't run `unbien …` from a shell.
//
// `linkCliBinaries` writes one symlink into `~/.local/bin/`:
//   - `un-bien`     → `<extensionRoot>/dist/index.js`
//
// The target gets `chmod +x` (tsc doesn't preserve the executable bit;
// node tolerates running it via symlink either way, but POSIX shells
// won't `exec` a non-executable file directly). The OS service runs the
// launcher daemon as `node dist/bin/launcher.js` directly, so it needs no
// symlink of its own.
//
// This step is opt-in and runs ONLY when the slash-command path triggers
// `_cmdInstall` — i.e., the user is inside Pi's TUI. The CLI-mode path
// (`unbien install` invoked from a shell because the user did
// `npm install -g un-bien`) MUST NOT symlink — the user already has
// working bins from npm-global, and stomping them with our symlinks
// would point them at the *Pi-extension copy* instead of the npm-global
// copy, which is a different file tree and would diverge on upgrades.

export interface LinkBinariesResult {
  /** `~/.local/bin/`. The symlink lands here. */
  binDir: string
  /** Paths of the symlink(s) we created/refreshed. */
  links: Array<{ name: string; path: string; target: string }>
  /** True when `binDir` is already on `$PATH`. False → caller surfaces the
   *  "add this line to your shell rc" hint to the user. */
  onPath: boolean
  log: string[]
}

export function userLocalBinDir(home: string = homedir()): string {
  return join(home, ".local", "bin")
}

/**
 * Check whether `dir` is on `process.env.PATH`. Tolerates trailing
 * slashes and relative entries (which we treat as not matching — `~/.local/bin`
 * is always absolute on our end).
 */
export function isOnPath(
  dir: string,
  envPath: string = process.env["PATH"] ?? "",
): boolean {
  const target = dir.replace(/\/+$/, "")
  return envPath
    .split(delimiter)
    .some((entry) => entry.replace(/\/+$/, "") === target)
}

/**
 * Create (or refresh) the `un-bien` symlink in `~/.local/bin/`. Idempotent —
 * replaces stale links pointing at old extension paths (Pi can reinstall the
 * extension to a different hash dir on upgrades, so this MUST overwrite).
 *
 * Returns `onPath: false` when `~/.local/bin` isn't in the user's `$PATH`.
 * The caller is responsible for surfacing the shell-rc instruction —
 * we don't edit the user's shell config files automatically.
 */
export function linkCliBinaries(
  home: string = homedir(),
  paths: { remotePi?: string } = {},
  opts: { node?: string; mutatePath?: boolean } = {},
): LinkBinariesResult {
  const binDir = userLocalBinDir(home)

  // Windows (plan/40): no POSIX symlinks. Installing via Pi (`pi install
  // npm:un-bien`) never reaches PATH, so write real `.cmd` shims into
  // `~/.local/bin` and add that dir to the user's PATH (HKCU — no admin).
  if (platform() === "win32") {
    return _linkCliBinariesWindows(home, binDir, paths, opts)
  }

  const log: string[] = []

  mkdirSync(binDir, { recursive: true })
  log.push(`ensured ${binDir}`)

  const remotePi = paths.remotePi ?? findRemotePiScript()
  if (!existsSync(remotePi)) {
    throw new Error(
      `unbien script not found at ${remotePi}. ` +
        "Run `pnpm build` (dev) or reinstall the extension.",
    )
  }

  // tsc strips the executable bit on its outputs; the shebang at the top
  // of dist/index.js means the file IS a valid interpreter target once
  // chmod +x is applied.
  try {
    chmodSync(remotePi, 0o755)
  } catch {
    /* best-effort */
  }

  const links: LinkBinariesResult["links"] = [
    { name: "unbien", path: join(binDir, "unbien"), target: remotePi },
  ]
  for (const link of links) {
    _replaceSymlink(link.path, link.target, log)
  }

  const onPath = isOnPath(binDir)
  if (!onPath) {
    log.push(
      `WARNING: ${binDir} is not on $PATH. ` +
        `Add this line to your shell rc (~/.zshrc, ~/.bashrc, etc.): ` +
        `export PATH="$HOME/.local/bin:$PATH"`,
    )
  }

  return { binDir, links, onPath, log }
}

/**
 * Windows variant of `linkCliBinaries`: writes an `un-bien.cmd` shim into
 * `~/.local/bin` and ensures that dir is on the user's PATH (User scope — no
 * admin). `opts.node` overrides the node binary (tests); `opts.mutatePath ===
 * false` skips the real PATH mutation (tests).
 */
function _linkCliBinariesWindows(
  home: string,
  binDir: string,
  paths: { remotePi?: string },
  opts: { node?: string; mutatePath?: boolean },
): LinkBinariesResult {
  void home
  const log: string[] = []
  mkdirSync(binDir, { recursive: true })
  log.push(`ensured ${binDir}`)

  const node = opts.node ?? findNodeBinary()
  const remotePi = paths.remotePi ?? findRemotePiScript()
  if (!existsSync(remotePi)) {
    throw new Error(
      `unbien script not found at ${remotePi}. ` +
        "Run `pnpm build` (dev) or reinstall the extension.",
    )
  }

  const links: LinkBinariesResult["links"] = [
    {
      name: "un-bien.cmd",
      path: join(binDir, "un-bien.cmd"),
      target: remotePi,
    },
  ]
  for (const link of links) {
    writeFileSync(link.path, buildCmdShim(node, link.target))
    log.push(`wrote ${link.path}`)
  }

  const onPath = isOnPath(binDir)
  if (!onPath && opts.mutatePath !== false) {
    try {
      _addUserPath(binDir)
      log.push(
        `added ${binDir} to your user PATH — open a NEW terminal for \`un-bien\` to resolve.`,
      )
    } catch (e) {
      log.push(
        `WARNING: ${binDir} is not on PATH and auto-add failed (${String(e)}). ` +
          `Add it manually: setx PATH "%PATH%;${binDir}"`,
      )
    }
  }

  return { binDir, links, onPath, log }
}

/** A Windows `.cmd` shim that forwards all args to `node "<target>"`. Pure. */
export function buildCmdShim(node: string, target: string): string {
  return `@echo off\r\n"${node}" "${target}" %*\r\n`
}

/**
 * Append `dir` to the User-scope PATH via PowerShell (HKCU\Environment — no
 * admin). Idempotent: skips when `dir` is already an exact PATH segment. Single-
 * quoted PS literal (backslashes are literal in PS single quotes) with embedded
 * `'` doubled.
 */
function _addUserPath(dir: string): void {
  const lit = `'${dir.replace(/'/g, "''")}'`
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$d = ${lit}; ` +
        "$p = [Environment]::GetEnvironmentVariable('Path','User'); " +
        "if (-not $p) { $p = '' }; " +
        "$parts = $p.Split(';') | Where-Object { $_ -ne '' }; " +
        "if ($parts -notcontains $d) { " +
        "[Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User') }",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
}

/**
 * Remove the symlinks `linkCliBinaries` created. Idempotent — missing
 * links are a no-op. Returns whether each link was actually present so
 * the caller can render a useful summary. Targets (the extension files)
 * are NOT touched here — they live outside this dir and belong to Pi.
 */
export interface UnlinkBinariesResult {
  binDir: string
  removed: Array<{ name: string; path: string; existed: boolean }>
  log: string[]
}

export function unlinkCliBinaries(
  home: string = homedir(),
): UnlinkBinariesResult {
  const binDir = userLocalBinDir(home)
  const log: string[] = []
  // Windows shims are `.cmd` files (linkCliBinaries writes those); POSIX uses
  // extensionless symlinks. Match what was actually created on this platform.
  const names = platform() === "win32" ? ["un-bien.cmd"] : ["unbien"]
  const removed: UnlinkBinariesResult["removed"] = []

  for (const name of names) {
    const path = join(binDir, name)
    let existed = false
    try {
      // lstatSync (not stat) so a symlink targeting a deleted file still
      // resolves — we want to remove the LINK itself, not chase it.
      lstatSync(path)
      existed = true
    } catch {
      /* not present */
    }
    if (existed) {
      try {
        unlinkSync(path)
        log.push(`removed ${path}`)
      } catch (e) {
        log.push(`failed to remove ${path}: ${String(e)}`)
        existed = false
      }
    }
    removed.push({ name, path, existed })
  }

  return { binDir, removed, log }
}

/**
 * Atomic-ish symlink replace. Idiomatic recipe — `symlinkSync` errors
 * with `EEXIST` if the path is already a symlink/file, so we remove
 * first. Race window between unlink and symlink is irrelevant for a
 * single-user install command (no concurrent writers).
 */
function _replaceSymlink(
  linkPath: string,
  target: string,
  log: string[],
): void {
  let existing: string | null = null
  try {
    existing = readlinkSync(linkPath)
  } catch {
    /* not a symlink, or doesn't exist */
  }

  if (existing === target) {
    log.push(`symlink ${linkPath} → ${target} (unchanged)`)
    return
  }

  // Either it doesn't exist, or it points elsewhere. Remove + recreate.
  try {
    unlinkSync(linkPath)
  } catch {
    /* fine if absent */
  }
  symlinkSync(target, linkPath)
  log.push(`symlink ${linkPath} → ${target}`)
}
