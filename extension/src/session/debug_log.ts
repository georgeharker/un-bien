// File-based envelope debug log. The fork usually runs detached (no visible
// stderr), so gated diagnostics go to a file the user can `tail -f`.
// Enabled by the `debug.envelope` pref in the global config
// (`extensions/un-bien.json`) — NOT an env var, because the detached fork
// doesn't inherit a shell's env. Best-effort, never throws.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import { unbienStateHome } from "../paths.js";

const LOG_PATH = join(unbienStateHome(), "envelope-debug.log");

// Resolved once: the debug pref is a dev switch, not something that flips
// mid-process, so we read the config file a single time on first use.
let enabled: boolean | undefined;
function isEnabled(): boolean {
  if (enabled === undefined) enabled = loadConfig().debug?.envelope === true;
  return enabled;
}

/** Append a timestamped line to `<state>/envelope-debug.log` when the
 *  `debug.envelope` config pref is set. Safe inside SDK callbacks. */
export function envLog(msg: string): void {
  if (!isEnabled()) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best-effort */
  }
}
