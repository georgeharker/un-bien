/**
 * `/unbien fork | branch | new` — session-replacement / tree ops that exist
 * ONLY on the command ctx (`ctx.fork` / `ctx.navigateTree` / `ctx.newSession`).
 *
 * These commands are INTERNAL plumbing, not a day-to-day surface: the app sends
 * the structured `session_fork` / `session_navigate` / `new_session` frame over
 * the wire, and the extension self-dispatches the matching slash command via
 * `pi.sendUserMessage("/unbien …")` to land in a command ctx — the only context
 * that carries these methods (an event/rpc ctx is the base `ExtensionContext`,
 * which lacks them). See the ub-plane router in index.ts (`session_fork` /
 * `session_navigate`) and the `new_session` rpc handler.
 *
 * The self-dispatched `/unbien …` shows as a user message in the transcript by
 * design (accepted trade-off — there is no non-visible command-dispatch API).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { CommandDeps } from "./deps.js"
import { writeForkLink } from "./fork_link.js"

/**
 * `/unbien fork <entryId> [reqId] [at|before]` — `ctx.fork` creates a NEW
 * session file. pi fires session_shutdown → session_start{reason:"fork"}, and
 * the new session's room announces a NEW app tile.
 *
 * `reqId` (optional) is the app's originating session_fork request id. When
 * present we record a fork-born LINK in the NEW session via `withSession` (the
 * only ctx bound to the replacement session); that session's first
 * session_sync_end echoes it back as `forked_from_req` so the app auto-navigates
 * to the new session. Without a reqId (manual `/unbien fork`) we skip the link.
 *
 * The token after entryId is a position keyword ONLY when it is literally
 * `before`/`at` (manual use); otherwise it is the reqId, and a following
 * `before`/`at` is the position.
 */
export async function _cmdFork(
  _deps: CommandDeps,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const entryId = parts[0]
  if (!entryId) {
    ctx.ui.notify("[un-bien] fork: missing entry id", "error")
    return
  }
  const isPos = (s: string | undefined): s is "before" | "at" =>
    s === "before" || s === "at"
  let reqId: string | undefined
  let position: "before" | "at" | undefined
  if (isPos(parts[1])) {
    position = parts[1]
  } else {
    reqId = parts[1]
    if (isPos(parts[2])) position = parts[2]
  }
  const req = reqId
  await ctx.fork(entryId, {
    ...(position ? { position } : {}),
    ...(req
      ? {
          withSession: async (fresh) => {
            writeForkLink(
              fresh.sessionManager.getSessionDir(),
              fresh.sessionManager.getSessionId(),
              req,
            )
          },
        }
      : {}),
  })
}

/**
 * `/unbien branch <entryId>` — `ctx.navigateTree` branches IN PLACE (same
 * session file, the leaf moves). Unlike fork it does NOT replace the session.
 *
 * No leaf beacon here: `navigateTree` fires pi's `session_tree` event, and the
 * `session_tree` handler in index.ts pushes the new leaf for EVERY move — TUI
 * `/tree`, edit-resubmit, AND this app-driven branch (marked fromExtension).
 * One source of truth, so a TUI branch reflects live too (it previously only
 * caught up on the next get_entries refetch).
 */
export async function _cmdBranch(
  _deps: CommandDeps,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const entryId = args.trim().split(/\s+/).find(Boolean)
  if (!entryId) {
    ctx.ui.notify("[un-bien] branch: missing entry id", "error")
    return
  }
  await ctx.navigateTree(entryId)
}

/**
 * `/unbien new` — `ctx.newSession` starts a fresh session. Same replacement
 * flow as fork (session_shutdown → session_start{reason:"new"}); the relay
 * lifecycle re-announces + restamps the session clock, and the app drops the
 * old conversation on the new hello (changed sessionId). No `withSession` for
 * the same stale-frame reason as fork.
 */
export async function _cmdNewSession(
  _deps: CommandDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.newSession()
}
