import { spawn, spawnSync, execFile } from "node:child_process"
import { basename, join, resolve } from "node:path"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { loadConfig } from "./config.js"
import { envLog } from "./session/debug_log.js"

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
  /** Pane command override — defaults to bare `pi`. `launchReq` correlation
   *  passes `env UNBIEN_LAUNCH_REQ=<id> pi` so the spawned extension can echo
   *  the request id (launch auto-open). */
  commandArgv: string[] = ["pi"],
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
        ...commandArgv,
        ...nameArgv,
        ...resumeArgv,
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
        ...commandArgv,
        ...nameArgv,
        ...resumeArgv,
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
 * for the resume flow (herdr `--` passthrough, tmux parity). Fire-and-forget
 * — the launched pi joins the relay and the app attaches there; create/start
 * errors are logged, not returned.
 */
async function _launchHerdr(
  cwd: string,
  agentName: string,
  launchReq?: string,
  extraArgv: string[] = [],
): Promise<void> {
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
      envLog("herdr launch: no root_pane_id in `workspace create` output")
      return
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
  } catch (error) {
    envLog(
      `herdr launch failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Honor a `session_launch` request. The caller checked the per-cwd opt-in and
 * picked `mode` from `launch.backend` (machine config). PTY-hosted backends
 * exec `pi` cleanly (no keystrokes): `tmux` = detached `new-session … pi`;
 * `herdr` = `workspace create` then `agent start --kind pi`. `rpc` is a
 * fast-follow (stubbed). Returns null when the launch is initiated, else an
 * error string.
 */
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
    return target === base || target.startsWith(base + "/")
  })
}

export function _launchSession(
  mode: "tmux" | "herdr" | "rpc",
  cwd: string,
  name: string | undefined,
  resume?: string | undefined,
  launchReq?: string | undefined,
): string | null {
  if (mode === "rpc") return "launch mode 'rpc' is not supported yet"
  if (mode !== "tmux" && mode !== "herdr") {
    return `unknown launch mode '${mode}'`
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return `cwd does not exist or is not a directory: ${cwd}`
  }
  if (!_backendAvailable(mode)) {
    return `launch backend '${mode}' is not installed`
  }
  if (mode === "herdr") {
    const agentName = _safeHerdrName(name, `pi-${basename(cwd) || "session"}`)
    // Resume parity with tmux: herdr passes trailing argv after `--`
    // UNCHANGED to the kind's executable, so `pi --session <id>` reaches pi.
    const resumeArgv =
      typeof resume === "string" && resume.trim().length > 0
        ? ["--session", resume.trim()]
        : []
    void _launchHerdr(cwd, agentName, launchReq, resumeArgv)
    return null
  }
  // One shared, named tmux session; each launch is a WINDOW in it (single
  // attach point). Clean `new-window` via the CLI — never a prefix keystroke.
  const session = _safeTmuxName(loadConfig().launch?.tmux_session, "un-bien")
  const windowName = _safeTmuxName(name, `pi-${basename(cwd) || "session"}`)
  // The raw name rides the pi argv (`-n`) — the extension resolves it as the
  // session-scoped agent name (see resolveAgentName). herdr keeps the
  // workspace-label-only plumbing until it can pass args through to pi.
  const sessionExists =
    spawnSync("tmux", ["has-session", "-t", session], {
      stdio: "ignore",
      timeout: 5_000,
    }).status === 0
  try {
    // launchReq rides INTO the pane command via `env` (tmux-version-proof —
    // no reliance on `new-window -e`): the spawned pi's extension reads it at
    // startup and echoes it in room_meta, so the launching app can match the
    // announcing room to its request and auto-open the chat (launch
    // correlation — resume flow). Undefined → plain `pi` command.
    const commandArgv = launchReq
      ? ["env", `UNBIEN_LAUNCH_REQ=${launchReq}`, "pi"]
      : ["pi"]
    const child = spawn(
      "tmux",
      _buildTmuxLaunchArgs(
        session,
        windowName,
        cwd,
        sessionExists,
        name,
        resume,
        commandArgv,
      ),
      { detached: true, stdio: "ignore" },
    )
    child.unref()
    return null
  } catch (error) {
    return `tmux launch failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
