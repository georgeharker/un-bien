import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { EnvelopeMessage } from "../session/rpc_envelope.js"

/**
 * The /unbien test canned-scenario runner (carved verbatim from index.ts,
 * build slice 3 of the index.ts decomposition). Emits synthetic frames via
 * the SAME broadcast the live plane uses, and injects plan/subagent/ask bus
 * events via the pi events bus — exercising the real translation seams with
 * zero side effects.
 */
interface PiEventBusInternals {
  events?: { emit(channel: string, data: unknown): void }
}

const _TEST_SVG_B64 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">' +
    '<rect width="120" height="60" rx="8" fill="#4c8bf5"/>' +
    '<text x="60" y="37" font-size="16" fill="white" text-anchor="middle"' +
    ' font-family="sans-serif">un-bien</text></svg>',
).toString("base64")


export interface TestScenarioDeps {
  /** Broadcast an envelope to every attached owner (the relay fan-out seam). */
  broadcast: (env: EnvelopeMessage) => void
  /** Emit on the pi events bus (drives the extension's real bridges). */
  emitBus: (channel: string, data: unknown) => void
}

/** The pi-events-bus emitter — reads the live `_pi` handle at CALL time
 *  (accessor, not snapshot: `_pi` is reassigned by session replacement and
 *  tests). */
export function makeTestBusEmitter(piAccessor: () => ExtensionAPI | null): (channel: string, data: unknown) => void {
  return (channel: string, data: unknown) => {
    try {
      ;(piAccessor() as PiEventBusInternals | null)?.events?.emit(channel, data)
    } catch {
      /* bus absent — best effort */
    }
  }
}


/** Run one canned UI-test scenario. Returns a short status for the notify. */
export function runTestScenario(
  deps: TestScenarioDeps,
  scenario: string,
): string {
  const { broadcast, emitBus } = deps
  const s = (scenario.trim().split(/\s+/)[0] || "help").toLowerCase()
  const id = `test-${Date.now()}`
  switch (s) {
    case "ask-select":
      broadcast({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "select",
          title: "Pick one (test)",
          options: ["Alpha", "Beta", "Gamma"],
        },
      })
      return "sent ask-select"
    case "ask-confirm":
      broadcast({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "confirm",
          title: "Confirm (test)",
          message: "Proceed with the test action?",
        },
      })
      return "sent ask-confirm"
    case "ask-input":
      broadcast({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "input",
          title: "Input (test)",
          placeholder: "Type something…",
        },
      })
      return "sent ask-input"
    case "ask-editor":
      broadcast({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "editor",
          title: "Editor (test)",
          prefill: "edit me",
        },
      })
      return "sent ask-editor"
    case "ask-notify":
      broadcast({
        rpc: {
          type: "extension_ui_request",
          id,
          method: "notify",
          message: "This is a test notice.",
          notify_type: "info",
        },
      })
      return "sent ask-notify"
    case "ask-rich":
      emitBus("@eko24ive/pi-ask:started", {
        version: 1,
        flowId: `test-flow-${Date.now()}`,
        source: "test",
        title: "Rich ask (test)",
        questions: [
          {
            id: "q1",
            prompt: "Which approach?",
            type: "single",
            options: [
              { value: "a", label: "Approach A", description: "the safe one" },
              { value: "b", label: "Approach B", preview: "preview text here" },
            ],
          },
          {
            id: "q2",
            prompt: "Anything to add?",
            type: "single",
            options: [{ value: "ok", label: "Looks good", freeform: true }],
          },
        ],
      })
      return "emitted pi-ask:started (rich)"
    case "plan":
      emitBus("plan:snapshot", {
        ns: "test",
        seq: 1,
        items: [
          {
            id: "t1",
            kind: "plan",
            title: "Design the thing",
            status: "done",
            deps: [],
          },
          {
            id: "t2",
            kind: "plan",
            title: "Build the thing",
            status: "in_progress",
            deps: ["t1"],
          },
          {
            id: "t3",
            kind: "plan",
            title: "Test the thing",
            status: "pending",
            deps: ["t2"],
          },
        ],
      })
      return "emitted plan:snapshot"
    case "subagents":
      emitBus("subagents:created", {
        id: "sa1",
        type: "explore",
        description: "Explore the codebase",
      })
      emitBus("subagents:started", { id: "sa1" })
      emitBus("subagents:created", {
        id: "sa2",
        type: "plan",
        description: "Draft an implementation plan",
      })
      emitBus("subagents:completed", { id: "sa2" })
      return "emitted subagents lifecycle"
    case "svg": {
      // A TOOL card renders standalone; the app pulls tool-emitted images from
      // INSIDE the tool_execution_end `result` (imagesFromToolResult unwraps
      // `{content:[{type:"image",data,mimeType}]}`) and renders them below the
      // card (WireImageView -> SVGImageView). Deliver the SVG that way.
      const tc = `tc-svg-${Date.now()}`
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "render_svg",
          args: { note: "test svg" },
        },
      })
      broadcast({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: {
            content: [
              { type: "text", text: "rendered a test SVG" },
              {
                type: "image",
                data: _TEST_SVG_B64,
                mimeType: "image/svg+xml",
              },
            ],
          },
          isError: false,
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent svg (envelope tool_execution_end + image)"
    }
    case "tool": {
      const tc = `tc-${Date.now()}`
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "echo hello" },
        },
      })
      broadcast({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "hello\n",
          isError: false,
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent tool pair (envelope)"
    }
    case "diff": {
      // Exercise the rich diff rendering: aux `{hunks}` (input Edit diff) rides
      // ALONGSIDE the raw edit `tool_execution_start`. OUTPUT is classified
      // app-side from the result, so no aux.output rides the end frame.
      const tc = `tc-diff-${Date.now()}`
      const hunks = [
        {
          lines: [
            { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
            { kind: "remove", oldLine: 2, text: "const b = 2;" },
            { kind: "add", newLine: 2, text: "const b = 3;" },
            { kind: "context", oldLine: 3, newLine: 3, text: "const c = 4;" },
          ],
        },
      ]
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "edit",
          args: {
            path: "demo.ts",
            old_string: "const b = 2;",
            new_string: "const b = 3;",
          },
        },
        aux: { hunks },
      })
      broadcast({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "edited demo.ts",
          isError: false,
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent diff (edit + aux hunks — shows the Diff⇄Content toggle)"
    }
    case "code-shell": {
      // bash-family result → the app classifies it into a `code` block (lang
      // shell), syntax-highlighted. OUTPUT is app-side now — no aux stamped.
      const tc = `tc-sh-${Date.now()}`
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "ls -la" },
        },
      })
      broadcast({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            "total 24\ndrwxr-xr-x  5 geo staff  160 Aug 29 10:00 .\n-rw-r--r--  1 geo staff 1024 index.ts\n-rw-r--r--  1 geo staff  512 README.md",
          isError: false,
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent code-shell (bash output → code block, lang shell)"
    }
    case "code-file": {
      // read-family with a *.swift path → `code` block, lang inferred from the
      // extension (swift) and highlighted.
      const tc = `tc-rd-${Date.now()}`
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "read",
          args: { path: "/src/Greeter.swift" },
        },
      })
      broadcast({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            'struct Greeter {\n    let name: String\n    func greet() -> String {\n        return "Hello, \\(name)!"\n    }\n}',
          isError: false,
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent code-file (read .swift → highlighted code block)"
    }
    case "diff-output": {
      // A tool whose RESULT already embeds a unified diff → the app parses it
      // into a `diff` block (re-reading persisted text; replay-safe).
      const tc = `tc-do-${Date.now()}`
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "bash",
          args: { command: "git diff" },
        },
      })
      broadcast({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result:
            'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n const port = 3000;\n-const host = "127.0.0.1";\n+const host = "0.0.0.0";\n start(host, port);',
          isError: false,
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent diff-output (result embeds a unified diff → diff block)"
    }
    case "write": {
      // write carries the new file text in args.content; no live diff → the
      // card shows the Content view (new text as a code block, replay-safe).
      const tc = `tc-wr-${Date.now()}`
      const content =
        "export function add(a: number, b: number): number {\n  return a + b;\n}"
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "tool_execution_start",
          toolCallId: tc,
          toolName: "write",
          args: { path: "/src/math.ts", content },
        },
      })
      broadcast({
        rpc: {
          type: "tool_execution_end",
          toolCallId: tc,
          result: "wrote /src/math.ts",
          isError: false,
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent write (args.content → content-as-code block)"
    }
    case "agent": {
      broadcast({ rpc: { type: "turn_start" } })
      broadcast({
        rpc: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "This is a ",
          },
        },
      })
      broadcast({
        rpc: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "test agent message.",
          },
        },
      })
      broadcast({
        rpc: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "This is a test agent message." }],
          },
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent agent message (envelope)"
    }
    case "error":
      broadcast({
        rpc: {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "This is a test error.",
          },
        },
      })
      broadcast({ rpc: { type: "agent_settled" } })
      return "sent error (envelope message_end/error)"
    case "all":
      for (const sc of [
        "ask-notify",
        "plan",
        "subagents",
        "svg",
        "tool",
        "diff",
        "code-shell",
        "code-file",
        "diff-output",
        "write",
        "agent",
        "error",
      ])
        runTestScenario(deps, sc)
      return "sent all (ask-notify, plan, subagents, svg, tool, diff, code-shell, code-file, diff-output, write, agent, error)"
    default:
      return "usage: /unbien test <ask-select|ask-confirm|ask-input|ask-editor|ask-notify|ask-rich|plan|subagents|svg|tool|diff|code-shell|code-file|diff-output|write|agent|error|all>"
  }
}

/**
 * New-protocol inbound: dispatch an envelope-carried pi `RpcCommand` to the SDK
 * and answer with a `{ rpc: response }` envelope to the SENDER. Native to the
 * envelope wire — does NOT use the stock `_routeClientMessageFrom` switch. The
 * SDK primitives (`_wakeAgent`, `_abortCurrentTurn`) are pi, not old protocol.
 */
