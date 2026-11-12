/**
 * Durable tool-result parity (tool faces, design 01M77YDWSZFD6WCYVFT3Z73SWJ).
 *
 * Runs pi-durable's own CodingTools (bash, read, edit, write) on a real
 * Harness (in-memory storage, the faux model) and captures what the app
 * receives through the PRODUCTION path: the live rpc frames
 * (ConversationViewSource → createRpcEnvelope) and the stored entries (the
 * transcript mirror, as get_entries serves them). It asserts the parity the
 * app relies on — the live result equals the stored one, same error state —
 * and keeps the captured calls as the durable fixture catalog
 * (app/Tests/Fixtures/tool-results/durable-catalog.json) that the app's face,
 * parity and height tests consume alongside the pi catalog.
 *
 * The catalog is normalized (paths, durations, timestamps) and compared with
 * the committed file, so a pi-durable change to what the app receives fails
 * here. Regenerate with UPDATE_TOOL_FIXTURES=1.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { createRpcEnvelope } from "@geohar/un-bien/durable"
import { ConversationViewSource } from "./event_source.js"
import { DurableTranscriptMirror } from "./mirror.js"

const ctx = BACKGROUND_CONTEXT
const CATALOG = join(dirname(fileURLToPath(import.meta.url)),
  "../../app/Tests/Fixtures/tool-results/durable-catalog.json")

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface Scenario {
  id: string
  spec: string
  tool: string
  args: Record<string, Json>
  /** Files to create in the working directory first. */
  files?: Record<string, string>
  expect: Record<string, Json>
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

const SCENARIOS: Scenario[] = [
  {
    id: "durable.bash.ok", tool: "bash", args: { command: "echo hi" },
    spec: "pi-durable tools/bash: no output of its own; the retained output becomes the content",
    expect: { face: "terminal", category: "shell", text: "hi\n", notices: [] },
  },
  {
    id: "durable.bash.exit-code", tool: "bash", args: { command: "echo out; exit 3" },
    spec: "pi-durable tools/bash: a non-zero exit is an error DIAGNOSTIC, rendered in the trailing <harness> block",
    // The error text joins the output and the error diagnostic, as pi's text reads.
    expect: { face: "error", category: "shell", isError: true,
              text: "out\n\nCommand exited with code 3",
              diagnostics: ["[error] Command exited with code 3"] },
  },
  {
    id: "durable.bash.truncated", tool: "bash", args: { command: "seq 3000" },
    spec: "pi-durable tools/bash: output past the retain bounds keeps the tail; truncation and the spill path are diagnostics",
    expect: { face: "terminal", category: "shell",
              diagnostics: ["[info] Full output: /spill/output.log",
                            "[warn] Output truncated to its end: 1000 lines, 3893 bytes dropped"] },
  },
  {
    id: "durable.read.text", tool: "read", args: { path: "a.swift" },
    files: { "a.swift": "import Foundation\nlet x = 1\n" },
    spec: "pi-durable tools/read: the file text as read",
    expect: { face: "file", category: "reads", lang: "swift" },
  },
  {
    id: "durable.read.truncated", tool: "read", args: { path: "big.py" },
    files: { "big.py": lines(2500) },
    spec: "pi-durable tools/read: truncation in details {truncation}; the continuation notice is a diagnostic",
    expect: { face: "file", category: "reads", lang: "python",
              diagnostics: ["[info] Showing lines 1-2000 of 2500. Use offset=2001 to continue."] },
  },
  {
    id: "durable.read.missing", tool: "read", args: { path: "missing.txt" },
    spec: "pi-durable tools/read: a missing file fails the call",
    // No text at all: the reason is only the error diagnostic.
    expect: { face: "error", category: "reads", isError: true,
              text: "ENOENT: no such file or directory, open '/w/missing.txt'",
              diagnostics: ["[error] ENOENT: no such file or directory, open '/w/missing.txt'"] },
  },
  {
    id: "durable.edit.ok", tool: "edit",
    args: { path: "c.sh", edits: [{ oldText: "b=2", newText: "b=3" }] },
    files: { "c.sh": "a=1\nb=2\nc=3\n" },
    spec: "pi-durable tools/edit: same success line and details {diff, patch, firstChangedLine} as pi",
    expect: { face: "diff", category: "edits", diffFrom: "details.patch",
              confirmation: "Successfully replaced 1 block(s) in c.sh." },
  },
  {
    id: "durable.write.ok", tool: "write", args: { path: "d.txt", content: "hello\n" },
    spec: "pi-durable tools/write: 'Successfully wrote to path', no details",
    expect: { face: "confirmation", category: "writes", confirmation: "Successfully wrote to d.txt" },
  },
]

let harness: Harness | null = null
let source: ConversationViewSource | null = null
afterEach(async () => {
  await source?.stop()
  await harness?.close(ctx)
  source = null
  harness = null
})

/** Run one scenario's call; return the app-facing frames and stored entries. */
async function capture(s: Scenario) {
  const cwd = mkdtempSync(join(tmpdir(), "unbien-tool-fx-"))
  for (const [name, text] of Object.entries(s.files ?? {})) writeFileSync(join(cwd, name), text)
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(CodingTools)
  harness = await Harness.open(new MemoryStorage(),
    { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, ctx)
  const conversation = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: faux.getModel().id }, cwd },
  })
  harness.resume()
  const mirror = new DurableTranscriptMirror()
  source = new ConversationViewSource({ conversation, context: ctx, mirror })
  const frames: Record<string, Json>[] = []
  let settled: () => void = () => undefined
  const done = new Promise<void>((resolve) => { settled = resolve })
  createRpcEnvelope(source, (env) => {
    frames.push(env.rpc as Record<string, Json>)
  })
  source.on("agent_settled", () => settled())
  await source.open()
  source.start()
  const callId = `call_${s.id.replace(/[.-]/g, "_")}`
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(s.tool, s.args, { id: callId })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ])
  await conversation.submit({ type: "input", content: [{ type: "text", text: "go" }] }, ctx)
  await done
  const wire = mirror.page().entries as unknown as Record<string, Json>[]
  return { cwd, callId, frames, wire }
}

/** Stable values for the committed catalog: the temp cwd, spill paths,
 *  timestamps and the faux provider's per-instance api id vary per run, and
 *  durationMs is present only when the run measured one, so it is dropped. */
function normalize(value: Json, cwd: string): Json {
  if (typeof value === "string") {
    return value.split(cwd).join("/w")
      .replace(/\/[^\s"\]]*?\/[^\s"\]/]*(spill|output)[^\s"\]]*/g, "/spill/output.log")
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, cwd))
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === "durationMs") continue
      if (k === "api" && typeof v === "string" && v.startsWith("faux:")) {
        out[k] = "faux"
        continue
      }
      else if (k === "timestamp") out[k] = typeof v === "number" ? 1794000000000 : "2026-11-12T00:00:00.000Z"
      else out[k] = normalize(v, cwd)
    }
    return out
  }
  return value
}

describe("durable tool results reach the app as pi tool results", () => {
  it("live equals stored for every CodingTools call; the catalog matches", async () => {
    const fixtures: Json[] = []
    for (const s of SCENARIOS) {
      const { cwd, callId, frames, wire } = await capture(s)
      const tool = frames.filter((f) => typeof f.type === "string" &&
        f.type.startsWith("tool_execution_") && f.toolCallId === callId)
      const end = tool.find((f) => f.type === "tool_execution_end")
      expect(end, `${s.id}: a tool_execution_end`).toBeDefined()
      expect(tool[0]?.type, `${s.id}: starts with tool_execution_start`).toBe("tool_execution_start")
      const callEntry = wire.find((e) => {
        const content = (e.message as { content?: Json } | undefined)?.content
        return Array.isArray(content) && content.some((b) => (b as { id?: Json })?.id === callId)
      })
      const resultEntry = wire.find((e) =>
        (e.message as { role?: Json; toolCallId?: Json } | undefined)?.role === "toolResult" &&
        (e.message as { toolCallId?: Json }).toolCallId === callId)
      expect(callEntry && resultEntry, `${s.id}: stored call and result`).toBeTruthy()
      const stored = resultEntry!.message as Record<string, Json>
      // PARITY: the live result object is the stored content + details.
      const live = end!.result as Record<string, Json>
      expect(live.content, `${s.id}: content`).toEqual(stored.content)
      expect(live.details ?? null, `${s.id}: details`).toEqual(stored.details ?? null)
      expect(end!.isError, `${s.id}: isError`).toBe(stored.isError)
      if (s.expect.isError === true) expect(stored.isError, s.id).toBe(true)
      // Partial frames, when they come, carry pi's {content, details?} shape.
      for (const update of tool.filter((f) => f.type === "tool_execution_update")) {
        expect(Array.isArray((update.partialResult as { content?: Json })?.content), `${s.id}: partial`).toBe(true)
      }
      fixtures.push(normalize({
        id: s.id, spec: s.spec, tool: s.tool, toolCallId: callId, args: s.args,
        // The settled frames (start, end): partial-update counts depend on timing.
        live: tool.filter((f) => f.type !== "tool_execution_update"),
        // The call and its result, linked as one path.
        stored: [
          { ...callEntry!, parentId: null },
          { ...resultEntry!, parentId: callEntry!.id },
        ],
        expect: s.expect,
      }, cwd))
      await source?.stop()
      await harness?.close(ctx)
      source = null
      harness = null
    }
    const catalog = JSON.stringify({
      schema: 1,
      source: "Captured from pi-durable 1.5 CodingTools through the un-bien durable binding (src/tool_fixtures.test.ts).",
      fixtures,
    }, null, 1) + "\n"
    if (process.env.UPDATE_TOOL_FIXTURES === "1") {
      writeFileSync(CATALOG, catalog)
    } else {
      expect(readFileSync(CATALOG, "utf8"),
        "durable-catalog.json drifted from what the binding sends: rerun with UPDATE_TOOL_FIXTURES=1 and review the diff")
        .toBe(catalog)
    }
  }, 60_000)
})
