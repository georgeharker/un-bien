import { describe, expect, it, vi } from "vitest";
import { dispatchRpcCommand, rpcResponse, type RpcCommandHandlers } from "./rpc_inbound.js";

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
    expect(rpcResponse("get_state", "x", { success: true, data: { a: 1 } })).toEqual({
      rpc: { type: "response", command: "get_state", success: true, id: "x", data: { a: 1 } },
    });
    expect(rpcResponse("prompt", "x", { success: false, error: "boom" })).toEqual({
      rpc: { type: "response", command: "prompt", success: false, id: "x", error: "boom" },
    });
  });
});

describe("dispatchRpcCommand", () => {
  it("prompt → handler + success response, passing streamingBehavior/images", async () => {
    const h = handlers();
    const resp = await dispatchRpcCommand(
      { type: "prompt", id: "p1", message: "hi", images: [{ x: 1 }], streamingBehavior: "steer" },
      h,
    );
    expect(h.prompt).toHaveBeenCalledWith("hi", { images: [{ x: 1 }], streamingBehavior: "steer" });
    expect(resp).toEqual({ rpc: { type: "response", command: "prompt", success: true, id: "p1" } });
  });

  it("steer / follow_up / abort each dispatch + ack", async () => {
    const h = handlers();
    expect(await dispatchRpcCommand({ type: "steer", id: "s", message: "go" }, h)).toEqual({
      rpc: { type: "response", command: "steer", success: true, id: "s" },
    });
    expect(h.steer).toHaveBeenCalledWith("go", { images: undefined });
    expect(await dispatchRpcCommand({ type: "follow_up", message: "later" }, h)).toEqual({
      rpc: { type: "response", command: "follow_up", success: true },
    });
    expect(await dispatchRpcCommand({ type: "abort", id: "a" }, h)).toEqual({
      rpc: { type: "response", command: "abort", success: true, id: "a" },
    });
    expect(h.abort).toHaveBeenCalledOnce();
  });

  it("a handler throw becomes success:false with the message", async () => {
    const h = handlers({ prompt: vi.fn(async () => { throw new Error("agent busy"); }) });
    expect(await dispatchRpcCommand({ type: "prompt", id: "p", message: "x" }, h)).toEqual({
      rpc: { type: "response", command: "prompt", success: false, id: "p", error: "agent busy" },
    });
  });

  it("set_model → handler + response carrying the model data", async () => {
    const h = handlers({ setModel: vi.fn(async () => ({ provider: "anthropic", id: "claude-opus" })) });
    const resp = await dispatchRpcCommand({ type: "set_model", id: "m", provider: "anthropic", modelId: "claude-opus" }, h);
    expect(h.setModel).toHaveBeenCalledWith("anthropic", "claude-opus");
    expect(resp).toEqual({
      rpc: { type: "response", command: "set_model", success: true, id: "m", data: { provider: "anthropic", id: "claude-opus" } },
    });
  });

  it("set_thinking_level → handler + ack", async () => {
    const h = handlers();
    const resp = await dispatchRpcCommand({ type: "set_thinking_level", id: "t", level: "high" }, h);
    expect(h.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(resp).toEqual({ rpc: { type: "response", command: "set_thinking_level", success: true, id: "t" } });
  });

  it("returns null for unhandled / typeless commands (forward-compat)", async () => {
    const h = handlers();
    expect(await dispatchRpcCommand({ type: "get_tree", id: "g" }, h)).toBeNull();
    expect(await dispatchRpcCommand({ id: "no-type" }, h)).toBeNull();
    expect(h.prompt).not.toHaveBeenCalled();
  });
});
