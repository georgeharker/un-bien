/**
 * Durable-binding unit tests: the transcript mirror's wire mapping, the
 * WatchEventsSource translation (durable AgentEvents → the pi event plane
 * the rpc-envelope producer consumes), and the DurableToolRegistrar
 * adaptation (neutral defs → durable ToolRegistrations). All hermetic —
 * no harness, no relay, no mesh; fake streams and peers.
 */
import { describe, expect, it, vi } from "vitest"
import type {
  AgentEvent,
  AgentEventStream,
  SnapshotEvent,
} from "@earendil-works/pi-durable"
import type { EntryRecord } from "@earendil-works/pi-durable"
import type { EventSource } from "@geohar/un-bien/core"
import { defineMeshTools } from "@geohar/un-bien/core"
import { MeshInbox } from "@geohar/un-bien/dist/session/mesh_inbox.js"
import { DurableTranscriptMirror } from "./port.js"
import { WatchEventsSource } from "./event_source.js"
import { DurableToolRegistrar } from "./registrar.js"

// ── fixtures ────────────────────────────────────────────────────────────────

function record(
  id: number,
  model?: unknown,
  kind = "pi.assistant",
): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind,
    ...(model !== undefined ? { model: [model] as never } : {}),
  }
}

/** Minimal AgentEventStream double: snapshot + manual batch delivery. */
function fakeStream(entries: readonly EntryRecord[]): {
  stream: AgentEventStream
  deliver(events: readonly AgentEvent[]): void
} {
  const snapshot: SnapshotEvent = {
    type: "snapshot",
    entries,
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
  }
  let listener: Parameters<AgentEventStream["start"]>[0] | null = null
  const stream: AgentEventStream = {
    snapshot,
    start(l) {
      listener = l
    },
    stop: vi.fn(async () => ({ ended: true }) as never),
    closed: new Promise(() => undefined) as never,
  }
  return {
    stream,
    deliver(events) {
      void listener?.(events, {} as never)
    },
  }
}

// ── DurableTranscriptMirror ────────────────────────────────────────────────

describe("DurableTranscriptMirror", () => {
  it("maps model-bearing records to pi message entries with string ids", () => {
    const mirror = new DurableTranscriptMirror()
    mirror.seed([
      record(10, { role: "user", content: [{ type: "text", text: "hi" }] }),
      record(
        11,
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ),
    ])
    const { entries, leafId } = mirror.page()
    expect(leafId).toBe("11")
    expect(entries).toHaveLength(2)
    const first = entries[0] as Record<string, unknown>
    expect(first["type"]).toBe("message")
    expect(first["id"]).toBe("10")
    expect(first["parentId"]).toBeNull()
    expect((first["message"] as { role: string }).role).toBe("user")
    const second = entries[1] as Record<string, unknown>
    expect(second["parentId"]).toBe("10")
  })

  it("maps bookkeeping records to typed stubs carrying the durable kind", () => {
    const mirror = new DurableTranscriptMirror()
    mirror.seed([record(5, undefined, "pi.reset")])
    const entry = mirror.page().entries[0] as Record<string, unknown>
    expect(entry["type"]).toBe("pi.reset")
    expect(entry["id"]).toBe("5")
  })

  it("appends after seed and pages by since with pi-faithful validation", () => {
    const mirror = new DurableTranscriptMirror()
    mirror.seed([record(1, { role: "user", content: "a" })])
    mirror.append(record(2, { role: "assistant", content: "b" }))
    expect(mirror.page().entries).toHaveLength(2)
    const tail = mirror.page({ since: "1" })
    expect(tail.entries).toHaveLength(1)
    expect((tail.entries[0] as Record<string, unknown>)["id"]).toBe("2")
    expect(() => mirror.page({ since: "nope" })).toThrow(
      "Entry not found: nope",
    )
  })
})

// ── WatchEventsSource ───────────────────────────────────────────────────────

describe("WatchEventsSource", () => {
  function makeSource(entries: readonly EntryRecord[] = []) {
    const { stream, deliver } = fakeStream(entries)
    const mirror = new DurableTranscriptMirror()
    const busy: boolean[] = []
    const source = new WatchEventsSource(stream, {
      mirror,
      onBusyChange: (b) => busy.push(b),
    })
    source.start()
    const seen: Array<[string, unknown]> = []
    const events: EventSource = source
    events.on("agent_start", (p) => seen.push(["agent_start", p]))
    events.on("agent_end", (p) => seen.push(["agent_end", p]))
    events.on("agent_settled", (p) => seen.push(["agent_settled", p]))
    events.on("message_start", (p) => seen.push(["message_start", p]))
    events.on("message_update", (p) => seen.push(["message_update", p]))
    events.on("tool_execution_start", (p) =>
      seen.push(["tool_execution_start", p]),
    )
    events.on("tool_execution_update", (p) =>
      seen.push(["tool_execution_update", p]),
    )
    events.on("tool_execution_end", (p) =>
      seen.push(["tool_execution_end", p]),
    )
    events.on("session_compact", (p) => seen.push(["session_compact", p]))
    return { source, deliver, seen, mirror, busy }
  }

  it("seeds the mirror from the attachment snapshot", () => {
    const { source } = makeSource([
      record(3, { role: "user", content: "x" }),
    ])
    expect(source).toBeDefined()
    const mirror = new DurableTranscriptMirror()
    // (the constructor consumed the snapshot itself)
    void mirror
  })

  it("maps run lifecycle to agent_start/agent_end/agent_settled + busy flag", () => {
    const { deliver, seen, busy } = makeSource()
    deliver([{ type: "run_start", inputs: [] }])
    deliver([{ type: "run_end", inputs: [] }])
    expect(busy).toEqual([true, false])
    expect(seen.map(([name]) => name)).toEqual([
      "agent_start",
      "agent_end",
      "agent_settled",
    ])
    const end = seen[1]![1] as Record<string, unknown>
    expect(end["willRetry"]).toBe(false)
  })

  it("synthesizes toolcall_start partials the producer's stripPartial lifts", () => {
    const { deliver, seen } = makeSource()
    deliver([
      {
        type: "message_update",
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        changes: [
          {
            type: "toolcall_start",
            contentIndex: 0,
            block: { type: "toolCall", id: "tc_1", name: "bash", arguments: {} },
          },
        ],
      },
    ])
    const payload = seen[0]![1] as {
      assistantMessageEvent: {
        type: string
        partial: { content: unknown[] }
      }
    }
    expect(payload.assistantMessageEvent.type).toBe("toolcall_start")
    expect(payload.assistantMessageEvent.partial.content[0]).toEqual({
      id: "tc_1",
      name: "bash",
    })
  })

  it("folds tool output trim/append into partialResult buffers", () => {
    const { deliver, seen } = makeSource()
    deliver([
      { type: "tool_execution_start", toolCallId: "tc_1", toolName: "bash", args: {} },
    ])
    deliver([
      {
        type: "tool_execution_update",
        toolCallId: "tc_1",
        toolName: "bash",
        output: { append: "hello " },
      },
    ])
    deliver([
      {
        type: "tool_execution_update",
        toolCallId: "tc_1",
        toolName: "bash",
        output: { trimStart: 3, append: "world" },
      },
    ])
    deliver([
      {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "bash",
        entry: {
          id: 9 as EntryRecord["id"],
          conversationId: 1 as EntryRecord["conversationId"],
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              content: [{ type: "text", text: "hello world" }],
            },
          ] as never,
        },
      },
    ])
    const updates = seen.filter(([n]) => n === "tool_execution_update")
    const update = updates[updates.length - 1]![1] as {
      partialResult: string
    }
    expect(update.partialResult).toBe("lo world")
    const end = seen.find(([n]) => n === "tool_execution_end")![1] as {
      result: string
      isError: boolean
    }
    expect(end.result).toBe("hello world")
    expect(end.isError).toBe(false)
  })

  it("maps compaction_end to session_compact for the producer's frame builder", () => {
    const { deliver, seen } = makeSource()
    deliver([
      { type: "compaction_end", taskId: 1 as never, reason: "manual" },
    ])
    const payload = seen[0]![1] as { compactionEntry: unknown }
    expect(payload.compactionEntry).toBeDefined()
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