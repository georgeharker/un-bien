import { spawn, spawnSync, execFile } from "node:child_process"
import { basename, dirname, join, resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { loadConfig } from "./config.js"
import { unbienStateHome } from "./paths.js"
import { envLog, launcherLog } from "./session/debug_log.js"

/**
 * Launch backends for remote `session_launch` — shared by the extension (index.ts)
 * and the regime-2 launcher daemon. PTY-hosted backends exec `pi` cleanly (no
 * keystrokes): `tmux` = a WINDOW in one shared named session; `herdr` =
 * `workspace create` then `agent start --kind pi`. `rpc` is a fast-follow.
 */

/** Expand a leading `~`/`~/` to the extension machine's home dir. Node's `fs` does
 *  NOT expand `~`, so a launch cwd like `~/proj` would fail the existsSync
 *  check and silently abort the launch. Machine-side (the phone's `~` is
 *  meaningless here). Exported for tests. */
export function _expandTilde(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

/** Sanitize a tmux session name: keep it shell-safe and tmux-legal. */
/** The shell remote launches run through (launchd fix): config
 *  `launch.shell` → $SHELL → the user's LOGIN SHELL from the OS (launchd /
 *  systemd strip SHELL from the daemon env, so the OS is the only reliable
 *  source) → `zsh` as the final fallback. NEVER assume the user's shell —
 *  a bash user with a zsh default would get an empty environment, the
 *  exact bug this resolves. */
export function _launchShell(): string {
  const configured = loadConfig().launch?.shell
  if (configured && configured.trim()) return configured.trim()
  if (process.env.SHELL) return process.env.SHELL
  try {
    if (process.platform === "darwin") {
      const r = spawnSync(
        "dscl",
        [".", "-read", `/Users/${process.env.USER}`, "UserShell"],
        { encoding: "utf8", timeout: 3_000 },
      )
      const m = /UserShell:\s*(\S+)/.exec(r.stdout ?? "")
      if (m?.[1]) return m[1]
    } else {
      const r = spawnSync(
        "getent",
        ["passwd", String(process.getuid?.() ?? "")],
        { encoding: "utf8", timeout: 3_000 },
      )
      const shell = (r.stdout ?? "").trim().split(":").pop()
      if (shell && shell.includes("/")) return shell
    }
  } catch {
    // OS lookup failed (unusual platform / dscl restrictions) — fall through.
  }
  return "zsh"
}

function _safeTmuxName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").trim() || fallback
  // tmux disallows `.` and `:` in session names; strip anything risky.
  const clean = base
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
  return clean.slice(0, 40) || "pi"
}

/** Build the argv for launching `pi` in `cwd` as a WINDOW of the shared tmux
 *  session `session` (one named session, a window per pi — clean `new-window`,
 *  NO keystrokes/prefix). First launch creates the detached session; later ones
 *  add a window. Array (never a shell string) so cwd/names can't inject.
 *  Exported for tests. */
/**
 * argv for the tmux launch. The pi invocation carries `-n <name>` when the
 * launch request named the session: pi's native session display name, which
 * the extension reads back (piSessionName → resolveAgentName) so the mesh
 * join, cwd lock, room_meta, and the app tile ALL show the requested name
 * instead of the path-derived default. Per-process arg — never inherited by
 * subagents or child processes. Exported for tests.
 */
export function _buildTmuxLaunchArgs(
  session: string,
  windowName: string,
  cwd: string,
  sessionExists: boolean,
  sessionName?: string | undefined,
  resume?: string | undefined,
  /** Pane command override — the FULL tmux shell-command argv, verbatim.
   *  When provided, NOTHING is appended after it (the legacy path appends
   *  the -n name and --session resume args; a custom command carries them
   * INSIDE — tmux joins trailing args with spaces, so appending onto a
   * quoted one-string command corrupts it: observed live as every launch
   * failing at tmux itself). Absent ⇒ the legacy argv: `pi` + name +
   *  resume. */
  commandArgv?: string[],
): string[] {
  const nameArgv =
    typeof sessionName === "string" && sessionName.trim().length > 0
      ? ["-n", sessionName.trim()]
      : []
  // Resume a stored session: `--session <path|partial-uuid>` (NOT -r — that
  // opens pi's interactive picker, unusable in a spawned window).
  const resumeArgv =
    typeof resume === "string" && resume.trim().length > 0
      ? ["--session", resume.trim()]
      : []
  return sessionExists
    ? [
        "new-window",
        "-t",
        session,
        "-n",
        windowName,
        "-c",
        cwd,
        "--",
        ...(commandArgv ?? ["pi", ...nameArgv, ...resumeArgv]),
      ]
    : [
        "new-session",
        "-d",
        "-s",
        session,
        "-n",
        windowName,
        "-c",
        cwd,
        "--",
        ...(commandArgv ?? ["pi", ...nameArgv, ...resumeArgv]),
      ]
}

/** Sanitize a herdr agent name: must match [a-z][a-z0-9_-]{0,31}. */
function _safeHerdrName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").trim().toLowerCase() || fallback
  let clean = base
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!/^[a-z]/.test(clean)) clean = `pi-${clean}`
  return clean.slice(0, 32).replace(/-+$/g, "") || "pi"
}

/** argv for creating a detached herdr workspace in `cwd`. No `--json` flag:
 *  herdr >=0.9.1 removed it (output is JSON by default) and rejects it
 *  outright ("unknown option: --json"), which made every remote-launch
 *  fail before this hit the pane. ARRAY (never a shell string) so
 *  cwd/label can't inject. Exported for tests. */
export function _buildHerdrWorkspaceArgs(label: string, cwd: string): string[] {
  return [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    label,
    "--no-focus",
  ]
}

/** argv for exec-launching `pi` as a named herdr agent in an existing pane —
 *  herdr's canonical-executable launch (NOT keystroke injection). `extraArgv`
 *  rides after `--` (herdr passes trailing args UNCHANGED to the kind's
 *  executable — how `pi --session <id>` reaches pi for resume parity). */
export function _buildHerdrAgentStartArgs(
  agentName: string,
  paneId: string,
  extraArgv: string[] = [],
): string[] {
  const passthrough = extraArgv.length > 0 ? ["--", ...extraArgv] : []
  return ["agent", "start", agentName, "--kind", "pi", "--pane", paneId, ...passthrough]
}

/** Extract `.result.root_pane.pane_id` from `herdr workspace create`'s
 *  (default-JSON, as of herdr >=0.9.1) stdout. */
export function _herdrPaneIdFromCreate(stdout: string): string | null {
  try {
    const j = JSON.parse(stdout) as {
      result?: { root_pane?: { pane_id?: unknown } }
    }
    const id = j.result?.root_pane?.pane_id
    return typeof id === "string" && id.length > 0 ? id : null
  } catch {
    return null
  }
}

/** Is a launch backend's binary present on PATH? A `--version` probe: a missing
 *  binary (ENOENT) sets `error`; anything that runs counts as present. */
function _backendAvailable(backend: "tmux" | "herdr"): boolean {
  try {
    return (
      spawnSync(backend, ["--version"], {
        stdio: "ignore",
        timeout: 5_000,
      }).error === undefined
    )
  } catch {
    return false
  }
}

function _execFileCapture(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 15_000, env: opts.env }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * herdr launch (clean exec, no keystrokes): create a detached workspace in
 * `cwd`, then start `pi` as its agent via herdr's canonical-executable path
 * (`agent start --kind pi -- [extra argv]`). extraArgv carries `--session`
 * for the resume flow (herdr `--` passthrough, tmux parity). Resolves null
 * once herdr reports the agent ready, else the failure (also logged).
 */
async function _launchHerdr(
  cwd: string,
  agentName: string,
  launchReq?: string,
  extraArgv: string[] = [],
): Promise<string | null> {
  // launchReq rides the spawn env: herdr's `agent start --kind pi` spawns pi
  // as a child, which inherits this env, so the extension's roomMeta can echo
  // it (launch correlation — the app auto-opens the launched chat).
  const spawnEnv = launchReq
    ? { env: { ...process.env, UNBIEN_LAUNCH_REQ: launchReq } }
    : {}
  try {
    const created = await _execFileCapture(
      "herdr",
      _buildHerdrWorkspaceArgs(agentName, cwd),
      spawnEnv,
    )
    const paneId = _herdrPaneIdFromCreate(created)
    if (!paneId) {
      launcherLog("herdr launch: no root_pane_id in `workspace create` output")
      return "herdr workspace create returned no pane"
    }
    // `agent start` is NOT fire-and-forget in herdr: it returns only after
    // herdr detects the agent and marks it ready (up to 30s default). Our
    // exec budget must exceed that, or a slow-starting pi gets killed by
    // OUR timeout while herdr is still detecting.
    await _execFileCapture(
      "herdr",
      _buildHerdrAgentStartArgs(agentName, paneId, extraArgv),
      { ...spawnEnv, timeout: 45_000 },
    )
    envLog(`herdr launch: agent '${agentName}' started in pane ${paneId}`)
    return null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    launcherLog(`herdr launch failed: ${detail}`)
    return `herdr launch failed: ${detail.slice(0, 400)}`
  }
}

/** Is `cwd` within the machine's remote-launch dir ALLOW-LIST (design 01M211VW9)?
 *  `"*"` or absent (the default) allows any dir; a named list allows a dir only
 *  when it equals or is nested under a listed entry. `~` expanded on both sides.
 *  Callers pass `loadConfig().launch?.dirs` FRESH per request. */
export function launchDirAllowed(
  cwd: string,
  dirs: "*" | string[] | undefined,
): boolean {
  if (dirs === undefined || dirs === "*") return true
  if (!Array.isArray(dirs) || dirs.length === 0) return false
  const target = resolve(_expandTilde(cwd))
  return dirs.some((d) => {
    const base = resolve(_expandTilde(d))
    return target === base || target.startsWith(`${base}/`)
  })
}

// ── Launch results ──────────────────────────────────────────────────────────

export type LaunchBackend = "tmux" | "herdr" | "rex"

/** Why a launch did not start, as the app's `session_launch_result.code`. */
export type LaunchErrorCode =
  | "remote_launch_disabled"
  | "unknown_peer"
  | "permission_denied"
  | "cwd_missing"
  | "backend_missing"
  | "backend_unavailable"
  | "spawn_failed"
  | "exited_early"

/** The outcome of one `session_launch`. `ok` means pi was started; a later
 *  `exited_early` result may still follow for the same request. */
export interface LaunchResult {
  ok: boolean
  backend?: LaunchBackend
  /** The configured backend was unavailable and `launch.fallback` was used. */
  fell_back?: { from: LaunchBackend; reason: string }
  code?: LaunchErrorCode
  message?: string
  /** The tail of pi's output when it exited early. */
  output?: string
}

export interface LaunchRequest {
  cwd: string
  name?: string | undefined
  resume?: string | undefined
  /** The app's request id, passed to pi as UNBIEN_LAUNCH_REQ. */
  launchReq?: string | undefined
}

/** How long a started pi must stay up before its launch counts as good. */
export const EARLY_EXIT_WINDOW_MS = 20_000
/** Lines of pi's output an `exited_early` result carries. */
const OUTPUT_TAIL_LINES = 40

/** The machine's configured backend (`launch.backend`; tmux when absent). */
export function configuredBackend(): LaunchBackend {
  const b = loadConfig().launch?.backend
  return b === "herdr" || b === "rex" ? b : "tmux"
}

function configuredFallback(): LaunchBackend | null {
  const f = loadConfig().launch?.fallback
  return f === "tmux" || f === "herdr" || f === "rex" ? f : null
}

/** Why `backend` cannot be used right now, or null when it can. A missing
 *  binary is `backend_missing`; a present one that can't serve (Rex with no
 *  reachable server) is `backend_unavailable`. */
export async function backendUnavailable(
  backend: LaunchBackend,
): Promise<{ code: LaunchErrorCode; message: string } | null> {
  if (backend === "rex") return rexUnavailable()
  return _backendAvailable(backend)
    ? null
    : { code: "backend_missing", message: `launch backend '${backend}' is not installed` }
}

/** The tail of `text`: its last `lines` non-empty-at-end lines. */
export function _outputTail(text: string, lines = OUTPUT_TAIL_LINES): string {
  const all = text.replace(/\s+$/, "").split("\n")
  return all.slice(-lines).join("\n")
}

/**
 * Honor a `session_launch` request whose gates (opt-in, pairing, allow-list)
 * the caller has checked: validate the cwd, pick the backend (falling back
 * per `launch.fallback` when the configured one is unavailable), and start pi.
 * Resolves with the immediate result; when pi dies within
 * EARLY_EXIT_WINDOW_MS, `onLater` receives an `exited_early` result with the
 * tail of its output.
 */
export async function launchSession(
  req: LaunchRequest,
  onLater?: (result: LaunchResult) => void,
): Promise<LaunchResult> {
  if (!existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) {
    return { ok: false, code: "cwd_missing", message: `Directory does not exist: ${req.cwd}` }
  }
  const configured = configuredBackend()
  let backend = configured
  let fellBack: LaunchResult["fell_back"]
  const unavailable = await backendUnavailable(configured)
  if (unavailable) {
    const fallback = configuredFallback()
    const fallbackProblem = fallback && fallback !== configured ? await backendUnavailable(fallback) : null
    if (!fallback || fallback === configured || fallbackProblem) {
      return {
        ok: false,
        backend: configured,
        code: unavailable.code,
        message: fallbackProblem
          ? `${unavailable.message}; fallback '${fallback}' also unavailable: ${fallbackProblem.message}`
          : unavailable.message,
      }
    }
    backend = fallback
    fellBack = { from: configured, reason: unavailable.message }
    launcherLog(`launch: '${configured}' unavailable (${unavailable.message}); falling back to '${fallback}'`)
  }
  const later = onLater
    ? (r: LaunchResult) => onLater({ ...r, ...(fellBack ? { fell_back: fellBack } : {}) })
    : undefined
  let result: LaunchResult
  try {
    if (backend === "tmux") result = await launchTmux(req, later)
    else if (backend === "herdr") result = await launchHerdr(req)
    else result = await launchRex(req, later)
  } catch (error) {
    result = {
      ok: false,
      backend,
      code: "spawn_failed",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  return fellBack ? { ...result, fell_back: fellBack } : result
}

// ── herdr ───────────────────────────────────────────────────────────────────

async function launchHerdr(req: LaunchRequest): Promise<LaunchResult> {
  const agentName = _safeHerdrName(req.name, `pi-${basename(req.cwd) || "session"}`)
  // Resume parity with tmux: herdr passes trailing argv after `--`
  // UNCHANGED to the kind's executable, so `pi --session <id>` reaches pi.
  const resumeArgv =
    typeof req.resume === "string" && req.resume.trim().length > 0
      ? ["--session", req.resume.trim()]
      : []
  const failure = await _launchHerdr(req.cwd, agentName, req.launchReq, resumeArgv)
  return failure
    ? { ok: false, backend: "herdr", code: "spawn_failed", message: failure }
    : { ok: true, backend: "herdr" }
}

// ── tmux ────────────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Run `command` through the user's login shell (the daemon's launchd env has
 *  no Homebrew PATH, so tmux itself is resolved there). */
function _loginShellRun(
  command: string,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(_launchShell(), ["-l", "-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += String(d)))
    child.stderr?.on("data", (d) => (stderr += String(d)))
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr: stderr || err.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
  })
}

/** The tmux argv for a launch, printing the new window's id and keeping its
 *  pane after the command exits (so an early death can be read), in ONE tmux
 *  invocation: the chained set-option applies to the new window before its
 *  command can exit. Exported for tests. */
export function _withWindowIdAndRemain(argv: string[]): string[] {
  return [argv[0] ?? "", "-P", "-F", "#{window_id}", ...argv.slice(1), ";", "set-option", "-w", "remain-on-exit", "on"]
}

async function launchTmux(
  req: LaunchRequest,
  onLater?: (result: LaunchResult) => void,
): Promise<LaunchResult> {
  const { cwd, name, resume, launchReq } = req
  // One shared, named tmux session; each launch is a WINDOW in it (single
  // attach point). Clean `new-window` via the CLI — never a prefix keystroke.
  const session = _safeTmuxName(loadConfig().launch?.tmux_session, "un-bien")
  const windowName = _safeTmuxName(name, `pi-${basename(cwd) || "session"}`)
  // BOTH-LAYER wrap: the OUTER tmux invocation runs in the login shell (the
  // daemon's launchd env has no Homebrew PATH), and the INNER pane command
  // keeps its own shell wrap (windows inherit the SERVER's env, which may
  // predate any env fix). The pane command is ONE shell-quoted string: tmux
  // joins trailing argv with spaces into a single shell command, so the name,
  // resume and launchReq ride inside it, POSIX-quoted (injection-safe).
  const sessionExists =
    (await _loginShellRun(`exec tmux has-session -t ${q(session)}`, 5_000)).code === 0
  const piTail = [
    ...(name ? [`-n`, q(name)] : []),
    ...(resume ? [`--session`, q(resume)] : []),
  ].join(" ")
  const inner = launchReq
    ? `exec env UNBIEN_LAUNCH_REQ=${q(launchReq)} pi${piTail ? ` ${piTail}` : ""}`
    : `exec pi${piTail ? ` ${piTail}` : ""}`
  // Extra shell args (launch.shell_args, default ["-l"]) ride quoted before
  // -c, so configured args can never displace the command.
  const extraArgs = (loadConfig().launch?.shell_args ?? ["-l"]).map(q).join(" ")
  const commandArgv = [`${q(_launchShell())} ${extraArgs} -c ${q(inner)}`]
  const argv = _withWindowIdAndRemain(
    _buildTmuxLaunchArgs(session, windowName, cwd, sessionExists, name, resume, commandArgv),
  )
  const run = await _loginShellRun(`exec tmux ${argv.map(q).join(" ")}`)
  if (run.code !== 0) {
    const detail = run.stderr.trim().slice(0, 400) || `tmux exited with code ${String(run.code)}`
    launcherLog(`launch tmux failed: ${detail}`)
    return { ok: false, backend: "tmux", code: "spawn_failed", message: detail }
  }
  const windowId = /@\d+/.exec(run.stdout)?.[0]
  if (windowId) _watchTmuxWindow(windowId, onLater)
  return { ok: true, backend: "tmux" }
}

/** After EARLY_EXIT_WINDOW_MS: a dead pane means pi exited early. Report it
 *  with the pane's output and close the window; a live pane stops keeping
 *  itself after exit (pi's normal exit closes the window, as before). */
function _watchTmuxWindow(windowId: string, onLater?: (result: LaunchResult) => void): void {
  const timer = setTimeout(() => {
    void (async () => {
      const panes = await _loginShellRun(
        `exec tmux list-panes -t ${q(windowId)} -F '#{pane_dead} #{pane_dead_status}'`,
        5_000,
      )
      const [dead, status] = panes.stdout.trim().split(/\s+/)
      if (panes.code !== 0) return   // the window is gone (closed by hand)
      if (dead !== "1") {
        await _loginShellRun(`exec tmux set-option -w -t ${q(windowId)} remain-on-exit off`, 5_000)
        return
      }
      const captured = await _loginShellRun(`exec tmux capture-pane -p -t ${q(windowId)}`, 5_000)
      const output = _outputTail(
        captured.stdout.split("\n").filter((l) => !/^Pane is dead \(/.test(l)).join("\n"),
      )
      await _loginShellRun(`exec tmux kill-window -t ${q(windowId)}`, 5_000)
      launcherLog(`launch tmux: pi exited early (status ${status ?? "?"}): ${output.slice(-400)}`)
      onLater?.({
        ok: false,
        backend: "tmux",
        code: "exited_early",
        message: `pi exited${status ? ` with status ${status}` : ""} right after starting`,
        output,
      })
    })()
  }, EARLY_EXIT_WINDOW_MS)
  timer.unref?.()
}

// ── Rex ─────────────────────────────────────────────────────────────────────
//
// Rex (superlogical.com/rex) hosts each pi as a WINDOW of the Rex session
// labelled `launch.rex_session` (default "un-bien"): an existing session with
// that label (whoever made it), else one created with it. Every rex call passes
// `--autostart=false` and the server endpoint: run outside a Rex terminal the
// CLI's default socket is not the running server's, and autostart would
// start a second, hidden server. The command is a real argv (no shell
// string); Rex runs it through the login shell's environment (.zshenv /
// .zprofile; `--interactive` adds .zshrc). Windows are created with
// `--keep-open` (a pane that fails at once is otherwise gone before its
// output can be read): a pi that exits within EARLY_EXIT_WINDOW_MS is
// reported with its output and its pane left open; one that exits later has
// its window closed, as a tmux window closes.

/** Where the Rex app ships its CLI (it installs nothing on PATH). */
const REX_APP_BINARIES = [
  "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
  "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
]

/** The rex binary: `launch.rex_bin`, else PATH, else the Rex app bundle. */
export function _rexBinary(): string | null {
  const configured = loadConfig().launch?.rex_bin?.trim()
  if (configured) {
    const path = _expandTilde(configured)
    return existsSync(path) ? path : null
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, "rex")
    if (existsSync(candidate)) return candidate
  }
  return REX_APP_BINARIES.find((p) => existsSync(p)) ?? null
}

/** The server endpoint: `launch.rex_server`, else REX_SERVER, else (macOS)
 *  the local server's socket. Only a local `unix://` socket is accepted: the
 *  launch cwd, allow-list and pairing all belong to this machine. Null when
 *  the CLI's own default applies (Linux, nothing configured). */
export function _rexEndpoint(): { endpoint: string | null; error?: string } {
  const configured = (loadConfig().launch?.rex_server ?? process.env.REX_SERVER ?? "").trim()
  if (configured) {
    return configured.startsWith("unix://")
      ? { endpoint: configured }
      : { endpoint: null, error: `launch.rex_server must be a local unix:// socket, not '${configured}'` }
  }
  if (process.platform === "darwin") {
    const sock = join(homedir(), "Library", "Application Support", "rex", "server.sock")
    return { endpoint: `unix://${sock.split("/").map(encodeURIComponent).join("/")}` }
  }
  return { endpoint: null }
}

/** Global args every rex call starts with. Exported for tests. */
export function _rexGlobalArgs(endpoint: string | null): string[] {
  return ["--autostart=false", ...(endpoint ? ["-S", endpoint] : []), "--timeout", "10s"]
}

/** A window label from the launch name (Rex allows any text up to 128
 *  characters; a leading `-` would read as a flag). Exported for tests. */
export function _rexLabel(name: string | undefined, cwd: string): string {
  const base = (name ?? "").replace(/[\r\n\t]+/g, " ").trim() || `pi-${basename(cwd) || "session"}`
  return base.replace(/^-+/, "").slice(0, 128) || "pi"
}

/** The pi argv a Rex window runs. Exported for tests. */
export function _rexPiArgv(req: LaunchRequest): string[] {
  const name = req.name?.trim()
  const resume = req.resume?.trim()
  return [
    ...(req.launchReq ? ["env", `UNBIEN_LAUNCH_REQ=${req.launchReq}`] : []),
    "pi",
    ...(name ? ["-n", name] : []),
    ...(resume ? ["--session", resume] : []),
  ]
}

/** Flags shared by `rex new` and `rex window new` for a launch: the cwd,
 *  keep-open, and the shell (launch.shell → --shell; "-i" in
 *  launch.shell_args → --interactive). Exported for tests. */
export function _rexWindowFlags(cwd: string): string[] {
  const launch = loadConfig().launch
  const shell = launch?.shell?.trim()
  return [
    "-c", cwd,
    "--keep-open",
    ...(shell ? [`--shell=${shell}`] : []),
    ...((launch?.shell_args ?? []).includes("-i") ? ["--interactive"] : []),
    "--json",
  ]
}

/** argv to create the launcher's Rex session with pi as its first window. */
export function _buildRexNewArgs(session: string, label: string, req: LaunchRequest): string[] {
  return ["new", session, `--window=${label}`, ..._rexWindowFlags(req.cwd), "--", ..._rexPiArgv(req)]
}

/** argv to add pi as a window of the launcher's session, without focus. */
export function _buildRexWindowArgs(sessionId: string, label: string, req: LaunchRequest): string[] {
  return ["window", "new", "-s", sessionId, label, "--focus=false", ..._rexWindowFlags(req.cwd), "--", ..._rexPiArgv(req)]
}

/** The ids `rex new --json` / `rex window new --json` print. */
export function _rexIdsFromJson(stdout: string): { sessionId?: string; windowId?: string; blockId?: string } {
  try {
    const j = JSON.parse(stdout) as {
      session_id?: unknown
      window_id?: unknown
      block_ids?: unknown
      initial_windows?: { window_id?: unknown; block_ids?: unknown }[]
    }
    const first = j.initial_windows?.[0]
    const windowId = typeof j.window_id === "string" ? j.window_id : first?.window_id
    const blocks = Array.isArray(j.block_ids) ? j.block_ids : first?.block_ids
    const blockId = Array.isArray(blocks) ? blocks[0] : undefined
    return {
      ...(typeof j.session_id === "string" ? { sessionId: j.session_id } : {}),
      ...(typeof windowId === "string" ? { windowId } : {}),
      ...(typeof blockId === "string" ? { blockId } : {}),
    }
  } catch {
    return {}
  }
}

interface RexRun {
  code: number
  stdout: string
  stderr: string
}

function _rexRun(bin: string, endpoint: string | null, args: string[], timeoutMs = 15_000): Promise<RexRun> {
  return new Promise((resolveRun) => {
    execFile(bin, [..._rexGlobalArgs(endpoint), ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const exitCode = (err as { code?: unknown } | null)?.code
      let code = 0
      if (err) code = typeof exitCode === "number" ? exitCode : -1
      resolveRun({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function rexUnavailable(): Promise<{ code: LaunchErrorCode; message: string } | null> {
  const bin = _rexBinary()
  if (!bin) {
    return { code: "backend_missing", message: "Rex is not installed (no rex on PATH or in the Rex app)" }
  }
  const { endpoint, error } = _rexEndpoint()
  if (error) return { code: "backend_unavailable", message: error }
  const who = await _rexRun(bin, endpoint, ["whoami", "--json"], 12_000)
  if (who.code !== 0) {
    return {
      code: "backend_unavailable",
      message: (who.stderr.trim().replace(/^Error:\s*/, "") || "the Rex server did not answer").slice(0, 300),
    }
  }
  return null
}

/** The session the launcher last used, kept across restarts: the tie-break
 *  when several sessions share the configured label. */
interface RexLaunchState {
  endpoint: string | null
  host_id: string
  session_id: string
}

function _rexStatePath(): string {
  return join(unbienStateHome(), "rex-launch.json")
}

function _readRexState(): RexLaunchState | null {
  try {
    const raw = JSON.parse(readFileSync(_rexStatePath(), "utf8")) as Partial<RexLaunchState>
    return typeof raw.session_id === "string" && typeof raw.host_id === "string"
      ? { endpoint: raw.endpoint ?? null, host_id: raw.host_id, session_id: raw.session_id }
      : null
  } catch {
    return null
  }
}

function _writeRexState(state: RexLaunchState): void {
  try {
    mkdirSync(dirname(_rexStatePath()), { recursive: true })
    writeFileSync(_rexStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch (err) {
    launcherLog(`rex: could not save the session id: ${String(err)}`)
  }
}

/** The server's host id from `rex whoami --json` ("" when unreadable, so a
 *  stored session is not trusted). */
function _rexHostId(whoamiJson: string): string {
  try {
    return String((JSON.parse(whoamiJson) as { host_id?: unknown }).host_id ?? "")
  } catch {
    return ""
  }
}

/** The ids of the sessions `rex ls --json` lists under exactly `label`, in
 *  list order. Exported for tests. */
export function _rexSessionsLabelled(lsJson: string, label: string): string[] {
  try {
    const sessions = (JSON.parse(lsJson) as { sessions?: { session_id?: unknown; label?: unknown }[] }).sessions ?? []
    return sessions
      .filter((x) => x.label === label && typeof x.session_id === "string")
      .map((x) => x.session_id as string)
  } catch {
    return []
  }
}

/** The session labelled `label` on this server: the one last used when
 *  several share it, else the first listed; null when none does. */
async function _rexSessionByLabel(
  bin: string, endpoint: string | null, hostId: string, label: string,
): Promise<string | null> {
  const ls = await _rexRun(bin, endpoint, ["ls", "--json"])
  if (ls.code !== 0) return null
  const matches = _rexSessionsLabelled(ls.stdout, label)
  const stored = _readRexState()
  if (stored && hostId && stored.host_id === hostId && stored.endpoint === endpoint &&
      matches.includes(stored.session_id)) {
    return stored.session_id
  }
  return matches[0] ?? null
}

/** One Rex launch at a time, so two first launches create one session. */
let rexLaunchQueue: Promise<unknown> = Promise.resolve()

async function launchRex(req: LaunchRequest, onLater?: (result: LaunchResult) => void): Promise<LaunchResult> {
  const run = rexLaunchQueue.then(() => _launchRexNow(req, onLater))
  rexLaunchQueue = run.catch(() => undefined)
  return run
}

async function _launchRexNow(req: LaunchRequest, onLater?: (result: LaunchResult) => void): Promise<LaunchResult> {
  const bin = _rexBinary()
  if (!bin) return { ok: false, backend: "rex", code: "backend_missing", message: "Rex is not installed" }
  const { endpoint } = _rexEndpoint()
  const fail = (r: RexRun, what: string): LaunchResult => {
    const detail = (r.stderr.trim().replace(/^Error:\s*/, "") || `${what} exited with code ${r.code}`).slice(0, 400)
    launcherLog(`launch rex ${what} failed: ${detail}`)
    return { ok: false, backend: "rex", code: "spawn_failed", message: detail }
  }
  const who = await _rexRun(bin, endpoint, ["whoami", "--json"])
  if (who.code !== 0) return fail(who, "whoami")
  const hostId = _rexHostId(who.stdout)
  const label = _rexLabel(req.name, req.cwd)
  const sessionLabel = (loadConfig().launch?.rex_session ?? "").trim() || "un-bien"
  const sessionId = await _rexSessionByLabel(bin, endpoint, hostId, sessionLabel)
  let ids: ReturnType<typeof _rexIdsFromJson>
  if (sessionId) {
    const made = await _rexRun(bin, endpoint, _buildRexWindowArgs(sessionId, label, req))
    if (made.code !== 0) return fail(made, "window new")
    ids = { sessionId, ..._rexIdsFromJson(made.stdout) }
  } else {
    const made = await _rexRun(bin, endpoint, _buildRexNewArgs(sessionLabel, label, req))
    if (made.code !== 0) return fail(made, "new")
    ids = _rexIdsFromJson(made.stdout)
  }
  if (ids.sessionId && hostId) _writeRexState({ endpoint, host_id: hostId, session_id: ids.sessionId })
  launcherLog(`launch rex: '${label}' in ${ids.sessionId ?? "?"} (window ${ids.windowId ?? "?"})`)
  if (ids.sessionId && ids.windowId && ids.blockId) {
    _watchRexBlock(bin, endpoint, ids.sessionId, ids.windowId, ids.blockId, onLater)
  }
  return { ok: true, backend: "rex" }
}

/** The exit code `rex wait --json` printed, or null (timed out, the block
 *  closed without one, or the server went away). Exported for tests. */
export function _rexExitCode(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    try {
      const code = (JSON.parse(line) as { exit_code?: unknown }).exit_code
      if (typeof code === "number") return code
    } catch {
      // not the result line
    }
  }
  return null
}

/** Watch a launched pi: an exit within EARLY_EXIT_WINDOW_MS reports
 *  `exited_early` with its output (pane left open to read); a later exit
 *  closes its window. A launcher restart ends the watch, so such a pane
 *  stays open after pi exits. */
function _watchRexBlock(
  bin: string,
  endpoint: string | null,
  sessionId: string,
  windowId: string,
  blockId: string,
  onLater?: (result: LaunchResult) => void,
): void {
  void (async () => {
    const early = await _rexRun(
      bin, endpoint,
      ["wait", blockId, "-s", sessionId, "--for", `${Math.round(EARLY_EXIT_WINDOW_MS / 1000)}s`, "--json"],
      EARLY_EXIT_WINDOW_MS + 10_000,
    )
    const status = _rexExitCode(early.stdout)
    if (status !== null) {
      const captured = await _rexRun(bin, endpoint, ["capture", "-s", sessionId, "-b", blockId, "--trim"])
      const output = _outputTail(captured.stdout)
      launcherLog(`launch rex: pi exited early (status ${status}): ${output.slice(-400)}`)
      onLater?.({
        ok: false,
        backend: "rex",
        code: "exited_early",
        message: `pi exited with status ${status} right after starting`,
        output,
      })
      return
    }
    if (!/timed out/i.test(early.stderr)) return   // the block or server went away
    // Still running: close the window when pi exits, as tmux does. No --for:
    // the wait lasts as long as pi (the global timeout doesn't bound events).
    const child = execFile(
      bin,
      [..._rexGlobalArgs(endpoint), "wait", blockId, "-s", sessionId, "--json"],
      { timeout: 0 },
      (_err, stdout) => {
        if (_rexExitCode(String(stdout)) === null) return
        void _rexRun(bin, endpoint, ["window", "close", "-s", sessionId, windowId])
      },
    )
    child.unref()
  })()
}
