/**
 * Pi binding's AgentConfigPort: the model / thinking-level / session-name /
 * queue verbs over the ROOT session's ExtensionAPI and the always-fresh
 * session_start ctx's model registry.
 *
 * Constructed with accessor closures (like PiSessionPort), so every call
 * reads the current session and a session replacement never strands it.
 */
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { AgentConfigPort } from "../core/port.js"
import { ensureModelRegistry } from "../actions/registry.js"
import {
  wireFromModel,
  type ActionCtx,
  type ActionPi,
} from "../actions/handlers.js"
import type { ThinkingLevel, WireModel } from "../protocol/types.js"

// The concrete AgentSession's queue control; the public ExtensionAPI type
// does not surface it.
interface PiQueueControl {
  clearQueue(): { steering: string[]; followUp: string[] }
}

export interface PiAgentConfigOptions {
  /** The root session's ExtensionAPI (null before the factory wired it). */
  getPi(): ExtensionAPI | null
  /** The freshest session_start ctx (model registry, current model). */
  getActionCtx(): ActionCtx | null
}

/**
 * Persist a model change to the PROJECT settings (`<cwd>/.pi/settings.json`) so
 * a model picked from the app survives a Pi/daemon restart. `pi.setModel` only
 * sets the LIVE model — on the next restart a fresh session reads the saved
 * default and reverts (the reported bug). We write the PROJECT scope, NOT
 * global, deliberately: the SDK merges global←project with PROJECT winning
 * (`SettingsManager`), so a folder that already has a project default (every
 * created daemon does) would shadow a global write like the TUI's. Project
 * scope is also correct for a fleet — each daemon keeps its own model rather
 * than leaking one default globally.
 *
 * Read-merge-write + best-effort: preserves other keys and never throws (a
 * settings write must not fail the live model change, which already applied).
 */
function persistModelDefault(provider: string, modelId: string): void {
  try {
    const path = join(process.cwd(), ".pi", "settings.json")
    let obj: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (parsed && typeof parsed === "object")
        obj = parsed as Record<string, unknown>
    } catch {
      /* no existing/parseable file → start fresh */
    }
    obj["defaultProvider"] = provider
    obj["defaultModel"] = modelId
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(obj, null, 2))
  } catch {
    /* best-effort — model change already applied live */
  }
}

export class PiAgentConfig implements AgentConfigPort {
  constructor(private readonly opts: PiAgentConfigOptions) {}

  private requirePi(): ExtensionAPI {
    const pi = this.opts.getPi()
    if (!pi) throw new Error("agent session not bound")
    return pi
  }

  async getModelState(): Promise<{
    model?: { id: string; provider: string }
    thinkingLevel?: string
  }> {
    const model = this.opts.getActionCtx()?.getModel?.()
    let thinkingLevel: string | undefined
    try {
      thinkingLevel = this.opts.getPi()?.getThinkingLevel()
    } catch {
      /* older SDK / no level — omit */
    }
    return {
      ...(model ? { model: { id: model.id, provider: model.provider } } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    }
  }

  async listModels(): Promise<{ models: WireModel[]; current?: WireModel }> {
    const actionCtx = this.opts.getActionCtx()
    const reg = actionCtx?.modelRegistry ?? ensureModelRegistry(actionCtx)
    reg.refresh()
    const models = reg.getAvailable().map(wireFromModel)
    const current = actionCtx?.getModel?.()
    return { models, current: current ? wireFromModel(current) : undefined }
  }

  async setModel(provider: string, modelId: string): Promise<WireModel> {
    const pi = this.requirePi()
    const actionCtx = this.opts.getActionCtx()
    const reg = actionCtx?.modelRegistry ?? ensureModelRegistry(actionCtx)
    reg.refresh()
    const model = reg.find(provider, modelId)
    if (!model) throw new Error(`model "${provider}/${modelId}" not in registry`)
    // Route via the minimal ActionPi view (matches handleModelSet): the
    // registry's `find` returns the minimal SdkModelLike, structurally fine
    // for setModel at runtime.
    // SAFETY: pi is the concrete AgentSession; its setModel accepts the
    // minimal SdkModelLike the registry's find() returns, matching
    // handleModelSet's ActionPi view.
    const ok = await (pi as unknown as ActionPi).setModel(model)
    if (!ok) throw new Error("no auth configured for this model")
    persistModelDefault(model.provider, model.id) // survive restart, mirrors stock model_set
    return wireFromModel(model)
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.requirePi().setThinkingLevel(level)
  }

  async setSessionName(name: string): Promise<void> {
    // pi fires session_info_changed, which index.ts forwards to the app.
    this.requirePi().setSessionName(name)
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    // SAFETY: pi is the concrete AgentSession, which implements clearQueue();
    // the public ExtensionAPI type omits it.
    return (this.requirePi() as unknown as PiQueueControl).clearQueue()
  }

  isKnownSlash(token: string): boolean {
    // The session's slash registry (extension commands + prompt templates +
    // skills) via pi.getCommands(). Registry failure => true (assume known;
    // unknown tokens then keep their status-quo pass-through to pi).
    try {
      const commands =
        (this.opts.getPi() as { getCommands?: () => Array<{ name: string }> } | null)
          ?.getCommands?.() ?? []
      const bare = token.slice(1)
      return commands.some(
        (c) => c.name === bare || c.name.startsWith(bare + " "),
      )
    } catch {
      return true
    }
  }
}
