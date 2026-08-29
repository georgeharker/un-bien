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

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EnvelopeMessage } from "./rpc_envelope.js";

/** Native pi `get_entries` result: the raw entry log + the leaf cursor to
 *  resume from. The app reduces `entries` into its transcript itself. */
export interface GetEntriesResult {
      entries: SessionEntry[];
      leafId: string | null;
}

/** Build a `{ rpc: response }` envelope. Correlates by the command's `id`. */
export function rpcResponse(
      command: string,
      id: string | undefined,
      result: { success: boolean; data?: unknown; error?: string },
): EnvelopeMessage {
      const frame: Record<string, unknown> = {
            type: "response",
            command,
            success: result.success,
      };
      if (id !== undefined) frame.id = id;
      if (result.data !== undefined) frame.data = result.data;
      if (result.error !== undefined) frame.error = result.error;
      return { rpc: frame };
}

/** SDK-facing operations the dispatcher needs; wired to fork primitives. */
export interface RpcCommandHandlers {
      prompt(
            message: string,
            opts: { id?: string; images?: unknown; streamingBehavior?: string },
      ): Promise<void>;
      steer(message: string, opts: { images?: unknown }): Promise<void>;
      followUp(message: string, opts: { images?: unknown }): Promise<void>;
      abort(): Promise<void>;
      /** Switch the live model; resolves to the wire Model object for the response. */
      setModel(provider: string, modelId: string): Promise<unknown>;
      /** Set the thinking (reasoning-effort) level. */
      setThinkingLevel(level: string): Promise<void>;
      /** List configured models (pi `get_available_models`); resolves to Model[].
       *  Optional while the surface is being wired — an unset handler falls through
       *  to the transitional stock path (returns null from dispatch). */
      getAvailableModels?(): Promise<unknown>;
      /** Manually compact context (pi `compact`); resolves to the CompactionResult. */
      compact?(customInstructions?: string): Promise<unknown>;
      /** Start a fresh session (pi `new_session`); resolves to {cancelled}. */
      newSession?(parentSession?: string): Promise<unknown>;
      /** Clear the steering/follow-up queue (pi `clear_queue`); resolves to the
       *  removed {steering, followUp} text. */
      clearQueue?(): Promise<unknown>;
      /** Return the session ENTRY log (pi `get_entries`); resolves to
       *  `{ entries, leafId }`. `since` slices to entries AFTER that entry id
       *  (the native delta cursor). This is the transcript source — the app
       *  reduces the raw entries itself; the fork does NOT replay them. */
      getEntries?(since?: string): Promise<GetEntriesResult>;
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
                              id,
                              images: frame.images,
                              streamingBehavior:
                                    typeof frame.streamingBehavior === "string"
                                          ? frame.streamingBehavior
                                          : undefined,
                        });
                        return rpcResponse("prompt", id, { success: true });
                  case "steer":
                        await handlers.steer(str(frame.message), {
                              images: frame.images,
                        });
                        return rpcResponse("steer", id, { success: true });
                  case "follow_up":
                        await handlers.followUp(str(frame.message), {
                              images: frame.images,
                        });
                        return rpcResponse("follow_up", id, { success: true });
                  case "abort":
                        await handlers.abort();
                        return rpcResponse("abort", id, { success: true });
                  case "set_model": {
                        const data = await handlers.setModel(
                              str(frame.provider),
                              str(frame.modelId),
                        );
                        return rpcResponse("set_model", id, {
                              success: true,
                              data,
                        });
                  }
                  case "set_thinking_level":
                        await handlers.setThinkingLevel(str(frame.level));
                        return rpcResponse("set_thinking_level", id, {
                              success: true,
                        });
                  case "get_available_models": {
                        if (!handlers.getAvailableModels) return null;
                        const data = await handlers.getAvailableModels();
                        return rpcResponse("get_available_models", id, {
                              success: true,
                              data,
                        });
                  }
                  case "compact": {
                        if (!handlers.compact) return null;
                        const data = await handlers.compact(
                              typeof frame.customInstructions === "string"
                                    ? frame.customInstructions
                                    : undefined,
                        );
                        return rpcResponse("compact", id, {
                              success: true,
                              data,
                        });
                  }
                  case "new_session": {
                        if (!handlers.newSession) return null;
                        const data = await handlers.newSession(
                              typeof frame.parentSession === "string"
                                    ? frame.parentSession
                                    : undefined,
                        );
                        return rpcResponse("new_session", id, {
                              success: true,
                              data,
                        });
                  }
                  case "clear_queue": {
                        if (!handlers.clearQueue) return null;
                        const data = await handlers.clearQueue();
                        return rpcResponse("clear_queue", id, {
                              success: true,
                              data,
                        });
                  }
                  case "get_entries": {
                        if (!handlers.getEntries) return null;
                        const data = await handlers.getEntries(
                              typeof frame.since === "string"
                                    ? frame.since
                                    : undefined,
                        );
                        return rpcResponse("get_entries", id, {
                              success: true,
                              data,
                        });
                  }
                  default:
                        return null; // unhandled command: ignore (forward-compat)
            }
      } catch (err) {
            return rpcResponse(command, id, {
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
            });
      }
}
