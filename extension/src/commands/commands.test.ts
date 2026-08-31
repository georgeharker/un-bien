/**
 * Registration-surface tests for the `/unbien` command family, colocated
 * with commands/register.ts (carved out of extension.test.ts). These only
 * assert which commands the extension registers and how the rename verb
 * dispatches, so the full relay/storage mock harness isn't needed — but
 * the helpers are verbatim copies of the ones in extension.test.ts.
 */
import { describe, expect, test, vi } from "vitest"
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent"

const indexModule = await import("../index.js")
const { default: extension } = indexModule

function makeMockPi(): { pi: ExtensionAPI; registeredCommands: string[] } {
  const registeredCommands: string[] = []
  const pi = {
    on: () => undefined,
    registerCommand(name: string, _opts: unknown) {
      registeredCommands.push(name)
    },
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI
  return { pi, registeredCommands }
}

function makeMockCtx(cwd = "/home/user/projects/remote_pi") {
  return { ui: { notify: vi.fn() }, cwd, abort: vi.fn() }
}

type CmdHandler = (
  args: string,
  ctx: ReturnType<typeof makeMockCtx>,
) => Promise<void>

function captureHandler(commandName: string): CmdHandler {
  let captured: CmdHandler | undefined
  const pi = {
    on: () => undefined,
    registerCommand(name: string, opts: { handler: CmdHandler }) {
      if (name === commandName) captured = opts.handler
    },
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI
  ;(extension as ExtensionFactory)(pi)
  if (!captured) throw new Error(`command "${commandName}" not registered`)
  return captured
}

// ── Registration tests ────────────────────────────────────────────────────────

describe("extension default export", () => {
  test("is an ExtensionFactory function", () => {
    expect(typeof extension).toBe("function")
  })

  test("registers the user-facing commands", () => {
    const { pi, registeredCommands } = makeMockPi()
    ;(extension as ExtensionFactory)(pi)
    // Local session (plan/25)
    expect(registeredCommands).toContain("unbien")
    expect(registeredCommands).toContain("unbien setup")
    expect(registeredCommands).toContain("unbien status")
    expect(registeredCommands).toContain("unbien stop")
    expect(registeredCommands).toContain("unbien pair")
    expect(registeredCommands).toContain("unbien devices")
    expect(registeredCommands).toContain("unbien revoke")
    expect(registeredCommands).toContain("unbien set-relay")
    // Service install — the presence daemon as a system service
    expect(registeredCommands).toContain("unbien install")
    expect(registeredCommands).toContain("unbien uninstall")
    // Cross-PC peer inventory (plan/25 W D)
    expect(registeredCommands).toContain("unbien peers")
    // Machine identity (non-secret show) + its `show` verb alias
    expect(registeredCommands).toContain("unbien identity")
    expect(registeredCommands).toContain("unbien identity show")
  })

  test("no deprecated or removed commands leak back into the surface", () => {
    const { pi, registeredCommands } = makeMockPi()
    ;(extension as ExtensionFactory)(pi)
    // 8 plan-25 + 2 install + 1 cross-PC inventory (plan-25 W D)
    // + 1 rename (plan/41) + 1 relay control (issue #119)
    // + 2 identity (`unbien identity` and its `identity show` verb alias)
    // + 1 config.
    expect(registeredCommands).toHaveLength(16)
    // `relay` is back as ONE command with verbs (start/stop/status/url), not the
    // five separate registrations plan/19 trimmed — the README documents it and
    // without it every `/unbien relay …` silently reprinted the status panel.
    expect(registeredCommands).toContain("unbien relay")
    expect(registeredCommands).toContain("unbien config")
    for (const removed of [
      "unbien join",
      "un-bien leave",
      "un-bien sessions",
      "unbien relay start",
      "unbien relay stop",
      "unbien relay status",
      "unbien relay url",
      "unbien start",
      "un-bien list",
      "un-bien add-relay",
      // Retired supervisord/daemon-fleet/cron subsystem.
      "unbien create",
      "unbien remove",
      "unbien daemons",
      "unbien daemon start",
      "unbien daemon stop",
      "unbien daemon restart",
      "unbien daemon status",
      "unbien daemon send",
      "unbien cron",
    ]) {
      expect(registeredCommands).not.toContain(removed)
    }
  })

  // README documents `/unbien rename <new>` but the verb had been dropped
  // from the TUI dispatcher (only the Cockpit `rename:` control path worked).
  // Re-adding it aligns the implementation with the documented surface.
  test("/unbien rename is registered and dispatches to _renameAgent", async () => {
    const rename = captureHandler("unbien rename")
    expect(typeof rename).toBe("function")
    // Empty arg → _renameAgent no-ops (same contract as the control channel).
    await expect(rename("", makeMockCtx())).resolves.toBeUndefined()
  })
})
