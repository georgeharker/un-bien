/**
 * DurableAgentConfig against a real Harness (in-memory storage, the faux
 * provider): the app's model / thinking / name / queue verbs map onto the
 * conversation's agent and inbox.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { Harness, createRegistry, type Conversation } from "@earendil-works/pi-durable"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { DurableAgentConfig } from "./agent_config.js"
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
  const cwd = mkdtempSync(join(tmpdir(), "unbien-agent-"))
  const faux = fauxProvider({
    models: [
      { id: "thinker", reasoning: true },
      { id: "plain", reasoning: false },
    ],
  })
  const models = createModels()
  models.setProvider(faux.provider)
  harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd }) },
    ctx,
  )
  const conversation: Conversation = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "thinker" }, cwd },
  })
  harness.resume()
  source = new ConversationViewSource({
    conversation,
    context: ctx,
    mirror: new DurableTranscriptMirror(),
  })
  await source.open()
  source.start()
  const renamed: string[] = []
  const config = new DurableAgentConfig({
    conversation: () => conversation,
    harness,
    models,
    context: ctx,
    inbox: () => source?.inbox,
    rename: async (name) => {
      renamed.push(name)
    },
  })
  return { faux, conversation, config, renamed }
}

describe("DurableAgentConfig on a real Harness", () => {
  it("reports and lists models in the wire shape", async () => {
    const { config } = await setup()
    expect(await config.getModelState()).toEqual({
      model: { id: "thinker", provider: "faux" },
      thinkingLevel: "off",
    })
    const { models, current } = await config.listModels()
    expect(models.map((m) => m.id).sort()).toEqual(["plain", "thinker"])
    expect(current).toMatchObject({ id: "thinker", provider: "faux", reasoning: true })
    expect(Object.keys(current!).sort()).toEqual(
      ["context_window", "id", "name", "provider", "reasoning", "vision"],
    )
  })

  it("sets the thinking level and the model, clamping the level to the model", async () => {
    const { config, conversation } = await setup()
    await config.setThinkingLevel("high")
    expect((await conversation.agent(ctx)).thinkingLevel).toBe("high")
    const wire = await config.setModel("faux", "plain")
    expect(wire).toMatchObject({ id: "plain", reasoning: false })
    const agent = await conversation.agent(ctx)
    expect(agent.model).toEqual({ provider: "faux", modelId: "plain" })
    expect(agent.thinkingLevel).toBe("off")
    await expect(config.setModel("faux", "nope")).rejects.toThrow(
      'model "faux/nope" not in registry',
    )
  })

  it("renames through the bridge callback", async () => {
    const { config, renamed } = await setup()
    await config.setSessionName("research")
    expect(renamed).toEqual(["research"])
  })

  it("withdraws queued follow-ups and reports their text", async () => {
    const { faux, conversation, config } = await setup()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    faux.setResponses([
      async () => {
        await held
        return fauxAssistantMessage("first")
      },
      fauxAssistantMessage("never"),
    ])
    const first = await conversation.submit(
      { type: "input", content: [{ type: "text", text: "go" }] },
      ctx,
    )
    // Wait for the run to hold, then queue a follow-up behind it.
    for (let i = 0; i < 100 && faux.state.callCount === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    const queued = await conversation.submit(
      { type: "input", content: [{ type: "text", text: "later" }], whenBusy: "followUp" },
      ctx,
    )
    for (let i = 0; i < 100 && (source?.inbox?.items.length ?? 0) === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(await config.clearQueue()).toEqual({ steering: [], followUp: ["later"] })
    release()
    await first.wait(ctx)
    expect((await queued.status(ctx)).status).not.toBe("done")
    expect(faux.state.callCount).toBe(1)
  })
})
