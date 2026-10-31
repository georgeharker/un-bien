/**
 * Ollama Cloud provider for the durable host (skeleton).
 *
 * WHY THIS EXISTS: pi-durable has no pi-extension interface, so the
 * `pi-ollama-cloud` extension (which registers the provider in pi sessions
 * via pi.registerProvider) can't run here. pi-ai ships no ollama provider.
 * The host owns its models registry (createModels + setProvider in host.ts),
 * so the provider is composed host-side from the same data the extension
 * uses: OpenAI-compatible completions transport against https://ollama.com/v1,
 * OLLAMA_API_KEY auth, and the model catalog (compat flags copied from
 * pi-ollama-cloud's models.generated.ts — they are pi-ai Model compat data,
 * verified against the glm-5.3 entry).
 *
 * SKELETON SCOPE (TODOs):
 *  - Static catalog: glm-5.3 + glm-5.3-flash only. Sync more entries from
 *    pi-ollama-cloud's models.generated.ts as needed.
 *  - No live catalog refresh (fetchModels / refreshOllamaCatalog overlay):
 *    wire the GET https://ollama.com/v1/models + /api/show flow later if the
 *    static list goes stale.
 */
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"

/** Compat flags shared by the glm-5.x family (pi-ollama-cloud models.generated.ts). */
const GLM_COMPAT = {
  maxTokensField: "max_tokens",
  requiresAssistantAfterToolResult: false,
  requiresReasoningContentOnAssistantMessages: false,
  requiresThinkingAsText: false,
  requiresToolResultName: false,
  sendSessionAffinityHeaders: false,
  supportsDeveloperRole: false,
  supportsLongCacheRetention: false,
  supportsReasoningEffort: true,
  supportsStore: false,
  supportsStrictMode: false,
  supportsUsageInStreaming: true,
  thinkingFormat: "openai",
  zaiToolStream: false,
} as const

// TODO: sync further entries from pi-ollama-cloud models.generated.ts
const OLLAMA_CLOUD_MODELS: readonly Model<"openai-completions">[] = [
  {
    id: "glm-5.3",
    name: "glm-5.3",
    api: "openai-completions",
    provider: "ollama-cloud",
    baseUrl: "https://ollama.com/v1",
    compat: { ...GLM_COMPAT },
    contextWindow: 1048576,
    cost: { cacheRead: 0.26, cacheWrite: 0, input: 1.4, output: 4.4 },
    input: ["text"],
    maxTokens: 524288,
    reasoning: true,
    thinkingLevelMap: {
      high: "high",
      low: "low",
      medium: null,
      minimal: null,
      off: "none",
      xhigh: "max",
    },
  },
  {
    id: "glm-5.3-flash",
    name: "glm-5.3-flash",
    api: "openai-completions",
    provider: "ollama-cloud",
    baseUrl: "https://ollama.com/v1",
    compat: { ...GLM_COMPAT },
    // TODO: verify flash's window/cost/thinking map against models.generated.ts
    contextWindow: 1048576,
    cost: { cacheRead: 0.03, cacheWrite: 0, input: 0.15, output: 0.5 },
    input: ["text"],
    maxTokens: 524288,
    reasoning: true,
    thinkingLevelMap: {
      high: "high",
      low: "low",
      medium: null,
      minimal: null,
      off: "none",
      xhigh: "max",
    },
  },
]

/** The Ollama Cloud provider (register via models.setProvider in host.ts). */
export function ollamaCloudProvider() {
  return createProvider({
    id: "ollama-cloud",
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    auth: { apiKey: envApiKeyAuth("Ollama Cloud API key", ["OLLAMA_API_KEY"]) },
    models: OLLAMA_CLOUD_MODELS,
    // TODO: fetchModels overlay (refreshOllamaCatalog) for the live catalog.
    api: openAICompletionsApi(),
  })
}