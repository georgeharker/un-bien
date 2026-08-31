// One-time, best-effort migration of legacy state (`~/.pi/un-bien`) into the
// resolved state root — design 01M1CB6Q (config/state split). The legacy root
// predates the `UNBIEN_STATE_DIR` / XDG default; `peers.json` is PAIRING
// TRUST, so it (and everything else under the legacy root) must survive the
// move. Never throws; idempotent; skips entirely once the new root is
// populated. Same best-effort style as `envLog`.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { unbienStateHome } from "./paths.js"
import { envLog } from "./session/debug_log.js"

export type MigrationStatus =
  /** The resolved root IS the legacy dir — nothing to move. */
  | "same-dir"
  /** The resolved root already has peers.json — skip entirely. */
  | "already-populated"
  /** No legacy `~/.pi/un-bien` with peers.json — nothing to migrate. */
  | "no-legacy"
  /** Entries were moved (renamed, or copied+removed cross-device). */
  | "migrated"
  /** Something unexpected failed; legacy data is left untouched. */
  | "error"

export interface MigrationResult {
  status: MigrationStatus
  /** Entry names moved via rename. */
  renamed: string[]
  /** Entry names moved via the copy fallback (rename failed, e.g. EXDEV or a
   *  non-empty target dir; copied recursively, then removed from legacy). */
  copied: string[]
  /** Entry names that could not be moved at all (left behind in legacy). */
  failed: string[]
}

const EMPTY: MigrationResult = {
  status: "no-legacy",
  renamed: [],
  copied: [],
  failed: [],
}

/**
 * The legacy state root: literally `~/.pi/un-bien` off the REAL home — never
 * env-overridable, so `UNBIEN_HOME` test fixtures can't redirect the search.
 */
export function legacyStateDir(): string {
  return join(homedir(), ".pi", "un-bien")
}

/**
 * Move the legacy `~/.pi/un-bien` contents into `root`.
 *
 * Runs only when `root` lacks `peers.json` AND the legacy dir has one (i.e.
 * the new root is not yet populated and there is pairing trust to carry
 * over). Per entry: rename, with a recursive-copy-then-remove fallback for
 * cross-device roots or non-empty target dirs. Legacy entries are never
 * deleted unless the copy succeeded, so a mid-migration failure leaves the
 * old root fully intact for a retry. Never throws.
 */
export function migrateLegacyState(
  root: string,
  legacyDir: string = legacyStateDir(),
): MigrationResult {
  try {
    if (root === legacyDir) return { ...EMPTY, status: "same-dir" }
    const rootPeers = join(root, "peers.json")
    const legacyPeers = join(legacyDir, "peers.json")
    if (existsSync(rootPeers)) {
      return { ...EMPTY, status: "already-populated" }
    }
    if (!existsSync(legacyPeers)) return EMPTY

    mkdirSync(root, { recursive: true })
    const renamed: string[] = []
    const copied: string[] = []
    const failed: string[] = []
    for (const entry of readdirSync(legacyDir)) {
      const from = join(legacyDir, entry)
      const to = join(root, entry)
      try {
        renameSync(from, to)
        renamed.push(entry)
      } catch {
        // Cross-device (EXDEV) or a non-empty target dir — merge via copy,
        // then remove the legacy copy. Best-effort: on failure the entry
        // simply stays put in the legacy root.
        try {
          cpSync(from, to, { force: true, recursive: true })
          rmSync(from, { recursive: true, force: true })
          copied.push(entry)
        } catch {
          failed.push(entry)
        }
      }
    }
    const result: MigrationResult = {
      status: "migrated",
      renamed,
      copied,
      failed,
    }
    envLog(
      `legacy state migration: moved ${renamed.length} entr(ies) (renamed) + ` +
        `${copied.length} (copied) from ${legacyDir} to ${root}` +
        (failed.length > 0 ? `; FAILED to move: ${failed.join(", ")}` : ""),
    )
    return result
  } catch {
    // Never throws — an unreadable legacy root, a read-only new root, etc.
    // just means no migration this run; the next attempt retries.
    return { ...EMPTY, status: "error" }
  }
}

let autoAttempted = false

/**
 * Auto-hook invoked from `unbienStateHome()`: run the one-time migration at
 * most once per process, against the currently-resolved root. Skipped under
 * vitest so test runs never touch a developer's real home — the migration
 * itself is covered by `state_migration.test.ts` calling
 * `migrateLegacyState()` directly.
 */
export function migrateLegacyStateOnce(): void {
  if (autoAttempted) return
  autoAttempted = true
  if (process.env["VITEST"]) return
  migrateLegacyState(unbienStateHome())
}
