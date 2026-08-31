import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  dispatchRpcCommand,
  type GetEntriesResult,
  pageEntries,
  rpcResponse,
  type RpcCommandHandlers,
} from "./rpc_inbound.js";

function handlers(over: Partial<RpcCommandHandlers> = {}): RpcCommandHandlers {
  return {
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => ({ provider: "anthropic", id: "claude" })),
    setThinkingLevel: vi.fn(async () => {}),
    ...over,
  };
}

describe("rpcResponse", () => {
  it("builds a {rpc:response} envelope correlated by id", () => {
    expect(rpcResponse("prompt", "req-1", { success: true })).toEqual({
      rpc: { type: "response", command: "prompt", success: true, id: "req-1" },
    });
  });
  it("omits id/data/error when absent; carries them when present", () => {
    expect(rpcResponse("abort", undefined, { success: true })).toEqual({
      rpc: { type: "response", command: "abort", success: true },
    });
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
    });
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
    });
  });
});

describe("dispatchRpcCommand", () => {
  it("prompt → handler + success response, passing streamingBehavior/images", async () => {
    const h = handlers();
    const resp = await dispatchRpcCommand(
      {
        type: "prompt",
        id: "p1",
        message: "hi",
        images: [{ x: 1 }],
        streamingBehavior: "steer",
      },
      h,
    );
    expect(h.prompt).toHaveBeenCalledWith("hi", {
      id: "p1",
      images: [{ x: 1 }],
      streamingBehavior: "steer",
    });
    expect(resp).toEqual({
      rpc: { type: "response", command: "prompt", success: true, id: "p1" },
    });
  });

  it("steer / follow_up / abort each dispatch + ack", async () => {
    const h = handlers();
    expect(
      await dispatchRpcCommand({ type: "steer", id: "s", message: "go" }, h),
    ).toEqual({
      rpc: { type: "response", command: "steer", success: true, id: "s" },
    });
    expect(h.steer).toHaveBeenCalledWith("go", { images: undefined });
    expect(
      await dispatchRpcCommand({ type: "follow_up", message: "later" }, h),
    ).toEqual({
      rpc: { type: "response", command: "follow_up", success: true },
    });
    expect(await dispatchRpcCommand({ type: "abort", id: "a" }, h)).toEqual({
      rpc: { type: "response", command: "abort", success: true, id: "a" },
    });
    expect(h.abort).toHaveBeenCalledOnce();
  });

  it("a handler throw becomes success:false with the message", async () => {
    const h = handlers({
      prompt: vi.fn(async () => {
        throw new Error("agent busy");
      }),
    });
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
    });
  });

  it("set_model → handler + response carrying the model data", async () => {
    const h = handlers({
      setModel: vi.fn(async () => ({
        provider: "anthropic",
        id: "claude-opus",
      })),
    });
    const resp = await dispatchRpcCommand(
      {
        type: "set_model",
        id: "m",
        provider: "anthropic",
        modelId: "claude-opus",
      },
      h,
    );
    expect(h.setModel).toHaveBeenCalledWith("anthropic", "claude-opus");
    expect(resp).toEqual({
      rpc: {
        type: "response",
        command: "set_model",
        success: true,
        id: "m",
        data: { provider: "anthropic", id: "claude-opus" },
      },
    });
  });

  it("set_thinking_level → handler + ack", async () => {
    const h = handlers();
    const resp = await dispatchRpcCommand(
      { type: "set_thinking_level", id: "t", level: "high" },
      h,
    );
    expect(h.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(resp).toEqual({
      rpc: {
        type: "response",
        command: "set_thinking_level",
        success: true,
        id: "t",
      },
    });
  });

  it("get_entries → handler(since) + response carrying {entries, leafId}", async () => {
    const data = {
      entries: [{ type: "message", id: "e1" }],
      leafId: "e1",
    } as unknown as GetEntriesResult;
    const h = handlers({ getEntries: vi.fn(async () => data) });
    const resp = await dispatchRpcCommand(
      { type: "get_entries", id: "ge", since: "e0" },
      h,
    );
    expect(h.getEntries).toHaveBeenCalledWith("e0");
    expect(resp).toEqual({
      rpc: {
        type: "response",
        command: "get_entries",
        success: true,
        id: "ge",
        data,
      },
    });
  });

  it("get_entries without `since` passes undefined; an unwired handler → null", async () => {
    const h = handlers({
      getEntries: vi.fn(async () => ({ entries: [], leafId: null })),
    });
    await dispatchRpcCommand({ type: "get_entries", id: "g2" }, h);
    expect(h.getEntries).toHaveBeenCalledWith(undefined);
    // getEntries is optional — unset means the command falls through to null.
    expect(
      await dispatchRpcCommand({ type: "get_entries", id: "g3" }, handlers()),
    ).toBeNull();
  });

  // get_entries backfill paging: the reply is ONE budget-bounded page; the
  // shape stays pi-faithful ({entries, leafId} — no extra fields). The app
  // loops `since: leafId` until an empty page.
  describe("pageEntries", () => {
    const mk = (id: string, size: number) =>
      ({
        type: "message",
        id,
        text: "x".repeat(Math.max(0, size - 40)),
      }) as unknown as SessionEntry;

    it("small log → single page, complete, leafId passes through", () => {
      const all = [mk("e1", 100), mk("e2", 100)];
      expect(pageEntries(all, undefined, "e2")).toEqual({
        entries: all,
        leafId: "e2",
      });
    });

    it("budget exceeded → partial page, leafId = last INCLUDED entry id", () => {
      const all = [mk("e1", 100_000), mk("e2", 100_000), mk("e3", 100_000)];
      const page = pageEntries(all, undefined, "e3", 150_000);
      expect(page.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
      expect(page.leafId).toBe("e2");
    });

    it("resumes after `since`; an unknown since restarts from index 0 (helper tolerance — handlers pre-validate)", () => {
      const all = [mk("e1", 10), mk("e2", 10), mk("e3", 10)];
      expect(
        pageEntries(all, "e1", "e3", 1000).entries.map((e) => e.id),
      ).toEqual(["e2", "e3"]);
      expect(
        pageEntries(all, "nope", "e3", 1000).entries.map((e) => e.id),
      ).toEqual(["e1", "e2", "e3"]);
    });

    it("a single entry larger than the budget still rides alone (guaranteed progress)", () => {
      const all = [mk("e1", 500_000), mk("e2", 10)];
      const page = pageEntries(all, undefined, "e2", 1000);
      expect(page.entries.map((e) => e.id)).toEqual(["e1"]);
      expect(page.leafId).toBe("e1");
    });

    it("nothing after since → empty terminal page; empty log → passthrough", () => {
      const all = [mk("e1", 10)];
      expect(pageEntries(all, "e1", "e1")).toEqual({
        entries: [],
        leafId: "e1",
      });
      expect(pageEntries([], undefined, null)).toEqual({
        entries: [],
        leafId: null,
      });
    });
  });

  it("returns null for unhandled / typeless commands (forward-compat)", async () => {
    const h = handlers();
    expect(
      await dispatchRpcCommand({ type: "get_tree", id: "g" }, h),
    ).toBeNull();
    expect(await dispatchRpcCommand({ id: "no-type" }, h)).toBeNull();
    expect(h.prompt).not.toHaveBeenCalled();
  });
});
