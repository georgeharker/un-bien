/**
 * Plan/28 — Mirror of the Pi SDK's built-in slash commands.
 *
 * The SDK `@mariozechner/pi-coding-agent` defines `BUILTIN_SLASH_COMMANDS`
 * in `dist/core/slash-commands.js` but does NOT re-export it from the main
 * package entry, and the `exports` field of its `package.json` blocks deep
 * imports. So pi-extension carries this manually-maintained mirror until
 * an upstream PR exposes the constant publicly.
 *
 * **Maintenance**: when bumping `@mariozechner/pi-coding-agent`, diff the
 * runtime's `BUILTIN_SLASH_COMMANDS` against this file and update names,
 * descriptions, and the invokable / takes_args flags. The Wave 0 scout of
 * plan/28 captured the 0.73.1 baseline; later bumps should leave a
 * one-liner note here documenting which SDK version was synced.
 *
 * Synced from SDK version: **0.73.1**.
 *
 * **Invokability**: a builtin is `invokable: true` only when an entry in
 * `ExtensionContextActions` lets the extension run it without simulating
 * keyboard input in the TUI. The full mapping lives in `dispatcher.ts`
 * (Wave B Slice 2). When more upstream APIs land, flip more flags to
 * `true` here and add the corresponding dispatch in `dispatcher.ts`.
 */

import type { WireCommand } from "../protocol/types.js";

/**
 * A built-in slash command as exposed by the Pi TUI. Mirror of the SDK's
 * `BuiltinSlashCommand` interface, kept local to avoid the deep-import.
 */
export interface BuiltinMirrorEntry {
  /** Slash name without the leading `/`. */
  name: string;
  /** One-line description shown in the app picker. */
  description: string;
  /**
   * Whether the extension API can invoke this builtin programmatically
   * via `ExtensionContextActions`. Stays `false` until plan/28 Wave B
   * Slice 2 wires the dispatcher AND the underlying SDK action exists.
   */
  invokable: boolean;
  /**
   * Whether the builtin meaningfully accepts free-text arguments after
   * its name (e.g. `/model claude-opus-4-7`, `/name <session-name>`).
   * Used by the app to decide whether to keep the input editable after
   * the chip is placed.
   */
  takes_args: boolean;
}

export const BUILTIN_SLASH_COMMANDS_MIRROR: readonly BuiltinMirrorEntry[] = [
  // Session lifecycle
  { name: "compact",       description: "Manually compact the session context",                invokable: true,  takes_args: false },
  { name: "new",           description: "Start a new session",                                 invokable: false, takes_args: false },
  { name: "resume",        description: "Resume a different session",                          invokable: false, takes_args: false },
  { name: "fork",          description: "Create a new fork from a previous user message",      invokable: false, takes_args: false },
  { name: "clone",         description: "Duplicate the current session at the current position", invokable: false, takes_args: false },
  { name: "tree",          description: "Navigate session tree (switch branches)",             invokable: false, takes_args: false },
  { name: "name",          description: "Set session display name",                            invokable: false, takes_args: true  },
  { name: "session",       description: "Show session info and stats",                         invokable: false, takes_args: false },

  // Model / providers
  { name: "model",         description: "Select model",                                        invokable: true,  takes_args: true  },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling",            invokable: false, takes_args: false },
  { name: "login",         description: "Configure provider authentication",                   invokable: false, takes_args: false },
  { name: "logout",        description: "Remove provider authentication",                      invokable: false, takes_args: false },

  // Import / export / share
  { name: "export",        description: "Export session (HTML default, or specify path)",      invokable: false, takes_args: true  },
  { name: "import",        description: "Import and resume a session from a JSONL file",       invokable: false, takes_args: true  },
  { name: "share",         description: "Share session as a secret GitHub gist",               invokable: false, takes_args: false },
  { name: "copy",          description: "Copy last agent message to clipboard",                invokable: false, takes_args: false },

  // UI / settings
  { name: "settings",      description: "Open settings menu",                                  invokable: false, takes_args: false },
  { name: "hotkeys",       description: "Show all keyboard shortcuts",                         invokable: false, takes_args: false },
  { name: "changelog",     description: "Show changelog entries",                              invokable: false, takes_args: false },
  { name: "reload",        description: "Reload keybindings, extensions, skills, prompts, themes", invokable: false, takes_args: false },
  { name: "quit",          description: "Quit pi",                                             invokable: true,  takes_args: false },
] as const;

/**
 * Lookup helper used by the dispatcher. Returns the mirror entry for a
 * builtin name, or `undefined` if `name` is not a known builtin.
 */
export function findBuiltin(name: string): BuiltinMirrorEntry | undefined {
  return BUILTIN_SLASH_COMMANDS_MIRROR.find((c) => c.name === name);
}

/**
 * Project a mirror entry to the wire schema. Shared by the list_commands
 * handler so the mirror and the wire stay in lockstep.
 */
export function builtinToWire(entry: BuiltinMirrorEntry): WireCommand {
  return {
    name: entry.name,
    description: entry.description,
    source: "builtin",
    invokable: entry.invokable,
    takes_args: entry.takes_args,
  };
}
