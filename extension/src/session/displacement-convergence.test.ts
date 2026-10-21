import { describe, expect, test } from "vitest"
import { lstatSync, mkdtempSync, renameSync, unlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createConnection } from "node:net"
import { SessionPeer } from "./peer.js"
import { ipcAddress } from "./ipc.js"

// Field-verified island shape: a leader loses its socket file when another
// process unlinks the path and re-binds its own broker. The displaced leader
// has NO close events (its followers' sockets stay open), so nothing in the
// failover design converges the mesh — except leader-side displacement
// detection. These tests exercise exactly that: A leads, C steals the file,
// and A/B converge onto C's registry with no manual intervention.

function tmpSock(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-disp-"))
  return ipcAddress(`disp-${basename(dir)}`, join(dir, "broker.sock"))
}

/** Poll until `fn` is true (or throw with the given note). */
async function eventually(
  note: string,
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`never became true: ${note}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Raw observer-probe of the broker roster (same shape as Broker's
 *  `_tryObserverProbe`): list_peers in, `body.peers` out. No registration,
 *  no side effects — the read discovery surface the CLI uses. */
function probeRoster(sock: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const sock2 = createConnection({ path: sock })
    let buf = ""
    const timer = setTimeout(() => {
      sock2.destroy()
      reject(new Error("roster probe timed out"))
    }, 3_000)
    sock2.setEncoding("utf8")
    sock2.on("connect", () => {
      sock2.write(JSON.stringify({ type: "list_peers" }) + "\n")
    })
    sock2.on("data", (chunk) => {
      buf += chunk
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      const line = buf.slice(0, nl)
      try {
        const env = JSON.parse(line) as {
          body?: { type?: string; peers?: string[] }
        }
        if (env?.body?.type === "list_peers_reply") {
          clearTimeout(timer)
          sock2.destroy()
          resolve(env.body.peers ?? [])
        }
      } catch {
        /* keep reading */
      }
    })
    sock2.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

describe("leader displacement convergence", () => {
  test.skipIf(process.platform === "win32")(
    "displaced leader re-elects onto the new broker; followers converge",
    async () => {
      const sock = tmpSock()
      const a = new SessionPeer({
        sockPath: sock,
        name: "a",
        defaultTimeoutMs: 3000,
        displacementWatchMs: 50,
        electionLimits: { busyMaxAttempts: 3 },
      })
      await a.start()
      expect(a.currentRole()).toBe("leader")
      const boundInoBefore = lstatSync(sock).ino

      const b = new SessionPeer({
        sockPath: sock,
        name: "b",
        defaultTimeoutMs: 3000,
        // b rides a's broker; same fast settings for its own failover after
        // a's broker teardown closes b's socket.
        displacementWatchMs: 50,
        electionLimits: { busyMaxAttempts: 3 },
      })
      await b.start()
      expect(b.currentRole()).toBe("follower")

      // C steals the path the old way: unlink a's live file, bind its own
      // broker, rename in a fresh socket file. (This is precisely what the
      // pre-fix joinOrLead did to busy leaders.)
      const stealTmp = `${sock}.steal`
      const c = new SessionPeer({
        sockPath: stealTmp,
        name: "c",
        defaultTimeoutMs: 3000,
        displacementWatchMs: 0,
      })
      await c.start()
      expect(c.currentRole()).toBe("leader")
      unlinkSync(sock)
      renameSync(stealTmp, sock)

      // a detects the inode change and re-elects onto c's registry. NOTE:
      // role flips to "follower" early in the re-election, so the honest
      // convergence signal is the roster on the CURRENT path, not a role.
      // b's socket died with a's teardown → socket-close failover → rejoins.
      await eventually(
        "roster lists a, b and c on one registry",
        async () => {
          try {
            const roster = await probeRoster(sock)
            const joined = roster.join(",")
            return (
              joined.includes("a") && joined.includes("b") && joined.includes("c")
            )
          } catch {
            return false
          }
        },
      )
      await eventually("a settled as follower", () => a.currentRole() === "follower")
      await eventually("b rejoined", () => b.currentRole() === "follower")
      const roster = await probeRoster(sock)
      const joined = roster.join(",")
      expect(joined).toContain("a")
      expect(joined).toContain("b")
      expect(joined).toContain("c")

      // The path no longer points at a's original inode.
      expect(lstatSync(sock).ino).not.toBe(boundInoBefore)

      await a.leave()
      await b.leave()
      await c.leave()
    },
  )
})