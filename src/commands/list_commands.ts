/**
 * Plan/28 Wave B Slice 1 — `list_commands` handler.
 *
 * Builds the catalog the app's slash-command picker renders. Sources:
 *
 *   1. **Builtins**: from `BUILTIN_SLASH_COMMANDS_MIRROR` (manual mirror of
 *      the Pi SDK's hardcoded list — see `builtin_mirror.ts` for why).
 *   2. **Extension / prompt / skill**: from `pi.getCommands()` at runtime,
 *      so anything our extension (or future plugins) register shows up
 *      automatically.
 *
 * Invokability of extension-registered commands is `true` by default — the
 * pi-extension owns its own command handlers and the Wave B Slice 2
 * dispatcher will call them directly via a local registry. Prompt and
 * skill commands stay `false` until we wire dispatch for them.
 */

import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import type { ClientMessage, ServerMessage, WireCommand } from "../protocol/types.js";
import {
  BUILTIN_SLASH_COMMANDS_MIRROR,
  builtinToWire,
  findBuiltin,
} from "./builtin_mirror.js";

/**
 * Minimal channel surface the handler needs to reply to the requesting
 * owner. `PlainPeerChannel` satisfies it; tests can pass a fake.
 */
export interface CommandReplySender {
  send(msg: ServerMessage): void;
}

/**
 * Subset of `ExtensionAPI` used by `handleListCommands`. Narrowing the
 * signature lets us instantiate fakes in tests without rebuilding the
 * whole `ExtensionAPI` surface.
 */
export interface CommandSourcePi {
  getCommands(): SlashCommandInfo[];
}

type ListCommandsMsg = Extract<ClientMessage, { type: "list_commands" }>;

/**
 * Build the wire catalog and send the reply. Pure modulo I/O on `sender`.
 *
 * Implementation notes:
 * - Builtins come first so the app's default ordering keeps the most
 *   familiar names (`/compact`, `/model`) near the top of the picker.
 *   The app may re-sort; this is only a default.
 * - Skills returned by `pi.getCommands()` are already prefixed with
 *   `skill:` in their `name` (per the SDK's runtime — see
 *   `agent-session.js`'s `_bindExtensionCore`). We forward verbatim.
 * - If a mirror entry's name collides with a registered command of a
 *   different source (extension overriding a builtin), the registered
 *   one wins — we strip the duplicate builtin from the output. This
 *   matches the TUI's actual dispatch order.
 */
export function handleListCommands(
  pi: CommandSourcePi,
  sender: CommandReplySender,
  msg: ListCommandsMsg,
): void {
  const registered = pi.getCommands();

  const registeredNames = new Set(registered.map((c) => c.name));
  const builtinWire: WireCommand[] = BUILTIN_SLASH_COMMANDS_MIRROR
    .filter((b) => !registeredNames.has(b.name))
    .map(builtinToWire);

  const registeredWire: WireCommand[] = registered.map((c) =>
    sdkCommandToWire(c),
  );

  const commands: WireCommand[] = [...builtinWire, ...registeredWire];
  sender.send({
    type: "commands_list",
    in_reply_to: msg.id,
    commands,
  });
}

/**
 * Convert a `SlashCommandInfo` from the SDK into the wire schema.
 * Visible so the dispatcher (Wave B Slice 2) can reuse the source/
 * invokability decisions without redoing them.
 */
export function sdkCommandToWire(c: SlashCommandInfo): WireCommand {
  const source = c.source;  // "extension" | "prompt" | "skill"
  // Extension commands are dispatched via our own local registry in
  // Slice 2, so they're invokable today. Prompt templates and skills
  // don't have a public invocation API yet — surface them as hints.
  const invokable = source === "extension";
  return {
    name: c.name,
    description: c.description,
    source,
    invokable,
    // The SDK doesn't expose a `takesArgs` flag on `SlashCommandInfo`.
    // Be permissive: assume any registered command may take args, so the
    // app keeps the input editable after the chip. Builtins use the
    // explicit per-name flag from the mirror.
    takes_args: true,
  };
}

// Re-export for callers that want builtin lookup without importing both
// modules. Keeps the public surface of "commands" small.
export { findBuiltin };
