import { envLog } from "./session/debug_log.js"
import { dispatchRpcCommand } from "./session/rpc_inbound.js"
import { createRpcHandlers, type RpcHandlersDeps } from "./session/rpc_handlers.js"
import type { EnvelopeMessage } from "./session/rpc_envelope.js"
import type { PlainPeerChannel } from "./transport/peer_channel.js"
import { takeForkLink } from "./commands/fork_link.js"
import {
  _expandTilde,
  _launchSession,
  launchDirAllowed,
} from "./launch.js"
import {
  effectiveAllowRemoteLaunch,
  effectiveAllowRemoteTerminate,
  loadLocalConfig,
} from "./session/local_config.js"
import { loadConfig } from "./config.js"
import type { ExtensionUiResponseWire } from "./protocol/types.js"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Plane routers (carved from index.ts, build slice 4 of the decomposition):
 * the {rpc} dispatch (byte-faithful pi rpc commands + extension_ui_response)
 * and the un-bien plane dispatch ({ub}: session_sync, session_launch,
 * session_fork/navigate, terminate, close_child_room).
 *
 * Deps are ACCESSOR CLOSURES over index.ts module state (mutables read live —
 * the routers must always see the CURRENT bridge/relay state), matching the
 * commands/deps.ts pattern.
 */
/** Minimal root-session view the fork link needs (structural — the full
 *  SessionState interface lives inline in index.ts). */
interface RootSessionView {
  sessionManager?: {
    getSessionDir(): string
    getSessionId(): string
  } | null
}

export interface PlaneRouterDeps {
  extensionUiBridge: () => import("./extension_ui_bridge.js").ExtensionUiBridge | null
  panelBridge: () => import("./panel_bridge.js").PanelBridge | null
  rpcDeps: RpcHandlersDeps
  subagentRooms: () => import("./subagent_rooms.js").SubagentRoomsController | null
  sessionStartedAt: () => number
  myRoomMeta: () => import("./commands/deps.js").RoomMeta | null
  rootState: () => RootSessionView
  safeNotify: (message: string, level: "info" | "warning" | "error") => void
  liveCtx: () => unknown
  pi: () => ExtensionAPI | null
}

/**
 * rpc-plane inbound dispatch (byte-faithful pi rpc commands +
 * extension_ui_response). Session_sync/session_launch ride the un plane —
 * dispatched by _routeUnBienPlaneFrom, NOT here.
 */
export function routeRpcCommand(
  deps: PlaneRouterDeps,
  sender: PlainPeerChannel,
  env: EnvelopeMessage,
): void {
  const frame = env.rpc
  if (!frame || typeof frame !== "object") return // no {evt} inbound today
  envLog(`rpc inbound: ${String((frame as Record<string, unknown>).type)}`)
  // extension_ui_response is a reply to an extension-issued dialog, not a command —
  // route it straight to the ui bridge (same target as the stock path).
  if ((frame as Record<string, unknown>).type === "extension_ui_response") {
    // SAFETY: the type-discriminator check directly above proves this frame is
    // an extension_ui_response envelope, which is the ExtensionUiResponseWire shape.
    deps.extensionUiBridge()?.respond(frame as unknown as ExtensionUiResponseWire)
    return
  }
  // session_sync (reconstruction) is un-bien's OWN protocol — dispatched on the
  // un plane by _routeUnBienPlaneFrom, NOT here. Only byte-faithful pi rpc
  // commands + extension_ui_response ride this rpc dispatch.
  const handlers = createRpcHandlers(deps.rpcDeps, sender)
  void dispatchRpcCommand(frame as Record<string, unknown>, handlers)
    .then((resp) => {
      // Envelope-native ONLY: no stock fallback. An unhandled rpc type is
      // ignored (forward-compat). un-bien's own commands (session_sync,
      // session_launch) ride the un plane via _routeUnBienPlaneFrom.
      if (resp) sender.sendEnvelope(resp)
    })
    .catch((err) => {
      console.error(`[un-bien] rpc inbound dispatch failed: ${String(err)}`)
    })
}

/**
 * un-bien plane inbound (`type:"ub"`): dispatch un-bien's OWN protocol frames by
 * their inner `.type`. app->ext today: `session_sync` (reconstruction request)
 * and `session_launch` (mesh remote-launch). These are NOT pi rpc — the
 * EXTENSION acts. The reconstruction REPLAY frames it emits stay byte-faithful
 * pi rpc frames on the rpc plane; only the request + `session_sync_end`
 * terminator are un-plane frames.
 */
export function routeUnBienPlane(
  deps: PlaneRouterDeps,
  sender: PlainPeerChannel,
  env: EnvelopeMessage,
): void {
  const frame = env.ub
  if (!frame || typeof frame !== "object") return
  const type = (frame as Record<string, unknown>).type
  envLog(`ub inbound: ${String(type)}`)

  if (type === "session_sync") {
    const f = frame as Record<string, unknown>
    // session_sync now carries ONLY un-bien's NON-rpc display state: panels +
    // pending extension_ui. The TRANSCRIPT is the app's OWN native get_entries
    // rpc (reduced by SessionState.applyEntries) — NOT replayed here. Design
    // 01M15FMQ: separate the rpc transcript (get_entries) from un-bien panel/ui
    // state, each an independent app-driven request issued on open + reconnect.
    for (const req of deps.extensionUiBridge()?.pendingRequests() ?? [])
      // ENVELOPE the replay: the app's handleRouted only dispatches
      // {rpc|evt|ub} frames — a bare extension_ui_request fell through both
      // branches and was silently dropped, so every session_sync replay was
      // a no-op and the terminator then retired the still-pending prompt as
      // "stale" (the "ask not displayed on phone" bug, 2026-09-25). The live
      // ask path sends the same shape enveloped ({rpc}); mirror it here.
      sender.sendEnvelope({ rpc: req })
    const panels = deps.panelBridge()?.pendingPanels() ?? []
    for (const panel of panels)
      sender.sendEnvelope({ evt: { channel: "panel", data: panel } })
    // Per-replay-ask detail (plan 01M1D112Z8JVW part 3): method + id make a
    // session_sync replay distinguishable from the live ask in the envelope
    // log — same triage story as _uiBroadcast's enriched line.
    for (const req of deps.extensionUiBridge()?.pendingRequests() ?? []) {
      const r = req as { method?: string; notify_type?: string; id?: string }
      envLog(
        `session_sync ui replay: method=${r.method ?? "?"}`
        + (r.notify_type ? ` notify_type=${r.notify_type}` : "")
        + ` id=${r.id ?? "?"}`,
      )
    }
    envLog(
      `session_sync(ub): panels=${panels.length} + ui=${(deps.extensionUiBridge()?.pendingRequests() ?? []).length} (transcript is the app's get_entries rpc)`,
    )
    // Terminator/ack on the ub plane; carries the session clock so the app can
    // detect a pi restart. `truncated`/`limit` are gone (a replay concern;
    // get_entries is unbounded / since-delta). `session_name` (pre-release
    // 2026-09-18): the NAME PULL — heals a missed session_info_changed push
    // (an iOS backgrounded socket misses live frames; the relay's stored meta
    // is stale until our next hello, so reconnects can't carry it either).
    // session_sync is issued on EVERY open + reconnect, so the name heals on
    // every natural cycle. Old apps ignore the field; old extensions omit it.
    //
    // SOURCE = the room's DISPLAY name (myRoomMeta.name), NOT deps.sessionName:
    // the latter is `_sessionName`, which `_cmdJoin` sets to the mesh session
    // id LOCAL_SESSION_NAME ("local"). Sending that here clobbered the tile
    // label with "local" on every reconnect (the flaky-name bug) — the
    // non-live pull disagreed with the live session_info push. myRoomMeta.name
    // is the same value pair_ok sends (deps.displayName) and tracks live
    // renames (session_info_changed updates it), so pull == push now.
    const displayName = deps.myRoomMeta?.name
    // Fork auto-nav: a fork-born session's FIRST sync echoes the app's
    // originating fork request id (design: fork switch). take = read+unlink,
    // so it fires once (the app navigates on first receipt; later reconnects
    // must not re-jump). Keyed by the session id, so it survives the extension
    // module re-eval that ctx.fork triggers.
    const forkSm = deps.rootState().sessionManager
    const forkedFromReq =
      forkSm && typeof forkSm.getSessionDir === "function"
        ? takeForkLink(forkSm.getSessionDir(), forkSm.getSessionId())
        : undefined
    sender.sendEnvelope({
      ub: {
        type: "session_sync_end",
        ...(typeof f.id === "string" ? { in_reply_to: f.id } : {}),
        session_started_at: deps.sessionStartedAt() ?? 0,
        ...(displayName ? { session_name: displayName } : {}),
        ...(forkedFromReq ? { forked_from_req: forkedFromReq } : {}),
      } as EnvelopeMessage["ub"],
    })
    return
  }

  if (type === "terminate") {
    // app->ext: kill THIS session. Root room only — a child room's terminate
    // is handled by the child-room router in subagent_rooms (never reaches
    // here; that room's conn dispatches its own ub frames). Gate on local
    // config; the app confirms + shows red before sending.
    if (!effectiveAllowRemoteTerminate(loadLocalConfig(process.cwd()))) {
      envLog("terminate(ub): remote terminate disabled on this machine")
      return
    }
    envLog(
      `terminate(ub): graceful host shutdown requested${typeof (frame as Record<string, unknown>).reason === "string" ? ` (${String((frame as Record<string, unknown>).reason)})` : ""}`,
    )
    deps.safeNotify("Terminated from the app", "warning")
    try {
      // ctx.shutdown() IS the /quit equivalent — pi's own source lists
      // "extension shutdown()" alongside Ctrl+D / /quit (interactive-mode.js
      // 3229: same graceful this.shutdown(): drain input, ui.stop() restores
      // cooked mode + cursor, extension disposal, resume hint, exit). It sits
      // DIRECTLY on the event ctx (ExtensionContext.shutdown — there is no
      // ctx.actions sub-object; the first two attempts failed exactly there).
      //
      // MID-TURN DEFERRAL: the interactive handler fires immediately only when
      // idle; otherwise it sets `shutdownRequested` and waits for
      // `agent_settled` — which never arrives when nothing is running. So
      // abort() FIRST: aborting a running turn forces the settle that
      // re-checks the flag; on an idle session abort is a no-op and the
      // idle fast-path fires directly.
      //
      // NO process.exit fallback, ever: a raw exit leaves the TTY in raw
      // mode (keypresses echo escape codes until `stty sane`). No live ctx =>
      // log loudly and stay up; the user quits on the machine.
      const ctx = deps.liveCtx() as {
        abort?: () => void
        shutdown?: () => void
      } | null
      if (ctx?.shutdown) {
        ctx.abort?.()
        ctx.shutdown()
      } else {
        envLog(
          "terminate(ub): no live ctx — refusing raw exit (would leave the terminal in raw mode); staying up",
        )
      }
    } catch (err) {
      envLog(
        `terminate(ub) error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }

  if (type === "close_child_room") {
    // app->ext(PARENT): permanently close one of MY child rooms (done-subagent
    // removal — the room lingers by design otherwise). Tombstone + dispose in
    // subagent_rooms; the relay fires room_ended when the last conn drops.
    if (!effectiveAllowRemoteTerminate(loadLocalConfig(process.cwd()))) {
      envLog("close_child_room(ub): remote terminate disabled on this machine")
      return
    }
    const roomId = (frame as Record<string, unknown>).room_id
    if (typeof roomId !== "string" || roomId.length === 0) return
    const closed = deps.subagentRooms()?.closeChildRoom(roomId) ?? false
    envLog(`close_child_room(ub): room=${roomId.slice(0, 8)} closed=${closed}`)
    return
  }

  if (type === "session_launch") {
    const f = frame as Record<string, unknown>
    const cwd = _expandTilde(
      typeof f.cwd === "string" && f.cwd.length > 0 ? f.cwd : process.cwd(),
    )
    if (!effectiveAllowRemoteLaunch(loadLocalConfig(cwd))) {
      envLog("session_launch(ub): remote launch disabled on this machine")
      return
    }
    // Directory allow-list (design 01M211VW9), read FRESH each request.
    if (!launchDirAllowed(cwd, loadConfig().launch?.dirs)) {
      envLog("session_launch(ub): cwd not in launch.dirs allow-list")
      sender.send({
        type: "error",
        code: "permission_denied",
        message: "Remote launch not permitted for this directory",
      })
      return
    }
    // Backend is a MACHINE config choice (pick-one via launch.backend), not
    // app-chosen; rpc is a fast-follow so only tmux|herdr resolve here.
    const backend = loadConfig().launch?.backend === "herdr" ? "herdr" : "tmux"
    const launchError = _launchSession(
      backend,
      cwd,
      typeof f.name === "string" ? f.name : undefined,
      // Launch correlation: pi is spawned with UNBIEN_LAUNCH_REQ=<id> and
      // echoes it in room_meta, so the launching app can match the announcing
      // room to THIS request and auto-open the chat (resume flow).
      typeof f.resume === "string" && f.resume.trim().length > 0
        ? f.resume.trim()
        : undefined,
      typeof f.id === "string" && f.id.trim().length > 0
        ? f.id.trim()
        : undefined,
    )
    if (launchError) envLog(`session_launch(ub) error: ${launchError}`)
    return
  }

  if (type === "session_fork" || type === "session_navigate") {
    // app->ext: fork a NEW session / branch IN PLACE from a conversation entry.
    // ctx.fork / ctx.navigateTree live ONLY on the command ctx, so we can't act
    // here (this is the peer-channel dispatch, not a command). Self-dispatch the
    // registered `/unbien fork|branch` command via sendUserMessage — pi runs it
    // with a real ExtensionCommandContext. No stashed ctx, no startup bootstrap:
    // the command ctx lives exactly as long as the op that needs it. Not gated
    // beyond being paired — these are no more privileged than a prompt on this
    // same room (which the app can already send).
    const f = frame as Record<string, unknown>
    const entryId = typeof f.entry_id === "string" ? f.entry_id : ""
    if (!entryId) {
      envLog(`${String(type)}(ub): missing entry_id — ignored`)
      return
    }
    if (type === "session_fork") {
      // Thread the request id (reqId) so the new session can echo it back as
      // forked_from_req on its first sync — the app's auto-nav correlation.
      // Order: `<entryId> <reqId> [pos]` (see _cmdFork's parse).
      const reqId = typeof f.id === "string" ? f.id : ""
      const posArg =
        f.position === "at" || f.position === "before" ? ` ${f.position}` : ""
      const reqArg = reqId ? ` ${reqId}` : ""
      envLog(`session_fork(ub): entry=${entryId.slice(0, 8)}${posArg}`)
      deps.pi()?.sendUserMessage(`/unbien fork ${entryId}${reqArg}${posArg}`, {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      })
    } else {
      envLog(`session_navigate(ub): entry=${entryId.slice(0, 8)}`)
      deps.pi()?.sendUserMessage(`/unbien branch ${entryId}`, {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      })
    }
    return
  }
}
