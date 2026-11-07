/**
 * The default thinking level for durable conversations.
 *
 * pi-durable starts every conversation's agent at thinking level "off", so a
 * reasoning model answers without reasoning blocks and its working
 * narration arrives as plain text. pi starts sessions at the user's
 * `defaultThinkingLevel` ("medium" unless configured). The bridge applies
 * the same default to each conversation it attaches whose level is still
 * "off", clamped to what the conversation's model supports (glm-5.3 has no
 * "medium", so it gets "high"). A level other than "off" is left alone.
 */
import type { Context } from "@earendil-works/chord"
import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import { clampThinkingLevel, type Models } from "@earendil-works/pi-ai/models"
import type { Conversation } from "@earendil-works/pi-durable"

/** pi's default when settings name none. */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium"

const LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/** Parse a thinking level from a flag or env value; undefined when invalid. */
export function parseThinkingLevel(
  value: string | undefined,
): ModelThinkingLevel | undefined {
  return LEVELS.find((level) => level === value)
}

/**
 * Raise `conversation` from "off" to `level` (clamped to its model).
 * Returns the level set, or undefined when nothing changed.
 */
export async function ensureThinkingLevel(
  conversation: Conversation,
  models: Models,
  level: ModelThinkingLevel,
  context: Context,
): Promise<ModelThinkingLevel | undefined> {
  if (level === "off") return undefined
  const agent = await conversation.agent(context)
  if (agent.thinkingLevel !== "off") return undefined
  const model =
    agent.model !== undefined
      ? models.getModel(agent.model.provider, agent.model.modelId)
      : undefined
  const target = model !== undefined ? clampThinkingLevel(model, level) : level
  if (target === "off") return undefined
  await conversation.configure({ thinkingLevel: target }, context)
  return target
}
