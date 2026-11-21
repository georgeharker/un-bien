import { describe, expect, test } from "vitest"
import { createServer, type Socket } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { SessionPeer } from "./peer.js"
import { ipcAddress } from "./ipc.js"

function tmpSock(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-leave-race-"))
  return ipcAddress(`lr-${basename(dir)}`, join(dir, "broker.sock"))
}

const pong = JSON.stringify({ from: "broker", to: "observer", id: "p", re: null, body: { type: "broker_pong" } }) + "\n"
const ack = (name: string) =>
  JSON.stringify({ type: "register_ack", name_assigned: name, address_assigned: `/w@${name}` }) + "\n"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("leave() during a re-election", () => {
  test("the re-election's connection is closed, not registered (no ghost peer)", async () => {
    const sockPath = tmpSock()
    const conns: Socket[] = []
    let holdPong = false
    let releasePong: () => void = () => undefined
    const server = createServer((conn) => {
      conns.push(conn)
      conn.setEncoding("utf8")
      let buf = ""
      conn.on("data", (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl)) as { type?: string; name?: string }
          buf = buf.slice(nl + 1)
          if (msg.type === "broker_ping") {
            if (holdPong) releasePong = () => conn.write(pong)
            else conn.write(pong)
          } else if (msg.type === "register") conn.write(ack(msg.name ?? "?"))
        }
      })
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))
    const open = () => conns.filter((c) => !c.destroyed && !c.closed).length

    const peer = new SessionPeer({ sockPath, name: "a", cwd: "/w", defaultTimeoutMs: 3000 })
    await peer.start()
    expect(open()).toBe(1)

    // The leader goes away for this follower: its socket closes and a
    // re-election starts. Hold the probe's reply so leave() lands mid-election.
    holdPong = true
    conns[0]!.destroy()
    await wait(300) // past the failover retry delay: the probe is waiting
    expect(conns.length).toBe(2)
    await peer.leave()
    releasePong()
    await wait(200)

    expect(open()).toBe(0)
    for (const c of conns) c.destroy()
    await new Promise<void>((r) => server.close(() => r()))
  })
})
