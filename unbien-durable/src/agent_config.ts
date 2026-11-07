/**
 * Durable binding's AgentConfigPort: the app's model / thinking-level /
 * session-name / queue verbs over a durable Conversation.
 *
 *   getModelState / listModels / setModel / setThinkingLevel
 *     → `conversation.agent()` / `configure()` against the harness's model
 *       registry. setModel accepts only models with credentials
 *       (`models.getAvailable()`), the same answer pi's registry gives, and
 *       like pi clamps the thinking level to what the new model supports;
 *       setThinkingLevel clamps to the current model. The agent state is
 *       durable, so both survive restarts.
 *   setSessionName → the bridge's rename (room name, live confirmation,
 *     persisted record).
 *   clearQueue → aborts each queued steer / follow-up submission in
 *     `pi.inbox`; resolves to the text of those withdrawn.
 *
 * There is no command registry, so `isKnownSlash` is absent: slash tokens
 * pass to the agent as text.
 */
import type { Context } from "@earendil-works/chord"
import { clampThinkingLevel, type Models } from "@earendil-works/pi-ai/models"
import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import type {
  Conversation,
  Harness,
  InboxState,
} from "@earendil-works/pi-durable"
import type {
  AgentConfigPort,
  ThinkingLevel,
  WireModel,
} from "@geohar/un-bien/core"
import { wireFromModel } from "@geohar/un-bien/durable"

export interface DurableAgentConfigOptions {
  /** The conversation served now (the bridge retargets it). */
  conversation(): Conversation
  harness: Harness
  models: Models
  context: Context
  /** The conversation's queue, as of the latest view value. */
  inbox(): InboxState | undefined
  /** Rename the served session (the bridge's room + record). */
  rename(name: string): Promise<void>
}

export class DurableAgentConfig implements AgentConfigPort {
  constructor(private readonly opts: DurableAgentConfigOptions) {}

  async getModelState(): Promise<{
    model?: { id: string; provider: string }
    thinkingLevel?: string
  }> {
    const agent = await this.opts.conversation().agent(this.opts.context)
    return {
      ...(agent.model
        ? { model: { id: agent.model.modelId, provider: agent.model.provider } }
        : {}),
      thinkingLevel: agent.thinkingLevel,
    }
  }

  async listModels(): Promise<{ models: WireModel[]; current?: WireModel }> {
    const [available, agent] = await Promise.all([
      this.opts.models.getAvailable(),
      this.opts.conversation().agent(this.opts.context),
    ])
    const current = agent.model
      ? this.opts.models.getModel(agent.model.provider, agent.model.modelId)
      : undefined
    return {
      models: available.map(wireFromModel),
      current: current ? wireFromModel(current) : undefined,
    }
  }

  async setModel(provider: string, modelId: string): Promise<WireModel> {
    const model = this.opts.models.getModel(provider, modelId)
    if (!model) throw new Error(`model "${provider}/${modelId}" not in registry`)
    const available = await this.opts.models.getAvailable(provider)
    if (!available.some((m) => m.id === modelId))
      throw new Error("no auth configured for this model")
    const conversation = this.opts.conversation()
    const agent = await conversation.agent(this.opts.context)
    const thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
    await conversation.configure(
      {
        model: { provider, modelId },
        ...(thinkingLevel !== agent.thinkingLevel ? { thinkingLevel } : {}),
      },
      this.opts.context,
    )
    return wireFromModel(model)
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const conversation = this.opts.conversation()
    const agent = await conversation.agent(this.opts.context)
    const model = agent.model
      ? this.opts.models.getModel(agent.model.provider, agent.model.modelId)
      : undefined
    const target: ModelThinkingLevel = model
      ? clampThinkingLevel(model, level)
      : level
    await conversation.configure({ thinkingLevel: target }, this.opts.context)
  }

  async setSessionName(name: string): Promise<void> {
    await this.opts.rename(name)
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const cleared = { steering: [] as string[], followUp: [] as string[] }
    for (const item of this.opts.inbox()?.items ?? []) {
      if (item.mode === "write") continue
      const submission = await this.opts.harness.submission(
        item.id,
        this.opts.context,
      )
      if (!submission) continue
      // "already_placed": the run took it first; "settled": already done.
      if ((await submission.abort(this.opts.context)) !== "aborted") continue
      const text = inputText(item.content)
      if (item.mode === "steer") cleared.steering.push(text)
      else cleared.followUp.push(text)
    }
    return cleared
  }
}

/** The text of a queued input: a string, or its text blocks joined. */
function inputText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: unknown })?.type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
}
