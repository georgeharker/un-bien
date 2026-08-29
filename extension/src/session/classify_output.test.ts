import { describe, expect, it } from "vitest";
import { classifyToolOutput } from "./classify_output.js";

describe("classifyToolOutput — diff kind", () => {
  it("parses a unified-diff string into per-hunk DiffLines with line counters", () => {
    const diff = [
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,3 @@",
      " context one",
      "-removed two",
      "+added two",
      " context three",
    ].join("\n");
    const out = classifyToolOutput("edit", diff);
    expect(out).toEqual({
      kind: "diff",
      hunks: [
        {
          lines: [
            { kind: "context", oldLine: 1, newLine: 1, text: "context one" },
            { kind: "remove", oldLine: 2, text: "removed two" },
            { kind: "add", newLine: 2, text: "added two" },
            { kind: "context", oldLine: 3, newLine: 3, text: "context three" },
          ],
        },
      ],
    });
  });

  it("emits one hunk per @@ header", () => {
    const diff = [
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -10,2 +10,2 @@",
      " keep",
      "-old",
      "+new",
    ].join("\n");
    const out = classifyToolOutput("edit", diff) as {
      kind: string;
      hunks: { lines: unknown[] }[];
    };
    expect(out.kind).toBe("diff");
    expect(out.hunks).toHaveLength(2);
    expect(out.hunks[1].lines[0]).toEqual({
      kind: "context",
      oldLine: 10,
      newLine: 10,
      text: "keep",
    });
  });

  it("extracts diff text from a { content:[{type:text}] } result shape", () => {
    const result = {
      content: [{ type: "text", text: "@@ -1 +1 @@\n-x\n+y" }],
    };
    const out = classifyToolOutput("bash", result) as { kind: string };
    expect(out.kind).toBe("diff");
  });

  it("returns null for non-diff plain text", () => {
    expect(
      classifyToolOutput("bash", "just some output\nno markers here"),
    ).toBeNull();
  });

  it("returns null for a non-string, non-diff result", () => {
    expect(classifyToolOutput("bash", { ok: true, count: 3 })).toBeNull();
    expect(classifyToolOutput("bash", null)).toBeNull();
    expect(classifyToolOutput("bash", undefined)).toBeNull();
  });
});
