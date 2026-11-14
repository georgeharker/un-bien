/**
 * session_launch handling shared by the launcher and a live pi: every request
 * is answered with a session_launch_result frame, and the legacy `error`
 * frames older apps understand are still sent where they were.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleSessionLaunch, launchResultEnvelope } from "./launch_request.js"
import type { EnvelopeMessage } from "./session/rpc_envelope.js"

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "UNBIEN_STATE_DIR", "UNBIEN_DIRECT_CONFIG", "FAKE_REX_LOG"]
const SAVED: Record<string, string | undefined> = {}
let dir = ""

// A fake rex that creates sessions and reports pi still running.
const FAKE_REX = `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --autostart=false) shift ;; -S|--timeout) shift 2 ;; *) break ;; esac; done
case "$1" in
  whoami) echo '{"host_id":"h"}' ;;
  new) echo '{"session_id":"session:s","initial_windows":[{"window_id":"window:w","block_ids":["block:b"]}]}' ;;
  wait) echo 'Error: wait timed out after 20s' >&2; exit 1 ;;
  *) echo '{}' ;;
esac
`

function sender() {
  const legacy: Record<string, unknown>[] = []
  const results: Record<string, unknown>[] = []
  return {
    legacy,
    results,
    send: (frame: Record<string, unknown>) => legacy.push(frame),
    sendEnvelope: (env: EnvelopeMessage) => results.push(env.ub as unknown as Record<string, unknown>),
  }
}

function writeConfig(launch: Record<string, unknown>): void {
  writeFileSync(join(dir, "agent", "extensions", "un-bien.json"),
    JSON.stringify({ launch: { backend: "rex", rex_bin: join(dir, "rex"), rex_server: "unix:///tmp/x.sock", ...launch } }))
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k]
  dir = mkdtempSync(join(tmpdir(), "unbien-launchreq-"))
  mkdirSync(join(dir, "agent", "extensions"), { recursive: true })
  mkdirSync(join(dir, "work"))
  writeFileSync(join(dir, "rex"), FAKE_REX)
  chmodSync(join(dir, "rex"), 0o755)
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent")
  process.env.UNBIEN_STATE_DIR = join(dir, "state")
  process.env.UNBIEN_DIRECT_CONFIG = JSON.stringify({ allow_remote_launch: true })
  writeConfig({})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

const log = () => undefined

describe("session_launch_result", () => {
  it("answers a started launch with ok, the backend and the request id", async () => {
    const s = sender()
    await handleSessionLaunch({ type: "session_launch", id: "req-1", cwd: join(dir, "work"), name: "n" }, s, { log })
    expect(s.results).toEqual([{ type: "session_launch_result", in_reply_to: "req-1", ok: true, backend: "rex" }])
    expect(s.legacy).toEqual([])
  })

  it("reports remote launch turned off (old apps got nothing, so no legacy frame)", async () => {
    process.env.UNBIEN_DIRECT_CONFIG = JSON.stringify({ allow_remote_launch: false })
    const s = sender()
    await handleSessionLaunch({ type: "session_launch", id: "r", cwd: join(dir, "work") }, s, { log })
    expect(s.results[0]).toMatchObject({ ok: false, code: "remote_launch_disabled", in_reply_to: "r" })
    expect(s.legacy).toEqual([])
  })

  it("keeps the legacy unknown_peer error beside the result", async () => {
    const s = sender()
    await handleSessionLaunch({ type: "session_launch", id: "r", cwd: join(dir, "work") }, s,
      { log, isPaired: async () => false })
    expect(s.legacy).toEqual([{ type: "error", code: "unknown_peer", message: "Peer not paired — re-scan QR" }])
    expect(s.results[0]).toMatchObject({ ok: false, code: "unknown_peer" })
  })

  it("keeps the legacy permission_denied error for a directory outside launch.dirs", async () => {
    writeConfig({ dirs: [join(dir, "elsewhere")] })
    const s = sender()
    await handleSessionLaunch({ type: "session_launch", id: "r", cwd: join(dir, "work") }, s, { log })
    expect(s.legacy[0]).toMatchObject({ type: "error", code: "permission_denied" })
    expect(s.results[0]).toMatchObject({ ok: false, code: "permission_denied" })
  })

  it("reports a directory that doesn't exist", async () => {
    const s = sender()
    await handleSessionLaunch({ type: "session_launch", id: "r", cwd: join(dir, "missing") }, s, { log })
    expect(s.results[0]).toMatchObject({ ok: false, code: "cwd_missing" })
    expect(String(s.results[0]?.message)).toContain("missing")
  })

  it("leaves out fields a result doesn't have", () => {
    expect(launchResultEnvelope("r", { ok: false, code: "spawn_failed", message: "boom" })).toEqual({
      ub: { type: "session_launch_result", in_reply_to: "r", ok: false, code: "spawn_failed", message: "boom" },
    })
  })
})
