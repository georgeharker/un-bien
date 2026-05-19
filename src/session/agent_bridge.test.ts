import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ServerMessage } from "../protocol/types.js";
import { AgentBridge, type BridgeToolCallContext, type PeerChannel } from "./agent_bridge.js";

// ── Minimal mocks ─────────────────────────────────────────────────────────────

class MockSession {
  private listeners: Array<(e: AgentSessionEvent) => void> = [];
  readonly promptArgs: string[] = [];
  abortCount = 0;

  subscribe(l: (e: AgentSessionEvent) => void): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  emit(ev: AgentSessionEvent): void {
    for (const l of this.listeners) l(ev);
  }

  async prompt(text: string): Promise<void> {
    this.promptArgs.push(text);
  }

  async abort(): Promise<void> {
    this.abortCount++;
    this.emit({ type: "agent_end", messages: [] });
  }

  get isStreaming(): boolean {
    return false;
  }
}

class MockChannel implements PeerChannel {
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTextDeltaEvent(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: {} as AgentSessionEvent extends { type: "message_update" }
      ? never
      : never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: {} as never,
    },
  } as unknown as AgentSessionEvent;
}

function makeToolEndEvent(
  toolCallId: string,
  result: unknown,
  isError = false,
): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "Bash",
    result,
    isError,
  } as unknown as AgentSessionEvent;
}

function makeToolCtx(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): BridgeToolCallContext {
  return {
    toolCall: { toolCallId, toolCall: { name: toolName, arguments: args } },
    args,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AgentBridge", () => {
  let session: MockSession;
  let channel: MockChannel;
  let bridge: AgentBridge;

  beforeEach(() => {
    session = new MockSession();
    channel = new MockChannel();
    bridge = new AgentBridge(session as unknown as AgentSession, channel);
  });

  afterEach(() => {
    bridge.dispose();
  });

  // ── user_message → chunks → agent_done ───────────────────────────────────

  test("user_message triggers prompt; 3 text deltas + agent_done flow", () => {
    bridge.onClientMessage({
      type: "user_message",
      id: "turn-1",
      text: "hello Pi",
    });

    expect(session.promptArgs).toEqual(["hello Pi"]);

    // Simulate 3 text delta events
    session.emit(makeTextDeltaEvent("foo "));
    session.emit(makeTextDeltaEvent("bar "));
    session.emit(makeTextDeltaEvent("baz"));

    // Simulate agent_end
    session.emit({ type: "agent_end", messages: [] });

    const chunks = channel.sent.filter((m) => m.type === "agent_chunk");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      type: "agent_chunk",
      in_reply_to: "turn-1",
      delta: "foo ",
    });
    expect(chunks[2]).toEqual({
      type: "agent_chunk",
      in_reply_to: "turn-1",
      delta: "baz",
    });

    const done = channel.sent.filter((m) => m.type === "agent_done");
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({ type: "agent_done", in_reply_to: "turn-1" });
  });

  // ── tool_call Bash → tool_request → approve_tool deny → turn aborts ───────

  test("Bash tool_call emits tool_request; deny blocks execution and aborts", async () => {
    bridge.onClientMessage({
      type: "user_message",
      id: "turn-2",
      text: "do stuff",
    });

    const ctx = makeToolCtx("tc_bash_1", "Bash", { command: "rm -rf /" });
    const blockPromise = bridge.beforeToolCallHook(ctx);

    // tool_request must have been sent synchronously before await
    expect(
      channel.sent.find((m) => m.type === "tool_request"),
    ).toMatchObject({
      type: "tool_request",
      tool_call_id: "tc_bash_1",
      tool: "Bash",
      args: { command: "rm -rf /" },
    });

    // User denies
    bridge.onClientMessage({
      type: "approve_tool",
      id: "approve-1",
      tool_call_id: "tc_bash_1",
      decision: "deny",
    });

    const result = await blockPromise;

    // beforeToolCall returns block:true (Bash must NOT run)
    expect(result?.block).toBe(true);

    // Session must have been aborted
    expect(session.abortCount).toBeGreaterThanOrEqual(1);
  });

  // ── tool_call Read → auto-approve → tool_result (no tool_request) ─────────

  test("Read tool_call auto-approves without emitting tool_request", async () => {
    bridge.onClientMessage({
      type: "user_message",
      id: "turn-3",
      text: "read a file",
    });

    const ctx = makeToolCtx("tc_read_1", "Read", { file_path: "/foo.ts" });
    const result = await bridge.beforeToolCallHook(ctx);

    // No block, no tool_request
    expect(result).toBeUndefined();
    expect(channel.sent.some((m) => m.type === "tool_request")).toBe(false);

    // Simulate tool completing
    session.emit(
      makeToolEndEvent("tc_read_1", { content: [{ type: "text", text: "file content" }] }),
    );

    const toolResults = channel.sent.filter((m) => m.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: "tool_result",
      tool_call_id: "tc_read_1",
    });
  });

  // ── tool_result for error case ─────────────────────────────────────────────

  test("tool_execution_end with isError=true emits tool_result with error field", async () => {
    bridge.onClientMessage({
      type: "user_message",
      id: "turn-4",
      text: "do something",
    });

    const ctx = makeToolCtx("tc_err_1", "Read", { file_path: "/missing" });
    await bridge.beforeToolCallHook(ctx);

    session.emit(makeToolEndEvent("tc_err_1", "file not found", true));

    const toolResults = channel.sent.filter((m) => m.type === "tool_result");
    expect(toolResults[0]).toMatchObject({
      type: "tool_result",
      tool_call_id: "tc_err_1",
      error: "file not found",
    });
  });

  // ── cancel → session.abort + cancelled emitted ────────────────────────────

  test("cancel aborts session and emits cancelled with correct in_reply_to", async () => {
    bridge.onClientMessage({
      type: "cancel",
      id: "cancel-1",
      target_id: "turn-5",
    });

    // abort() emits agent_end internally in mock
    expect(session.abortCount).toBe(1);

    const cancelled = channel.sent.find((m) => m.type === "cancelled");
    expect(cancelled).toEqual({
      type: "cancelled",
      in_reply_to: "cancel-1",
      target_id: "turn-5",
    });
  });

  // ── ping → pong ───────────────────────────────────────────────────────────

  test("ping returns pong with correct in_reply_to", () => {
    bridge.onClientMessage({ type: "ping", id: "ping-42" });

    expect(channel.sent).toContainEqual({
      type: "pong",
      in_reply_to: "ping-42",
    });
  });

  // ── tool_request timeout → auto-deny + error{code:'timeout'} ─────────────

  test("tool approval timeout after 60s auto-denies and emits error:timeout", async () => {
    vi.useFakeTimers();

    bridge.onClientMessage({
      type: "user_message",
      id: "turn-timeout",
      text: "do something slow",
    });

    const ctx = makeToolCtx("tc_timeout_1", "Bash", { command: "sleep 9999" });
    const blockPromise = bridge.beforeToolCallHook(ctx);

    // tool_request was sent
    expect(channel.sent.some((m) => m.type === "tool_request")).toBe(true);

    // Advance 60 seconds — triggers the timeout handler
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await blockPromise;

    // Should have auto-denied
    expect(result?.block).toBe(true);

    // error{code:'timeout'} should have been sent
    const err = channel.sent.find(
      (m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error",
    );
    expect(err).toBeDefined();
    expect(err?.code).toBe("timeout");

    vi.useRealTimers();
  });

  // ── dispose cleans up pending approvals ────────────────────────────────────

  test("dispose resolves pending approvals as deny and unsubscribes", async () => {
    bridge.onClientMessage({
      type: "user_message",
      id: "turn-dispose",
      text: "hi",
    });

    const ctx = makeToolCtx("tc_dispose_1", "Write", { file_path: "/x", content: "y" });
    const blockPromise = bridge.beforeToolCallHook(ctx);

    bridge.dispose();

    const result = await blockPromise;
    expect(result?.block).toBe(true);
  });
});
