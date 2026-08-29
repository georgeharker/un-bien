import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _enrichToolArgs } from "./index.js";

type DiffLine =
  | { kind: "context"; oldLine?: number; newLine?: number; text: string }
  | { kind: "remove"; oldLine?: number; text: string }
  | { kind: "add"; newLine?: number; text: string }
  | { kind: "ellipsis" };

describe("_enrichToolArgs — edit diff enrichment", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempFile(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "unbien-enrich-"));
    dirs.push(dir);
    const p = join(dir, name);
    writeFileSync(p, content, "utf8");
    return p;
  }

  it("returns raw args unchanged for a non-edit tool", () => {
    const args = { command: "ls" };
    expect(_enrichToolArgs("bash", args)).toEqual(args);
  });

  it("builds add/remove/context DiffLines against a real file (absolute path)", () => {
    const path = tempFile(
      "sample.txt",
      ["line1", "line2", "target old", "line4", "line5", ""].join("\n"),
    );
    const args = {
      path,
      edits: [{ oldText: "target old", newText: "target new" }],
    };
    const enriched = _enrichToolArgs("edit", args) as {
      path: string;
      edits: unknown[];
      hunks?: { lines: DiffLine[] }[];
    };

    // Raw args are preserved alongside the derived hunks.
    expect(enriched.path).toBe(path);
    expect(enriched.edits).toBe(args.edits);
    expect(Array.isArray(enriched.hunks)).toBe(true);
    expect(enriched.hunks).toHaveLength(1);

    const lines = enriched.hunks![0].lines;
    const remove = lines.find((l) => l.kind === "remove") as Extract<
      DiffLine,
      { kind: "remove" }
    >;
    const add = lines.find((l) => l.kind === "add") as Extract<
      DiffLine,
      { kind: "add" }
    >;
    expect(remove).toMatchObject({
      kind: "remove",
      oldLine: 3,
      text: "target old",
    });
    expect(add).toMatchObject({ kind: "add", newLine: 3, text: "target new" });

    // Context surrounds the change (line2 before, line4 after).
    const contextTexts = lines
      .filter(
        (l): l is Extract<DiffLine, { kind: "context" }> =>
          l.kind === "context",
      )
      .map((l) => l.text);
    expect(contextTexts).toContain("line2");
    expect(contextTexts).toContain("line4");
  });

  it("returns the base args (no hunks) when the file cannot be read", () => {
    const args = {
      path: "/no/such/unbien/file.txt",
      edits: [{ oldText: "a", newText: "b" }],
    };
    const enriched = _enrichToolArgs("edit", args) as { hunks?: unknown[] };
    expect(enriched.hunks).toBeUndefined();
  });
});
