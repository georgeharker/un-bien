import { describe, expect, test } from "vitest";
import {
  _buildTmuxLaunchArgs,
  _buildHerdrWorkspaceArgs,
  _buildHerdrAgentStartArgs,
  _herdrPaneIdFromCreate,
  _expandTilde,
} from "./launch.js";

describe("launch backends — tmux/herdr argv + tilde expansion", () => {
  test("remote launch: first pi creates the shared tmux session (new-session, safe array)", () => {
    expect(
      _buildTmuxLaunchArgs("un-bien", "pi-foo", "/tmp/work", false),
    ).toEqual([
      "new-session",
      "-d",
      "-s",
      "un-bien",
      "-n",
      "pi-foo",
      "-c",
      "/tmp/work",
      "pi",
    ]);
  });

  test("remote launch: later pis add a WINDOW to the shared session (new-window, no keystrokes)", () => {
    expect(
      _buildTmuxLaunchArgs("un-bien", "pi-foo", "/tmp/work", true),
    ).toEqual([
      "new-window",
      "-t",
      "un-bien",
      "-n",
      "pi-foo",
      "-c",
      "/tmp/work",
      "pi",
    ]);
  });

  test("remote launch: herdr workspace-create argv is a safe array, cwd + label, JSON", () => {
    expect(_buildHerdrWorkspaceArgs("pi-foo", "/tmp/work")).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/tmp/work",
      "--label",
      "pi-foo",
      "--no-focus",
      "--json",
    ]);
  });

  test("remote launch: herdr agent-start execs pi (canonical kind), not keystrokes", () => {
    expect(_buildHerdrAgentStartArgs("pi-foo", "pane-42")).toEqual([
      "agent",
      "start",
      "pi-foo",
      "--kind",
      "pi",
      "--pane",
      "pane-42",
    ]);
  });

  test("remote launch: herdr pane id is parsed from `workspace create --json`", () => {
    const out = JSON.stringify({
      result: {
        workspace: { workspace_id: "ws-1" },
        tab: { tab_id: "tab-1" },
        root_pane: { pane_id: "pane-42" },
      },
    });
    expect(_herdrPaneIdFromCreate(out)).toBe("pane-42");
    // Malformed / missing pane id → null (caller aborts, never keystroke-injects).
    expect(_herdrPaneIdFromCreate("not json")).toBeNull();
    expect(_herdrPaneIdFromCreate(JSON.stringify({ result: {} }))).toBeNull();
  });

  test("remote launch: ~/ cwd expands to an absolute home path (Node fs won't)", () => {
    const expanded = _expandTilde("~/proj");
    expect(expanded.startsWith("~")).toBe(false);
    expect(expanded.startsWith("/")).toBe(true);
    expect(expanded.endsWith("/proj")).toBe(true);
    // absolute + relative paths pass through untouched
    expect(_expandTilde("/abs/path")).toBe("/abs/path");
    expect(_expandTilde("relative")).toBe("relative");
  });
});
