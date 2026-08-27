import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRpcEnvelope, envelopeForEvent, RPC_EVENT_NAMES } from "./rpc_envelope.js";

// Golden shapes are grounded in the real `pi --mode rpc` capture
// (un-bien Tests/Fixtures/rpc-stream/message-turn-clean.jsonl): a message_update
// wire frame is `{ type, usage, assistantMessageEvent }` with NO cumulative
// `message` and NO `assistantMessageEvent.partial`.

describe("envelopeForEvent — live plane", () => {
  it("message_update strips the cumulative snapshot and lifts usage", () => {
    const usage = { input: 2, output: 1, totalTokens: 3 };
    const env = envelopeForEvent("message_update", {
      type: "message_update",
      message: { role: "assistant", usage, content: [{ type: "text", text: "hello world" }] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: { content: [{ type: "text", text: "hello" }] },
      },
    });
    expect(env).toEqual({
      rpc: {
        type: "message_update",
        usage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
      },
    });
    // No cumulative fields leak onto the wire.
    const ame = (env?.rpc as { assistantMessageEvent: Record<string, unknown> }).assistantMessageEvent;
    expect("partial" in ame).toBe(false);
    expect("message" in (env?.rpc as object)).toBe(false);
  });

  it("toolcall_start keeps constant-sized id + toolName", () => {
    const env = envelopeForEvent("message_update", {
      type: "message_update",
      message: { usage: {} },
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: { content: [{ type: "text" }, { type: "toolCall", id: "tc_1", name: "bash" }] },
      },
    });
    const ame = (env?.rpc as { assistantMessageEvent: Record<string, unknown> }).assistantMessageEvent;
    expect(ame).toMatchObject({ type: "toolcall_start", contentIndex: 1, id: "tc_1", toolName: "bash" });
    expect("partial" in ame).toBe(false);
  });

  it("turn_start drops extension-only enrichment (bare rpc frame)", () => {
    const env = envelopeForEvent("turn_start", { type: "turn_start", turnIndex: 3, timestamp: 123 });
    expect(env).toEqual({ rpc: { type: "turn_start" } });
  });

  it("turn_end keeps message + toolResults only", () => {
    const message = { role: "assistant", content: [] };
    const env = envelopeForEvent("turn_end", { type: "turn_end", turnIndex: 3, message, toolResults: [] });
    expect(env).toEqual({ rpc: { type: "turn_end", message, toolResults: [] } });
  });

  it("tool_execution_end passes through the card fields", () => {
    const env = envelopeForEvent("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tc_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    expect(env).toEqual({
      rpc: {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      },
    });
  });

  it("message_end / message_start carry the message", () => {
    const message = { role: "user", content: [{ type: "text", text: "hi" }] };
    expect(envelopeForEvent("message_end", { type: "message_end", message })).toEqual({
      rpc: { type: "message_end", message },
    });
    expect(envelopeForEvent("message_start", { type: "message_start", message })).toEqual({
      rpc: { type: "message_start", message },
    });
  });

  it("session_compact remaps to a compaction_end frame the consumer renders", () => {
    const env = envelopeForEvent("session_compact", {
      type: "session_compact",
      reason: "threshold",
      fromExtension: false,
      compactionEntry: { summary: "did stuff", tokensBefore: 150000, firstKeptEntryId: "abc" },
    });
    expect(env).toEqual({
      rpc: {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "did stuff", tokensBefore: 150000 },
        aborted: false,
        willRetry: false,
      },
    });
  });

  it("agent_settled / agent_start are bare; agent_end defaults willRetry", () => {
    expect(envelopeForEvent("agent_settled", { type: "agent_settled" })).toEqual({ rpc: { type: "agent_settled" } });
    expect(envelopeForEvent("agent_start", { type: "agent_start" })).toEqual({ rpc: { type: "agent_start" } });
    expect(envelopeForEvent("agent_end", { type: "agent_end", messages: [] })).toEqual({
      rpc: { type: "agent_end", messages: [], willRetry: false },
    });
  });

  it("returns null for events with no streamed frame", () => {
    expect(envelopeForEvent("context", { type: "context", messages: [] })).toBeNull();
    expect(envelopeForEvent("model_select", { type: "model_select" })).toBeNull();
  });
});

describe("createRpcEnvelope — wiring", () => {
  function fakePi() {
    const handlers = new Map<string, (payload: unknown) => void>();
    const pi = {
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
      }),
    } as unknown as ExtensionAPI;
    return { pi, handlers };
  }

  it("registers a handler for every rpc event name", () => {
    const { pi, handlers } = fakePi();
    createRpcEnvelope(pi, () => {});
    for (const name of RPC_EVENT_NAMES) expect(handlers.has(name)).toBe(true);
  });

  it("broadcasts the frame when an event fires", () => {
    const { pi, handlers } = fakePi();
    const out: unknown[] = [];
    createRpcEnvelope(pi, (env) => out.push(env));
    handlers.get("message_end")?.({ type: "message_end", message: { role: "user", content: [] } });
    expect(out).toEqual([{ rpc: { type: "message_end", message: { role: "user", content: [] } } }]);
  });

  it("stops broadcasting after dispose()", () => {
    const { pi, handlers } = fakePi();
    const out: unknown[] = [];
    const h = createRpcEnvelope(pi, (env) => out.push(env));
    h.dispose();
    handlers.get("turn_start")?.({ type: "turn_start" });
    expect(out).toEqual([]);
  });

  it("swallows broadcast errors (never escapes the SDK callback)", () => {
    const { pi, handlers } = fakePi();
    createRpcEnvelope(pi, () => {
      throw new Error("relay down");
    });
    expect(() => handlers.get("agent_settled")?.({ type: "agent_settled" })).not.toThrow();
  });
});
