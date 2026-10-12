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

### 0.20.24 (2026-10-10)

- **mesh.tools config gate** — the cross-session mesh tools (`agent_send`,
  `list_peers`, `whoami`, `mesh_*`) are now gated on a `mesh.tools` config
  setting (default `true`). Set `"mesh": {"tools": false}` in
  `un-bien.json` to disable them; the broker + relay still work for the
  paired app, but the model can't call the mesh tools. Restart pi to
  pick up a flip.
- **Docs: `docs/cross-session-comms.md`** — full documentation of the
  cross-session messaging surface: tools, delivery model (push + pull +
  wait), error semantics, events, in-place rename, broker architecture,
  same-owner validation, collision safety, app safety.

### 0.20.23 (2026-10-10)

- **Cross-mesh robust messaging + inbox pull + in-place rename** —
  LLM-agnostic (pi + un-bien, any model). No app changes.
  - **`unknown_peer` ACK**: the local broker returns a fast `unknown_peer`
    ACK (not a silent 5s timeout) when a peer isn't registered. The relay
    does the same cross-machine (relay 0.7.4).
  - **`whoami` tool**: returns the agent's mesh identity (`address`, `name`,
    `broker`, `socket`). `list_peers` includes a `self` field.
  - **Inbox pull + wait-until**: `mesh_get_message` / `mesh_list_messages` /
    `mesh_wait_message` — every inbound mesh message is stored in a
    `MeshInbox`; a missed push is recoverable; `mesh_wait_message` blocks
    for a reply by `re` (the `agent_request` replacement).
  - **Events**: `un-bien:peer_joined` / `peer_left` / `message_received`
    on `pi.events`.
  - **In-place rename**: `/name` now re-keys the broker mesh name in-place
    (no teardown/rejoin, no leader re-election) so `list_peers` reflects
    the new name immediately — was: needed `/reload`.
- **Tool names collision-checked**: `whoami` + `mesh_*` vs Claude built-ins
  - pi-subagents.

### 0.20.22 (2026-10-04)

- **Bridge stock `ctx.ui` dialogs to the paired app (first-responder-wins)** —
  pi-ask is optional, so an extension's raw `ctx.ui.select`/`confirm`/`input`/`editor`
  (consent gates, elicitation, un-bien's own wizard) previously rendered on the
  local TUI only and never reached the phone, stranding the mobile user. The UI
  bridge now wraps pi's shared `ExtensionUIContext` once at `session_start` (one
  object across all extensions) so every stock dialog races the local TUI against
  the paired app: whichever answers first wins, the other is dismissed (local win
  → id-matched notify closes the app modal; app win → the `AbortSignal` closes the
  local dialog). Same wire contract pi-ask already uses — **no app changes**
  (the app's `ExtensionUIPromptView` already rendered stock `extension_ui_request`).
  Disjoint from pi-ask (which renders via `ctx.ui.custom` + its event bus, not
  `select/confirm/input`); inbound responses route by id space. Restore/reconnect:
  open dialogs replay on `session_sync`; resolved-while-disconnected ones retire
  via the app's existing ask-reconcile.
- **Internal: remove dead imports + fix localized lint warnings in `index.ts`** —
  nine imports/interface left dead by the routing carve (7866ff5) and per-session
  refactor (f55f116) removed; a nested ternary, a switch-without-default, and a
  non-null assertion cleaned. No behavior change.

### 0.20.21 (2026-09-30)

- **Compatibility: declare host-provided packages as `peerDependencies` `"*"` (pi 0.99.1)** — pi 0.99.1 rejects extension packages that list host-provided runtime (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) under `dependencies`; an installed copy can bypass the extension loader and create duplicate runtime modules. Moved the three to `peerDependencies` with a `*` range so the host supplies them and the published tarball no longer ships its own. No behavior change.

### 0.20.19 (2026-09-26)

- **Fixed: room tiles sporadically showed `myRoomMeta` after opening a chat
  (refresh fixed it)** — `session_sync_end` pushed the session name as
  `deps.myRoomMeta?.name`, but in the plane-router deps `myRoomMeta` is an
  accessor _function_ (`() => _rootState().myRoomMeta`), not the meta object.
  So `?.name` read the JavaScript function's own `.name` property — the literal
  string `"myRoomMeta"` — and the app applied it to the tile on every open +
  reconnect. `rooms_check` (pull-to-refresh) overwrote it with the real name
  from the relay, so the tile self-healed on refresh. One-character fix from
  the routing carve: call the accessor (`deps.myRoomMeta()?.name`). Regression
  test asserts `session_sync_end.session_name` is the room's display name and
  is never the literal `myRoomMeta`.

### 0.20.18 (2026-09-26)

- **Fixed: rooms sporadically announced without a name after a session
  replacement** — `0.20.17` keyed the relay-room projection
  (`myRoomId`/`myRoomMeta`/`sessionStartedAt`) on the rotating pi session
  id, so every New/Fork/Clone/Reload lazily created a fresh session record
  and nulled the projection until the async relay connect repopulated it.
  In that window a reconnect announced a NAMELESS room — the relay fell
  back to its default room name and the app showed a placeholder tile until
  a manual refresh re-pulled the live name. The projection is a
  root-process singleton by contract (`_goIdle` preserves it across
  stop/start; `session_shutdown` never cleared it), so keying it on the sid
  that rotates on every replacement contradicted the teardown contract.
  The root record is now ONE stable singleton; `session_start` adopts the
  new sid before its per-session writes; `session_shutdown` clears only the
  base ctx. New/Fork/Clone/Reload now re-announce with their own name and
  no update is ever addressed to the dead old room. No-clobber invariant
  for subagent children unchanged.

### 0.20.17 (2026-09-25)

- **Hardening: per-session state, keyed by pi sessionId** — the extension's
  remaining module-level singletons (`myRoomId`/`myRoomMeta`,
  `sessionStartedAt`, `currentModel`/`currentThinking`, and the base event
  ctx) moved into the per-session `SessionState` record. pi re-activates
  in-process for every subagent, and a subagent's `session_start`/turn
  events used to overwrite the root session's values with the child's
  (latent since 0.1 — mostly benign because the room projection is
  root-only, but it demonstrably broke root-scoped notifies via a clobbered
  ctx, and mixed per-session data whenever values genuinely differed). All
  per-session data is now contextualized; the remaining module globals are
  root-lifecycle/process-level by construction behind ownership gates.
  No user-facing behavior change expected.
- **Internal: `index.ts` decomposition** — the plane routers ({rpc}
  dispatch + un-bien plane) moved to `src/routing.ts` behind the
  accessor-deps pattern (index.ts ~2500 lines, down from 6600).
  Behaviour-preserving.

### 0.20.16 (2026-09-25)

- **Fixed: ask_user prompts missing on the phone after a session
  re-open/reconnect** — the `session_sync` replay of pending asks rode a
  bare ServerMessage frame, which the app's envelope router silently
  drops; every replay was a no-op and the terminator then retired the
  still-pending prompt as "stale" ~1s after opening the session. The
  replay now rides the same `{rpc}` envelope as the live ask path, so a
  flow asked while you were away appears on the next open/reconnect.

### 0.20.15 (2026-09-24)

- **herdr compatibility with herdr >=0.9.1** — `workspace create` no longer
  sends the removed `--json` flag (newer herdr rejects it outright, which
  made every herdr remote-launch fail before reaching the pane). Output is
  JSON by default; the response shape is unchanged. (PR #4, joshkaspar)
- **Launcher/relay services no longer guess a wrong `PI_CODING_AGENT_DIR`**
  — when the var is unset in the installing shell, generated launchd/systemd
  units previously baked in `~/.config/pi/agent`, silently overriding the
  correct `~/.pi` fallback and crash-looping the service with "no relay
  configured". Units now snapshot `""` and resolve exactly as the installing
  shell does. Shared resolver extracted to one function used by both
  installers. (PR #5, joshkaspar)

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

| Version | Repins to | Date       |
| ------- | --------- | ---------- |
| 0.1.12  | 0.20.9    | 2026-09-20 |
| 0.1.11  | 0.20.8    | 2026-09-20 |
| 0.1.10  | 0.20.7    | 2026-09-18 |
| 0.1.9   | 0.20.5    | 2026-09-18 |

## Relay (un-bien-relay)

### 0.7.4 (2026-10-10)

- **`unknown_peer` transport_error for offline remote** — the relay's
  pi-forward path now returns `transport_error: unknown_peer` (was:
  `offline` → the extension timed out 5s) when the target PC isn't
  registered on the relay. The sender gets a fast `unknown_peer` ACK,
  not a timeout. Cross-owner sends are still refused (`not_authorized`,
  unchanged). Companion to extension 0.20.23.

### 0.7.3 (2026-09-18)

- Datestamped fallback paths (raw `eprintln!` routed through tracing).
- `debug.relay` pref: the relay reads the shared `un-bien.json` and
  upgrades its log filter from ERROR-only to INFO when set (`RUST_LOG`
  still wins). Restart the relay to pick up a flip.

## CLI (@geohar/unbien-cli)

### 0.3.4

- Current release; no changes in the recent wave.
## Known issue: app backfill misses text response

**Observed:** During app backfill (session_sync  replay), the user sees the thinking block but not the model's text response. Both are visible in the TUI.

**Suspected causes:**
1.  truncation in  cuts the text from the end of a large entry (2 MiB cap) while preserving the thinking at the beginning
2.  paging boundary splits thinking + text across pages — the app only requests the first page
3. The app receives the full entry but only renders the thinking block (app display bug)
4. Pi stores thinking + text as separate content blocks — the backfill only deserializes the first

**Investigation needed:**
- Check if the raw entry JSON has the full text or if it's truncated
- Check the  paging handler in 
- Check if  content blocks (thinking vs text) are both serialized in the entry

**Not federation-related** — pre-existing app/pi backfill issue observed during federation testing.
**Key file:**  —  + the  paging handler

