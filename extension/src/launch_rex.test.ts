/**
 * The Rex launch backend, against a fake `rex` (a shell script that logs each
 * call's argv and plays back the JSON shapes the real CLI prints, verified
 * against rex 0.1.0-preview.19 on a private server). Pure argv builders are
 * tested directly.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _rexSessionsLabelled,
  _buildRexNewArgs,
  _buildRexWindowArgs,
  _outputTail,
  _rexEndpoint,
  _rexExitCode,
  _rexGlobalArgs,
  _rexIdsFromJson,
  _rexLabel,
  _rexPiArgv,
  _withWindowIdAndRemain,
  launchSession,
  type LaunchResult,
} from "./launch.js"

const FAKE_REX = `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "$FAKE_REX_LOG"; printf '\\n' >> "$FAKE_REX_LOG"
while [ $# -gt 0 ]; do
  case "$1" in --autostart=false) shift ;; -S|--timeout) shift 2 ;; *) break ;; esac
done
case "$1" in
  whoami)
    if [ -n "$FAKE_REX_NO_SERVER" ]; then
      echo "Error: no Rex server is running at /x/server.sock, and autostart is disabled" >&2; exit 1
    fi
    echo '{"host_id":"host-1","pid":1}' ;;
  ls)
    # Sessions this fake created (FAKE_REX_SESSIONS), plus any pre-existing ones.
    printf '{"sessions":[%s%s]}\n' "$FAKE_REX_EXISTING" "$(cat "$FAKE_REX_SESSIONS" 2>/dev/null)" ;;
  new)
    sep=""; [ -s "$FAKE_REX_SESSIONS" ] || [ -n "$FAKE_REX_EXISTING" ] && sep=","
    printf '%s{"session_id":"session:s1","label":"%s"}' "$sep" "$2" >> "$FAKE_REX_SESSIONS"
    echo '{"session_id":"session:s1","initial_windows":[{"window_id":"window:w1","block_ids":["block:b1"]}]}' ;;
  window)
    if [ "$2" = new ]; then echo '{"window_id":"window:w2","block_ids":["block:b2"],"revision":2}'; else echo '{}'; fi ;;
  wait)
    if [ -n "$FAKE_REX_EXIT" ]; then echo "{\\"exit_code\\":$FAKE_REX_EXIT,\\"error\\":\\"exit status $FAKE_REX_EXIT\\"}"; exit "$FAKE_REX_EXIT"; fi
    echo 'Error: wait timed out after 20s: context deadline exceeded' >&2; exit 1 ;;
  capture) printf 'starting pi\\nError: no API key for provider anthropic\\n' ;;
esac
`

const SAVED: Record<string, string | undefined> = {}
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "UNBIEN_STATE_DIR", "FAKE_REX_LOG", "FAKE_REX_NO_SERVER",
  "FAKE_REX_SESSIONS", "FAKE_REX_EXISTING", "FAKE_REX_EXIT", "REX_SERVER"]
let dir = ""

function configure(launch: Record<string, unknown>): void {
  writeFileSync(join(dir, "agent", "extensions", "un-bien.json"),
    JSON.stringify({ launch: { rex_bin: join(dir, "rex"), rex_server: "unix:///tmp/fake-rex.sock", ...launch } }))
}

/** Each fake-rex call as its argv, global args stripped. */
function calls(): string[][] {
  let text = ""
  try {
    text = readFileSync(join(dir, "rex.log"), "utf8")
  } catch {
    return []
  }
  return text.split("\n").filter(Boolean).map((line) => {
    const argv = line.split("\u001f").filter((a) => a !== "")
    const out: string[] = []
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i] ?? ""
      if (a === "--autostart=false") continue
      if (a === "-S" || a === "--timeout") { i++; continue }
      out.push(a)
    }
    return out
  })
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k]
  dir = mkdtempSync(join(tmpdir(), "unbien-rex-"))
  mkdirSync(join(dir, "agent", "extensions"), { recursive: true })
  mkdirSync(join(dir, "state"), { recursive: true })
  writeFileSync(join(dir, "rex"), FAKE_REX)
  chmodSync(join(dir, "rex"), 0o755)
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent")
  process.env.UNBIEN_STATE_DIR = join(dir, "state")
  process.env.FAKE_REX_LOG = join(dir, "rex.log")
  process.env.FAKE_REX_SESSIONS = join(dir, "sessions")
  for (const k of ["FAKE_REX_NO_SERVER", "FAKE_REX_EXISTING", "FAKE_REX_EXIT", "REX_SERVER"]) delete process.env[k]
  configure({ backend: "rex" })
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

describe("rex argv", () => {
  it("passes pi a real argv: env, name and resume as single arguments", () => {
    expect(_rexPiArgv({ cwd: "/w", name: "fix the 'login' $(rm -rf ~) bug", resume: "abc", launchReq: "req-1" }))
      .toEqual(["env", "UNBIEN_LAUNCH_REQ=req-1", "pi", "-n", "fix the 'login' $(rm -rf ~) bug", "--session", "abc"])
    expect(_rexPiArgv({ cwd: "/w" })).toEqual(["pi"])
  })

  it("never lets a label read as a flag, and caps it at 128 characters", () => {
    expect(_rexLabel("--focus=true", "/w")).toBe("focus=true")
    expect(_rexLabel("a\nb", "/w")).toBe("a b")
    expect(_rexLabel(undefined, "/Users/x/proj")).toBe("pi-proj")
    expect(_rexLabel("x".repeat(200), "/w")).toHaveLength(128)
  })

  it("creates windows kept open, unfocused, with --window= and the command after --", () => {
    const req = { cwd: "/w", name: "n", launchReq: "r" }
    expect(_buildRexNewArgs("un-bien", "n", req)).toEqual(
      ["new", "un-bien", "--window=n", "-c", "/w", "--keep-open", "--json", "--", "env", "UNBIEN_LAUNCH_REQ=r", "pi", "-n", "n"])
    expect(_buildRexWindowArgs("session:s1", "n", req)).toEqual(
      ["window", "new", "-s", "session:s1", "n", "--focus=false", "-c", "/w", "--keep-open", "--json", "--",
        "env", "UNBIEN_LAUNCH_REQ=r", "pi", "-n", "n"])
  })

  it("maps launch.shell and an -i shell arg to Rex's own flags", () => {
    configure({ backend: "rex", shell: "/bin/bash", shell_args: ["-l", "-i"] })
    expect(_buildRexNewArgs("s", "l", { cwd: "/w" })).toEqual(
      ["new", "s", "--window=l", "-c", "/w", "--keep-open", "--shell=/bin/bash", "--interactive", "--json", "--", "pi"])
  })

  it("always disables autostart and names the server", () => {
    expect(_rexGlobalArgs("unix:///s.sock")).toEqual(["--autostart=false", "-S", "unix:///s.sock", "--timeout", "10s"])
    expect(_rexGlobalArgs(null)).toEqual(["--autostart=false", "--timeout", "10s"])
  })

  it("accepts only a local unix socket as the server", () => {
    configure({ rex_server: "devbox:7681" })
    expect(_rexEndpoint().error).toMatch(/must be a local unix:\/\/ socket/)
    configure({ rex_server: "unix:///a%20b/s.sock" })
    expect(_rexEndpoint()).toEqual({ endpoint: "unix:///a%20b/s.sock" })
  })

  it("defaults on macOS to the local server's socket, spaces encoded", () => {
    writeFileSync(join(dir, "agent", "extensions", "un-bien.json"), JSON.stringify({ launch: { backend: "rex" } }))
    if (process.platform !== "darwin") return
    expect(_rexEndpoint().endpoint).toMatch(/^unix:\/\/.*\/Library\/Application%20Support\/rex\/server\.sock$/)
  })

  it("reads ids from both creation shapes, and nothing from junk", () => {
    expect(_rexIdsFromJson('{"session_id":"session:s","initial_windows":[{"window_id":"window:w","block_ids":["block:b"]}]}'))
      .toEqual({ sessionId: "session:s", windowId: "window:w", blockId: "block:b" })
    expect(_rexIdsFromJson('{"window_id":"window:w","block_ids":["block:b"]}')).toEqual({ windowId: "window:w", blockId: "block:b" })
    expect(_rexIdsFromJson("not json")).toEqual({})
  })

  it("reads wait's exit code, and none from a timeout", () => {
    expect(_rexExitCode('{"exit_code":3,"error":"exit status 3"}\n')).toBe(3)
    expect(_rexExitCode('{"exit_code":0}')).toBe(0)
    expect(_rexExitCode("")).toBeNull()
  })

  it("tmux: prints the window id and keeps the pane, in the same invocation", () => {
    expect(_withWindowIdAndRemain(["new-window", "-t", "s", "--", "cmd"])).toEqual(
      ["new-window", "-P", "-F", "#{window_id}", "-t", "s", "--", "cmd", ";", "set-option", "-w", "remain-on-exit", "on"])
  })

  it("keeps the last lines of output", () => {
    const text = `${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")}\n\n`
    const tail = _outputTail(text).split("\n")
    expect(tail).toHaveLength(40)
    expect(tail.at(-1)).toBe("line 60")
  })
})

describe("rex launch", () => {
  it("first launch creates the session and stores its id; the next adds a window to it", async () => {
    const first = await launchSession({ cwd: dir, name: "one", launchReq: "req-1" })
    expect(first).toEqual({ ok: true, backend: "rex" })
    const second = await launchSession({ cwd: dir, name: "two", launchReq: "req-2" })
    expect(second).toEqual({ ok: true, backend: "rex" })
    const made = calls().filter((c) => c[0] === "new" || (c[0] === "window" && c[1] === "new"))
    expect(made[0]?.slice(0, 3)).toEqual(["new", "un-bien", "--window=one"])
    expect(made[1]?.slice(0, 5)).toEqual(["window", "new", "-s", "session:s1", "two"])
    expect(JSON.parse(readFileSync(join(dir, "state", "rex-launch.json"), "utf8"))).toMatchObject(
      { host_id: "host-1", session_id: "session:s1" })
  })

  it("recreates the session when none has the label any more", async () => {
    await launchSession({ cwd: dir, name: "one" })
    writeFileSync(join(dir, "sessions"), "")   // the session was closed (or renamed)
    await launchSession({ cwd: dir, name: "two" })
    expect(calls().filter((c) => c[0] === "new")).toHaveLength(2)
  })

  it("puts pis into an existing session with the configured label, whoever made it", async () => {
    process.env.FAKE_REX_EXISTING = '{"session_id":"session:mine","label":"work"}'
    configure({ backend: "rex", rex_session: "work" })
    await launchSession({ cwd: dir, name: "one" })
    expect(calls().some((c) => c[0] === "new")).toBe(false)
    expect(calls().find((c) => c[0] === "window")?.slice(0, 4)).toEqual(["window", "new", "-s", "session:mine"])
  })

  it("creates the session with the configured label when none exists", async () => {
    configure({ backend: "rex", rex_session: "pi agents" })
    await launchSession({ cwd: dir, name: "one" })
    expect(calls().find((c) => c[0] === "new")?.slice(0, 2)).toEqual(["new", "pi agents"])
  })

  it("matches labels exactly and prefers the session it used last", () => {
    const ls = JSON.stringify({ sessions: [
      { session_id: "session:a", label: "un-bien" },
      { session_id: "session:b", label: "un-bien 2" },
      { session_id: "session:c", label: "un-bien" },
    ] })
    expect(_rexSessionsLabelled(ls, "un-bien")).toEqual(["session:a", "session:c"])
    expect(_rexSessionsLabelled("junk", "un-bien")).toEqual([])
  })

  it("reports an unreachable server without creating anything", async () => {
    process.env.FAKE_REX_NO_SERVER = "1"
    const result = await launchSession({ cwd: dir, name: "one" })
    expect(result).toMatchObject({ ok: false, backend: "rex", code: "backend_unavailable" })
    expect(result.message).toMatch(/no Rex server is running/)
    expect(calls().some((c) => c[0] === "new")).toBe(false)
  })

  it("reports a missing rex binary", async () => {
    configure({ backend: "rex", rex_bin: join(dir, "no-such-rex") })
    expect(await launchSession({ cwd: dir })).toMatchObject({ ok: false, code: "backend_missing" })
  })

  it("reports a pi that exits right after starting, with its output", async () => {
    process.env.FAKE_REX_EXIT = "3"
    const later = new Promise<LaunchResult>((resolveLater) => {
      void launchSession({ cwd: dir, name: "one" }, resolveLater).then((r) => expect(r.ok).toBe(true))
    })
    const result = await later
    expect(result).toMatchObject({ ok: false, backend: "rex", code: "exited_early" })
    expect(result.message).toMatch(/status 3/)
    expect(result.output).toContain("no API key for provider anthropic")
    expect(calls().some((c) => c[0] === "window" && c[1] === "close")).toBe(false)
  })

  it("falls back only when configured, and says so", async () => {
    process.env.FAKE_REX_NO_SERVER = "1"
    configure({ backend: "rex", fallback: "herdr" })
    const result = await launchSession({ cwd: dir })
    // herdr isn't installed here either, so the fallback is reported as unavailable too.
    expect(result).toMatchObject({ ok: false, code: "backend_unavailable" })
    expect(result.message).toMatch(/fallback 'herdr' also unavailable/)
  })

  it("uses the fallback when the configured backend is missing", async () => {
    // herdr is the configured backend and is not installed; Rex (the fake) is the fallback.
    configure({ backend: "herdr", fallback: "rex" })
    const result = await launchSession({ cwd: dir, name: "one" })
    expect(result.ok).toBe(true)
    expect(result.backend).toBe("rex")
    expect(result.fell_back).toMatchObject({ from: "herdr" })
  })

  it("refuses a missing directory before touching any backend", async () => {
    expect(await launchSession({ cwd: join(dir, "nope") })).toMatchObject({ ok: false, code: "cwd_missing" })
    expect(calls()).toEqual([])
  })
})
