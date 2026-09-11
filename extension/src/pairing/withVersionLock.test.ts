import { describe, expect, test, beforeAll, afterAll } from "vitest"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _testLockInternals } from "./storage.js"

const { withVersionLock, allowVersionLockPath, LOCK_STALE_MS } =
  _testLockInternals

/// LOCKFILE SEMANTICS TEST — exercises the actual acquire/release/stale-break/
/// timeout logic in isolation against a temp dir (the vitest skip inside
/// nextAllowListVersion prevents integration tests from hitting this path, so
/// this dedicated test is the ONLY coverage of the lock behavior).
///
/// The vitest skip in nextAllowListVersion checks process.env["VITEST"], but
/// this test calls withVersionLock DIRECTLY — bypassing that gate — so the
/// lock logic runs for real against a redirected state dir.

describe("withVersionLock", () => {
  let stateDir: string

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "pi-lock-test-"))
    process.env["UNBIEN_STATE_DIR"] = stateDir
  })

  afterAll(() => {
    delete process.env["UNBIEN_STATE_DIR"]
    rmSync(stateDir, { recursive: true, force: true })
  })

  test("clean acquire and release", async () => {
    const result = await withVersionLock(async () => {
      // We hold the lock — the lockfile must exist
      expect(existsSync(allowVersionLockPath())).toBe(true)
      return 42
    })
    expect(result).toBe(42)
    // Released after fn completes
    expect(existsSync(allowVersionLockPath())).toBe(false)
  })

  test("lock path resolves to the redirected state dir", () => {
    const path = allowVersionLockPath()
    expect(path).toContain(stateDir)
    expect(path.endsWith("allow-list-version.lock")).toBe(true)
  })

  test("stale lock is broken after LOCK_STALE_MS", async () => {
    const lockPath = allowVersionLockPath()
    // Create a stale lockfile (backdated mtime — older than the stale threshold)
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000)
    writeFileSync(lockPath, "99999")
    utimesSync(lockPath, old, old)

    const result = await withVersionLock(async () => "stale-broken")
    expect(result).toBe("stale-broken")
    // The stale lock was broken and the new one released
    expect(existsSync(lockPath)).toBe(false)
  })

  test("fresh lock causes timeout fall-through (proceeds unlocked, benign)", async () => {
    const lockPath = allowVersionLockPath()
    // Create a FRESH lockfile (someone else holds it, not stale)
    writeFileSync(lockPath, String(process.pid))

    const result = await withVersionLock(async () => "fell-through")
    // The function still ran — the lock is an optimization, not a gate
    expect(result).toBe("fell-through")
    // The foreign lock is still there (we didn't break it — it's fresh)
    expect(existsSync(lockPath)).toBe(true)

    // Clean up for subsequent tests
    rmSync(lockPath)
  })

  test("concurrent callers serialize (no duplicate fn execution overlap)", async () => {
    const executionOrder: string[] = []
    const mk = (name: string, delay: number) =>
      withVersionLock(async () => {
        executionOrder.push(`${name}:start`)
        await new Promise((r) => setTimeout(r, delay))
        executionOrder.push(`${name}:end`)
        return name
      })

    const [a, b] = await Promise.all([mk("A", 30), mk("B", 5)])
    expect(a).toBe("A")
    expect(b).toBe("B")

    // Within a single process, the promise chain already serializes; the
    // lockfile adds cross-process safety. Verify no interleaving:
    const aStart = executionOrder.indexOf("A:start")
    const aEnd = executionOrder.indexOf("A:end")
    const bStart = executionOrder.indexOf("B:start")
    const bEnd = executionOrder.indexOf("B:end")
    // B either fully before or fully after A (no overlap)
    const bBeforeA = bEnd < aStart
    const bAfterA = bStart > aEnd
    expect(bBeforeA || bAfterA).toBe(true)
  })

  test("fn result and errors propagate through the lock", async () => {
    // Successful result
    expect(await withVersionLock(async () => "ok")).toBe("ok")

    // Error propagates (and the lock is still released)
    await expect(
      withVersionLock(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(existsSync(allowVersionLockPath())).toBe(false)
  })

  test("mkdir creates the parent when missing", async () => {
    // Delete the state dir entirely — the lock's mkdir should recreate it
    rmSync(stateDir, { recursive: true, force: true })
    const result = await withVersionLock(async () => "recreated")
    expect(result).toBe("recreated")
  })
})
