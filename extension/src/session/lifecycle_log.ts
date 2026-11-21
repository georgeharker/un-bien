/**
 * lifecycle.log — a small always-on record of un-bien's session lifecycle:
 * pi's session_start / session_shutdown (with pi's reason), each shutdown
 * step, why un-bien went idle, relay close and reconnect, and mesh join,
 * leave and failover. These are rare events (a handful per session), kept so
 * an incident such as every pi going idle at once, or a peer left registered
 * after a shutdown, can be reconstructed afterwards.
 *
 * `<state dir>/lifecycle.log`, one line per event:
 *   2026-11-21T05:35:58.071Z pid=36335 session_shutdown reason=reload
 * Rotated to lifecycle.log.1 at MAX_BYTES. Best-effort: logging never throws.
 * UNBIEN_LIFECYCLE_LOG=0 turns it off (the test suite sets it, so tests never
 * write to a real state dir).
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { unbienStateHome } from "../paths.js"

const MAX_BYTES = 2 * 1024 * 1024

export function lifecycleLogPath(): string {
  return join(unbienStateHome(), "lifecycle.log")
}

/** A field value: bare when it has no spaces, quotes or `=`, else quoted. */
const format = (v: string | number | boolean | null): string => {
  const s = String(v)
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s
}

/** Append one event line: `event` plus `key=value` fields. */
export function lifecycleLog(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  if (process.env["UNBIEN_LIFECYCLE_LOG"] === "0") return
  try {
    const path = lifecycleLogPath()
    mkdirSync(dirname(path), { recursive: true })
    try {
      if (statSync(path).size >= MAX_BYTES) renameSync(path, `${path}.1`)
    } catch {
      /* not there yet */
    }
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${format(v as string | number | boolean | null)}`)
    appendFileSync(path, `${new Date().toISOString()} pid=${process.pid} ${event}${parts.length ? ` ${parts.join(" ")}` : ""}\n`)
  } catch {
    /* best-effort */
  }
}
