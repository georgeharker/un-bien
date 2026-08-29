// Classify a RAW tool RESULT into an un-bien display sidecar (`aux.output`) that
// rides ALONGSIDE the byte-faithful `rpc.result` on a `tool_execution_end`
// envelope. This is the OUTPUT twin of `_enrichToolArgs` (input hunks on
// `tool_execution_start`): the rpc frame stays raw; the app renders `aux.output`
// when the `kind` is one it knows, and falls back to raw JSON otherwise.
//
// v1 recognises exactly one kind — "diff": a result whose text carries unified
// diff hunk headers (`@@ -\d+,?\d* \+\d+,?\d* @@`) is parsed into per-hunk
// DiffLines. Everything else returns null (most tools fall back).
//
// PURE + defensively typed: this runs inside an SDK event callback, so it never
// throws and never mutates its input.

/** One rendered diff line — mirrors the app-side diff renderer and the input
 *  hunk shape produced by `_enrichToolArgs`. */
export type DiffLine =
  | { kind: "context"; oldLine?: number; newLine?: number; text: string }
  | { kind: "remove"; oldLine?: number; text: string }
  | { kind: "add"; newLine?: number; text: string }
  | { kind: "ellipsis" };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const HAS_HUNK = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Pull a plain-text view out of a raw tool result. Handles the common pi shapes
 * — a bare string, or `{ content: [{ type:"text", text }] }` — and otherwise
 * falls back to a JSON serialization so embedded diff text can still be found.
 */
function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === "text" && typeof b.text === "string")
            parts.push(b.text);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Parse a unified-diff text into `{ kind:"diff", hunks }`. One hunk per `@@`
 * header; within a hunk a leading `' '`→context, `'-'`→remove, `'+'`→add; the
 * oldLine/newLine counters seed from the header numbers. Lines before the first
 * header (and any `+++`/`---` file markers) are ignored.
 */
function parseDiff(
  text: string,
): { kind: "diff"; hunks: { lines: DiffLine[] }[] } | null {
  const rows = text.split("\n");
  const hunks: { lines: DiffLine[] }[] = [];
  let current: DiffLine[] | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const row of rows) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      current = [];
      hunks.push({ lines: current });
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!current) continue; // preamble before the first hunk header
    if (row.startsWith("+++") || row.startsWith("---")) continue; // file markers
    const marker = row[0];
    const body = row.slice(1);
    if (marker === "-") {
      current.push({ kind: "remove", oldLine, text: body });
      oldLine += 1;
    } else if (marker === "+") {
      current.push({ kind: "add", newLine, text: body });
      newLine += 1;
    } else if (marker === " ") {
      current.push({ kind: "context", oldLine, newLine, text: body });
      oldLine += 1;
      newLine += 1;
    }
    // '\'' (No newline at end of file) and blank rows carry no diff cell.
  }
  if (hunks.length === 0) return null;
  return { kind: "diff", hunks };
}

/**
 * Classify a tool's RAW result into a display sidecar, or null when nothing is
 * recognised (the common case — the app then renders raw JSON). Never throws.
 */
export function classifyToolOutput(
  _toolName: string,
  result: unknown,
): { kind: string; [k: string]: unknown } | null {
  try {
    const text = resultToText(result);
    if (!text || !HAS_HUNK.test(text)) return null;
    return parseDiff(text);
  } catch {
    return null;
  }
}
