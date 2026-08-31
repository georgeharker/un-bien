import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadLocalConfig,
  localConfigExists,
  saveLocalConfig,
  effectiveAllowRemoteLaunch,
} from "./local_config.js"

const ENV = "UNBIEN_DIRECT_CONFIG"

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), "rp-localcfg-"))
}

/** Write a config.json into <cwd>/.pi/un-bien/. */
function writeFileConfig(cwd: string, obj: unknown): void {
  const dir = join(cwd, ".pi", "un-bien")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj))
}

// Isolate the GLOBAL config home for EVERY test in this file, so a load never
// reads the developer's real extension config
// (`<PI_CODING_AGENT_DIR|~/.pi>/extensions/un-bien.json`) — its `defaults` block
// (e.g. auto_start_relay:true) would otherwise leak in and break the "blank"
// expectations. `PI_CODING_AGENT_DIR` repoints `unbienConfigHome()` at a fresh
// dir; `UNBIEN_HOME` isolates the state dir alongside it.
let _globalHome: string
let _prevAgentDir: string | undefined
beforeEach(() => {
  _globalHome = mkdtempSync(join(tmpdir(), "rp-cfghome-"))
  _prevAgentDir = process.env["PI_CODING_AGENT_DIR"]
  process.env["PI_CODING_AGENT_DIR"] = _globalHome
  process.env["UNBIEN_HOME"] = _globalHome
})
afterEach(() => {
  if (_prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]
  else process.env["PI_CODING_AGENT_DIR"] = _prevAgentDir
  delete process.env["UNBIEN_HOME"]
  rmSync(_globalHome, { recursive: true, force: true })
})

describe("loadLocalConfig — file vs UNBIEN_DIRECT_CONFIG", () => {
  let cwd: string

  beforeEach(() => {
    cwd = makeCwd()
    delete process.env[ENV]
  })
  afterEach(() => {
    delete process.env[ENV]
    rmSync(cwd, { recursive: true, force: true })
  })

  test("reads the on-disk file when env is unset", () => {
    writeFileConfig(cwd, { agent_name: "fromfile", auto_start_relay: false })
    expect(loadLocalConfig(cwd)).toEqual({
      agent_name: "fromfile",
      auto_start_relay: false,
    })
  })

  test("empty config when neither env nor file present", () => {
    expect(loadLocalConfig(cwd)).toEqual({})
  })

  test("inline env takes precedence over the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile", auto_start_relay: false })
    process.env[ENV] = JSON.stringify({
      agent_name: "fromenv",
      auto_start_relay: true,
    })
    expect(loadLocalConfig(cwd)).toEqual({
      agent_name: "fromenv",
      auto_start_relay: true,
    })
  })

  test("inline env works with no file on disk", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "envonly" })
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "envonly" })
  })

  test("malformed env JSON falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" })
    process.env[ENV] = "{not valid json"
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" })
  })

  test("empty/whitespace env falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" })
    process.env[ENV] = "   "
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" })
  })

  test("only known fields are surfaced (unknown keys dropped)", () => {
    process.env[ENV] = JSON.stringify({
      agent_name: "a",
      auto_start_relay: true,
      session_name: "x",
      junk: 1,
    })
    expect(loadLocalConfig(cwd)).toEqual({
      agent_name: "a",
      auto_start_relay: true,
    })
  })

  test("non-object env (array/number) falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" })
    process.env[ENV] = "[1,2,3]"
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" })
  })
})

describe("loadLocalConfig — workspace / worktree removed (plan 38)", () => {
  // The fields were dropped: the mesh identity is `(cwd, nome)`, with `cwd`
  // subsuming folder + worktree disambiguation. A stale key from an old config
  // (or one the Cockpit still injects) must be silently ignored on read.
  let cwd: string

  beforeEach(() => {
    cwd = makeCwd()
    delete process.env[ENV]
  })
  afterEach(() => {
    delete process.env[ENV]
    rmSync(cwd, { recursive: true, force: true })
  })

  test("ignores a stale workspace/worktree key from the file", () => {
    writeFileConfig(cwd, {
      agent_name: "app",
      workspace: "acme",
      worktree: "feat-login",
    })
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "app" })
  })

  test("ignores a stale workspace/worktree key from the inline env", () => {
    process.env[ENV] = JSON.stringify({
      agent_name: "app",
      workspace: "acme",
      worktree: "feat-login",
    })
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "app" })
  })
})

describe("localConfigExists — honors env + file", () => {
  let cwd: string

  beforeEach(() => {
    cwd = makeCwd()
    delete process.env[ENV]
  })
  afterEach(() => {
    delete process.env[ENV]
    rmSync(cwd, { recursive: true, force: true })
  })

  test("false when neither env nor file present", () => {
    expect(localConfigExists(cwd)).toBe(false)
  })

  test("true when only the file exists", () => {
    writeFileConfig(cwd, { agent_name: "a" })
    expect(localConfigExists(cwd)).toBe(true)
  })

  test("true when only the inline env is set", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "a" })
    expect(localConfigExists(cwd)).toBe(true)
  })

  test("false when env is set but malformed and no file", () => {
    process.env[ENV] = "nope"
    expect(localConfigExists(cwd)).toBe(false)
  })
})

describe("saveLocalConfig — unaffected by env (still writes the file)", () => {
  let cwd: string

  beforeEach(() => {
    cwd = makeCwd()
    delete process.env[ENV]
  })
  afterEach(() => {
    delete process.env[ENV]
    rmSync(cwd, { recursive: true, force: true })
  })

  test("auto_start_relay defaults to true on save", () => {
    saveLocalConfig(cwd, { agent_name: "saved" })
    delete process.env[ENV] // ensure we read the file back, not any env
    expect(loadLocalConfig(cwd)).toEqual({
      agent_name: "saved",
      auto_start_relay: true,
    })
  })
})

describe("effectiveAllowRemoteLaunch — default OFF (authority-sensitive)", () => {
  test("undefined -> false", () => {
    expect(effectiveAllowRemoteLaunch({})).toBe(false)
  })
  test("explicit true -> true", () => {
    expect(effectiveAllowRemoteLaunch({ allow_remote_launch: true })).toBe(true)
  })
  test("explicit false -> false", () => {
    expect(effectiveAllowRemoteLaunch({ allow_remote_launch: false })).toBe(
      false,
    )
  })
})

describe("global defaults — allow_remote_launch flows machine-wide", () => {
  let cwd: string
  beforeEach(() => {
    cwd = makeCwd()
    delete process.env[ENV]
  })
  afterEach(() => {
    delete process.env[ENV]
    rmSync(cwd, { recursive: true, force: true })
  })

  function writeGlobalDefaults(defaults: Record<string, unknown>): void {
    const dir = join(_globalHome, "extensions")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "un-bien.json"), JSON.stringify({ defaults }))
  }

  test("defaults.allow_remote_launch:true -> enabled for a cwd with no local file", () => {
    writeGlobalDefaults({ allow_remote_launch: true })
    const cfg = loadLocalConfig(cwd)
    expect(cfg.allow_remote_launch).toBe(true)
    expect(effectiveAllowRemoteLaunch(cfg)).toBe(true)
  })

  test("a per-cwd file still overrides the global default (opt OUT)", () => {
    writeGlobalDefaults({ allow_remote_launch: true })
    writeFileConfig(cwd, { agent_name: "x", allow_remote_launch: false })
    expect(effectiveAllowRemoteLaunch(loadLocalConfig(cwd))).toBe(false)
  })
})
