# App Store release notes — 1.6.0 (build 28)

What's New text, App Store "What's New" field / TestFlight build notes.
Everything since 1.5.5 (build 25).

## iOS + macOS

- Tool results now look like what they are, live and when reopened: clean
  shell output, highlighted files, diffs, search matches, scripts with their
  calls and output, and formatted web pages and agent reports. Failed calls
  show why. Results no longer show as raw JSON.
- New Settings → Tool results: choose whether each kind of tool card starts
  open, as a short preview, or closed (this replaces "Expand rich tool
  results"), and whether agent cards show their prompt.
- Preview shows the last lines of shell output and the first lines of a
  read or search, with a tap to see the rest.
- Card headers name the file and line range, URL, task or MCP tool a call
  acts on, and how long it took.
- A jump-to-end button appears while you're scrolled away from the newest
  messages.
- Durable sessions render their tool results just like pi sessions.
- Steadier, faster scrolling: heights are estimated much more closely,
  including multi-line messages you send.

## One-liner (if a single field is preferred)

Tool results that read like what they are, per-kind display settings with
pi-style previews, agent prompts, and a jump-to-end button.
