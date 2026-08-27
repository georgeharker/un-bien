// File-based envelope debug log. The fork usually runs detached (no visible
// stderr), so gated diagnostics go to a file the user can `tail -f`.
// Enabled by REMOTE_PI_DEBUG_ENVELOPE=1; best-effort, never throws.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_PATH = join(homedir(), ".pi", "remote", "envelope-debug.log");

/** Append a timestamped line to ~/.pi/remote/envelope-debug.log. TEMPORARILY
 *  UNCONDITIONAL (the detached fork doesn't inherit REMOTE_PI_DEBUG_ENVELOPE);
 *  re-gate once resume is diagnosed. Safe inside SDK callbacks. */
export function envLog(msg: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best-effort */
  }
}
