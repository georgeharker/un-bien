/**
 * PiAgentConfig — the pi binding of the model / thinking / name / queue
 * verbs. Fakes stand in for the root ExtensionAPI and the session_start
 * ctx's model registry.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ActionCtx, ActionModelRegistry } from "../actions/handlers.js"
import { PiAgentConfig } from "./agent_config.js"

const sonnet = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  contextWindow: 200_000,
  input: ["text", "image"],
}
const gpt = {
  id: "gpt-5",
  name: "GPT-5",
  provider: "openai",
  reasoning: false,
  contextWindow: 400_000,
  input: ["text"],
}

function registry(): ActionModelRegistry {
  return {
    refresh: vi.fn(),
    getAvailable: () => [sonnet, gpt] as never,
    find: (provider, id) =>
      ([sonnet, gpt].find((m) => m.provider === provider && m.id === id) ??
        undefined) as never,
  }
}

function make(opts: { pi?: Partial<Record<string, unknown>> | null; setModelOk?: boolean } = {}) {
  const pi =
    opts.pi === null
      ? null
      : ({
          setModel: vi.fn(async () => opts.setModelOk ?? true),
          setThinkingLevel: vi.fn(),
          getThinkingLevel: vi.fn(() => "high"),
          setSessionName: vi.fn(),
          clearQueue: vi.fn(() => ({ steering: ["s"], followUp: ["f"] })),
          getCommands: vi.fn(() => [{ name: "unbien" }, { name: "review code" }]),
          ...opts.pi,
        } as unknown as ExtensionAPI)
  const ctx: ActionCtx = { modelRegistry: registry(), getModel: () => gpt as never }
  return { pi, config: new PiAgentConfig({ getPi: () => pi, getActionCtx: () => ctx }) }
}

describe("PiAgentConfig", () => {
  it("reports the current model and thinking level", async () => {
    const { config } = make()
    expect(await config.getModelState()).toEqual({
      model: { id: "gpt-5", provider: "openai" },
      thinkingLevel: "high",
    })
  })

  it("lists models in the wire shape with the current one", async () => {
    const { config } = make()
    const { models, current } = await config.listModels()
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4", "gpt-5"])
    expect(models[0]).toEqual({
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      reasoning: true,
      context_window: 200_000,
      vision: true,
    })
    expect(current?.id).toBe("gpt-5")
  })

  it("sets a model, persisting the project default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unbien-agent-config-"))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const { pi, config } = make()
      const wire = await config.setModel("anthropic", "claude-sonnet-4")
      expect(wire.id).toBe("claude-sonnet-4")
      expect((pi as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel).toHaveBeenCalled()
      const saved = JSON.parse(readFileSync(join(dir, ".pi", "settings.json"), "utf8"))
      expect(saved).toMatchObject({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4" })
    } finally {
      process.chdir(cwd)
    }
  })

  it("refuses an unknown model and a model without auth", async () => {
    await expect(make().config.setModel("x", "y")).rejects.toThrow('model "x/y" not in registry')
    await expect(
      make({ setModelOk: false }).config.setModel("openai", "gpt-5"),
    ).rejects.toThrow("no auth configured for this model")
  })

  it("passes thinking level, name, and queue through to pi", async () => {
    const { pi, config } = make()
    await config.setThinkingLevel("low")
    await config.setSessionName("renamed")
    expect(await config.clearQueue()).toEqual({ steering: ["s"], followUp: ["f"] })
    const spy = pi as unknown as Record<string, ReturnType<typeof vi.fn>>
    expect(spy.setThinkingLevel).toHaveBeenCalledWith("low")
    expect(spy.setSessionName).toHaveBeenCalledWith("renamed")
  })

  it("knows the session's slash commands", () => {
    const { config } = make()
    expect(config.isKnownSlash("/unbien")).toBe(true)
    expect(config.isKnownSlash("/review")).toBe(true)
    expect(config.isKnownSlash("/nope")).toBe(false)
  })

  it("answers 'agent session not bound' before pi is wired, but still lists models", async () => {
    const { config } = make({ pi: null })
    await expect(config.setThinkingLevel("low")).rejects.toThrow("agent session not bound")
    await expect(config.clearQueue()).rejects.toThrow("agent session not bound")
    expect((await config.listModels()).models).toHaveLength(2)
  })
})
