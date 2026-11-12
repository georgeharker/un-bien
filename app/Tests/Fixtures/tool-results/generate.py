#!/usr/bin/env python3
"""Generate catalog.json: tool-result fixtures transcribed from each tool's
declared result spec (design 01M77YDWSZFD6WCYVFT3Z73SWJ).

Each fixture is ONE tool call in both forms the app receives it:
  live   - the rpc frames pi emits (tool_execution_start / _update / _end),
           as forwarded by the un-bien extension (result object unchanged);
  stored - the session entries pi persists (the assistant message carrying the
           toolCall, then the toolResult message), as get_entries returns them.
`expect` states what the rendering must show (face, category, text, notices);
later stages assert it. `spec` cites the source the content was transcribed
from (pi-coding-agent / pi-agent-core 1.5.0 unless stated).

Run: python3 -I generate.py   (writes catalog.json next to this file)
"""
import hashlib
import json
import os

TS = 1794000000000  # fixed epoch ms; stored timestamps derive from it


def text(t):
    return {"type": "text", "text": t}


def image(mime="image/png"):
    # 1x1 transparent PNG
    return {"type": "image", "mimeType": mime,
            "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="}


def truncation(**over):
    """pi core/tools/truncate.ts TruncationResult — every field present."""
    base = {"content": "", "truncated": True, "truncatedBy": "lines",
            "totalLines": 4000, "totalBytes": 120000, "outputLines": 2000,
            "outputBytes": 60000, "lastLinePartial": False,
            "firstLineExceedsLimit": False, "maxLines": 2000, "maxBytes": 51200}
    base.update(over)
    return base


NULL = object()  # sentinel: details present as JSON null (vs omitted)


def fixture(fid, spec, tool, args, content, details=None, is_error=False,
            updates=(), expect=None, duration_ms=12, compat=None,
            live_result=None, stored_message=None, stored=True, live=True):
    """Build one fixture. `details=None` means pi omitted it (undefined)."""
    call_id = "call_" + fid.replace(".", "_").replace("-", "_")
    result = {"content": content}
    if details is NULL:
        result["details"] = None
    elif details is not None:
        result["details"] = details
    if is_error:
        result["isError"] = True
    end = {"type": "tool_execution_end", "toolCallId": call_id, "toolName": tool,
           "result": live_result if live_result is not None else result,
           "isError": is_error}
    frames = [{"type": "tool_execution_start", "toolCallId": call_id,
               "toolName": tool, "args": args}]
    for partial in updates:
        frames.append({"type": "tool_execution_update", "toolCallId": call_id,
                       "toolName": tool, "args": args, "partialResult": partial})
    frames.append(end)
    msg = {"role": "toolResult", "toolCallId": call_id, "toolName": tool,
           "content": content, "isError": is_error, "durationMs": duration_ms,
           "timestamp": TS + 2}
    if details is NULL:
        msg["details"] = None
    elif details is not None:
        msg["details"] = details
    if stored_message is not None:
        msg = stored_message
    assistant = {"role": "assistant", "timestamp": TS + 1, "content": [
        {"type": "toolCall", "id": call_id, "name": tool, "arguments": args}]}
    entries = [
        # Stable 8-hex entry ids (pi's id width), derived from the fixture id.
        {"type": "message", "id": "a" + hashlib.sha256(fid.encode()).hexdigest()[:7],
         "parentId": None, "timestamp": "2026-11-12T00:00:01.000Z", "message": assistant},
    ]
    entries.append({"type": "message", "id": "r" + entries[0]["id"][1:],
                    "parentId": entries[0]["id"],
                    "timestamp": "2026-11-12T00:00:02.000Z", "message": msg})
    out = {"id": fid, "spec": spec, "tool": tool, "toolCallId": call_id,
           "args": args, "expect": expect or {}}
    if live:
        out["live"] = frames
    if stored:
        out["stored"] = entries
    if compat:
        out["compat"] = compat
    return out


F = []

# ── bash (core/tools/bash.ts; renderer core/tools/renderers/bash.ts) ─────────
F.append(fixture(
    "bash.ok", "bash: merged output as one text block; details undefined when not truncated",
    "bash", {"command": "ls"}, [text("README.md\nsrc\n")],
    updates=[{"content": [text("README.md\n")], "details": {}}],
    expect={"face": "terminal", "category": "shell", "text": "README.md\nsrc\n", "notices": []}))
F.append(fixture(
    "bash.ok-empty-details", "bash: some runs persist details as {} (seen in session logs)",
    "bash", {"command": "true"}, [text("")], details={},
    expect={"face": "terminal", "category": "shell", "text": "", "notices": []}))
F.append(fixture(
    "bash.exit-code", "bash: non-zero exit returns isError with 'Command exited with code N' appended after a blank line",
    "bash", {"command": "make"}, [text("make: *** No rule to make target.\n\nCommand exited with code 2")],
    is_error=True,
    expect={"face": "error", "category": "shell", "isError": True,
            "text": "make: *** No rule to make target.\n\nCommand exited with code 2"}))
F.append(fixture(
    "bash.aborted", "bash: abort throws 'Command aborted'; the loop's createErrorToolResult gives details {}",
    "bash", {"command": "sleep 100"}, [text("partial\n\nCommand aborted")], details={}, is_error=True,
    expect={"face": "error", "category": "shell", "isError": True, "text": "partial\n\nCommand aborted"}))
F.append(fixture(
    "bash.truncated", "bash: tail kept; '[Showing lines a-b of N. Full output: path]' appended; details {truncation, fullOutputPath}",
    "bash", {"command": "seq 4000"},
    # The path pi reports is under os.tmpdir() (macOS: /var/folders/…/T/).
    [text("2001\n2002\n\n[Showing lines 2001-4000 of 4000. Full output: /var/folders/zz/T/pi-bash-1.log]")],
    details={"truncation": truncation(content="2001\n2002\n"), "fullOutputPath": "/var/folders/zz/T/pi-bash-1.log"},
    expect={"face": "terminal", "category": "shell", "text": "2001\n2002\n",
            "notices": ["Showing lines 2001-4000 of 4000. Full output: /var/folders/zz/T/pi-bash-1.log"]}))
F.append(fixture(
    "bash.git-diff", "bash: a unified diff in output (kept improvement: rendered as a diff)",
    "bash", {"command": "git diff"},
    [text("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n")],
    expect={"face": "terminal", "category": "shell", "diffInOutput": True}))

# ── read (core/tools/read.ts; renderers/read.ts) ─────────────────────────────
F.append(fixture(
    "read.text", "read: the file text AS READ, no line numbers; details undefined",
    "read", {"path": "src/a.swift"}, [text("import Foundation\nlet x = 1\n")],
    expect={"face": "file", "category": "reads", "lang": "swift", "text": "import Foundation\nlet x = 1\n"}))
F.append(fixture(
    "read.ranged", "read: user limit stopped early -> '[N more lines in file. Use offset=K to continue.]'",
    "read", {"path": "src/a.ts", "offset": 1, "limit": 2},
    [text("line1\nline2\n\n[120 more lines in file. Use offset=3 to continue.]")],
    expect={"face": "file", "category": "reads", "lang": "typescript", "text": "line1\nline2\n",
            "notices": ["120 more lines in file. Use offset=3 to continue."]}))
F.append(fixture(
    "read.truncated", "read: tool limit -> '[Showing lines a-b of N. Use offset=K to continue.]' + details {truncation}",
    "read", {"path": "big.py"},
    [text("x = 1\n\n[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]")],
    details={"truncation": truncation(totalLines=5000, content="x = 1\n")},
    expect={"face": "file", "category": "reads", "lang": "python", "text": "x = 1\n",
            "notices": ["Showing lines 1-2000 of 5000. Use offset=2001 to continue."]}))
F.append(fixture(
    "read.image", "read: image -> 'Read image file [mime]' note + image block",
    "read", {"path": "shot.png"}, [text("Read image file [image/png]"), image()],
    expect={"face": "file", "category": "reads", "images": 1, "text": "Read image file [image/png]"}))
F.append(fixture(
    "read.error", "read: thrown error -> createErrorToolResult (details {})",
    "read", {"path": "missing.txt"},
    [text("ENOENT: no such file or directory, access '/w/missing.txt'")], details={}, is_error=True,
    expect={"face": "error", "category": "reads", "isError": True,
            "text": "ENOENT: no such file or directory, access '/w/missing.txt'"}))

# ── edit (core/tools/edit.ts, edit-diff.ts) ──────────────────────────────────
PATCH = ("--- /w/colima.sh\n+++ /w/colima.sh\n@@ -5,3 +5,4 @@\n \n"
         " export PATH=\"/opt/homebrew/bin:$PATH\"\n+source \"$HOME/.env.sh\"\n CONTEXT=\"colima\"\n")
DIFF = ("    ...\n  5 \n  6 export PATH=\"/opt/homebrew/bin:$PATH\"\n"
        "+ 7 source \"$HOME/.env.sh\"\n  7 CONTEXT=\"colima\"\n    ...")
F.append(fixture(
    "edit.ok", "edit: 'Successfully replaced N block(s) in path.' + details {diff (numbered display), patch (unified), firstChangedLine}",
    "edit", {"path": "/w/colima.sh", "edits": [{"oldText": "CONTEXT=\"colima\"",
                                                "newText": "source \"$HOME/.env.sh\"\nCONTEXT=\"colima\""}]},
    [text("Successfully replaced 1 block(s) in /w/colima.sh.")],
    details={"diff": DIFF, "patch": PATCH, "firstChangedLine": 7},
    expect={"face": "diff", "category": "edits", "diffFrom": "details.patch",
            "confirmation": "Successfully replaced 1 block(s) in /w/colima.sh."}))
F.append(fixture(
    "edit.error", "edit: thrown 'Could not edit file: path. reason.' (details {})",
    "edit", {"path": "/w/a.ts", "oldText": "nope", "newText": "x"},
    [text("Could not edit file: /w/a.ts. The text to replace was not found.")], details={}, is_error=True,
    expect={"face": "error", "category": "edits", "isError": True, "diffFrom": "args"}))

# ── write (core/tools/write.ts) ──────────────────────────────────────────────
F.append(fixture(
    "write.ok", "write: 'Successfully wrote to path'; details undefined",
    "write", {"path": "/w/x.sh", "content": "#!/bin/sh\necho hi\n"},
    [text("Successfully wrote to /w/x.sh")],
    expect={"face": "confirmation", "category": "writes", "confirmation": "Successfully wrote to /w/x.sh"}))

# ── grep / find / ls (core/tools/grep.ts, find.ts, ls.ts) ────────────────────
F.append(fixture(
    "grep.hits", "grep: 'path:line: text' lines; details undefined without notices",
    "grep", {"pattern": "TODO", "path": "src"}, [text("src/a.ts:12: // TODO x\nsrc/b.ts:3: // TODO y")],
    expect={"face": "lines", "category": "searches", "text": "src/a.ts:12: // TODO x\nsrc/b.ts:3: // TODO y", "notices": []}))
F.append(fixture(
    "grep.none", "grep: 'No matches found', details undefined",
    "grep", {"pattern": "zzz"}, [text("No matches found")],
    expect={"face": "lines", "category": "searches", "text": "No matches found"}))
F.append(fixture(
    "grep.limit", "grep: notices joined with '. ' inside one '[...]' after a blank line; details {matchLimitReached, linesTruncated}",
    "grep", {"pattern": "x", "limit": 100},
    [text("a.ts:1: x\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern. Some lines truncated to 500 chars. Use read tool to see full lines]")],
    details={"matchLimitReached": 100, "linesTruncated": True},
    expect={"face": "lines", "category": "searches", "text": "a.ts:1: x",
            "notices": ["100 matches limit reached. Use limit=200 for more, or refine pattern",
                        "Some lines truncated to 500 chars. Use read tool to see full lines"]}))
F.append(fixture(
    "find.hits", "find: one path per line", "find", {"pattern": "*.swift", "path": "app"},
    [text("app/A.swift\napp/B.swift")],
    expect={"face": "lines", "category": "searches", "text": "app/A.swift\napp/B.swift"}))
F.append(fixture(
    "find.none", "find: 'No files found matching pattern'", "find", {"pattern": "*.zz"},
    [text("No files found matching pattern")],
    expect={"face": "lines", "category": "searches", "text": "No files found matching pattern"}))
F.append(fixture(
    "ls.empty", "ls: '(empty directory)'", "ls", {"path": "empty"}, [text("(empty directory)")],
    expect={"face": "lines", "category": "searches", "text": "(empty directory)"}))

# ── codemode (extensions/codemode/execute.js, renderer.ts) ───────────────────
CALLS = [{"id": "call_cm/1", "name": "github_get_latest_release", "args": "{\"repo\":\"x\"}",
          "status": "ok", "durationMs": 420}]
F.append(fixture(
    "codemode.completed", "codemode: header block 'Script completed\\nWall time S seconds\\nOutput:\\n' then output blocks; details {calls}",
    "codemode", {"code": "return await tools.github_get_latest_release({repo: 'x'})"},
    [text("Script completed\nWall time 0.9 seconds\nOutput:\n"), text("{\"tag_name\":\"v1\"}")],
    details={"calls": CALLS},
    expect={"face": "script", "category": "codemode", "calls": 1, "text": "{\"tag_name\":\"v1\"}"}))
F.append(fixture(
    "codemode.failed", "codemode: 'Script failed' header, 'Script error:\\n…' item, isError true",
    "codemode", {"code": "throw new Error('boom')"},
    [text("Script failed\nWall time 0.1 seconds\nOutput:\n"), text("Script error:\nError: boom")],
    details={"calls": []}, is_error=True,
    expect={"face": "error", "category": "codemode", "isError": True, "text": "Script error:\nError: boom"}))
F.append(fixture(
    "codemode.rejected", "codemode: invalid options rejected before running: no header",
    "codemode", {"code": "// @options: {bad"},
    [text("Invalid @options line: expected JSON")], details={}, is_error=True,
    expect={"face": "error", "category": "codemode", "isError": True}))

# ── mcp (pi builtin mcp extension) ───────────────────────────────────────────
F.append(fixture(
    "mcp.call", "mcp: upstream content passed through; details {mode:'call', server, tool}",
    "mcp", {"tool": "cribsheet_note_lookup", "args": "{}"}, [text("[{\"relpath\":\"a.md\"}]")],
    details={"mode": "call", "server": "cribsheet", "tool": "cribsheet_note_lookup"},
    expect={"face": "text", "category": "mcp", "text": "[{\"relpath\":\"a.md\"}]"}))
F.append(fixture(
    "mcp.search", "mcp: search mode; details {mode:'search', query, count}",
    "mcp", {"search": "crib"}, [text("2 of ~2 matches for \"crib\"\ncribsheet_a — x\ncribsheet_b — y")],
    details={"mode": "search", "query": "crib", "count": 2},
    expect={"face": "text", "category": "mcp"}))
F.append(fixture(
    "mcp.image", "mcp: image content from an upstream tool", "mcp",
    {"tool": "svg-mcp_render_document", "args": "{}"}, [text("rendered"), image()],
    details={"mode": "call", "server": "svg-mcp", "tool": "svg-mcp_render_document"},
    expect={"face": "text", "category": "mcp", "images": 1}))

# ── extension tools whose details we know (their own packages) ───────────────
F.append(fixture(
    "subagent.ok", "@gotgenes/pi-subagents agent tool: the agent's answer; details AgentDetails",
    "subagent", {"description": "review", "prompt": "…"}, [text("**Verdict: ready.**\n\n- one\n- two")],
    details={"displayName": "Agent", "description": "review", "subagentType": "general-purpose",
             "toolUses": 3, "tokens": "10k", "durationMs": 5000, "status": "completed"},
    expect={"face": "text", "category": "agents"}))
F.append(fixture(
    "web_fetch.ok", "@juicesharp/rpiv-web-tools web_fetch: markdown by convention; details {url, contentType}",
    "web_fetch", {"url": "https://x.dev"}, [text("**Fetched:** https://x.dev\n**Content-Type:** text/html\n\n# Title")],
    details={"url": "https://x.dev", "contentType": "text/html"},
    expect={"face": "text", "category": "web"}))
F.append(fixture(
    "agent_send.ok", "un-bien agent_send: one line; details {ok, status, target, id}",
    "agent_send", {"to": "x@y", "body": "hi"},
    [text("Delivered to \"x@y\" — peer will process it in an upcoming turn.")],
    details={"ok": True, "status": "received", "target": "x@y", "id": "01a"},
    expect={"face": "text", "category": "other"}))
F.append(fixture(
    "agent_request.reply", "un-bien agent_request: success returns details = the reply BODY, any JSON (here a string); pi types details as JsonValue",
    "agent_request", {"to": "x@y", "body": "q"}, [text("the answer")], details="the answer",
    expect={"face": "text", "category": "other", "text": "the answer"}))
F.append(fixture(
    "mesh_wait_message.timeout", "un-bien mesh_wait_message: a timed-out wait returns details null",
    "mesh_wait_message", {"re": "01a"}, [text("No message within 30000ms.")], details=NULL,
    expect={"face": "text", "category": "other"}))
F.append(fixture(
    "tool.not-found", "pi-agent-core: unknown tool -> createErrorToolResult('Tool NAME not found')",
    "nonexistent", {}, [text("Tool nonexistent not found")], details={}, is_error=True,
    expect={"face": "error", "category": "other", "isError": True, "text": "Tool nonexistent not found"}))

# ── durable (pi-durable 1.5 harness/tool.js appendToolResult) ────────────────
F.append(fixture(
    "durable.diagnostics", "pi-durable: diagnostics rendered as a trailing '<harness>' text block; structured list in entry data (not on the wire)",
    "bash", {"command": "ls"},
    [text("a\n"), text("<harness>\n[error] Tool call blocked: denied by policy\n</harness>")],
    details={},
    expect={"face": "terminal", "category": "shell", "text": "a\n",
            "diagnostics": ["[error] Tool call blocked: denied by policy"]}))

# ── compatibility (older or foreign producers) ───────────────────────────────
F.append(fixture(
    "compat.string-result", "pre-1.5 un-bien durable translator: tool_execution_end result was the joined text string",
    "bash", {"command": "ls"}, [text("a\nb")], live_result="a\nb",
    compat="live result is a bare string; stored entry is pi-shaped",
    expect={"face": "terminal", "category": "shell", "text": "a\nb"}))
F.append(fixture(
    "compat.foreign-grep", "pi-find (@tian.zuo/pi-find) grep: same NAME as pi's builtin, different details",
    "grep", {"pattern": "x"}, [text("a.ts:1: x")],
    details={"kind": "content", "output": "a.ts:1: x", "query": "x", "resultCount": 1,
             "fileCount": 1, "timedOut": False, "truncated": False},
    compat="details do not validate against pi's GrepToolDetails -> text fallback",
    expect={"face": "text", "category": "searches", "text": "a.ts:1: x"}))
F.append(fixture(
    "compat.edit-no-details", "older pi: edit result without details (no diff/patch in the record)",
    "edit", {"path": "/w/a.ts", "oldText": "a", "newText": "b"},
    [text("Successfully replaced 1 block(s) in /w/a.ts.")],
    compat="no details.patch -> diff from the stored args (no line numbers)",
    expect={"face": "diff", "category": "edits", "diffFrom": "args"}))
F.append(fixture(
    "compat.elided-entry", "un-bien extension fitEntryForTransport: an entry over 5 MiB is replaced by an assistant placeholder",
    "bash", {"command": "cat huge"}, [text("…")],
    stored_message={"role": "assistant", "content": [text("[entry rX exceeds the transport ceiling — content elided]")]},
    compat="replay has no toolResult; the card keeps its live value or shows 'result not available'",
    expect={"face": "terminal", "category": "shell", "replayAvailable": False}))

CATALOG = {"schema": 1,
           "source": "Transcribed from pi-coding-agent / pi-agent-core 1.5.0 tool sources; see each fixture's spec.",
           "fixtures": F}

if __name__ == "__main__":
    ids = [f["id"] for f in F]
    assert len(ids) == len(set(ids)), "duplicate fixture id"
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.json")
    with open(path, "w") as fh:
        json.dump(CATALOG, fh, indent=1, ensure_ascii=False, sort_keys=True)
        fh.write("\n")
    print(f"wrote {len(F)} fixtures -> {path}")
