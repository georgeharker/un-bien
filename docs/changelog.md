# Changelog

Release notes per component, newest first. The app ships independently of
the npm/relay packages; the sections below note companion-version
requirements where they matter.

## App

### 1.3 (build 7, 2026-09-22)

- **Fixed: owner key wiped on every restart (first reported issue #2)** —
  `save()` was delete-then-add, and on iOS the trailing "legacy keychain
  cleanup" hit the same (only) keychain and deleted the key it had just
  written. Fresh installs re-paired on every app restart; the iCloud-sync
  toggle also dropped the pairing on macOS. `save()` is now an in-place
  upsert (the keychain is never empty between writes, and a crash mid-save
  can no longer lose the identity); legacy-keychain contact is a macOS-only
  one-time migration in `load()`; the iCloud toggle adds/removes only the
  synced copy, keeping the device-local copy as the durable anchor.

### 1.2 (build 6, 2026-09-20)

- **Resume Session** — long-press a machine row and pick a stored pi
  session to relaunch: recency-ordered list, type-to-filter, sortable by
  name/message count. The resumed chat auto-opens when it comes live.
  Requires extension 0.20.6+ on the machine (the launcher daemon
  advertises `session_resume`); the menu item is hidden on older daemons.
- **New Conversation…** joins the machine long-press menu (previously
  only the ＋ chip).
- Launched and resumed conversations **auto-open** when their room comes
  live — deterministic, via the daemon's launch-correlation echo. A
  launch that never comes live expires quietly after 60s (the session
  still appears via normal discovery).
- **Slash commands in the composer** — text starting with `/` runs as a
  pi command on the machine (pi built-ins with remote equivalents like
  `/compact`, `/new`, `/name`, `/thinking`, `/model` execute; unknown
  commands are refused with a toast instead of reaching the model).
  Command output arrives as transient toasts. Requires extension
  0.20.9+ for the built-in intercept.
- **Transient toasts** — machine-pushed notices render as auto-dismissing,
  level-colored toasts at the top of the screen (never transcript noise).
  Requires extension 0.20.8+.
- Truthful error states in the resume picker: a machine refusal
  (unpaired / directory gate / lister failure) is shown as such instead
  of a fake "No stored sessions".
- Fixed: the model picker's open menu could snap back to the top while
  scrolling when the model roster refreshed (row identity churn); models
  are keyed by provider+id.

### 1.1 (build 5)

- Initial App Store release ("Un Bien").
- Relays, QR pairing (`unbien://` deep link), live session transcripts
  with streaming tool calls / text / thinking, steering and queued
  follow-ups, tool-call approval, fork / clone / branch, subagent and
  plan panels, remote rename and terminate, model & thinking pickers,
  themes, iOS + macOS.

## Extension (@geohar/un-bien)

### 0.20.14 (2026-09-23)

- **Resume works on the herdr backend** — herdr passes trailing argv
  after `--` to the agent's executable, so remote resume now sends
  `pi --session <id>` exactly like tmux (the "resume is tmux only"
  refusal is gone). Also: the herdr `agent start` exec timeout raised
  to 45s — herdr waits up to 30s for agent detection, and the old 15s
  budget could kill a slow-starting launch mid-detection.

### 0.20.9 (2026-09-20)

- **TUI built-in slash intercept** for remote clients: `/compact
  [instructions]`, `/new`, `/name <name>`, `/thinking <level>`,
  `/model <term>` execute against session verbs; the 19 machine-local
  TUI commands (`/settings`, `/export`, `/copy`, `/resume`, `/fork`,
  `/clone`, …) and unknown slash commands refuse with a toast instead of
  reaching the model — unless the session's command registry knows the
  token (extension commands, `/unbien*`, skills, prompt templates pass
  through). Companion to the app's slash-command support.

### 0.20.8 (2026-09-20)

- **Owner-notify bridge**: `/unbien` command reports (install/uninstall
  summaries, errors) broadcast to paired apps as transient toasts via
  `extension_ui_request {method:"notify"}`.

### 0.20.7 (2026-09-18)

- Consolidated install/uninstall report: ONE final summary toast (the
  app's toasts replace each other, so per-step reports were wiping each
  other out).
- Linux service installs `enable` + `restart` — an already-running
  daemon is bounced onto fresh code (parity with macOS bootout +
  bootstrap).

### 0.20.6 (2026-09-18)

- **App-driven resume support**: `sessions_list`, `session_launch
  {resume}`, and the `UNBIEN_LAUNCH_REQ` launch-correlation echo
  (`session_resume` capability advertised by the launcher daemon).
- Datestamped `launcher.log` + the `debug.launcher` / `debug.relay`
  config prefs (separate from `debug.envelope`).

### 0.20.5 (2026-09-18)

- Install output streams live (fixes "installing…" then silence on
  Linux), and supervisor failures fail loud with actionable hints
  (e.g. `loginctl enable-linger` over SSH).

## Launcher (@geohar/un-bien-launcher)

The launcher daemon's code ships with the extension; launcher releases
are repins so standalone `npm i -g @geohar/un-bien-launcher` pulls
current code.

| Version | Repins to | Date |
| --- | --- | --- |
| 0.1.12 | 0.20.9 | 2026-09-20 |
| 0.1.11 | 0.20.8 | 2026-09-20 |
| 0.1.10 | 0.20.7 | 2026-09-18 |
| 0.1.9 | 0.20.5 | 2026-09-18 |

## Relay (un-bien-relay)

### 0.7.3 (2026-09-18)

- Datestamped fallback paths (raw `eprintln!` routed through tracing).
- `debug.relay` pref: the relay reads the shared `un-bien.json` and
  upgrades its log filter from ERROR-only to INFO when set (`RUST_LOG`
  still wins). Restart the relay to pick up a flip.

## CLI (@geohar/unbien-cli)

### 0.3.4

- Current release; no changes in the recent wave.
