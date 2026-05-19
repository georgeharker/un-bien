import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";
import { decide } from "./tool_gate.js";

// ── Interfaces ────────────────────────────────────────────────────────────────

/**
 * Abstraction over the Noise-encrypted transport.
 * Wave 3 plugs the real channel; tests use a mock.
 */
export interface PeerChannel {
  send(msg: ServerMessage): void;
}

/**
 * Minimal subset of BeforeToolCallContext consumed by the bridge.
 * Shape-compatible with @mariozechner/pi-agent-core BeforeToolCallContext.
 */
export interface BridgeToolCallContext {
  toolCall: {
    toolCallId: string;
    toolCall: {
      name: string;
      arguments: Record<string, unknown>;
    };
  };
  args: unknown;
}

const APPROVAL_TIMEOUT_MS = 60_000;

// ── AgentBridge ───────────────────────────────────────────────────────────────

/**
 * Bridges an AgentSession (Pi SDK) and a PeerChannel (remote app).
 *
 * Wire-up at session creation:
 *   const bridge = new AgentBridge(session, channel)
 *   // pass bridge.beforeToolCallHook to createAgentSession as beforeToolCall
 *
 * Then route incoming client messages:
 *   channel.on('message', msg => bridge.onClientMessage(msg))
 */
export class AgentBridge {
  private readonly session: AgentSession;
  private readonly channel: PeerChannel;
  /** ID of the active user_message turn, used as in_reply_to for streaming. */
  private currentTurnId: string | null = null;
  /** Pending tool approvals keyed by tool_call_id. */
  private readonly pendingApprovals = new Map<
    string,
    (decision: "allow" | "deny") => void
  >();
  private readonly unsubscribe: () => void;

  constructor(session: AgentSession, channel: PeerChannel) {
    this.session = session;
    this.channel = channel;
    this.unsubscribe = session.subscribe(this.onSessionEvent.bind(this));
  }

  // ── beforeToolCall hook ────────────────────────────────────────────────────

  /**
   * Pass this as `beforeToolCall` in createAgentSession options.
   * Auto-approves whitelisted tools; pauses everything else for user approval.
   */
  readonly beforeToolCallHook = async (
    ctx: BridgeToolCallContext,
    signal?: AbortSignal,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    const toolName = ctx.toolCall.toolCall.name;
    const toolCallId = ctx.toolCall.toolCallId;

    if (decide(toolName) === "auto") {
      return undefined; // proceed immediately
    }

    // Needs user approval: emit tool_request and block until response
    this.channel.send({
      type: "tool_request",
      tool_call_id: toolCallId,
      tool: toolName,
      args: ctx.args as Record<string, unknown>,
    });

    const decision = await this.awaitApproval(toolCallId, signal);

    if (decision === "deny") {
      // Cancel the whole turn — user denied execution
      void this.session.abort();
      return { block: true, reason: "denied by user" };
    }

    return undefined; // allow
  };

  // ── Incoming client messages ───────────────────────────────────────────────

  onClientMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case "user_message":
        this.currentTurnId = msg.id;
        void this.session.prompt(msg.text);
        break;

      case "approve_tool": {
        const resolve = this.pendingApprovals.get(msg.tool_call_id);
        if (resolve) resolve(msg.decision);
        break;
      }

      case "cancel":
        void this.session.abort();
        this.channel.send({
          type: "cancelled",
          in_reply_to: msg.id,
          target_id: msg.target_id,
        });
        break;

      case "ping":
        this.channel.send({ type: "pong", in_reply_to: msg.id });
        break;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  dispose(): void {
    this.unsubscribe();
    for (const resolve of this.pendingApprovals.values()) {
      resolve("deny");
    }
    this.pendingApprovals.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private awaitApproval(
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<"allow" | "deny"> {
    return new Promise<"allow" | "deny">((resolve) => {
      let settled = false;

      const settle = (d: "allow" | "deny") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingApprovals.delete(toolCallId);
        resolve(d);
      };

      // 60 s timeout → auto-deny + inform remote peer
      const timer = setTimeout(() => {
        this.channel.send({
          type: "error",
          code: "timeout",
          message: `tool approval timeout: ${toolCallId}`,
        });
        settle("deny");
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(toolCallId, settle);

      signal?.addEventListener("abort", () => settle("deny"), { once: true });
    });
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    // ── text streaming ─────────────────────────────────────────────────────
    if (event.type === "message_update" && this.currentTurnId !== null) {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_delta") {
        this.channel.send({
          type: "agent_chunk",
          in_reply_to: this.currentTurnId,
          delta: ae.delta,
        });
      }
    }

    // ── tool result ────────────────────────────────────────────────────────
    if (event.type === "tool_execution_end") {
      const toolResult: ServerMessage = event.isError
        ? {
            type: "tool_result",
            tool_call_id: event.toolCallId,
            error: String(event.result),
          }
        : {
            type: "tool_result",
            tool_call_id: event.toolCallId,
            result: event.result as unknown,
          };
      this.channel.send(toolResult);
    }

    // ── turn complete ──────────────────────────────────────────────────────
    if (event.type === "agent_end" && this.currentTurnId !== null) {
      this.channel.send({ type: "agent_done", in_reply_to: this.currentTurnId });
      this.currentTurnId = null;
    }
  }
}
