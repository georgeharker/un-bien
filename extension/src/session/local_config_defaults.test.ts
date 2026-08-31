import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadLocalConfig,
  localConfigExists,
  effectiveAutoStartRelay,
} from "./local_config.js"

// Isolate the GLOBAL config into a tmp dir via PI_CODING_AGENT_DIR, and
// neutralise any UNBIEN_DIRECT_CONFIG / UNBIEN_DIR / UNBIEN_HOME the ambient
// shell may carry, so these assertions never touch the real home. The global
// config is a pi extension config at `<PI_CODING_AGENT_DIR>/extensions/
// un-bien.json` (see unbienConfigHome in paths.ts), so we point that env at a
// tmp agent dir and write the file into its `extensions/` subdir.
const SAVED = {
  dir: process.env["UNBIEN_DIR"],
  home: process.env["UNBIEN_HOME"],
  direct: process.env["UNBIEN_DIRECT_CONFIG"],
  agent: process.env["PI_CODING_AGENT_DIR"],
}

let globalDir: string

function writeGlobalConfig(obj: unknown): void {
  const extDir = join(globalDir, "extensions")
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, "un-bien.json"), JSON.stringify(obj, null, 2))
}

beforeEach(() => {
  globalDir = mkdtempSync(join(tmpdir(), "pi-globalcfg-"))
  process.env["PI_CODING_AGENT_DIR"] = globalDir
  delete process.env["UNBIEN_DIR"]
  delete process.env["UNBIEN_HOME"]
  delete process.env["UNBIEN_DIRECT_CONFIG"]
})

afterEach(() => {
  rmSync(globalDir, { recursive: true, force: true })
  for (const [k, v] of [
    ["UNBIEN_DIR", SAVED.dir],
    ["UNBIEN_HOME", SAVED.home],
    ["UNBIEN_DIRECT_CONFIG", SAVED.direct],
    ["PI_CODING_AGENT_DIR", SAVED.agent],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function freshCwd(): string {
  return mkdtempSync(join(tmpdir(), "pi-defaults-cwd-"))
}

describe("global config `defaults` as a machine-wide local-config fallback", () => {
  test("no defaults block → behaviour unchanged (fresh cwd is unconfigured)", () => {
    const cwd = freshCwd()
    expect(localConfigExists(cwd)).toBe(false)
    expect(loadLocalConfig(cwd).auto_start_relay).toBeUndefined()
  })

  test("defaults.auto_start_relay counts as configured (suppresses wizard)", () => {
    writeGlobalConfig({ defaults: { auto_start_relay: true } })
    const cwd = freshCwd()
    expect(localConfigExists(cwd)).toBe(true)
    expect(effectiveAutoStartRelay(loadLocalConfig(cwd))).toBe(true)
  })

  test("defaults.auto_start_relay:false disables relay for every unconfigured cwd", () => {
    writeGlobalConfig({ defaults: { auto_start_relay: false } })
    const cwd = freshCwd()
    expect(localConfigExists(cwd)).toBe(true)
    expect(loadLocalConfig(cwd).auto_start_relay).toBe(false)
    expect(effectiveAutoStartRelay(loadLocalConfig(cwd))).toBe(false)
  })

  test("a per-cwd file overrides the global default", () => {
    writeGlobalConfig({ defaults: { auto_start_relay: false } })
    const cwd = freshCwd()
    mkdirSync(join(cwd, ".pi", "un-bien"), { recursive: true })
    writeFileSync(
      join(cwd, ".pi", "un-bien", "config.json"),
      JSON.stringify({ agent_name: "x", auto_start_relay: true }),
    )
    expect(loadLocalConfig(cwd).auto_start_relay).toBe(true)
  })

  test("UNBIEN_DIRECT_CONFIG overrides the global default", () => {
    writeGlobalConfig({ defaults: { auto_start_relay: false } })
    process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
      auto_start_relay: true,
    })
    const cwd = freshCwd()
    expect(loadLocalConfig(cwd).auto_start_relay).toBe(true)
  })

  test("a `relay`-only global config (no defaults) stays inert", () => {
    writeGlobalConfig({ relay: "https://relay.example" })
    const cwd = freshCwd()
    expect(localConfigExists(cwd)).toBe(false)
    expect(loadLocalConfig(cwd).auto_start_relay).toBeUndefined()
  })
})
