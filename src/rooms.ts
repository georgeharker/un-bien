import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/**
 * Deterministic room id derived from a cwd. Two Pi processes in the same
 * directory produce the same id; different cwds produce different ids
 * (with cryptographic-strength collision resistance). Symlinks are resolved
 * via `realpath` so `/a` and `/symlink-to-a` map to the same room.
 *
 * Format: first 12 chars of base64url(sha256(realpath)).
 */
export function roomIdForCwd(cwd: string): string {
  let target: string;
  try {
    target = realpathSync(cwd);
  } catch {
    // cwd doesn't exist (unlikely in production) — fallback to raw path.
    target = cwd;
  }
  return createHash("sha256").update(target).digest("base64url").slice(0, 12);
}
