import { afterEach, describe, expect, test } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import { unbienConfigHome, unbienStateHome } from "./paths.js"

const SAVED_STATE_DIR = process.env["UNBIEN_STATE_DIR"]
const SAVED_DIR = process.env["UNBIEN_DIR"]
const SAVED_HOME = process.env["UNBIEN_HOME"]
const SAVED_AGENT_DIR = process.env["PI_CODING_AGENT_DIR"]
const SAVED_XDG_STATE = process.env["XDG_STATE_HOME"]

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore("UNBIEN_STATE_DIR", SAVED_STATE_DIR)
  restore("UNBIEN_DIR", SAVED_DIR)
  restore("UNBIEN_HOME", SAVED_HOME)
  restore("PI_CODING_AGENT_DIR", SAVED_AGENT_DIR)
  restore("XDG_STATE_HOME", SAVED_XDG_STATE)
})

describe("unbienStateHome precedence", () => {
  test("defaults to ~/.local/state/un-bien when nothing is set", () => {
    delete process.env["UNBIEN_STATE_DIR"]
    delete process.env["UNBIEN_DIR"]
    delete process.env["UNBIEN_HOME"]
    delete process.env["XDG_STATE_HOME"]
    expect(unbienStateHome()).toBe(
      join(homedir(), ".local", "state", "un-bien"),
    )
  })

  test("XDG_STATE_HOME replaces the ~/.local/state base", () => {
    delete process.env["UNBIEN_STATE_DIR"]
    delete process.env["UNBIEN_DIR"]
    delete process.env["UNBIEN_HOME"]
    process.env["XDG_STATE_HOME"] = "/tmp/xdg-state"
    expect(unbienStateHome()).toBe(join("/tmp/xdg-state", "un-bien"))
  })

  test("UNBIEN_HOME is treated as a stand-in $HOME (appends .pi/un-bien)", () => {
    delete process.env["UNBIEN_STATE_DIR"]
    delete process.env["UNBIEN_DIR"]
    process.env["UNBIEN_HOME"] = "/tmp/fake-home"
    expect(unbienStateHome()).toBe(join("/tmp/fake-home", ".pi", "un-bien"))
  })

  test("UNBIEN_DIR is an absolute override with no path suffix appended", () => {
    delete process.env["UNBIEN_STATE_DIR"]
    process.env["UNBIEN_DIR"] = "/Users/x/.config/pi/unbien"
    process.env["UNBIEN_HOME"] = "/tmp/fake-home" // ignored when DIR is set
    expect(unbienStateHome()).toBe("/Users/x/.config/pi/unbien")
  })

  test("UNBIEN_STATE_DIR wins over UNBIEN_DIR and UNBIEN_HOME", () => {
    process.env["UNBIEN_STATE_DIR"] = "/state/root"
    process.env["UNBIEN_DIR"] = "/legacy/dir-override"
    process.env["UNBIEN_HOME"] = "/tmp/fake-home"
    expect(unbienStateHome()).toBe("/state/root")
  })

  test("an empty UNBIEN_STATE_DIR falls through to UNBIEN_DIR", () => {
    process.env["UNBIEN_STATE_DIR"] = ""
    process.env["UNBIEN_DIR"] = "/legacy/dir-override"
    process.env["UNBIEN_HOME"] = "/tmp/fake-home"
    expect(unbienStateHome()).toBe("/legacy/dir-override")
  })

  test("empty UNBIEN_STATE_DIR and UNBIEN_DIR fall through to UNBIEN_HOME", () => {
    process.env["UNBIEN_STATE_DIR"] = ""
    process.env["UNBIEN_DIR"] = ""
    process.env["UNBIEN_HOME"] = "/tmp/fake-home"
    expect(unbienStateHome()).toBe(join("/tmp/fake-home", ".pi", "un-bien"))
  })

  test("an empty UNBIEN_DIR falls through to the XDG default", () => {
    delete process.env["UNBIEN_STATE_DIR"]
    delete process.env["UNBIEN_HOME"]
    delete process.env["XDG_STATE_HOME"]
    process.env["UNBIEN_DIR"] = ""
    expect(unbienStateHome()).toBe(
      join(homedir(), ".local", "state", "un-bien"),
    )
  })

  test("resolved at call time (a later env change is picked up)", () => {
    process.env["UNBIEN_STATE_DIR"] = "/first"
    expect(unbienStateHome()).toBe("/first")
    process.env["UNBIEN_STATE_DIR"] = "/second"
    expect(unbienStateHome()).toBe("/second")
  })
})

describe("unbienConfigHome precedence", () => {
  test("PI_CODING_AGENT_DIR unset → ~/.pi/extensions", () => {
    delete process.env["PI_CODING_AGENT_DIR"]
    delete process.env["UNBIEN_STATE_DIR"]
    delete process.env["UNBIEN_DIR"]
    delete process.env["UNBIEN_HOME"]
    expect(unbienConfigHome()).toBe(join(homedir(), ".pi", "extensions"))
  })

  test("PI_CODING_AGENT_DIR set → <agentDir>/extensions", () => {
    process.env["PI_CODING_AGENT_DIR"] = join(homedir(), ".pi")
    expect(unbienConfigHome()).toBe(join(homedir(), ".pi", "extensions"))
  })

  test("PI_CODING_AGENT_DIR wins over the state resolver (UNBIEN_STATE_DIR)", () => {
    process.env["PI_CODING_AGENT_DIR"] = "/agent/home"
    process.env["UNBIEN_STATE_DIR"] = "/state/root" // steers state, not config
    expect(unbienConfigHome()).toBe(join("/agent", "home", "extensions"))
    expect(unbienStateHome()).toBe("/state/root")
  })

  test("an empty PI_CODING_AGENT_DIR → ~/.pi/extensions (no state-dir fallback)", () => {
    process.env["PI_CODING_AGENT_DIR"] = ""
    process.env["UNBIEN_STATE_DIR"] = "/state/root"
    expect(unbienConfigHome()).toBe(join(homedir(), ".pi", "extensions"))
  })

  test("resolved at call time (a later env change is picked up)", () => {
    process.env["PI_CODING_AGENT_DIR"] = "/first"
    expect(unbienConfigHome()).toBe(join("/first", "extensions"))
    process.env["PI_CODING_AGENT_DIR"] = "/second"
    expect(unbienConfigHome()).toBe(join("/second", "extensions"))
  })
})
