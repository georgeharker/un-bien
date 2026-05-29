/**
 * Plan/28 Wave B Slice 1 — round-trip test for `list_commands`.
 *
 * Pure unit test: we hand the handler a fake `pi` returning canned
 * `SlashCommandInfo[]` and a fake `sender` that captures the reply, then
 * assert the wire schema, ordering, dedup rule, and invokability defaults.
 *
 * The real `_routeClientMessageFrom` wiring (index.ts) is exercised by
 * `extension.test.ts` in a separate slice — keeping this file laser-focused
 * on the handler logic makes failures easy to read.
 */

import { describe, expect, test } from "vitest";
import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import { handleListCommands } from "./list_commands.js";
import { BUILTIN_SLASH_COMMANDS_MIRROR } from "./builtin_mirror.js";
import type { ServerMessage, WireCommand } from "../protocol/types.js";

/** Capture-only fake of the sender contract. */
function makeSender() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send(msg: ServerMessage): void {
      sent.push(msg);
    },
  };
}

/** Builder for canned SlashCommandInfo[] returned by the fake pi. */
function makePi(getCommands: () => SlashCommandInfo[]) {
  return { getCommands };
}

/**
 * Helper: extract the single `commands_list` reply from a sender, asserting
 * exactly one reply was sent. Keeps individual tests terse.
 */
function singleCommandsList(sender: ReturnType<typeof makeSender>): WireCommand[] {
  expect(sender.sent).toHaveLength(1);
  const reply = sender.sent[0];
  expect(reply.type).toBe("commands_list");
  if (reply.type !== "commands_list") throw new Error("type guard");
  expect(reply.in_reply_to).toBe("req-1");
  return reply.commands;
}

describe("handleListCommands", () => {
  test("returns all builtins when pi has no registered commands", () => {
    const pi = makePi(() => []);
    const sender = makeSender();
    handleListCommands(pi, sender, { type: "list_commands", id: "req-1" });
    const commands = singleCommandsList(sender);
    expect(commands).toHaveLength(BUILTIN_SLASH_COMMANDS_MIRROR.length);
    // All are sourced as builtin.
    expect(commands.every((c) => c.source === "builtin")).toBe(true);
    // /compact is the canonical invokable builtin per the Wave B Slice 2
    // dispatcher matrix; reverse-mapping guards against a typo in the mirror.
    const compact = commands.find((c) => c.name === "compact");
    expect(compact).toBeDefined();
    expect(compact?.invokable).toBe(true);
    expect(compact?.takes_args).toBe(false);
  });

  test("merges extension/prompt/skill commands after builtins", () => {
    const pi = makePi(() => [
      // sourceInfo isn't used by the handler — cast to satisfy the type.
      { name: "remote-pi", description: "Mesh control", source: "extension", sourceInfo: {} as never },
      { name: "skill:onboarding", description: "Onboard a new dev", source: "skill", sourceInfo: {} as never },
      { name: "summary", description: "Summarize the session", source: "prompt", sourceInfo: {} as never },
    ]);
    const sender = makeSender();
    handleListCommands(pi, sender, { type: "list_commands", id: "req-1" });
    const commands = singleCommandsList(sender);

    // Three new entries appended after the full mirror.
    expect(commands).toHaveLength(BUILTIN_SLASH_COMMANDS_MIRROR.length + 3);
    const tail = commands.slice(BUILTIN_SLASH_COMMANDS_MIRROR.length);
    expect(tail.map((c) => c.name)).toEqual(["remote-pi", "skill:onboarding", "summary"]);

    // Extension commands are invokable; prompt/skill aren't (yet).
    expect(tail[0]).toMatchObject({ source: "extension", invokable: true,  takes_args: true });
    expect(tail[1]).toMatchObject({ source: "skill",     invokable: false, takes_args: true });
    expect(tail[2]).toMatchObject({ source: "prompt",    invokable: false, takes_args: true });
  });

  test("registered command of the same name overrides the builtin entry", () => {
    // Hypothetical extension that re-defines `/compact`. The TUI's
    // dispatch order would use the registered handler, so the wire
    // catalog drops the duplicate builtin to match that behavior.
    const pi = makePi(() => [
      { name: "compact", description: "Custom compact", source: "extension", sourceInfo: {} as never },
    ]);
    const sender = makeSender();
    handleListCommands(pi, sender, { type: "list_commands", id: "req-1" });
    const commands = singleCommandsList(sender);

    const compactEntries = commands.filter((c) => c.name === "compact");
    expect(compactEntries).toHaveLength(1);
    expect(compactEntries[0]).toMatchObject({
      source: "extension",
      description: "Custom compact",
      invokable: true,
    });
  });

  test("reply carries the same `id` from the request as `in_reply_to`", () => {
    const pi = makePi(() => []);
    const sender = makeSender();
    handleListCommands(pi, sender, { type: "list_commands", id: "custom-id-42" });
    expect(sender.sent[0]).toMatchObject({
      type: "commands_list",
      in_reply_to: "custom-id-42",
    });
  });
});
