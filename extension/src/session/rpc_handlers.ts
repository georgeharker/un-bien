/**
 * Rpc-inbound handler implementations.
 *
 * The `RpcCommandHandlers` object `_routeRpcCommandFrom` (index.ts — it owns
 * channel/sender routing) dispatches into: prompt/steer/followUp handoffs,
 * abort, setModel/setThinkingLevel/getAvailableModels, compact, newSession,
 * clearQueue, and the paged get_entries transcript read.
 *
 * Seam: index.ts (composition root) owns the mutable module state and the
 * SDK-handoff helpers these handlers touch (`_pi`, the root session record,
 * `_lastEventCtx`/`_lastCtx`, `_wakeAgent`, `_abortCurrentTurn`, the image
 * pipeline); they are threaded through `RpcHandlersDeps`. This module MUST
 * NOT import `../index.js` (circular import).
 *
 * Moved with the handlers (only they use them): `_persistModelDefault`
 * (project-settings model write behind set_model) and `_resetSessionForNew`
 * (session clock restamp behind new_session). NOT here: `_wakeAgent` /
 * `_abortCurrentTurn` (also used by the image pipeline + the stock cancel
 * router in index.ts — passed in as dep function refs) and `_resolveToolCwd`
 * (rpc-envelope enrichArgs path only — stays in index.ts entirely).
 */
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { ensureModelRegistry } from "../actions/registry.js"
import {
  wireFromModel,
  type ActionCtx,
  type ActionPi,
} from "../actions/handlers.js"
import type { ClientMessage, ThinkingLevel } from "../protocol/types.js"
import type { PlainPeerChannel } from "../transport/peer_channel.js"
import { pageEntries, type RpcCommandHandlers } from "./rpc_inbound.js"
import {
  _deliverImageUserMessage,
  type ImagePipelineDeps,
} from "./received_images.js"

/**
 * Structural mirror of index.ts's local `ClientUserMessage` (the
 * `user_message` variant of the app protocol). Kept local so this module
 * never imports the composition root.
 */
type ClientUserMessage = Extract<ClientMessage, { type: "user_message" }>

/** Mirror of index.ts's sendUserMessage options (steering behavior verb). */
type SendUserMessageOptions = NonNullable<
  Parameters<ExtensionAPI["sendUserMessage"]>[1]
>

/** Mirror of index.ts's `_wakeAgent` result shape. */
type WakeAgentResult = { ok: true } | { ok: false; detail: string }

// Minimal structural views of pi SDK internals the handlers reach for but the
// public ExtensionAPI type does not surface. Each names exactly the member(s)
// known to exist on the concrete AgentSession at runtime. (Mirrors of
// index.ts's locals.)
interface PiStreamingInternals {
  isStreaming?: boolean
}
interface PiQueueControl {
  clearQueue(): { steering: string[]; followUp: string[] }
}

/** The root session's sessionManager as the get_entries handler needs it. */
interface RpcSessionManager {
  getSessionId(): string
  getEntries(): SessionEntry[]
  getLeafId(): string | null
}

/**
 * The seam between index.ts (composition root) and the rpc-inbound handlers.
 *
 * Same shape as `CommandDeps` / `RelayLifecycleDeps`: accessor closures /
 * function references only, members added exactly as the moved code requires
 * them.
 */
export interface RpcHandlersDeps {
  // ── Read-only state ──────────────────────────────────────────────────────

  /** The ROOT session's ExtensionAPI (never a subagent child's). */
  readonly pi: ExtensionAPI | null
  /** The ROOT session's state record (turn seeding + get_entries reads). */
  rootState(): {
    turnId: string | null
    sessionManager?: RpcSessionManager | null
  }
  /** Freshest session_start ctx (model registry / compact / newSession). */
  readonly lastEventCtx: Pick<
    ExtensionContext,
    "compact" | "abort" | "ui"
  > | null
  /** Most recent command ctx (fallback when no fresh event ctx exists). */
  readonly lastCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null
  /** The image-pipeline seam index.ts builds (prompt with images). */
  readonly imageDeps: ImagePipelineDeps

  // ── Helpers (direct function references from index.ts) ──────────────────

  /** SDK handoff primitive (prompt/steer/followUp delivery). */
  wakeAgent(
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
    label: string,
    steeringBehavior?: SendUserMessageOptions["deliverAs"],
  ): WakeAgentResult
  /** Abort the current turn (freshest ctx first). */
  abortCurrentTurn(): boolean
  /** Restamp the session clock (new_session handler — `_resetSessionForNew`). */
  set sessionStartedAt(value: number | null)
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
function _persistModelDefault(provider: string, modelId: string): void {
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

/**
 * Resets the Pi-side session view after a SUCCESSFUL `session_new`. The app's
 * New Session clears its local store on `action_ok`, but that alone isn't
 * durable: `_messageBuffer` (which answers `session_sync`) is append-only and
 * `_sessionStartedAt` is stamped once, so a later reconnect/restart would
 * replay the OLD history. We clear the buffer and restamp the clock so the
 * envelope `session_sync` reconstructs from a clean slate. The app drops the
 * stale conversation off the new-session `hello` (changed `sessionId`).
 */
function _resetSessionForNew(deps: RpcHandlersDeps): void {
  // Restamp the session clock so the app detects the pi restart (session_sync_end
  // carries it). The transcript resets naturally: the app re-fetches via
  // get_entries against the fresh session and drops the old one on the new hello.
  deps.sessionStartedAt = Date.now()
}

/**
 * Build the `RpcCommandHandlers` implementation for one inbound rpc sender.
 * `_routeRpcCommandFrom` (index.ts) owns channel/sender routing and calls
 * this per dispatch; the handlers answer through the dispatcher's response
 * envelope, so `sender` is only needed for the image-bearing prompt path
 * (per-sender image echo + delivery-failure error frames).
 */
export function createRpcHandlers(
  deps: RpcHandlersDeps,
  sender: PlainPeerChannel,
): RpcCommandHandlers {
  return {
    prompt: async (message, opts) => {
      // Full parity with the retired stock user_message handler:
      //  - ALWAYS hand off with deliverAs:"steer" — the SDK ignores it while idle
      //    but REQUIRES it when a turn is running or still settling right after
      //    agent return; without it the message is rejected as busy.
      //  - `shouldSteer` (echo label + steer tracking) = requested OR inferred
      //    busy-room send.
      //  - seed `_rootState().turnId` for a fresh (non-steer) turn so the agent's
      //    reply chunks/done have a target; restore it if the handoff fails.
      // The APP owns the steer-vs-followUp semantic switch (design 01M14T6J5W):
      // pass its chosen streamingBehavior straight through to pi. The extension does
      // NOT force steer over a followUp anymore. `shouldSteer` below is now only
      // BOOKKEEPING (turn-seeding + image-preview defer), not the delivery verb.
      const requestedSteer = opts.streamingBehavior === "steer"
      // Authoritative busy signal from pi's OWN state (AgentSession.isStreaming),
      // correct across subagent lifecycles (turnId/working stick busy after a
      // subagent run).
      const streaming =
        (deps.pi as PiStreamingInternals | null)?.isStreaming === true
      const shouldSteer = requestedSteer || streaming
      const msg: ClientUserMessage = {
        type: "user_message",
        id: opts.id ?? deps.rootState().turnId ?? String(Date.now()),
        text: message,
        images: opts.images as ClientUserMessage["images"],
      }
      // Image path mirrors the stock handler (SDK handoff WITH images + echo).
      if (msg.images && msg.images.length > 0) {
        await _deliverImageUserMessage(deps.imageDeps, sender, msg, shouldSteer)
        return
      }
      const previousTurnId = deps.rootState().turnId
      const seededTurnId = !shouldSteer || deps.rootState().turnId === null
      if (seededTurnId) deps.rootState().turnId = msg.id
      // PASS-THROUGH the app's verb (design 01M14T6J5W). pi's prompt(): idle
      // ignores streamingBehavior (fresh run); streaming+"steer" -> _queueSteer;
      // streaming+"followUp" -> _queueFollowUp; streaming+none -> throws. The
      // `?? (streaming ? "steer" : undefined)` is a MECHANICAL safety net (not
      // semantic inference) so a racing/old client's no-behavior busy send
      // defensively steers instead of throwing (keeps plan/43).
      const wake = deps.wakeAgent(
        message,
        "app rpc prompt",
        opts.streamingBehavior === "followUp"
          ? "followUp"
          : opts.streamingBehavior === "steer" || streaming
            ? "steer"
            : undefined,
      )
      if (!wake.ok) {
        if (seededTurnId) deps.rootState().turnId = previousTurnId
        throw new Error(wake.detail)
      }
    },
    steer: async (message) => {
      const wake = deps.wakeAgent(message, "app rpc steer", "steer")
      if (!wake.ok) throw new Error(wake.detail)
    },
    followUp: async (message) => {
      const wake = deps.wakeAgent(message, "app rpc follow_up", "followUp")
      if (!wake.ok) throw new Error(wake.detail)
    },
    abort: async () => {
      if (!deps.abortCurrentTurn()) throw new Error("no active turn to abort")
    },
    setModel: async (provider, modelId) => {
      if (!deps.pi) throw new Error("agent session not bound")
      const actionCtx = (deps.lastEventCtx ?? deps.lastCtx) as ActionCtx | null
      const reg = actionCtx?.modelRegistry ?? ensureModelRegistry(actionCtx)
      reg.refresh()
      const model = reg.find(provider, modelId)
      if (!model)
        throw new Error(`model "${provider}/${modelId}" not in registry`)
      // Route via the minimal ActionPi view (matches handleModelSet): the
      // registry's `find` returns the minimal SdkModelLike, structurally fine
      // for setModel at runtime.
      // SAFETY: deps.pi (checked non-null above) is the concrete AgentSession;
      // its setModel accepts the minimal SdkModelLike the registry's find()
      // returns, matching handleModelSet's ActionPi view.
      const ok = await (deps.pi as unknown as ActionPi).setModel(model)
      if (!ok) throw new Error("no auth configured for this model")
      _persistModelDefault(model.provider, model.id) // survive restart, mirrors stock model_set
      return wireFromModel(model)
    },
    setThinkingLevel: async (level) => {
      if (!deps.pi) throw new Error("agent session not bound")
      deps.pi.setThinkingLevel(level as ThinkingLevel)
    },
    getAvailableModels: async () => {
      const actionCtx = (deps.lastEventCtx ?? deps.lastCtx) as ActionCtx | null
      const reg = actionCtx?.modelRegistry ?? ensureModelRegistry(actionCtx)
      reg.refresh()
      const models = reg.getAvailable().map(wireFromModel)
      const current = actionCtx?.getModel?.()
      return { models, current: current ? wireFromModel(current) : undefined }
    },
    compact: async (customInstructions) => {
      const actionCtx = (deps.lastEventCtx ?? deps.lastCtx) as ActionCtx | null
      if (!actionCtx?.compact)
        throw new Error("compact unavailable (no active session ctx)")
      actionCtx.compact(customInstructions ? { customInstructions } : undefined)
      return {}
    },
    newSession: async () => {
      const actionCtx = (deps.lastEventCtx ?? deps.lastCtx) as ActionCtx | null
      if (!actionCtx?.newSession) {
        throw new Error("new_session unavailable (no command ctx)")
      }
      await actionCtx.newSession({ withSession: async () => {} })
      // Restamp the session clock (parity with the retired stock session_new):
      // session_sync_end carries it so the app can detect the pi restart.
      _resetSessionForNew(deps)
      return { cancelled: false }
    },
    clearQueue: async () => {
      if (!deps.pi) throw new Error("agent session not bound")
      // SAFETY: deps.pi (checked non-null above) is the concrete AgentSession,
      // which implements clearQueue(); the public ExtensionAPI type omits it.
      return (deps.pi as unknown as PiQueueControl).clearQueue()
    },
    getEntries: async (since?: string) => {
      // Native pi get_entries, PAGED (design: get_entries backfill paging): the
      // app reconstructs the transcript itself from the raw entry log (each
      // message entry carries an AgentMessage), one budget-bounded page per
      // reply so a long session's multi-MB log never blows a transport cap (the
      // single-frame reply exceeded URLSessionWebSocketTask's 1 MiB default and
      // was silently dropped). Frame shapes stay PI-FAITHFUL — no extra fields;
      // the app loops `since: leafId` until an empty page. The extension does
      // NOT replay these — see the app's SessionState.applyEntries (design
      // 01M15FMQ).
      const sm = deps.rootState().sessionManager
      // Unbound → ERROR (pi always has a session here; a silent empty page on
      // the fork side reads as "no history" — make the failure visible).
      if (!sm) throw new Error("get_entries unavailable (no session bound)")
      const all = sm.getEntries()
      // pi-faithful `since` semantics (rpc-mode.js): unknown id → error, not a
      // silent restart from the beginning.
      if (
        typeof since === "string" &&
        all.findIndex((e) => e.id === since) === -1
      )
        throw new Error(`Entry not found: ${since}`)
      return pageEntries(all, since, sm.getLeafId())
    },
  }
}
