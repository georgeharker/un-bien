import { spawn, spawnSync, execFile } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { envLog } from "./session/debug_log.js";

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
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Sanitize a tmux session name: keep it shell-safe and tmux-legal. */
function _safeTmuxName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").trim() || fallback;
  // tmux disallows `.` and `:` in session names; strip anything risky.
  const clean = base
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.slice(0, 40) || "pi";
}

/** Build the argv for launching `pi` in `cwd` as a WINDOW of the shared tmux
 *  session `session` (one named session, a window per pi — clean `new-window`,
 *  NO keystrokes/prefix). First launch creates the detached session; later ones
 *  add a window. Array (never a shell string) so cwd/names can't inject.
 *  Exported for tests. */
export function _buildTmuxLaunchArgs(
  session: string,
  windowName: string,
  cwd: string,
  sessionExists: boolean,
): string[] {
  return sessionExists
    ? ["new-window", "-t", session, "-n", windowName, "-c", cwd, "pi"]
    : ["new-session", "-d", "-s", session, "-n", windowName, "-c", cwd, "pi"];
}

/** Sanitize a herdr agent name: must match [a-z][a-z0-9_-]{0,31}. */
function _safeHerdrName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").trim().toLowerCase() || fallback;
  let clean = base
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(clean)) clean = `pi-${clean}`;
  return clean.slice(0, 32).replace(/-+$/g, "") || "pi";
}

/** argv for creating a detached herdr workspace in `cwd` (JSON response).
 *  ARRAY (never a shell string) so cwd/label can't inject. Exported for tests. */
export function _buildHerdrWorkspaceArgs(label: string, cwd: string): string[] {
  return [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    label,
    "--no-focus",
    "--json",
  ];
}

/** argv for exec-launching `pi` as a named herdr agent in an existing pane —
 *  herdr's canonical-executable launch (NOT keystroke injection). */
export function _buildHerdrAgentStartArgs(
  agentName: string,
  paneId: string,
): string[] {
  return ["agent", "start", agentName, "--kind", "pi", "--pane", paneId];
}

/** Extract `.result.root_pane.pane_id` from `herdr workspace create --json`. */
export function _herdrPaneIdFromCreate(stdout: string): string | null {
  try {
    const j = JSON.parse(stdout) as {
      result?: { root_pane?: { pane_id?: unknown } };
    };
    const id = j.result?.root_pane?.pane_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
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
    );
  } catch {
    return false;
  }
}

function _execFileCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * herdr launch (clean exec, no keystrokes): create a detached workspace in
 * `cwd`, then start `pi` as its agent via herdr's canonical-executable path
 * (`agent start --kind pi`). Fire-and-forget — the launched pi joins the relay
 * and the app attaches there; create/start errors are logged, not returned.
 */
async function _launchHerdr(cwd: string, agentName: string): Promise<void> {
  try {
    const created = await _execFileCapture(
      "herdr",
      _buildHerdrWorkspaceArgs(agentName, cwd),
    );
    const paneId = _herdrPaneIdFromCreate(created);
    if (!paneId) {
      envLog("herdr launch: no root_pane_id in `workspace create` output");
      return;
    }
    await _execFileCapture(
      "herdr",
      _buildHerdrAgentStartArgs(agentName, paneId),
    );
    envLog(`herdr launch: agent '${agentName}' started in pane ${paneId}`);
  } catch (error) {
    envLog(
      `herdr launch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
export function _launchSession(
  mode: "tmux" | "herdr" | "rpc",
  cwd: string,
  name: string | undefined,
): string | null {
  if (mode === "rpc") return "launch mode 'rpc' is not supported yet";
  if (mode !== "tmux" && mode !== "herdr") {
    return `unknown launch mode '${mode}'`;
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return `cwd does not exist or is not a directory: ${cwd}`;
  }
  if (!_backendAvailable(mode)) {
    return `launch backend '${mode}' is not installed`;
  }
  if (mode === "herdr") {
    const agentName = _safeHerdrName(name, `pi-${basename(cwd) || "session"}`);
    void _launchHerdr(cwd, agentName);
    return null;
  }
  // One shared, named tmux session; each launch is a WINDOW in it (single
  // attach point). Clean `new-window` via the CLI — never a prefix keystroke.
  const session = _safeTmuxName(loadConfig().launch?.tmux_session, "un-bien");
  const windowName = _safeTmuxName(name, `pi-${basename(cwd) || "session"}`);
  const sessionExists =
    spawnSync("tmux", ["has-session", "-t", session], {
      stdio: "ignore",
      timeout: 5_000,
    }).status === 0;
  try {
    const child = spawn(
      "tmux",
      _buildTmuxLaunchArgs(session, windowName, cwd, sessionExists),
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return null;
  } catch (error) {
    return `tmux launch failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
