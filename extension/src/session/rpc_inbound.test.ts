import { describe, expect, it, vi } from "vitest"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import {
  dispatchRpcCommand,
  MAX_ENTRY_JSON_BYTES,
  type GetEntriesResult,
  pageEntries,
  rpcResponse,
  type RpcCommandHandlers,
} from "./rpc_inbound.js"

function handlers(over: Partial<RpcCommandHandlers> = {}): RpcCommandHandlers {
  return {
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => ({ provider: "anthropic", id: "claude" })),
    setThinkingLevel: vi.fn(async () => {}),
    ...over,
  }
}

describe("rpcResponse", () => {
  it("builds a {rpc:response} envelope correlated by id", () => {
    expect(rpcResponse("prompt", "req-1", { success: true })).toEqual({
      rpc: { type: "response", command: "prompt", success: true, id: "req-1" },
    })
  })
  it("omits id/data/error when absent; carries them when present", () => {
    expect(rpcResponse("abort", undefined, { success: true })).toEqual({
      rpc: { type: "response", command: "abort", success: true },
    })
    expect(
      rpcResponse("get_state", "x", { success: true, data: { a: 1 } }),
    ).toEqual({
      rpc: {
        type: "response",
        command: "get_state",
        success: true,
        id: "x",
        data: { a: 1 },
      },
    })
    expect(
      rpcResponse("prompt", "x", { success: false, error: "boom" }),
    ).toEqual({
      rpc: {
        type: "response",
        command: "prompt",
        success: false,
        id: "x",
        error: "boom",
      },
    })
  })
})

describe("dispatchRpcCommand", () => {
  it("prompt → handler + success response, passing streamingBehavior/images", async () => {
    const h = handlers()
    const resp = await dispatchRpcCommand(
      {
        type: "prompt",
        id: "p1",
        message: "hi",
        images: [{ x: 1 }],
        streamingBehavior: "steer",
      },
      h,
    )
    expect(h.prompt).toHaveBeenCalledWith("hi", {
      id: "p1",
      images: [{ x: 1 }],
      streamingBehavior: "steer",
    })
    expect(resp).toEqual({
      rpc: { type: "response", command: "prompt", success: true, id: "p1" },
    })
  })

  it("steer / follow_up / abort each dispatch + ack", async () => {
    const h = handlers()
    expect(
      await dispatchRpcCommand({ type: "steer", id: "s", message: "go" }, h),
    ).toEqual({
      rpc: { type: "response", command: "steer", success: true, id: "s" },
    })
    expect(h.steer).toHaveBeenCalledWith("go", { images: undefined })
    expect(
      await dispatchRpcCommand({ type: "follow_up", message: "later" }, h),
    ).toEqual({
      rpc: { type: "response", command: "follow_up", success: true },
    })
    expect(await dispatchRpcCommand({ type: "abort", id: "a" }, h)).toEqual({
      rpc: { type: "response", command: "abort", success: true, id: "a" },
    })
    expect(h.abort).toHaveBeenCalledOnce()
  })

  it("a handler throw becomes success:false with the message", async () => {
    const h = handlers({
      prompt: vi.fn(async () => {
        throw new Error("agent busy")
      }),
    })
    expect(
      await dispatchRpcCommand({ type: "prompt", id: "p", message: "x" }, h),
    ).toEqual({
      rpc: {
        type: "response",
        command: "prompt",
        success: false,
        id: "p",
        error: "agent busy",
      },
    })
  })

  it("set_model → handler + response carrying the model data", async () => {
    const h = handlers({
      setModel: vi.fn(async () => ({
        provider: "anthropic",
        id: "claude-opus",
      })),
    })
    const resp = await dispatchRpcCommand(
      {
        type: "set_model",
        id: "m",
        provider: "anthropic",
        modelId: "claude-opus",
      },
      h,
    )
    expect(h.setModel).toHaveBeenCalledWith("anthropic", "claude-opus")
    expect(resp).toEqual({
      rpc: {
        type: "response",
        command: "set_model",
        success: true,
        id: "m",
        data: { provider: "anthropic", id: "claude-opus" },
      },
    })
  })

  it("set_thinking_level → handler + ack", async () => {
    const h = handlers()
    const resp = await dispatchRpcCommand(
      { type: "set_thinking_level", id: "t", level: "high" },
      h,
    )
    expect(h.setThinkingLevel).toHaveBeenCalledWith("high")
    expect(resp).toEqual({
      rpc: {
        type: "response",
        command: "set_thinking_level",
        success: true,
        id: "t",
      },
    })
  })

  it("get_entries → handler(since) + response carrying {entries, leafId}", async () => {
    const data = {
      entries: [{ type: "message", id: "e1" }],
      leafId: "e1",
    } as unknown as GetEntriesResult
    const h = handlers({ getEntries: vi.fn(async () => data) })
    const resp = await dispatchRpcCommand(
      { type: "get_entries", id: "ge", since: "e0" },
      h,
    )
    expect(h.getEntries).toHaveBeenCalledWith("e0")
    expect(resp).toEqual({
      rpc: {
        type: "response",
        command: "get_entries",
        success: true,
        id: "ge",
        data,
      },
    })
  })

  it("get_entries without `since` passes undefined; an unwired handler → null", async () => {
    const h = handlers({
      getEntries: vi.fn(async () => ({ entries: [], leafId: null })),
    })
    await dispatchRpcCommand({ type: "get_entries", id: "g2" }, h)
    expect(h.getEntries).toHaveBeenCalledWith(undefined)
    // getEntries is optional — unset means the command falls through to null.
    expect(
      await dispatchRpcCommand({ type: "get_entries", id: "g3" }, handlers()),
    ).toBeNull()
  })

  // get_entries backfill paging: the reply is ONE budget-bounded page; the
  // shape stays pi-faithful ({entries, leafId} — no extra fields). The app
  // loops `since: leafId` until an empty page.
  describe("pageEntries", () => {
    const mk = (id: string, size: number) =>
      ({
        type: "message",
        id,
        text: "x".repeat(Math.max(0, size - 40)),
      }) as unknown as SessionEntry

    it("an entry beyond the transport ceiling is string-truncated (walk still crosses)", () => {
      // 6 MiB raw > the raised 5 MiB ceiling → still gets string-truncated
      // (the ladder must survive the cap raise; it now guards pathological
      // entries only, never normal long responses).
      const giant = mk("big", 6 * 1024 * 1024)
      const after = mk("after", 50)
      const page = pageEntries([giant, after], undefined, "after", 1024 * 1024)
      // Fitted ≈ 64 KiB + marker → under both the ceiling AND the budget, so
      // the page completes in one go with both entries.
      expect(page.entries.map((e) => e.id)).toEqual(["big", "after"])
      expect(page.leafId).toBe("after")
      expect(JSON.stringify(page.entries[0]).length).toBeLessThan(
        MAX_ENTRY_JSON_BYTES,
      )
      expect((page.entries[0] as any).text).toContain("transport-truncated")
    })

    it("many mid-size strings shrink across passes (multi-pass truncation)", () => {
      const wide: Record<string, unknown> = {
        type: "message",
        id: "wide",
        parentId: "",
      }
      for (let i = 0; i < 50; i++) wide[`f${i}`] = "y".repeat(100 * 1024)
      const page = pageEntries(
        [wide as unknown as SessionEntry],
        undefined,
        "wide",
        1024 * 1024,
      )
      expect(page.entries[0].id).toBe("wide")
      expect(JSON.stringify(page.entries[0]).length).toBeLessThan(
        MAX_ENTRY_JSON_BYTES,
      )
    })

    it("small log → single page, complete, leafId passes through", () => {
      const all = [mk("e1", 100), mk("e2", 100)]
      expect(pageEntries(all, undefined, "e2")).toEqual({
        entries: all,
        leafId: "e2",
      })
    })

    it("budget exceeded → partial page, leafId = last INCLUDED entry id", () => {
      const all = [mk("e1", 100_000), mk("e2", 100_000), mk("e3", 100_000)]
      const page = pageEntries(all, undefined, "e3", 150_000)
      expect(page.entries.map((e) => e.id)).toEqual(["e1", "e2"])
      expect(page.leafId).toBe("e2")
    })

    it("resumes after `since`; an unknown since restarts from index 0 (helper tolerance — handlers pre-validate)", () => {
      const all = [mk("e1", 10), mk("e2", 10), mk("e3", 10)]
      expect(
        pageEntries(all, "e1", "e3", 1000).entries.map((e) => e.id),
      ).toEqual(["e2", "e3"])
      expect(
        pageEntries(all, "nope", "e3", 1000).entries.map((e) => e.id),
      ).toEqual(["e1", "e2", "e3"])
    })

    it("a single entry larger than the budget still rides alone (guaranteed progress)", () => {
      const all = [mk("e1", 500_000), mk("e2", 10)]
      const page = pageEntries(all, undefined, "e2", 1000)
      expect(page.entries.map((e) => e.id)).toEqual(["e1"])
      expect(page.leafId).toBe("e1")
    })

    it("nothing after since → empty terminal page; empty log → passthrough", () => {
      const all = [mk("e1", 10)]
      expect(pageEntries(all, "e1", "e1")).toEqual({
        entries: [],
        leafId: "e1",
      })
      expect(pageEntries([], undefined, null)).toEqual({
        entries: [],
        leafId: null,
      })
    })
  })

  it("returns null for unhandled / typeless commands (forward-compat)", async () => {
    const h = handlers()
    expect(
      await dispatchRpcCommand({ type: "get_tree", id: "g" }, h),
    ).toBeNull()
    expect(await dispatchRpcCommand({ id: "no-type" }, h)).toBeNull()
    expect(h.prompt).not.toHaveBeenCalled()
  })
})

describe("TUI built-in slash intercept", () => {
  it("/compact executes the compact verb and never reaches prompt", async () => {
    const h = handlers({ compact: vi.fn(async () => ({})) })
    const resp = await dispatchRpcCommand(
      { type: "prompt", id: "c", message: "/compact focus on the plan" },
      h,
    )
    expect(h.compact).toHaveBeenCalledWith("focus on the plan")
    expect(h.prompt).not.toHaveBeenCalled()
    expect(resp).toEqual({
      rpc: { type: "response", command: "prompt", success: true, id: "c" },
    })
  })

  it("/new executes newSession", async () => {
    const h = handlers({ newSession: vi.fn(async () => ({ cancelled: false })) })
    await dispatchRpcCommand({ type: "prompt", id: "n", message: "/new" }, h)
    expect(h.newSession).toHaveBeenCalled()
    expect(h.prompt).not.toHaveBeenCalled()
  })

  it("bare /name and /model without args are consumed as usage toasts", async () => {
    const h = handlers()
    await dispatchRpcCommand({ type: "prompt", id: "a", message: "/name" }, h)
    await dispatchRpcCommand({ type: "prompt", id: "b", message: "/model" }, h)
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.setModel).not.toHaveBeenCalled()
  })

  it("/settings is TUI-only: consumed, no verb called", async () => {
    const h = handlers()
    await dispatchRpcCommand({ type: "prompt", id: "s", message: "/settings" }, h)
    expect(h.prompt).not.toHaveBeenCalled()
  })

  it("unknown /foo is refused when isKnownSlash says false", async () => {
    const h = handlers({ isKnownSlash: () => false })
    await dispatchRpcCommand({ type: "prompt", id: "u", message: "/foo bar" }, h)
    expect(h.prompt).not.toHaveBeenCalled()
  })

  it("unknown /foo passes when isKnownSlash is true (template/skill)", async () => {
    const h = handlers({ isKnownSlash: () => true })
    await dispatchRpcCommand({ type: "prompt", id: "t", message: "/deploy prod" }, h)
    expect(h.prompt).toHaveBeenCalledWith("/deploy prod", expect.anything())
  })

  it("unknown /foo passes when no isKnownSlash handler (status quo)", async () => {
    const h = handlers()
    await dispatchRpcCommand({ type: "prompt", id: "q", message: "/foo" }, h)
    expect(h.prompt).toHaveBeenCalledWith("/foo", expect.anything())
  })

  it("/unbien passes through to pi (extension command)", async () => {
    const h = handlers({ isKnownSlash: () => true })
    await dispatchRpcCommand({ type: "prompt", id: "ub", message: "/unbien status" }, h)
    expect(h.prompt).toHaveBeenCalledWith("/unbien status", expect.anything())
  })

  it("/model <term> with a unique match sets the model", async () => {
    const h = handlers({
      getAvailableModels: vi.fn(async () => [
        { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "gpt-5", name: "GPT-5", provider: "openai" },
      ]),
    })
    await dispatchRpcCommand({ type: "prompt", id: "m", message: "/model sonnet" }, h)
    expect(h.setModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4")
    expect(h.prompt).not.toHaveBeenCalled()
  })

  it("/model <term> ambiguous consumes with a warning (no set, no send)", async () => {
    const h = handlers({
      getAvailableModels: vi.fn(async () => [
        { id: "a-one", name: "One", provider: "p" },
        { id: "a-two", name: "Two", provider: "p" },
      ]),
    })
    await dispatchRpcCommand({ type: "prompt", id: "m2", message: "/model a" }, h)
    expect(h.setModel).not.toHaveBeenCalled()
    expect(h.prompt).not.toHaveBeenCalled()
  })
})

describe("TUI built-in slash intercept — absolute-path pass-through", () => {
  it("path-shaped tokens pass to the model (inner slash)", async () => {
    const h = handlers({ isKnownSlash: () => false })
    await dispatchRpcCommand(
      { type: "prompt", id: "p1", message: "/Users/george/x/refactor.ts please" },
      h,
    )
    expect(h.prompt).toHaveBeenCalledWith(
      "/Users/george/x/refactor.ts please",
      expect.anything(),
    )
  })

  it("bare known filesystem roots pass (/etc/hosts-style and bare)", async () => {
    const h = handlers({ isKnownSlash: () => false })
    await dispatchRpcCommand({ type: "prompt", id: "p2", message: "/etc/hosts" }, h)
    await dispatchRpcCommand({ type: "prompt", id: "p3", message: "/tmp" }, h)
    expect(h.prompt).toHaveBeenCalledTimes(2)
  })

  it("unknown single-word slash is still refused", async () => {
    const h = handlers({ isKnownSlash: () => false })
    await dispatchRpcCommand({ type: "prompt", id: "p4", message: "/foo" }, h)
    expect(h.prompt).not.toHaveBeenCalled()
  })
})
