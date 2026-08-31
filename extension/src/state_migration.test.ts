import { describe, expect, test } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  legacyStateDir,
  migrateLegacyState,
  migrateLegacyStateOnce,
} from "./state_migration.js"

// The migration is exercised through its explicit (root, legacyDir) params so
// no test ever touches a dev machine's real ~/.pi/un-bien; the auto-hook
// (migrateLegacyStateOnce) skips under vitest for exactly that reason.

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function seedLegacy(legacy: string): void {
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "peers.json"), '{"paired":true}')
  mkdirSync(join(legacy, "sessions"), { recursive: true })
  writeFileSync(join(legacy, "sessions", "one.jsonl"), "hello")
}

describe("migrateLegacyState", () => {
  test("no legacy dir → no-legacy, nothing created", () => {
    const root = tmpRoot("unbien-mig-root-")
    const legacy = tmpRoot("unbien-mig-legacy-empty-")
    const result = migrateLegacyState(root, legacy)
    expect(result.status).toBe("no-legacy")
    expect(result.renamed).toEqual([])
    expect(existsSync(join(root, "peers.json"))).toBe(false)
  })

  test("legacy without peers.json is not migration-worthy", () => {
    const root = tmpRoot("unbien-mig-root-")
    const legacy = tmpRoot("unbien-mig-legacy-nomatch-")
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "sessions.jsonl"), "leftovers")
    const result = migrateLegacyState(root, legacy)
    expect(result.status).toBe("no-legacy")
    expect(existsSync(join(legacy, "sessions.jsonl"))).toBe(true)
  })

  test("populated root (peers.json present) → skip entirely", () => {
    const root = tmpRoot("unbien-mig-root-")
    const legacy = tmpRoot("unbien-mig-legacy-")
    seedLegacy(legacy)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "peers.json"), '{"fresh":true}')
    const result = migrateLegacyState(root, legacy)
    expect(result.status).toBe("already-populated")
    // Legacy untouched — the new root won, nothing was moved.
    expect(existsSync(join(legacy, "peers.json"))).toBe(true)
    expect(readFileSync(join(root, "peers.json"), "utf8")).toBe(
      '{"fresh":true}',
    )
  })

  test("root === legacy → same-dir", () => {
    const dir = tmpRoot("unbien-mig-same-")
    expect(migrateLegacyState(dir, dir).status).toBe("same-dir")
  })

  test("moves legacy contents, peers.json survives verbatim", () => {
    const root = tmpRoot("unbien-mig-root-")
    const legacy = tmpRoot("unbien-mig-legacy-")
    seedLegacy(legacy)
    const result = migrateLegacyState(root, legacy)
    expect(result.status).toBe("migrated")
    expect(result.renamed).toContain("peers.json")
    expect(result.renamed).toContain("sessions")
    expect(result.copied).toEqual([])
    expect(result.failed).toEqual([])
    expect(readFileSync(join(root, "peers.json"), "utf8")).toBe(
      '{"paired":true}',
    )
    expect(readFileSync(join(root, "sessions", "one.jsonl"), "utf8")).toBe(
      "hello",
    )
    expect(existsSync(join(legacy, "peers.json"))).toBe(false)
    expect(existsSync(legacy)).toBe(true) // the emptied dir itself stays
  })

  test("idempotent: a second run is already-populated", () => {
    const root = tmpRoot("unbien-mig-root-")
    const legacy = tmpRoot("unbien-mig-legacy-")
    seedLegacy(legacy)
    expect(migrateLegacyState(root, legacy).status).toBe("migrated")
    expect(migrateLegacyState(root, legacy).status).toBe("already-populated")
  })

  test("copy fallback when the target entry is a non-empty dir (rename fails)", () => {
    const root = tmpRoot("unbien-mig-root-")
    const legacy = tmpRoot("unbien-mig-legacy-")
    seedLegacy(legacy)
    // Pre-create a non-empty `sessions` in the root: rename(dir → dir) fails
    // with ENOTEMPTY, forcing the copy-then-remove fallback path.
    mkdirSync(join(root, "sessions"), { recursive: true })
    writeFileSync(join(root, "sessions", "existing.jsonl"), "kept")
    const result = migrateLegacyState(root, legacy)
    expect(result.status).toBe("migrated")
    expect(result.copied).toContain("sessions")
    expect(result.renamed).toContain("peers.json")
    // Merged: both the root's file and the legacy one land in the new root.
    expect(readFileSync(join(root, "sessions", "existing.jsonl"), "utf8")).toBe(
      "kept",
    )
    expect(readFileSync(join(root, "sessions", "one.jsonl"), "utf8")).toBe(
      "hello",
    )
    expect(existsSync(join(legacy, "sessions"))).toBe(false)
  })

  test("never throws: an unwritable root → error status, legacy intact", () => {
    const legacy = tmpRoot("unbien-mig-legacy-")
    seedLegacy(legacy)
    // A root path under a plain FILE: mkdirSync fails with ENOTDIR, so the
    // migration must bail out with `error` — never throw, never delete
    // anything from the legacy root.
    const blocker = tmpRoot("unbien-mig-blocker-") + ".file"
    writeFileSync(blocker, "not a dir")
    const result = migrateLegacyState(join(blocker, "state"), legacy)
    expect(result.status).toBe("error")
    expect(existsSync(join(legacy, "peers.json"))).toBe(true)
    expect(existsSync(join(legacy, "sessions", "one.jsonl"))).toBe(true)
  })

  test("legacyStateDir is the real-home ~/.pi/un-bien, not env-overridable", () => {
    expect(legacyStateDir()).toBe(join(homedir(), ".pi", "un-bien"))
  })

  test("migrateLegacyStateOnce is a cheap no-op under vitest", () => {
    // Guarded by the VITEST env var; must not throw and must not touch
    // anything (the real hook is exercised only outside tests).
    expect(() => migrateLegacyStateOnce()).not.toThrow()
  })
})
