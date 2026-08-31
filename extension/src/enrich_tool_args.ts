import { resolve } from "node:path"
import { readFileSync } from "node:fs"

/**
 * Tool-arg enrichment for rich display — derives edit-diff hunks (add/remove/
 * context DiffLines) from an `edit` tool's args + the on-disk file, so the app
 * can render a real diff. Pure apart from reading the target file; `cwd` is the
 * base dir for resolving a relative path (the caller passes the session cwd).
 */

type ToolArgs = Record<string, unknown>
type DiffLine =
  | { kind: "context"; oldLine?: number; newLine?: number; text: string }
  | { kind: "remove"; oldLine?: number; text: string }
  | { kind: "add"; newLine?: number; text: string }
  | { kind: "ellipsis" }

export function _enrichToolArgs(
  tool: string,
  args: unknown,
  cwd: string = process.cwd(),
): ToolArgs {
  if (!args || typeof args !== "object") return {}
  const base = args as ToolArgs

  switch (tool.toLowerCase()) {
    case "edit":
      return _enrichEditToolArgs(base, cwd)
    default:
      return base
  }
}

function _enrichEditToolArgs(base: ToolArgs, cwd: string): ToolArgs {
  const filePath = _stringArg(base, ["path", "file_path"])
  const rawEdits = base["edits"]
  const edits = Array.isArray(rawEdits) ? rawEdits : [base]
  const text = _readToolFile(filePath, cwd)
  const hunks: { lines: DiffLine[] }[] = []
  let searchFrom = 0
  for (const rawEdit of edits) {
    if (!rawEdit || typeof rawEdit !== "object") continue
    const edit = rawEdit as ToolArgs
    const oldText = _stringArg(edit, [
      "oldText",
      "old_text",
      "old_string",
      "oldString",
    ])
    const newText = _stringArg(edit, [
      "newText",
      "new_text",
      "new_string",
      "newString",
    ])
    if (!oldText && !newText) continue

    const matchAt =
      oldText && text !== null ? text.indexOf(oldText, searchFrom) : -1
    const fallbackAt =
      oldText && matchAt < 0 && text !== null ? text.indexOf(oldText) : matchAt
    const startOffset = fallbackAt >= 0 ? fallbackAt : searchFrom
    if (text === null) continue
    const hunk = _buildEditHunk(text, startOffset, oldText, newText)
    if (hunk.length > 0) hunks.push({ lines: hunk })
    searchFrom = startOffset + Math.max(oldText.length, 1)
  }

  return hunks.length === 0 ? base : { ...base, hunks }
}

function _readToolFile(filePath: string, cwd: string): string | null {
  if (!filePath) return null
  const homePath =
    filePath.startsWith("~/") && process.env.HOME
      ? resolve(process.env.HOME, filePath.slice(2))
      : null
  const candidates = [
    filePath,
    resolve(cwd, filePath),
    resolve(process.cwd(), filePath),
    homePath,
  ].filter((p): p is string => typeof p === "string")
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8")
    } catch {
      // try next candidate
    }
  }
  return null
}

function _buildEditHunk(
  fileText: string,
  startOffset: number,
  oldText: string,
  newText: string,
): DiffLine[] {
  const context = 4
  const fileLines = fileText.split("\n")
  const oldLines = _splitPreviewLines(oldText)
  const newLines = _splitPreviewLines(newText)
  const oldStart = _lineNumberAt(fileText, startOffset)
  const newStart = oldStart
  const startIndex = oldStart - 1
  const beforeStart = Math.max(0, startIndex - context)
  const afterStart = startIndex + oldLines.length
  const afterEnd = Math.min(fileLines.length, afterStart + context)
  const out: DiffLine[] = []

  if (beforeStart > 0) out.push({ kind: "ellipsis" })
  for (let i = beforeStart; i < startIndex; i++) {
    out.push({
      kind: "context",
      oldLine: i + 1,
      newLine: i + 1,
      text: fileLines[i] ?? "",
    })
  }
  let commonPrefix = 0
  while (
    commonPrefix < oldLines.length &&
    commonPrefix < newLines.length &&
    oldLines[commonPrefix] === newLines[commonPrefix]
  ) {
    commonPrefix++
  }

  let commonSuffix = 0
  while (
    commonSuffix < oldLines.length - commonPrefix &&
    commonSuffix < newLines.length - commonPrefix &&
    oldLines[oldLines.length - 1 - commonSuffix] ===
      newLines[newLines.length - 1 - commonSuffix]
  ) {
    commonSuffix++
  }

  for (let i = 0; i < commonPrefix; i++) {
    out.push({
      kind: "context",
      oldLine: oldStart + i,
      newLine: newStart + i,
      text: oldLines[i] ?? "",
    })
  }
  for (let i = commonPrefix; i < oldLines.length - commonSuffix; i++) {
    out.push({
      kind: "remove",
      oldLine: oldStart + i,
      text: oldLines[i] ?? "",
    })
  }
  for (let i = commonPrefix; i < newLines.length - commonSuffix; i++) {
    out.push({ kind: "add", newLine: newStart + i, text: newLines[i] ?? "" })
  }
  for (let i = oldLines.length - commonSuffix; i < oldLines.length; i++) {
    const newLine = newStart + newLines.length - (oldLines.length - i)
    out.push({
      kind: "context",
      oldLine: oldStart + i,
      newLine,
      text: oldLines[i] ?? "",
    })
  }
  for (let i = afterStart; i < afterEnd; i++) {
    const newLine = newStart + newLines.length + (i - afterStart)
    out.push({
      kind: "context",
      oldLine: i + 1,
      newLine,
      text: fileLines[i] ?? "",
    })
  }
  if (afterEnd < fileLines.length) out.push({ kind: "ellipsis" })
  return out
}

function _lineNumberAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < Math.max(0, offset); i++) if (text[i] === "\n") line++
  return line
}

function _splitPreviewLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function _stringArg(args: ToolArgs, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string") return value
  }
  return ""
}
