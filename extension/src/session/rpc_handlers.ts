/**
 * Rpc-inbound handler implementations.
 *
 * The `RpcCommandHandlers` object `_routeRpcCommandFrom` (index.ts — it owns
 * channel/sender routing) dispatches into: prompt/steer/followUp handoffs,
 * abort, setModel/setThinkingLevel/getAvailableModels, compact, newSession,
 * clearQueue, and the paged get_entries transcript read.
 *
 * Seam: the composition root (index.ts for pi, the durable bridge) owns the
 * state and SDK-handoff helpers these handlers touch (the session / control /
 * agent-config ports, the root session record, `_wakeAgent`,
 * `_abortCurrentTurn`, the image pipeline); they are threaded through
 * `RpcHandlersDeps`. This module MUST NOT import `../index.js` (circular
 * import).
 *
 * The model / thinking / name / queue verbs go through the AgentConfigPort
 * (pi: pi_binding/agent_config.ts; durable: unbien-durable), so every binding
 * answers them in the same wire shapes. new_session self-dispatches the
 * `/unbien new` command on pi (ctx.newSession is command-ctx-only). NOT here:
 * `_wakeAgent` /
 * `_abortCurrentTurn` (also used by the image pipeline + the stock cancel
 * router in index.ts — passed in as dep function refs) and `_resolveToolCwd`
 * (rpc-envelope enrichArgs path only — stays in index.ts entirely).
 */
import type {
  AgentConfigPort,
  AgentSessionPort,
  SessionControlPort,
  SubmitContent,
  SubmitDelivery,
  SubmitResult,
} from "../core/port.js"
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

/** Mirror of index.ts's `_wakeAgent` result shape. */
type WakeAgentResult = SubmitResult

/**
 * The seam between index.ts (composition root) and the rpc-inbound handlers.
 *
 * Same shape as `CommandDeps` / `RelayLifecycleDeps`: accessor closures /
 * function references only, members added exactly as the moved code requires
 * them.
 *
 * Harness split: `session` (AgentSessionPort), `sessionControl`, and `agent`
 * (AgentConfigPort) carry every verb, so any binding serves the whole rpc
 * command dispatch.
 */
export interface RpcHandlersDeps {
  // ── Read-only state ──────────────────────────────────────────────────────

  /** The ROOT session's model / thinking / name / queue verbs. Null when
   *  unbound: those commands answer "agent session not bound". */
  readonly agent: AgentConfigPort | null
  /** The ROOT session, port-typed — submit/streaming/getEntries/compact. */
  readonly session: AgentSessionPort | null
  /** Branching/replacement ops (new/fork/navigate/shutdown). */
  readonly sessionControl: SessionControlPort | null
  /** The ROOT session's state record (turn seeding). */
  rootState(): {
    turnId: string | null
  }
  /** The image-pipeline seam index.ts builds (prompt with images). */
  readonly imageDeps: ImagePipelineDeps

  // ── Helpers (direct function references from index.ts) ──────────────────

  /** SDK handoff primitive (prompt/steer/followUp delivery). */
  wakeAgent(
    content: SubmitContent,
    label: string,
    steeringBehavior?: SubmitDelivery,
  ): WakeAgentResult
  /** Abort the current turn (freshest ctx first). */
  abortCurrentTurn(): boolean
}

function requireAgent(deps: RpcHandlersDeps): AgentConfigPort {
  if (!deps.agent) throw new Error("agent session not bound")
  return deps.agent
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
      // Authoritative busy signal from the session port (the base session
      // ctx's isIdle() under it), correct across subagent lifecycles
      // (turnId/working stick busy after a subagent run).
      const streaming = deps.session?.streaming === true
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
    isKnownSlash: (token) => {
      // No registry on this binding: unknown tokens pass to the agent.
      const known = deps.agent?.isKnownSlash?.(token)
      return known ?? true
    },
    setModel: async (provider, modelId) =>
      requireAgent(deps).setModel(provider, modelId),
    setThinkingLevel: async (level) => {
      await requireAgent(deps).setThinkingLevel(level as ThinkingLevel)
    },
    setSessionName: async (name?: string) => {
      // Native pi set_session_name (remote rename, pre-release 2026-09-18):
      // the reply rides the standard response plane; the binding confirms
      // the new name to the app live (pi: session_info_changed, forwarded in
      // index.ts).
      const agent = requireAgent(deps)
      if (typeof name !== "string" || name.length === 0)
        throw new Error("set_session_name: name required")
      await agent.setSessionName(name)
    },
    getState: async () => {
      // Native pi get_state snapshot. THE field the app reconciles against is
      // isStreaming (busy) — the session port's authoritative streaming flag,
      // the same signal the prompt handler reads. The rest mirror the app's
      // SessionSnapshot so applyState hydrates model/thinking/session too;
      // the model fields come from the binding's agent config and are
      // omitted when absent.
      if (!deps.session) throw new Error("agent session not bound")
      const streaming = deps.session.streaming
      const { model, thinkingLevel } = deps.agent
        ? await deps.agent.getModelState()
        : {}
      const sessionId = deps.session.sessionId
      return {
        isStreaming: streaming,
        ...(model ? { model: { id: model.id, provider: model.provider } } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(sessionId ? { sessionId } : {}),
        messageCount: deps.session.getEntries().entries.length,
      }
    },
    getAvailableModels: async () => requireAgent(deps).listModels(),
    compact: async (customInstructions) => {
      if (!deps.session)
        throw new Error("compact unavailable (no active session ctx)")
      deps.session.compact(
        customInstructions ? { customInstructions } : undefined,
      )
      return {}
    },
    newSession: async () => {
      // Branching ops live on the session-control port. On pi they exist ONLY
      // on the command ctx (the rpc dispatch ctx is the base ExtensionContext,
      // which lacks them), so the pi control impl self-dispatches the
      // registered `/unbien new` command via sendUserMessage; pi runs it with
      // a real command ctx. The session clock restamp is no longer needed
      // here — the resulting session_start → relay start restamps
      // _sessionStartedAt naturally. The app drops the old conversation on
      // the new hello (changed sessionId).
      if (!deps.sessionControl) throw new Error("agent session not bound")
      await deps.sessionControl.newSession()
      return { dispatched: true }
    },
    clearQueue: async () => requireAgent(deps).clearQueue(),
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
      const session = deps.session
      // Unbound → ERROR (pi always has a session here; a silent empty page on
      // the fork side reads as "no history" — make the failure visible).
      if (!session) throw new Error("get_entries unavailable (no session bound)")
      const { entries: all, leafId } = session.getEntries()
      // pi-faithful `since` semantics (rpc-mode.js): unknown id → error, not a
      // silent restart from the beginning.
      if (
        typeof since === "string" &&
        all.findIndex((e) => e.id === since) === -1
      )
        throw new Error(`Entry not found: ${since}`)
      return pageEntries(all, since, leafId)
    },
  }
}
