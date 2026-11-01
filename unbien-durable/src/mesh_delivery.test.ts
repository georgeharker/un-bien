/**
 * The mesh → inbox feed (mesh_delivery.ts): inbound agent-to-agent envelopes
 * land in the MeshInbox so launch_pi_task's correlated wait resolves. This is
 * the regression test for the "mesh inbox never fed" gap — the bridge tests
 * hand-fill the inbox, so nothing else covers the wiring.
 *
 * Hermetic: a fake MeshNode (envelope delivery + sendWithAck) and a fake
 * headless launch port; the REAL launch_pi_task tool and REAL MeshInbox run
 * end-to-end over them.
 */
import { describe, expect, it, vi } from "vitest"
import { MeshInbox } from "@geohar/un-bien/durable"
import type { MeshNode } from "@geohar/un-bien/durable"
import type {
  HeadlessLaunchedSession,
  HeadlessLaunchPort,
} from "@geohar/un-bien/core"
import { wireMeshInbox } from "./mesh_delivery.js"
import { createLaunchWaitQuitTool } from "./launch_wait_quit.js"

/** The envelope shape SessionPeer.onMessage handlers receive. */
interface MeshEnvelope {
  from: string
  to: string | string[]
  id: string
  re: string | null
  body: unknown
}

/** MeshNode double: records subscriptions, delivers envelopes, fake-ACKs. */
class FakeMeshNode {
  readonly delivered: MeshEnvelope[] = []
  private readonly messageHandlers = new Set<(env: MeshEnvelope) => void>()

  onMessage(handler: (env: MeshEnvelope) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  address(): string {
    return "/host/cwd@durable"
  }

  peer(): unknown {
    return this
  }

  async sendWithAck(): Promise<{ status: string; id: string }> {
    // The tool correlates the reply by this id — a fixed value stands in
    // for the broker's envelope id.
    return { status: "received", id: "send-1" }
  }

  /** Deliver as the broker would: fan out to every subscriber. */
  deliver(env: MeshEnvelope): void {
    for (const handler of [...this.messageHandlers]) handler(env)
  }
}

/** HeadlessLaunchPort double: the launched "session" is a no-op lifecycle. */
function fakeLaunch(): HeadlessLaunchPort {
  const session: HeadlessLaunchedSession = {
    name: "pi-task-1",
    joinMeshUnderName: async () => {},
    awaitReady: async () => ({ address: "/task/cwd@pi-task-1" }),
    tearDown: vi.fn(async () => {}),
  }
  return { launchHeadless: async () => session }
}

/** The tool wired over the fakes + the real inbox feed. */
function makeTool(): {
  inbox: MeshInbox
  meshNode: FakeMeshNode
  execute: ReturnType<typeof createLaunchWaitQuitTool>["execute"]
} {
  const inbox = new MeshInbox()
  const meshNode = new FakeMeshNode()
  wireMeshInbox(meshNode as unknown as MeshNode, inbox)
  const tool = createLaunchWaitQuitTool({
    launch: fakeLaunch(),
    getMeshNode: () => meshNode as unknown as MeshNode,
    getInbox: () => inbox,
  })
  return { inbox, meshNode, execute: tool.execute }
}

describe("wireMeshInbox", () => {
  it("stores real agent messages — a pending wait resolves on delivery", async () => {
    const { inbox, meshNode } = makeTool()
    const pending = inbox.wait({ re: "send-1" }, 500)
    meshNode.deliver({
      from: "/task/cwd@pi-task-1",
      to: "/host/cwd@durable",
      id: "reply-1",
      re: "send-1",
      body: { type: "pi_task_done", result: "ok" },
    })
    const reply = await pending
    expect(reply).not.toBeNull()
    expect(reply!.from).toBe("/task/cwd@pi-task-1")
    expect(reply!.re).toBe("send-1")
    expect(reply!.deliveredAt).toBeNull() // pull-only binding: no push stamp
  })

  it("filters broker system + control frames from the inbox", () => {
    const { inbox, meshNode } = makeTool()
    meshNode.deliver({
      from: "broker",
      to: "/host/cwd@durable",
      id: "sys-1",
      re: null,
      body: { type: "peer_joined", name: "new-peer" },
    })
    meshNode.deliver({
      from: "broker",
      to: "/host/cwd@durable",
      id: "sys-2",
      re: null,
      body: { type: "list_peers" },
    })
    expect(inbox.size).toBe(0)
  })
})

describe("launch_pi_task × wireMeshInbox (end-to-end over fakes)", () => {
  it("the correlated reply resolves the tool's inbox.wait as the tool result", async () => {
    const { meshNode, execute } = makeTool()
    // The launched "session" replies mid-flight: deliver AFTER the tool has
    // registered its wait (a microtask gap lets the tool reach inbox.wait).
    setTimeout(() => {
      meshNode.deliver({
        from: "/task/cwd@pi-task-1",
        to: "/host/cwd@durable",
        id: "reply-1",
        re: "send-1", // the fake sendWithAck's envelope id
        body: "task finished: 2 files edited",
      })
    }, 5)
    const result = (await execute(
      { task: "do the thing" },
      {} as never,
      {} as never,
    )) as { output: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBeFalsy()
    expect(result.output[0]!.text).toBe("task finished: 2 files edited")
  })

  it("still answers (a timeout report) when no reply is delivered", async () => {
    const { execute } = makeTool()
    const result = (await execute(
      { task: "silence", timeout_ms: 30 },
      {} as never,
      {} as never,
    )) as { output: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBeFalsy()
    expect(result.output[0]!.text).toContain("No reply within")
  })
})