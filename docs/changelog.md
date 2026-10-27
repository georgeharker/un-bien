# Changelog

Release notes per component, newest first. The app ships independently of
the npm/relay packages; the sections below note companion-version
requirements where they matter.

## App

### 1.5.1 - 1.5.4 (build 21, 2026-10-26)

- **Fixed: messages could go missing forever.** Some replies never appeared
  — live or after reopening — while later messages rendered around the
  gap. The app trusted message identifiers supplied by AI providers, and
  some providers reuse them, making the app mistake two different
  messages for one and silently drop the second. History now renders
  completely; older conversations may visibly recover messages that were
  absent.
- **History recovery is complete and safe.** When a history sync ends
  abnormally (flaky connections can do it), recovered messages now always
  render — and the view can never scroll the conversation backward.
- **Double-tap the message bar to jump to the newest messages.**

### 1.5 (build 14, 2026-10-21 - 2026-10-23)

- **Relay identity verification** — the app now proves which relay it's
  talking to: the first connection pins the relay's cryptographic
  identity, every reconnect re-verifies, and a wrong relay is refused
  before any of its traffic is trusted. Matches the desktop clients; the
  trust plane is symmetric everywhere.
- **Machines show up when they're available, not when you refresh** — a
  machine with its launcher daemon running appears with its launch
  control immediately (previously invisible until a session opened), and
  the control no longer waits on background polling.
- **Federated relays federate machine visibility** — machines on a linked
  relay appear across the mesh with their launch controls.
- **The transcript shows what tool calls are** — script calls render as
  JavaScript, shell commands as highlighted shell, search calls as their
  query, and tool output as colored code blocks instead of raw JSON.
  Applies to new and reopened history alike.
- **Reopened conversations keep their linked-machine sessions** through
  connect/refresh where they previously could vanish (empty snapshots no
  longer purge content the peer relay owns).

### 1.4 (build 8, 2026-10-15)

- **Federated mesh (v2)** — sessions and machines on federated relays
  appear with server chips and launch rows; remote launch/resume work
  end-to-end; dead federated rooms are attach-gated and pruned instead of
  spinning. Requires relay 0.7.40-dev+ and extension 0.20.60-dev+ for the
  full flow (older combinations degrade to direct-relay behavior).
- **A device now advertises its owner** — the app pushes a self-signed
  `pairing_set` on connect, which the strict federated content gates
  require for reply legs (transcript pages, launch acks) from remote
  machines.
- **Backfill overhaul** — the fetch cursor is now content-derived and
  persisted (the folded frontier): replay resumes only over content the
  app actually holds, foregrounding reconciles missed turns, a stale
  cursor after pi's resume-time id rewrites forces a genuinely full walk
  instead of looping, and the per-turn delta walk resumed from the folded
  frontier (beacon divergence closed). Backfill pages and the app's WS
  frame cap are sized to the relay's transport budget (32 MiB).
- **Unreachable relays pause** instead of retry-metronoming — one attempt
  per foreground, the state lives on Home's relay chip. Connection-death
  and transport notices are silent by design; WS stream-end reasons
  surface only where they change what the user should do.

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

### 0.21.2 (2026-10-16)

- **Install summary lists the baked-in relay env** — every `UNBIEN_*`
  variable the installer snapshots from the invoking shell into the
  relay's service env, with a warning when neither `UNBIEN_RELAY_URL`
  nor `UNBIEN_RELAY_BIND` is present (a relay that cannot advertise a
  dialable address — previously only discovered at the next pairing
  failure). The launcher daemon logs a boot version banner as the first
  line of `launcher.log`, so "which code is the process running" is
  answerable from the log.

### 0.21.0 (2026-10-15; dev cycle 0.20.25-dev → 0.20.60-dev)

- **Remote launches spawn through the user's login shell** (both layers:
  the tmux invocation and the pane command) — launchd-context daemons
  otherwise run devoid of the user's environment (homebrew PATH, version
  managers). Shell resolution never assumes: `launch.shell` → `$SHELL` →
  the OS login shell (`dscl`/`getent`) → zsh; extra flags via
  `launch.shell_args`; the pane command is one properly-quoted string
  (injection-safe) behind tmux's `--`, and spawn failures — including
  tmux's own stderr and nonzero exits — land in `launcher.log`.
- **`unbien-admin install` now updates the launcher npm package** —
  previously nothing ever did (the daemon ran stale code across five
  ext releases while the package looked current), and every install
  kickstarts both services.
- **get_entries pages are ≤ budget by construction** (preflight: the
  crossing entry begins the next page) — pages sized for the app's
  transport frame cap instead of exceeding it (with the app's 32 MiB
  receive cap, oversized pages became deliverable).
- The daemon's launch peer-gate refuses are logged; the pairing
  handshake tolerates a presenter without `UNBIEN_RELAY_URL` (URL
  inheritance; name still required); SRC-gate refusals log at warn with
  the gate's inputs; pairing frames are exempt from the federated
  content gates (federated pairing bootstrap unblocked).

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

### 0.8.4 (2026-10-21)

- **Federated machines visible with launcher only**: the
  `federated_peer_list` push carries daemon control rooms (the same
  shared grouping as rooms_check, no `is_daemon` filter) — a federated
  machine whose launcher daemon is up but has no pi sessions appears to
  the app with its machine row + launch caps immediately instead of
  waiting for a session to open. The app filters control rooms from
  session display itself; rooms_check (the CLI's control-room discovery
  path) is unchanged.
- Test rig no longer inherits ambient `UNBIEN_RELAY_BIND`/`URL` from the
  developer shell (a real relay's exported env made rig relays die at
  loud boot — "never started listening"); the transit-learning test's
  10s deadline widened to 30s (slow CI runners legitimately outran it;
  the assertion is eventual learning, not latency).

### 0.8.3 (2026-10-16)

- **`UNBIEN_RELAY_BIND` — named bind addresses**: comma-separated
  `host[:port]` entries (names or IPs, never URL schemes), one listener
  per address, sharing one router. The lockdown form
  `UNBIEN_RELAY_BIND=localhost,machine.<tailnet>.ts.net` binds loopback +
  tailnet only — the socket never opens on other interfaces. Unresolvable
  entries fail loudly at boot.
- **Bind-derived URL advertisement**: when the bind names a
  non-loopback host, the relay advertises `ws://<host>:<port>` in
  `relay_hello` automatically with `UNBIEN_RELAY_URL` unset — the
  advertisement can no longer be forgotten or drift from the bind.

### 0.8.0 (2026-10-15; dev cycle 0.7.35-dev → 0.7.40-dev)

- **Federation v2** — explicit pinned pairing replaces shared-owner hash
  intersection as the link gate (strict now: unpinned peers decline by
  design); the one-pair flow mints a single-use 24h secret that
  auto-adds the presenter (mutual config, one action); content gates are
  one rule over machine-signed owner sets (sender-owner ∩ target-owner,
  strict on unknown, no machine exemptions), decided at the source
  relay; all hosts become transitively known (origin-tagged
  advertisement segments with `fed_proto` negotiation, never back to the
  arrival link), frames route directed with per-hop re-signing,
  id→backlink acks, and the `visited` loop guard.
- **Hardened live on device**: spent pairing secrets fall through to the
  pin gate (links survive reconnects instead of working exactly once);
  a presenter without `UNBIEN_RELAY_URL` federates with URL inheritance
  (name still required); pending invitations expire in 24h with a
  consume-time sweep; `rooms_check` serves federated rooms in ONE frame
  per epk (the first-frame-resolve bug that hid every session after the
  first); SRC-gate refusals log at warn; the ct ceiling is 16 MiB.

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

### 0.4.0 (2026-10-15; dev cycle 0.3.7-dev → 0.3.34-dev)

- **The one-pair flow** (`relay pair` → `peer add relay-pair://…`) with
  pending-invitation lifecycle (single-use, 24h TTL, re-mint =
  revocation, expiry marking); the legacy `peer add <url> <name>` form
  is refused (pinned pairing is mandatory).
- **Federated resolution everywhere** — `connect` resolves machines
  from the federated room list when no stored pairing peer matches
  (launches always could), polls for a freshly-launched session
  instead of losing the propagation race, accepts hostname targets
  (short form and FQDN-on-first-label), and a CLI device pushes its
  self-signed `pairing_set` on connect (required for federated reply
  legs).

### 0.3.4

- Current release; no changes in the recent wave.

## Known issue: app backfill misses text response

**Observed:** During app backfill (session_sync get_entries replay), the user sees the thinking block but not the model's text response. Both are visible in the TUI.

**Suspected causes:**

1. fitEntryForTransport truncation in rpc_inbound.ts cuts the text from the end of a large entry (2 MiB cap) while preserving the thinking at the beginning
2. get_entries paging boundary splits thinking + text across pages — the app only requests the first page
3. The app receives the full entry but only renders the thinking block (app display bug)
4. Pi stores thinking + text as separate content blocks — the backfill only deserializes the first

**Investigation needed:** Check if the raw entry JSON has the full text or if it's truncated. Key file: extension/src/session/rpc_inbound.ts

**Not federation-related** — pre-existing app/pi backfill issue observed during federation testing.
