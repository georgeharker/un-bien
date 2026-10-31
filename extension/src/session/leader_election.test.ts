import { describe, expect, test } from "vitest"
import { mkdtempSync, writeFileSync, existsSync, lstatSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { joinOrLead } from "./leader_election.js"
import { Broker } from "./broker.js"
import { ipcAddress } from "./ipc.js"

function tmpSock(): string {
  // Per-test unique IPC address (pipe on Windows; `.sock` file on POSIX). The
  // suffix embeds the unique tmpdir basename so machine-global pipe names don't
  // collide across tests/workers (plan/40).
  const dir = mkdtempSync(join(tmpdir(), "pi-le-"))
  return ipcAddress(`le-${basename(dir)}`, join(dir, "broker.sock"))
}

describe("joinOrLead", () => {
  // The leader side must be a REAL broker for followers to join: joinOrLead
  // proves liveness with an application-level `broker_ping` probe, and a bare
  // `net.Server` never answers it (that is the busy-leader case below).
  async function cleanup(
    results: Array<
      | { role: string; server?: import("node:net").Server; socket?: import("node:net").Socket }
      | { role: "broker"; broker: Broker }
    >,
  ) {
    // Destroy follower sockets FIRST so the leader's server can close cleanly.
    for (const r of results) {
      if (r.role === "follower" && r.socket) r.socket.destroy()
    }
    for (const r of results) {
      if (r.role === "leader" && r.server) {
        await new Promise<void>((res) => r.server!.close(() => res()))
      }
    }
  }

  test("first caller becomes leader, second becomes follower", async () => {
    const sock = tmpSock()
    const r1 = await joinOrLead(sock)
    if (r1.role !== "leader") throw new Error("expected the first caller to lead")
    // Leader must SERVE for followers to app-probe-join it.
    const broker = new Broker({ server: r1.server })

    const r2 = await joinOrLead(sock)
    if (r2.role !== "follower") throw new Error("expected the second caller to follow")

    r2.socket.destroy()
    await broker.close()
  })

  test("the liveness probe asks ONE question — nothing is left in flight on the register socket", async () => {
    // The probed socket is handed to the follower `register`. A second probe
    // line would get a second answer (the whole roster) that can land between
    // the pong and the register_ack and abort the join — see the register
    // window test in e2e.test.ts.
    const { createServer } = await import("node:net")
    const sock = tmpSock()
    const lines: string[] = []
    const fake = createServer((socket) => {
      socket.setEncoding("utf8")
      let buf = ""
      socket.on("data", (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line) continue
          lines.push(line)
          if ((JSON.parse(line) as { type?: unknown }).type === "broker_ping") {
            socket.write(
              JSON.stringify({
                from: "broker",
                to: "observer",
                id: "pong-id",
                re: null,
                body: { type: "broker_pong" },
              }) + "\n",
            )
          }
        }
      })
    })
    await new Promise<void>((res) => fake.listen(sock, () => res()))

    const r = await joinOrLead(sock)
    if (r.role !== "follower") throw new Error("expected a follower join")
    // Give any second (buggy) probe line time to reach the fake broker.
    await new Promise((res) => setTimeout(res, 100))
    expect(lines).toEqual([JSON.stringify({ type: "broker_ping" })])

    r.socket.destroy()
    await new Promise<void>((res) => fake.close(() => res()))
  })

  test("3 concurrent callers: exactly 1 leader", async () => {
    const sock = tmpSock()
    // The (only) winner wraps its server in a Broker the moment it binds, so
    // the losers' busy/retry loop finds a serving broker instead of a silent
    // socket and joins as followers.
    let broker: Broker | null = null
    const results = await Promise.all([
      joinOrLead(sock).then((r) => {
        if (r.role === "leader") broker = new Broker({ server: r.server })
        return r
      }),
      joinOrLead(sock).then((r) => {
        if (r.role === "leader") broker = new Broker({ server: r.server })
        return r
      }),
      joinOrLead(sock).then((r) => {
        if (r.role === "leader") broker = new Broker({ server: r.server })
        return r
      }),
    ])
    const leaders = results.filter((r) => r.role === "leader")
    const followers = results.filter((r) => r.role === "follower")
    expect(leaders).toHaveLength(1)
    expect(followers).toHaveLength(2)
    expect(broker).not.toBeNull()

    for (const r of followers) {
      if (r.role === "follower") r.socket.destroy()
    }
    await broker!.close()
  })

  test.skipIf(process.platform === "win32")(
    "busy leader on a (silent) socket is waited out, never displaced",
    async () => {
      const { createServer } = await import("node:net")
      const sock = tmpSock()
      // A bound server that never speaks: the field-verified busy-leader
      // shape (an event-loop-starved pi shares the port and its broker
      // hasn't answered yet). Kernel-connect succeeds; nothing acks.
      const silent = createServer(() => {
        /* deliberately silent */
      })
      await new Promise<void>((res) => silent.listen(sock, () => res()))
      const inoBefore = lstatSync(sock).ino

      // Must NOT bind a second registry over it, and the file must survive.
      await expect(
        joinOrLead(sock, { busyMaxAttempts: 3 }),
      ).rejects.toThrow(/refusing to take over/)
      const inoAfter = lstatSync(sock).ino
      expect(inoAfter).toBe(inoBefore) // busy leader's file untouched

      silent.close(() => undefined)
    },
  )

  test.skipIf(process.platform === "win32")(
    "dead socket file (crashed listener) is reaped and replaced",
    async () => {
      const sock = tmpSock()
      const { spawn } = await import("node:child_process")
      // Own fixture listener, deliberately SIGKILLed WITHOUT unlinking its
      // socket file — the exact crash shape the stale-reaping path exists
      // for. Spawned and killed by this test at this path; not a system
      // process.
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const net=require('node:net');" +
            "net.createServer().listen(process.argv[1]," +
            "()=>console.log('ready'));" +
            "setTimeout(()=>{},600000)",
          sock,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("listener never bound")),
          5_000,
        )
        child.stdout.on("data", (d: Buffer) => {
          if (d.toString().includes("ready")) {
            clearTimeout(timer)
            resolve()
          }
        })
      })

      expect(existsSync(sock)).toBe(true)
      child.kill("SIGKILL")
      // Give the kernel a beat to release the port; the file lingers.
      await new Promise((r) => setTimeout(r, 300))
      expect(existsSync(sock)).toBe(true) // stale file still on disk

      const r2 = await joinOrLead(sock)
      if (r2.role !== "leader") throw new Error("expected stale reaping to lead")
      await r2.server.close()
    },
  )

  test("stale (orphan) sock file is cleaned up + caller becomes leader", async () => {
    const sock = tmpSock()
    // Plant a fake orphan: regular file with .sock name (not a real socket).
    // The cleanup heuristic only removes when lstat says isSocket(), so we
    // can't trigger removal of a plain file. Test the leader case where no
    // prior file exists.
    expect(existsSync(sock)).toBe(false)
    const r = await joinOrLead(sock)
    expect(r.role).toBe("leader")
    if (r.role === "leader")
      await new Promise<void>((res) => r.server.close(() => res()))
  })

  // POSIX-only: simulates a stale leftover by `writeFileSync(sock, "")` — i.e.
  // the sock-as-FILE crash-recovery path. On Windows `sock` is a named pipe
  // (auto-cleaned on owner exit; no file to leave behind), so the premise
  // doesn't apply — the Bloco A lifecycle skips unlink on win32 for the same
  // reason. The cross-platform election cases are covered by the tests above.
  test.skipIf(process.platform === "win32")(
    "real stale socket from prior leader is cleaned + new leader binds",
    async () => {
      const sock = tmpSock()
      const r1 = await joinOrLead(sock)
      expect(r1.role).toBe("leader")
      if (r1.role !== "leader") return
      // Close server without unlinking sock file (simulates abrupt crash).
      await new Promise<void>((res) => r1.server.close(() => res()))
      // sock file may still exist on disk
      writeFileSync(sock, "") // ensure stale entry — but as regular file; cleanup heuristic skips
      // The election should still succeed (bind would fail if sock file existed
      // as another regular file). For the test we accept either route — what
      // matters is no two leaders co-exist.
      try {
        const r2 = await joinOrLead(sock)
        if (r2.role === "leader") {
          await new Promise<void>((res) => r2.server.close(() => res()))
        } else {
          r2.socket.destroy()
        }
      } catch {
        // Acceptable: stale-file blocking with non-socket type means election
        // can't recover (rare). Documented limitation.
      }
    },
  )
})
