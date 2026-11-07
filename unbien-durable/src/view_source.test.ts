/**
 * ConversationViewSource against a real Harness: in-memory storage, the
 * faux model provider, and the coding tools. One run (a thinking + text +
 * bash tool-call answer, the tool's result, a final answer) must come out
 * as pi's event sequence with typed payloads, and the mirror must hold the
 * pi entry shapes the app replays.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { ConversationViewSource } from "./event_source.js"
import { DurableTranscriptMirror } from "./mirror.js"

const ctx = BACKGROUND_CONTEXT
let harness: Harness | null = null
let source: ConversationViewSource | null = null

afterEach(async () => {
  await source?.stop()
  await harness?.close(ctx)
  source = null
  harness = null
})

async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "unbien-view-"))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(CodingTools)
  harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => new NodeExecutionEnv({ cwd }),
    },
    ctx,
  )
  const conversation = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: faux.getModel().id }, cwd },
  })
  harness.resume()
  const mirror = new DurableTranscriptMirror()
  const events: Array<[string, Record<string, unknown>]> = []
  const busy: boolean[] = []
  let settled: () => void = () => undefined
  const runSettled = new Promise<void>((resolve) => {
    settled = resolve
  })
  source = new ConversationViewSource({
    conversation,
    context: ctx,
    mirror,
    onBusyChange: (b) => busy.push(b),
  })
  await source.open()
  source.onAny((name, payload) => {
    events.push([name, payload as Record<string, unknown>])
    if (name === "agent_settled") settled()
  })
  source.start()
  return { faux, conversation, mirror, events, busy, runSettled }
}

describe("ConversationViewSource on a real Harness", () => {
  it("emits pi's event sequence for a tool-calling run, with typed payloads", async () => {
    const { faux, conversation, mirror, events, busy, runSettled } = await setup()
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Check the shell."),
          fauxText("Running it."),
          fauxToolCall("bash", { command: "echo hi" }, { id: "tc1" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("It printed hi."),
    ])
    await conversation.submit(
      { type: "input", content: [{ type: "text", text: "go" }] },
      ctx,
    )
    await runSettled

    const names = events
      .map(([name]) => name)
      .filter((name) => name !== "message_update" && name !== "tool_execution_update")
    expect(names).toEqual([
      "agent_start",
      "turn_start",
      "message_start", // user
      "message_end",
      "message_start", // assistant (tool call)
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start", // toolResult
      "message_end",
      "turn_end",
      "turn_start",
      "message_start", // final answer
      "message_end",
      "turn_end",
      "agent_end",
      "agent_settled",
    ])
    expect(busy).toEqual([false, true, false])

    // Block events: thinking and text stream and end; the tool call starts
    // and ends with its final arguments.
    const blockEvents = events
      .filter(([name]) => name === "message_update")
      .map(([, p]) => p.assistantMessageEvent as Record<string, unknown>)
    const types = blockEvents.map((e) => e.type)
    expect(types).toContain("thinking_delta")
    expect(types).toContain("thinking_end")
    expect(types).toContain("text_end")
    expect(types).toContain("toolcall_start")
    const thinking = blockEvents
      .filter((e) => e.type === "thinking_delta")
      .map((e) => e.delta)
      .join("")
    expect(thinking).toBe("Check the shell.")
    const callEnd = blockEvents.find((e) => e.type === "toolcall_end")
    expect(callEnd?.toolCall).toMatchObject({
      type: "toolCall",
      id: "tc1",
      name: "bash",
      arguments: { command: "echo hi" },
    })

    // Tool events: pi's {content, details} result and the real isError.
    const start = events.find(([n]) => n === "tool_execution_start")![1]
    expect(start).toMatchObject({
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "echo hi" },
    })
    const end = events.find(([n]) => n === "tool_execution_end")![1]
    expect(end.isError).toBe(false)
    const result = end.result as { content: Array<{ type: string; text?: string }> }
    expect(result.content[0]?.type).toBe("text")
    expect(result.content[0]?.text).toContain("hi")

    // The assistant message_end carries the typed blocks, thinking included.
    const assistantEnd = events.find(
      ([n, p]) =>
        n === "message_end" &&
        (p.message as { role?: string }).role === "assistant",
    )![1]
    const blocks = (assistantEnd.message as { content: Array<{ type: string }> })
      .content
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "toolCall"])

    // The mirror replays the same messages as pi entries.
    const { entries, leafId } = mirror.page()
    const wire = entries as unknown as Array<{
      id: string
      type: string
      timestamp: string
      message?: { role: string }
    }>
    const replay = wire
      .filter((e) => e.type === "message")
      .map((e) => e.message?.role)
    expect(replay).toEqual(["user", "assistant", "toolResult", "assistant"])
    expect(leafId).toBe(wire.at(-1)!.id)
    for (const entry of wire) {
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false)
    }
  })

  it("reports a run that ends without an answer", async () => {
    const { faux, conversation } = await setup()
    const failures: string[] = []
    // A source of its own, observing failures.
    await source!.stop()
    const mirror = new DurableTranscriptMirror()
    const settledAgain = new Promise<void>((resolve) => {
      source = new ConversationViewSource({
        conversation,
        context: ctx,
        mirror,
        onRunFailure: (f) => failures.push(f.reason),
      })
      source.on("agent_settled", () => resolve())
    })
    await source!.open()
    source!.start()
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
    ])
    await conversation.submit(
      { type: "input", content: [{ type: "text", text: "go" }] },
      ctx,
    )
    await settledAgain
    expect(failures).toEqual(["model_error"])
  })
})
