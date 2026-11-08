/**
 * Durable-binding unit tests: the transcript mirror's wire mapping, the
 * ViewTranslator (conversation-view states → the pi event plane the
 * rpc-envelope producer consumes), and the DurableToolRegistrar adaptation
 * (neutral defs → durable ToolRegistrations). All hermetic — no harness, no
 * relay, no mesh. view_source.test.ts runs the translation on a real Harness.
 */
import { describe, expect, it } from "vitest"
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable"
import { defineMeshTools } from "@geohar/un-bien/core"
import { MeshInbox } from "@geohar/un-bien/durable"
import { DurableTranscriptMirror, entryIdOf } from "./mirror.js"
import { ViewTranslator } from "./view_translator.js"
import { DurableToolRegistrar } from "./registrar.js"

// ── fixtures ────────────────────────────────────────────────────────────────

function record(
  id: number,
  kind: string,
  fields: { model?: unknown[]; data?: unknown; head?: number } = {},
): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind,
    ...(fields.model !== undefined ? { model: fields.model as never } : {}),
    ...(fields.data !== undefined ? { data: fields.data as never } : {}),
    ...(fields.head !== undefined ? { head: fields.head as never } : {}),
  }
}

type Wire = {
  id: string
  type: string
  parentId: string | null
  timestamp: string
} & Record<string, unknown>

function wireOf(mirror: DurableTranscriptMirror): Wire[] {
  return mirror.page().entries as unknown as Wire[]
}

// ── DurableTranscriptMirror ────────────────────────────────────────────────

describe("DurableTranscriptMirror", () => {
  it("keeps pi-ai messages typed: thinking, toolCall, toolResult details", () => {
    const mirror = new DurableTranscriptMirror()
    mirror.ingest([
      record(10, "pi.user", {
        model: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1000 }],
      }),
      record(11, "pi.assistant", {
        model: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hm" },
              { type: "toolCall", id: "tc", name: "bash", arguments: { command: "ls" } },
            ],
            timestamp: 2000,
          },
        ],
      }),
      record(12, "pi.tool-result", {
        model: [
          {
            role: "toolResult",
            toolCallId: "tc",
            toolName: "bash",
            content: [{ type: "text", text: "a.txt" }],
            details: { exitCode: 0 },
            isError: false,
            timestamp: 3000,
          },
        ],
        data: { diagnostics: [] },
      }),
    ])
    const wire = wireOf(mirror)
    expect(wire.map((e) => [e.id, e.type, e.parentId])).toEqual([
      ["10", "message", null],
      ["11", "message", "10"],
      ["12", "message", "11"],
    ])
    expect(wire[0]!.timestamp).toBe(new Date(1000).toISOString())
    const assistant = wire[1]!.message as { content: Array<{ type: string }> }
    expect(assistant.content.map((b) => b.type)).toEqual(["thinking", "toolCall"])
    expect(wire[2]!.message).toMatchObject({ details: { exitCode: 0 }, isError: false })
    expect(mirror.leafId).toBe("12")
  })

  it("maps a compaction to pi's compaction entry with the unwrapped summary", () => {
    const mirror = new DurableTranscriptMirror()
    const wrapped =
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\nDid things.\n</summary>"
    mirror.ingest([
      record(20, "pi.compaction", {
        model: [{ role: "user", content: [{ type: "text", text: wrapped }], timestamp: 5 }],
        head: 17,
      }),
    ])
    expect(wireOf(mirror)[0]).toMatchObject({
      type: "compaction",
      id: "20",
      summary: "Did things.",
      firstKeptEntryId: "17",
    })
  })

  it("maps resets and app entries to custom_message entries", () => {
    const mirror = new DurableTranscriptMirror()
    mirror.ingest([
      record(30, "pi.reset"),
      record(31, "pi.reset", {
        model: [{ role: "user", content: [{ type: "text", text: "carry on" }], timestamp: 7 }],
      }),
      record(32, "un-bien.app", {
        data: {
          customType: "un-bien:auth-required",
          content: "Authorize x",
          display: true,
          details: { url: "https://x" },
        },
      }),
      record(33, "un-bien.app", {
        data: { customType: "un-bien:relay-state", content: "s", display: false },
      }),
    ])
    const wire = wireOf(mirror)
    expect(wire[0]).toMatchObject({
      type: "custom_message",
      customType: "un-bien:durable-reset",
      content: "Context reset",
      display: true,
    })
    expect(wire[1]!.content).toContain("carry on")
    expect(wire[2]).toMatchObject({
      type: "custom_message",
      customType: "un-bien:auth-required",
      display: true,
      details: { url: "https://x" },
    })
    expect(wire[3]).toMatchObject({ type: "custom_message", display: false })
  })

  it("gives later model messages suffixed ids and stubs bookkeeping kinds", () => {
    const mirror = new DurableTranscriptMirror()
    mirror.ingest([
      record(40, "ext.multi", {
        model: [
          { role: "user", content: "a", timestamp: 1 },
          { role: "user", content: "b", timestamp: 2 },
        ],
      }),
      record(41, "pi.system", { model: [{ role: "system", content: "" }] }),
    ])
    const wire = wireOf(mirror)
    expect(wire.map((e) => [e.id, e.type])).toEqual([
      ["40", "message"],
      ["40.1", "message"],
      ["41", "pi.system"],
    ])
    expect(entryIdOf("40.1")).toBe(40)
    expect(entryIdOf("41")).toBe(41)
    expect(entryIdOf("nope")).toBeUndefined()
  })

  it("ingests only newer ids and pages by since with pi-faithful validation", () => {
    const mirror = new DurableTranscriptMirror()
    const first = record(1, "pi.user", { model: [{ role: "user", content: "a", timestamp: 1 }] })
    const second = record(2, "pi.assistant", {
      model: [{ role: "assistant", content: "b", timestamp: 2 }],
    })
    expect(mirror.ingest([first])).toHaveLength(1)
    expect(mirror.ingest([first, second])).toEqual([second])
    expect(mirror.page().entries).toHaveLength(2)
    const tail = mirror.page({ since: "1" })
    expect(tail.entries.map((e) => e.id)).toEqual(["2"])
    expect(() => mirror.page({ since: "nope" })).toThrow("Entry not found: nope")
  })
})

// ── ViewTranslator ──────────────────────────────────────────────────────────

describe("ViewTranslator", () => {
  function make() {
    const seen: Array<[string, Record<string, unknown>]> = []
    const failures: string[] = []
    const translator = new ViewTranslator({
      emit: (name, payload) => seen.push([name, payload]),
      onRunFailure: (f) => failures.push(f.reason),
    })
    return { translator, seen, failures, names: () => seen.map(([n]) => n) }
  }
  const run = { taskId: 1, inputs: [], turns: 0 } as unknown as NonNullable<LiveState["run"]>

  it("streams text as deltas from successive partials, then ends the block", () => {
    const { translator, seen } = make()
    translator.prime(undefined)
    const partial = (text: string) =>
      ({ run, generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text }] } } }) as unknown as LiveState
    translator.feed([], partial("Hel"))
    translator.feed([], partial("Hello"))
    translator.feed(
      [record(5, "pi.assistant", { model: [{ role: "assistant", content: [{ type: "text", text: "Hello!" }] }] })],
      { run } as unknown as LiveState,
    )
    const updates = seen
      .filter(([n]) => n === "message_update")
      .map(([, p]) => p.assistantMessageEvent as { type: string; delta?: string; content?: string })
    expect(updates.map((u) => u.type)).toEqual([
      "text_start",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_end",
    ])
    expect(updates.filter((u) => u.delta).map((u) => u.delta).join("")).toBe("Hello!")
    expect(updates.at(-1)!.content).toBe("Hello!")
  })

  it("reports tool progress as pi partialResults and a faulted slot as an error", () => {
    const { translator, seen } = make()
    translator.prime(undefined)
    const slot = (status: string, output?: string) =>
      ({ run, tools: [{ callId: "tc", name: "bash", status, ...(output !== undefined ? { output } : {}) }] }) as unknown as LiveState
    translator.feed([], slot("running", "lo"))
    translator.feed([], slot("running", "lo"))
    translator.feed([], slot("done"))
    const tool = seen.filter(([n]) => n.startsWith("tool_execution"))
    expect(tool.map(([n]) => n)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ])
    expect(tool[1]![1].partialResult).toEqual({ content: [{ type: "text", text: "lo" }] })
    expect(tool[2]![1].isError).toBe(true)
  })

  it("emits compactions, display app entries, and new run failures only", () => {
    const { translator, seen, failures } = make()
    translator.prime({ runFailure: { taskId: 3, inputs: [], reason: "aborted" } } as unknown as LiveState)
    translator.feed(
      [
        record(7, "pi.compaction", { model: [{ role: "user", content: "S" }] }),
        record(8, "un-bien.app", { data: { customType: "x", content: "shown", display: true } }),
        record(9, "un-bien.app", { data: { customType: "y", content: "hidden", display: false } }),
      ],
      { runFailure: { taskId: 3, inputs: [], reason: "aborted" } } as unknown as LiveState,
    )
    expect(failures).toEqual([])
    expect(seen.find(([n]) => n === "session_compact")![1]).toMatchObject({
      compactionEntry: { summary: "S" },
    })
    const custom = seen
      .filter(([n]) => n === "message_end")
      .map(([, p]) => p.message as { role: string; content: string })
    expect(custom).toEqual([expect.objectContaining({ role: "custom", content: "shown" })])
    translator.feed([], { runFailure: { taskId: 4, inputs: [], reason: "model_error" } } as unknown as LiveState)
    expect(failures).toEqual(["model_error"])
  })

  it("attaching mid-run stays busy and ends the run once", () => {
    const { translator, names } = make()
    translator.prime({ run } as unknown as LiveState)
    translator.feed([], { run } as unknown as LiveState)
    translator.feed([], {} as LiveState)
    expect(names()).toEqual(["turn_end", "agent_end", "agent_settled"])
  })

  it("a notice written while idle opens no turn; the next run still does", () => {
    const { translator, names } = make()
    translator.prime(undefined)
    // e.g. the "Stopped" notice the bridge records after an aborted run.
    translator.feed(
      [record(50, "un-bien.app", { data: { customType: "x", content: "Stopped", display: true } })],
      {} as LiveState,
    )
    expect(names()).toEqual(["message_start", "message_end"])
    translator.feed(
      [record(51, "pi.user", { model: [{ role: "user", content: "next" }] })],
      { run } as unknown as LiveState,
    )
    expect(names().slice(2)).toEqual(["agent_start", "turn_start", "message_start", "message_end"])
  })
})

// ── DurableToolRegistrar ───────────────────────────────────────────────────

describe("DurableToolRegistrar", () => {
  it("adapts neutral mesh defs to durable ToolRegistrations with passthrough semantics", async () => {
    const registrar = new DurableToolRegistrar()
    const inbox = new MeshInbox()
    const defs = defineMeshTools({
      getSessionPeer: () => null, // not on the mesh → the refused path
      getInbox: () => inbox,
      getRemoteRelayPeers: () => [],
      getRemoteRelayPeersDetail: () => new Map(),
      getRelay: () => null,
    })
    for (const def of defs) registrar.registerTool(def)
    expect(registrar.registrations.map((t) => t.name)).toEqual([
      "agent_send",
      "list_peers",
      "whoami",
      "agent_request",
      "mesh_get_message",
      "mesh_list_messages",
      "mesh_wait_message",
    ])
    const whoami = registrar.registrations.find((t) => t.name === "whoami")!
    expect(whoami.description).toContain("mesh identity")
    // Execute through the durable signature: refused (no peer) → text output.
    const result = (await whoami.execute(
      {} as never,
      {} as never,
      {} as never,
    )) as { output: Array<{ type: string; text: string }>; details: unknown }
    expect(result.output[0]!.text).toContain("Not in a session")
    const details = result.details as { address: string; broker: string }
    expect(details.address).toBe("")
    expect(details.broker).toBe("local")
  })

  it("folds promptSnippet into the description (durable has no snippet surface)", () => {
    const registrar = new DurableToolRegistrar()
    registrar.registerTool({
      name: "t",
      label: "T",
      description: "Base.",
      promptSnippet: "t(): do the thing.",
      // SAFETY: a minimal hand-built schema exercises the registrar only —
      // durable validates against it at call time, not registration time.
      parameters: {
        "~kind": "Object",
        type: "object",
        properties: {},
        required: [],
      } as never,
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
      }),
    })
    expect(registrar.registrations[0]!.description).toBe(
      "Base.\n\nUsage: t(): do the thing.",
    )
  })
})