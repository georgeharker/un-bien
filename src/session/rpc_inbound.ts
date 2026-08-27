// App -> fork inbound: interpret an envelope-carried pi `RpcCommand` and drive
// the SDK, then answer with a `{ rpc: { type:"response", ... } }` envelope back
// to the sender. This is the NEW-protocol-native inbound path — it does NOT go
// through the stock `ClientMessage` / `_routeClientMessageFrom` switch (that,
// with its `error`/`cancelled`/`pong` ServerMessage replies, is old protocol,
// retired). The SDK primitives the handlers wrap (sendUserMessage/_wakeAgent,
// ctx.abort) are pi itself, not old protocol.
//
// Command shapes: pi.dev/docs/latest/rpc. v1 surface = prompt / steer /
// follow_up / abort / set_model / set_thinking_level. get_state / get_entries /
// compact / bash follow (they need the fuller ctx.sessionManager).

import type { EnvelopeMessage } from "./rpc_envelope.js";

/** Build a `{ rpc: response }` envelope. Correlates by the command's `id`. */
export function rpcResponse(
  command: string,
  id: string | undefined,
  result: { success: boolean; data?: unknown; error?: string },
): EnvelopeMessage {
  const frame: Record<string, unknown> = { type: "response", command, success: result.success };
  if (id !== undefined) frame.id = id;
  if (result.data !== undefined) frame.data = result.data;
  if (result.error !== undefined) frame.error = result.error;
  return { rpc: frame };
}

/** SDK-facing operations the dispatcher needs; wired to fork primitives. */
export interface RpcCommandHandlers {
  prompt(message: string, opts: { images?: unknown; streamingBehavior?: string }): Promise<void>;
  steer(message: string, opts: { images?: unknown }): Promise<void>;
  followUp(message: string, opts: { images?: unknown }): Promise<void>;
  abort(): Promise<void>;
  /** Switch the live model; resolves to the wire Model object for the response. */
  setModel(provider: string, modelId: string): Promise<unknown>;
  /** Set the thinking (reasoning-effort) level. */
  setThinkingLevel(level: string): Promise<void>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Map an inbound rpc command frame to an SDK call and produce the response
 * envelope. Returns `null` for commands we don't handle yet (ignored —
 * forward-compatible). A handler throw becomes `success:false` with the message.
 */
export async function dispatchRpcCommand(
  frame: Record<string, unknown>,
  handlers: RpcCommandHandlers,
): Promise<EnvelopeMessage | null> {
  const command = typeof frame.type === "string" ? frame.type : undefined;
  if (!command) return null;
  const id = typeof frame.id === "string" ? frame.id : undefined;
  try {
    switch (command) {
      case "prompt":
        await handlers.prompt(str(frame.message), {
          images: frame.images,
          streamingBehavior: typeof frame.streamingBehavior === "string" ? frame.streamingBehavior : undefined,
        });
        return rpcResponse("prompt", id, { success: true });
      case "steer":
        await handlers.steer(str(frame.message), { images: frame.images });
        return rpcResponse("steer", id, { success: true });
      case "follow_up":
        await handlers.followUp(str(frame.message), { images: frame.images });
        return rpcResponse("follow_up", id, { success: true });
      case "abort":
        await handlers.abort();
        return rpcResponse("abort", id, { success: true });
      case "set_model": {
        const data = await handlers.setModel(str(frame.provider), str(frame.modelId));
        return rpcResponse("set_model", id, { success: true, data });
      }
      case "set_thinking_level":
        await handlers.setThinkingLevel(str(frame.level));
        return rpcResponse("set_thinking_level", id, { success: true });
      default:
        return null; // unhandled command: ignore (forward-compat)
    }
  } catch (err) {
    return rpcResponse(command, id, { success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
