import { describe, expect, test, vi } from "vitest"
import { registerAgentTools } from "./tools.js"
import { MeshTransportError, type SessionPeer, type AckResult } from "./peer.js"
import { MeshInbox, type MeshMessage } from "./mesh_inbox.js"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

// Captures tools registered via pi.registerTool so we can invoke them directly.
function makeMockPi() {
  const tools = new Map<string, ToolDefinition>()
  const pi = {
    registerTool(t: ToolDefinition) {
      tools.set(t.name, t)
    },
  }
  return {
    pi: pi as unknown as Parameters<typeof registerAgentTools>[0],
    tools,
  }
}

function makeMockPeer(
  overrides: Partial<{
    name?: string
    send: unknown
    sendWithAck: unknown
    request: unknown
  }> = {},
) {
  const myName = overrides.name ?? "orq"
  const { name: _name, ...rest } = overrides
  return {
    name: () => myName,
    address: () => myName, // plan/38: tests treat address == name (no cwd)
    send: vi.fn().mockResolvedValue(undefined),
    sendWithAck: vi.fn().mockResolvedValue({
      status: "received",
      id: "uuid-out",
      target: "backend",
    } satisfies AckResult),
    request: vi.fn().mockResolvedValue({
      from: "backend",
      to: "orq",
      id: "uuid-reply",
      re: "uuid-orig",
      body: { ok: true, text: "pong" },
    }),
    ...rest,
  } as unknown as SessionPeer
}

const TOOL_CALL_ID = "tc_test"

describe("agent_send tool (ACK protocol)", () => {
  test("unicast idle peer → calls sendWithAck, returns status=received", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer()
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { task: "ping" } },
      undefined,
      undefined,
      {} as never,
    )

    expect(peer.sendWithAck).toHaveBeenCalledWith(
      "backend",
      { task: "ping" },
      null,
      5_000,
    )
    expect(result.details).toMatchObject({
      status: "received",
      ok: true,
      target: "backend",
    })
  })

  test("plan/34: defensive legacy busy reports the dropped delivery and recovery", async () => {
    // The current broker no longer emits `busy`. A stale leader that still
    // returns it dropped the message, so report non-delivery and the required
    // restart/resend recovery rather than treating it as ordinary backpressure.
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({
      sendWithAck: vi.fn().mockResolvedValue({
        status: "busy",
        id: "uuid-out",
        target: "backend",
      } satisfies AckResult),
    })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { x: 1 } },
      undefined,
      undefined,
      {} as never,
    )

    const text = (result.content[0] as { type: "text"; text: string }).text
    expect(text).toMatch(/not delivered/i)
    expect(text).toMatch(/out-of-date/i)
    expect(text).toMatch(/restart/i)
    expect(text).toMatch(/resend/i)
  })

  test("unicast denied peer → status=denied, ok=false", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({
      sendWithAck: vi.fn().mockResolvedValue({
        status: "denied",
        id: "uuid-out",
        target: "backend",
      } satisfies AckResult),
    })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { x: 1 } },
      undefined,
      undefined,
      {} as never,
    )

    expect(result.details).toMatchObject({ status: "denied", ok: false })
  })

  test("unicast unknown peer → status=unknown_peer, ok=false", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({
      sendWithAck: vi.fn().mockResolvedValue({
        status: "unknown_peer",
        id: "uuid-out",
        target: "backend",
      } satisfies AckResult),
    })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { x: 1 } },
      undefined,
      undefined,
      {} as never,
    )

    expect(result.details).toMatchObject({ status: "unknown_peer", ok: false })
  })

  test("true-silence timeout stays reasonless", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({
      sendWithAck: vi.fn().mockResolvedValue({
        status: "timeout",
        id: "uuid-out",
      } satisfies AckResult),
    })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { x: 1 } },
      undefined,
      undefined,
      {} as never,
    )

    expect(result.details).toEqual({ status: "timeout", ok: false })
  })

  test.each([
    {
      label: "offline",
      ack: {
        status: "timeout",
        id: "uuid-out",
        error: "transport_error: offline",
        reason: "offline",
      } satisfies AckResult,
    },
    {
      label: "not_authorized",
      ack: {
        status: "denied",
        id: "uuid-out",
        error: "transport_error: not_authorized",
        reason: "not_authorized",
      } satisfies AckResult,
    },
    {
      label: "bad_envelope",
      ack: {
        status: "denied",
        id: "uuid-out",
        error: "transport_error: bad_envelope",
        reason: "bad_envelope",
      } satisfies AckResult,
    },
  ])(
    "transport error $label preserves the full ACK reason",
    async ({ ack }) => {
      const { pi, tools } = makeMockPi()
      const peer = makeMockPeer({
        sendWithAck: vi.fn().mockResolvedValue(ack),
      })
      registerAgentTools(pi, () => peer, () => new MeshInbox())
      const tool = tools.get("agent_send")!

      const result = await tool.execute(
        TOOL_CALL_ID,
        { to: "backend", body: { x: 1 } },
        undefined,
        undefined,
        {} as never,
      )
      const text = (result.content[0] as { type: "text"; text: string }).text

      expect(result.details).toEqual({
        status: ack.status,
        ok: false,
        error: ack.error,
        reason: ack.reason,
      })
      expect(text).toContain(ack.error)
      if (ack.reason === "offline") {
        expect(text).toMatch(/timeout/i)
        expect(text).toMatch(/relay/i)
        expect(text).toMatch(/offline/i)
      } else {
        expect(text).toMatch(/do not|don't/i)
        expect(text).toMatch(/blindly/i)
        expect(text).toMatch(/retry/i)
      }
    },
  )

  test("forwards `re` for replies (correlation field)", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer()
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    await tool.execute(
      TOOL_CALL_ID,
      {
        to: "frontend",
        body: { answer: "pong" },
        re: "01976000-0000-7000-8000-000000000000",
      },
      undefined,
      undefined,
      {} as never,
    )

    expect(peer.sendWithAck).toHaveBeenCalledWith(
      "frontend",
      { answer: "pong" },
      "01976000-0000-7000-8000-000000000000",
      5_000,
    )
  })

  test("broadcast → fire-and-forget, status=sent, uses peer.send not sendWithAck", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer()
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "broadcast", body: { announce: "wave-2-started" } },
      undefined,
      undefined,
      {} as never,
    )

    expect(peer.send).toHaveBeenCalledWith(
      "broadcast",
      { announce: "wave-2-started" },
      null,
    )
    expect(peer.sendWithAck).not.toHaveBeenCalled()
    expect(result.details).toMatchObject({ status: "sent", ok: true })
  })

  test("not in a session → status=refused", async () => {
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => null, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: "hi" },
      undefined,
      undefined,
      {} as never,
    )

    expect(result.details).toMatchObject({
      status: "refused",
      ok: false,
      error: expect.stringContaining("Not in a session"),
    })
  })

  test("body as string passes through intact", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer()
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: "plain string body" },
      undefined,
      undefined,
      {} as never,
    )
    expect(peer.sendWithAck).toHaveBeenCalledWith(
      "backend",
      "plain string body",
      null,
      5_000,
    )
  })

  test("nested body object passes through intact", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer()
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const nested = { a: { b: { c: [1, 2, { d: "x" }] } }, e: null }
    await tool.execute(
      TOOL_CALL_ID,
      { to: "fanout-target", body: nested },
      undefined,
      undefined,
      {} as never,
    )
    expect(peer.sendWithAck).toHaveBeenCalledWith(
      "fanout-target",
      nested,
      null,
      5_000,
    )
  })

  test("self-send refused early → sendWithAck not called", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({ name: "orq" })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_send")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "orq", body: { x: 1 } },
      undefined,
      undefined,
      {} as never,
    )

    expect(peer.sendWithAck).not.toHaveBeenCalled()
    expect(result.details).toMatchObject({
      status: "refused",
      ok: false,
      error: expect.stringContaining("cannot agent_send to yourself"),
    })
  })
})

describe("list_peers tool", () => {
  function makeListPeersPeer(
    peers: string[],
    overrides: { name?: string; request?: unknown } = {},
  ) {
    const myName = overrides.name ?? "orq"
    return {
      name: () => myName,
      address: () => myName, // plan/38: tests treat address == name (no cwd)
      send: vi.fn(),
      sendWithAck: vi.fn(),
      request:
        overrides.request ??
        vi.fn().mockResolvedValue({
          from: "broker",
          to: myName,
          id: "uuid-reply",
          re: "uuid-orig",
          body: { type: "list_peers_reply", peers },
        }),
    } as unknown as SessionPeer
  }

  test("returns locals + cross-PC entries, excludes self", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeListPeersPeer(["orq", "backend", "casa:agent-1"])
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("list_peers")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      {},
      undefined,
      undefined,
      {} as never,
    )

    expect(peer.request).toHaveBeenCalledWith(
      "broker",
      { type: "list_peers" },
      2_000,
    )
    expect((result.details as { peers: string[] }).peers).toEqual(["backend", "casa:agent-1"])
    expect((result.details as { self?: { address: string; name: string; broker: string } }).self).toMatchObject({ address: "orq", name: "orq", broker: "local" })
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "backend\ncasa:agent-1",
    )
  })

  test("empty inventory → (no peers) text", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeListPeersPeer(["orq"]) // only self
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("list_peers")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      {},
      undefined,
      undefined,
      {} as never,
    )
    expect((result.details as { peers: string[] }).peers).toEqual([])
    expect((result.details as { self?: { address: string; name: string; broker: string } }).self).toMatchObject({ address: "orq", name: "orq", broker: "local" })
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "(no peers)",
    )
  })

  test("not in session → empty peers + NOT_IN_SESSION text", async () => {
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => null, () => new MeshInbox())
    const tool = tools.get("list_peers")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      {},
      undefined,
      undefined,
      {} as never,
    )
    expect(result.details).toEqual({ peers: [] })
    expect(
      (result.content[0] as { type: "text"; text: string }).text,
    ).toContain("Not in a session")
  })

  test("broker request throws → structured error, peers=[]", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeListPeersPeer([], {
      request: vi
        .fn()
        .mockRejectedValue(new Error("request to broker timed out")),
    })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("list_peers")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      {},
      undefined,
      undefined,
      {} as never,
    )
    expect(result.details).toEqual({ peers: [] })
    expect(
      (result.content[0] as { type: "text"; text: string }).text,
    ).toContain("list_peers failed")
  })
})

describe("agent_request tool (deprecated, still functional)", () => {
  test("legacy: calls SessionPeer.request → returns reply.body via details", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer()
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_request")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { q: "?" } },
      undefined,
      undefined,
      {} as never,
    )

    expect(peer.request).toHaveBeenCalledWith("backend", { q: "?" }, 30_000)
    expect(result.details).toEqual({ ok: true, text: "pong" })
  })

  test("custom timeout_ms is honored", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer()
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_request")!

    await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { q: "?" }, timeout_ms: 5_000 },
      undefined,
      undefined,
      {} as never,
    )
    expect(peer.request).toHaveBeenCalledWith("backend", { q: "?" }, 5_000)
  })

  test("not in a session → structured error", async () => {
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => null, () => new MeshInbox())
    const tool = tools.get("agent_request")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: "x" },
      undefined,
      undefined,
      {} as never,
    )
    expect(result.details).toMatchObject({
      error: expect.stringContaining("Not in a session"),
    })
  })

  test("SessionPeer.request throws (timeout) → structured error", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({
      request: vi
        .fn()
        .mockRejectedValue(
          new Error("request to backend timed out after 5000ms"),
        ),
    })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_request")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { q: "?" }, timeout_ms: 5_000 },
      undefined,
      undefined,
      {} as never,
    )
    expect(result.details).toMatchObject({
      error: expect.stringContaining("timed out"),
    })
  })

  test("MeshTransportError exposes the named reason in structured error and content", async () => {
    const correlationId = "01976000-0000-7000-8000-000000000000"
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({
      request: vi
        .fn()
        .mockRejectedValue(
          new MeshTransportError("not_authorized", correlationId),
        ),
    })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_request")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "backend", body: { q: "?" } },
      undefined,
      undefined,
      {} as never,
    )
    const text = (result.content[0] as { type: "text"; text: string }).text

    expect(result.details).toEqual({
      error: "transport_error: not_authorized",
    })
    expect(text).toContain("transport_error: not_authorized")
  })

  test("self-request refused early → request not called", async () => {
    const { pi, tools } = makeMockPi()
    const peer = makeMockPeer({ name: "orq" })
    registerAgentTools(pi, () => peer, () => new MeshInbox())
    const tool = tools.get("agent_request")!

    const result = await tool.execute(
      TOOL_CALL_ID,
      { to: "orq", body: { x: 1 } },
      undefined,
      undefined,
      {} as never,
    )

    expect(peer.request).not.toHaveBeenCalled()
    expect(result.details).toMatchObject({
      error: expect.stringContaining("cannot agent_request to yourself"),
    })
  })
})

describe("inbox tools (get_message / list_messages / wait_message)", () => {
  const TOOL_CALL_ID = "tc-1"
  const msg = (over: Partial<Record<string, unknown>> & { id: string }): MeshMessage => ({
    id: over.id,
    from: (over.from as string) ?? "backend",
    to: (over.to as string) ?? "orq",
    body: over.body ?? { x: 1 },
    re: (over.re as string | null | undefined) ?? null,
    sentAt: (over.sentAt as number) ?? 1_000,
    deliveredAt: (over.deliveredAt as number | null | undefined) ?? null,
  })

  test("get_message returns a stored message by id (null if absent)", async () => {
    const inbox = new MeshInbox()
    inbox.add(msg({ id: "m1", from: "backend", body: "hi" }))
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => makeMockPeer(), () => inbox)
    const tool = tools.get("mesh_get_message")!

    const hit = await tool.execute(TOOL_CALL_ID, { id: "m1" }, undefined, undefined, {} as never)
    expect(hit.details).toMatchObject({ id: "m1", from: "backend" })

    const miss = await tool.execute(TOOL_CALL_ID, { id: "nope" }, undefined, undefined, {} as never)
    expect(miss.details).toBeNull()
  })

  test("list_messages returns stored messages, filtered by from/re", async () => {
    const inbox = new MeshInbox()
    inbox.add(msg({ id: "m1", from: "backend", re: "r1" }))
    inbox.add(msg({ id: "m2", from: "docs", re: "r2" }))
    inbox.add(msg({ id: "m3", from: "backend", re: "r3" }))
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => makeMockPeer(), () => inbox)
    const tool = tools.get("mesh_list_messages")!

    const all = await tool.execute(TOOL_CALL_ID, {}, undefined, undefined, {} as never)
    expect((all.details as { messages: MeshMessage[] }).messages).toHaveLength(3)

    const fromBackend = await tool.execute(TOOL_CALL_ID, { from: "backend" }, undefined, undefined, {} as never)
    expect((fromBackend.details as { messages: MeshMessage[] }).messages.map((m) => m.id)).toEqual(["m1", "m3"])

    const byRe = await tool.execute(TOOL_CALL_ID, { re: "r2" }, undefined, undefined, {} as never)
    expect((byRe.details as { messages: MeshMessage[] }).messages.map((m) => m.id)).toEqual(["m2"])
  })

  test("wait_message returns an already-stored match immediately (poll)", async () => {
    const inbox = new MeshInbox()
    inbox.add(msg({ id: "m1", from: "backend", re: "reply-1", sentAt: 5_000 }))
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => makeMockPeer(), () => inbox)
    const tool = tools.get("mesh_wait_message")!

    const result = await tool.execute(TOOL_CALL_ID, { re: "reply-1", timeout_ms: 0 }, undefined, undefined, {} as never)
    expect(result.details).toMatchObject({ id: "m1", re: "reply-1" })
  })

  test("wait_message blocks until a matching message arrives", async () => {
    const inbox = new MeshInbox()
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => makeMockPeer(), () => inbox)
    const tool = tools.get("mesh_wait_message")!

    const waitP = tool.execute(TOOL_CALL_ID, { re: "reply-9", timeout_ms: 2_000 }, undefined, undefined, {} as never)
    // add the matching reply after the wait is pending
    setTimeout(
      () => inbox.add(msg({ id: "m-late", from: "backend", re: "reply-9", sentAt: 9_000 })),
      20,
    )
    const result = await waitP
    expect(result.details).toMatchObject({ id: "m-late", re: "reply-9" })
  })

  test("wait_message returns null on timeout (no match)", async () => {
    const inbox = new MeshInbox()
    const { pi, tools } = makeMockPi()
    registerAgentTools(pi, () => makeMockPeer(), () => inbox)
    const tool = tools.get("mesh_wait_message")!

    const result = await tool.execute(TOOL_CALL_ID, { re: "never", timeout_ms: 50 }, undefined, undefined, {} as never)
    expect(result.details).toBeNull()
  })
})
