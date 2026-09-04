/**
 * Fork-born linkage: a tiny marker persisted by `_cmdFork`'s `withSession`
 * (running in the NEW forked session) and consumed by that session's FIRST
 * `session_sync_end`, which echoes the app's originating fork request id as
 * `forked_from_req` so the app can auto-navigate to the new session.
 *
 * Why a FILE and not a module variable: `ctx.fork` replaces the AgentSession,
 * and the pi TUI host re-evaluates this extension module fresh for the new
 * session (jiti moduleCache:false), so a module-level stash set in withSession
 * would be lost before the new session handles the app's session_sync. The
 * marker is keyed by the new session id and lives in the session dir, so it
 * survives the re-eval (and a process restart) and is unambiguous.
 *
 * Consumed ONCE (take = read + unlink): the app navigates on the first sync;
 * leaving it would re-fire the jump on every reconnect.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function _linkPath(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `.unbien-fork-${sessionId}.json`)
}

/** Record that `sessionId` was born from the app fork request `req`. Best-effort. */
export function writeForkLink(
  sessionDir: string,
  sessionId: string,
  req: string,
): void {
  try {
    writeFileSync(
      _linkPath(sessionDir, sessionId),
      JSON.stringify({ req, ts: Date.now() }),
    )
  } catch {
    /* best-effort — a missing link just means no auto-nav */
  }
}

/** Read + delete the fork request id for `sessionId`, or undefined when none. */
export function takeForkLink(
  sessionDir: string,
  sessionId: string,
): string | undefined {
  const path = _linkPath(sessionDir, sessionId)
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { req?: unknown }
    unlinkSync(path)
    return typeof parsed.req === "string" ? parsed.req : undefined
  } catch {
    return undefined
  }
}
