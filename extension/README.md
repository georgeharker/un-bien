> **Derived from [remote-pi](https://github.com/jacobaraujo7/remote_pi)** by Jacob
> Moura, used under the MIT License (preserved in [`LICENSE`](LICENSE)). This tree
> is part of the [un-bien](../README.md) monorepo.

<p align="center">
  <img src="https://raw.githubusercontent.com/georgeharker/un-bien/main/app/icons/un-bien-macos-1024.png" width="160" alt="un-bien logo" />
</p>

<h1 align="center">un-bien</h1>

> Extend the [Pi coding agent](https://github.com/earendil-works/pi) with two
> superpowers: **remote-control Pi from your phone** (native iOS/macOS app over a
> relay you host), and a **local agent mesh** where several Pi sessions talk to
> each other.

`/unbien` is a single slash command that wires both at once. Run it; the first
time it asks a couple of questions and you are done.

## Protocol & Security

For wire format, identity model, ACK protocol, cross-PC routing, mesh
membership, and the trust model (what the relay sees and doesn't see),
read [`rpc-envelope`](../docs/rpc-envelope.md) at the repo root. It is the canonical
document — this README only covers user-facing setup.

---

## Quick start

Install the extension (one-time):

```bash
pi install npm:@geohar/un-bien
```

Then in any Pi terminal:

```text
/unbien
```

The first run shows a short interactive wizard (agent name, default session,
whether to use the relay on this terminal). On every following run, `/unbien`
joins the local agent session and starts the relay automatically — no extra
typing.

> **You must configure a relay before the mobile app can connect.** un-bien ships
> pointing at **nobody's** infrastructure — there is no built-in default relay.
> Self-host one (see [The relay](#the-relay)) and point the extension at it with
> `/unbien set-relay <url>`.

### Try the agent network in 30 seconds

Open **two** Pi terminals in the same directory and run `/unbien` in each.
Both join the same session. Now just talk to the LLM — it has the tools.

In terminal A (say it ended up named `agent-A`):

```text
Who else is connected in our agent session? List them.
```

The LLM calls `list_peers` and reports the complete routing addresses it sees.

Then, still in terminal A:

```text
Send a ping to agent-B using its listed address and ask it to reply later.
```

Pi calls `agent_send({ to: "<exact address from list_peers>", body: {
type: "ping" } })`. For unicast, the call waits only for the broker's delivery
ACK. Terminal B receives the message as a user-facing turn and can answer later
with `agent_send`, setting `re` to the ping's message id; that reply arrives in
terminal A's inbox or a later turn. It does not block terminal A waiting for
agent-B's content reply.

Copy the complete address exactly as listed. Do not build, parse, decode, or
normalize it.

---

## What it does

un-bien adds two independent layers on top of Pi. You can use either, or both:

### 1) Agent network (local broker, optional cross-PC relay)

Several Pi instances running side-by-side in different terminals can discover
each other and exchange messages. Each instance is a peer in a named
_session_. The LLM uses:

- `list_peers` — discover current peer routing addresses
- `agent_send` — unicast waits for the broker delivery ACK; broadcast is
  fire-and-forget

The legacy Pi-only `agent_request` tool is deprecated because it blocks while
waiting for another agent's content reply. Use `agent_send`, continue the
current turn, and receive any later reply through the inbox/turn flow with
`re` correlating it to the original message id.

Peers on the same machine talk over a Unix domain socket at
`~/.pi/un-bien/sessions/<session-name>/broker.sock`. When sibling PCs are paired,
a leader-capable Extension or MCP participant bridges the opaque cross-PC
addresses over the relay; local-only use stays on UDS when relay access is off.
Useful for splitting work across roles (`backend`, `frontend`, `tests`,
`orchestrator`, …) and letting them coordinate.

The first agent to enter a session becomes the _leader_ (hosts the broker);
the rest are _followers_. If the leader exits, a follower automatically takes
over — the failover is invisible to the LLMs.

### 2) Mobile app (over the relay)

The companion native iOS/macOS app lets you **attach to a running Pi session — or
launch a new one** — and drive it from your phone: send prompts, read responses,
answer Pi's interactive prompts, and switch models. The phone and the Pi process
find each other through a **relay**: a small WebSocket server that ferries
messages between them. Pairing is one-time and per device, via QR code.

Communication uses WebSocket over TLS to the relay. Fields such as `ct` are
wire containers, not a systemwide end-to-end confidentiality guarantee: current
Pi-forward, cross-PC, app, and control envelopes visible to the relay are not
fully opaque or E2E encrypted. A relay operator can see routed plaintext
protocol content and metadata; see [`rpc-envelope`](../docs/rpc-envelope.md) for the exact
trust boundaries. **Host the relay yourself** to keep that operator role in your
own hands.

---

## Mobile app actions

Beyond the chat, the app surfaces a small set of typed actions you can run
on the paired Pi session. Tap the ⚙ button next to the message input (visible
when the input is empty) to open the Quick Actions sheet:

| Action              | What it does                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compact context** | Runs `ctx.compact()` — same as `/compact` in the TUI.                                                                                        |
| **New session**     | Runs `ctx.newSession()` — equivalent to `/new`, asks for confirmation first.                                                                 |
| **Model**           | Opens a model picker fed by your authenticated providers (same source the TUI uses) and switches via `pi.setModel(model)`.                   |
| **Thinking**        | Segmented control with the 6 SDK levels (`off` · `minimal` · `low` · `medium` · `high` · `xhigh`). Changes via `pi.setThinkingLevel(level)`. |

Each action gets a structured `action_ok` / `action_error` reply so the app
can show a SnackBar on failure. Visible side-effects (chat output, model
change broadcasts, compaction notice) still flow through the normal chat
channels. The wire schema is documented in [`rpc-envelope`](../docs/rpc-envelope.md)
under "App actions".

It is **not** a generic slash-command picker. The Pi SDK does not expose
programmatic invocation for most builtins (those live in the TUI's
interactive loop), so the app exposes only the actions that have a clean
SDK call.

### Images

un-bien **displays images produced during a session** — when a tool or the agent
emits an image, the extension surfaces it to the app as a preview (customType
`un-bien:received-image`), capped at 10 MB.

On the inbound side, the wire and extension also support **image ingest**: a
`user_message` may carry an optional `images` field (`{ data: <base64>, mime }`),
which the extension turns into the SDK's multimodal content (an `ImageContent`
followed by the caption `TextContent`) and feeds to `sendUserMessage(content)`.
The mobile app does **not** yet expose an attach control, so this path is
available to clients but not surfaced in the app today.

Whether a model accepts images is surfaced as a `vision` flag on each
`WireModel` (derived from the SDK's `Model.input` including `"image"`).

The **relay is unchanged** — an image travels inside the same application
message container as the text, so there's no binary channel (large files are a
future track). Base64 or a field named `ct` is not an E2E confidentiality
boundary; the current Relay visibility follows the trust model above. Text-only
messages are unaffected.

---

## Install

Requirements: Node 20+, Pi (the host coding agent).

```bash
pi install npm:@geohar/un-bien
```

The extension self-registers the `/unbien` slash command and deploys an
agent skill that teaches the LLM how to use `list_peers`, `agent_send`, and the
event-driven inbox/reply flow.

To verify:

```text
/unbien config
```

It should print the effective relay URL and where it came from
(`env` / `config` / `unset`).

---

## Using `/unbien`

The bare command is the everyday entry point:

```text
/unbien
```

Behavior depends on whether there's a local config for this directory:

| State                                     | What happens                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| First run (no `.pi/un-bien/config.json`)  | Interactive wizard → saves config → joins agent session → starts relay (if you opted in) |
| Returning user, auto-start enabled        | Joins agent session + starts relay automatically, then prints status                     |
| Returning user, auto-start disabled       | Prints status only; join/relay must be run manually                                      |

The wizard asks three questions:

1. **Agent name** — the presentation leaf name for this agent. Senders still
   copy the complete opaque address returned by `list_peers`; they never build
   an address from this name. Defaults to the directory name.
2. **Default session** — the name of the agent-network room for this
   directory. Multiple terminals in the same directory join the same session.
3. **Use the relay on this terminal?** — `Yes` if you want `/unbien` to also
   connect to the relay so the mobile app (and paired PCs) can reach this Pi.
   `No` for local-only use (agent network without mobile access).

Re-run the wizard later with `/unbien setup`.

---

## Pairing a mobile device

Once the relay is up (`/unbien relay status` shows `started` or `paired`):

```text
/unbien pair
```

A QR code is printed in the terminal. Scan it with the un-bien mobile app.
Pairing is **per machine** — once a device is paired, every Pi process on
this machine accepts it (it lives in `~/.pi/un-bien/peers.json`).

To list paired devices:

```text
/unbien devices
```

To remove one:

```text
/unbien revoke <shortid>
```

The shortid is the first 8 chars shown by `devices`.

---

## The relay

The relay is the network boundary. TLS protects transit, but the Relay can see
routed plaintext protocol content and metadata; **use a relay you trust or
self-host**. There is no systemwide or PC-mesh E2E guarantee. For Pi-to-Pi
forwarding, the Relay currently permits a route when any correctly signed Owner
blob lists both canonical Pi keys. That does not prove the Owner paired with or
controls either Pi.

**un-bien ships with no default relay** — `/unbien config` reports `unset` until
you configure one, and the extension refuses to connect until you do.

### Self-host the relay

Run the relay yourself and put it behind a VPN like
[Tailscale](https://tailscale.com), [WireGuard](https://www.wireguard.com),
or your own VPC. Because the relay's network-level protection is just TLS +
keypair authentication, layering a VPN on top means **only your devices** can
even reach the WebSocket port — defense in depth.

Build and run from the `relay/` crate in this monorepo (see the
[relay README](../relay/README.md) for environment variables and reverse-proxy
guidance):

```bash
# From the monorepo root:
docker build -t un-bien-relay ./relay
docker run -d \
  --name un-bien-relay \
  -p 3000:3000 \
  -v un-bien-data:/data \
  --restart unless-stopped \
  un-bien-relay
```

Bind the container to your VPN interface, terminate TLS in a reverse proxy,
and point both your Pi and your phone at the resulting `https://…` URL.

### Pointing Pi at your own relay

Once your relay is reachable, tell the extension:

```text
/unbien relay url https://relay.yourdomain.tld
```

The URL **must** be `http://` or `https://` — `ws://` / `wss://` are
rejected at validation. The extension converts to WebSocket internally when
it opens the connection. Same canonical form for the mobile app and any
self-hosting docs: paste the URL your reverse proxy exposes.

This writes the `relay` field into the global config at
`~/.pi/extensions/un-bien.json`. Resolution order (highest precedence first):

1. `UNBIEN_RELAY` environment variable (CI / one-off overrides)
2. `relay` field in `~/.pi/extensions/un-bien.json`

There is **no built-in default** — when neither is set, the extension refuses
to connect and prompts you to configure a relay.

Verify the active URL and its source with:

```text
/unbien config
```

If you change the URL while connected, run `/unbien relay stop` then
`/unbien relay start` (or `/unbien relay` to toggle).

The mobile app has its own relay-URL setting in its preferences pane — keep
both pointing at the same relay.

---

## Agent network: deeper look

Each session is one Unix-domain-socket broker plus N peers. The broker
multiplexes messages by opaque `to` address and broadcasts system events
(`peer_joined`, `peer_left`).

Inside the LLM, the agent skill uses `list_peers` for discovery and
`agent_send` for delivery:

```jsonc
list_peers() // copy a complete address from this result

agent_send({
  to: "/repo/api@backend", // exact opaque address returned by list_peers
  body: { task: "add /healthz endpoint" },
  re: "<id>" // set to the received message id when replying
})
```

A unicast `agent_send` waits for the broker delivery ACK and returns the public
status `received`, `denied`, or `timeout`; broadcast is fire-and-forget. A
trusted Relay's closed transport reason is returned in `details` without
changing those statuses: `offline` maps to `timeout`, while `not_authorized`
and `bad_envelope` map to `denied`. Genuine silence is a reasonless `timeout`.
Do not blindly retry authorization or envelope failures. Trusted Relay errors
are consumed internally to settle pending sends; forged or invalid reserved
bodies do not gain that authority.

Mesh addresses are opaque routing values: echo them verbatim, including
receiver-local PC aliases with percent-encoded bytes (such as `%3A` or `%25`)
or collision suffixes containing `~`. Never parse, build, decode, or normalize
an address for routing or security. A PC alias is receiver-local presentation
and routing only, so different PCs may list the same sibling under different
aliases. The canonical 32-byte Ed25519 Pi public key is the PC's technical
identity; never use an alias as proof of identity.

`agent_request` remains available only as a deprecated legacy Pi tool. Prefer
`agent_send`, then handle any later inbox/turn reply whose `re` matches the
original message id.

The wire format is a 5-field envelope `{ from, to, id, re, body }` serialized
as one JSON line per message. The leader's broker writes an `audit.jsonl`
log at `~/.pi/un-bien/sessions/<name>/audit.jsonl` for postmortem inspection.

Useful commands:

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `/unbien`              | Join the local mesh (and start the relay, if enabled) |
| `/unbien peers`        | List local + cross-PC mesh peers, grouped by PC       |
| `/unbien rename <new>` | Rename this agent in the current session              |
| `/unbien stop`         | Leave the local mesh and disconnect the relay         |

Name collisions inside a session get a numeric suffix automatically
(`backend`, `backend#2`, `backend#3`). The broker assigns it and returns the
real name to the peer.

---

## Command reference

### Local session (one Pi, one terminal)

| Command                               | Description                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `/unbien`                             | Connect (join local mesh + start relay), or run setup on first use             |
| `/unbien setup`                       | Run the setup wizard and update local config                                   |
| `/unbien status`                      | Show local mesh + relay status                                                 |
| `/unbien stop`                        | Stop everything for **this** terminal (mesh + relay)                           |
| `/unbien pair`                        | Show QR code + copy-paste pairing URI for a new mobile device                  |
| `/unbien devices`                     | List paired mobile devices (online/offline per device)                         |
| `/unbien revoke <shortid>`            | Revoke a paired device by its shortid                                          |
| `/unbien set-relay <url>`             | Persist a new relay URL (http:// or https://)                                  |
| `/unbien relay [start\|stop\|status]` | Relay-only control — leaves local mesh membership untouched (no verb = toggle) |
| `/unbien relay url <url>`             | Same as `set-relay`                                                            |
| `/unbien config`                      | Show the effective relay URL and its source (env / config / unset)             |

### Daemon fleet (one supervisor, N background Pis — see [Daemon mode](#daemon-mode))

| Command                                     | Description                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `/unbien create <cwd> [--name X]`           | Register a folder as a daemon                                                 |
| `/unbien remove <id>`                       | Unregister a daemon (local config preserved)                                  |
| `/unbien daemons`                           | List registered daemons + state                                              |
| `/unbien daemon start`                      | Start every registered daemon                                                |
| `/unbien daemon stop`                       | Stop every running daemon (`/unbien stop` stops only the local terminal)     |
| `/unbien daemon restart`                    | Stop + start all daemons                                                     |
| `/unbien daemon status`                     | Detailed runtime status (pid, uptime, restart count)                         |
| `/unbien daemon send <id> "<text>"`         | Send a prompt to a specific daemon                                           |
| `/unbien cron add <id> "<expr>" "<prompt>"` | Schedule a recurring prompt (`--tz`, `--wake`, `--no-skip-busy`, `--catchup`) |
| `/unbien cron list`                         | List scheduled jobs (schedule, enabled, next run, last status)               |
| `/unbien cron run <jobId>`                  | Fire a job now (ignores its schedule)                                        |
| `/unbien cron enable\|disable <jobId>`      | Toggle a job on/off                                                          |
| `/unbien cron remove <jobId>`               | Delete a job                                                                 |
| `/unbien cron log [<jobId>] [--tail N]`     | Read the fire/skip audit log                                                 |
| `/unbien install`                           | Install `pi-supervisord` as a system service                                 |
| `/unbien uninstall`                         | Remove the system service (registry preserved)                              |

All commands above work both as Pi slash commands (interactive) and as
shell-level `unbien <subcommand>` when the package is installed
globally (`npm install -g @geohar/un-bien`).

### Scheduled prompts (`cron`)

`unbien cron` schedules **recurring prompts** to daemons through the
supervisor — e.g. a daily "summarise new PRs". Output flows fire-and-forget to
the mesh/app like any prompt; the cron layer only audits the dispatch.

- **Schedule** is a cron expression (croner syntax; an optional 6th _seconds_
  field is supported), with an optional IANA timezone via `--tz`:

  ```sh
  unbien cron add a1b2c3d4 "0 9 * * *" "Summarise new PRs" --tz America/Sao_Paulo
  ```

- **Minimum interval is 60s** — more frequent schedules are rejected (guards
  token cost + pileup). A fire is **skipped when the daemon is mid-turn**
  (`--no-skip-busy` to override); `--wake` starts a stopped daemon first;
  `--catchup` runs once on supervisor start if the previous run was missed.
- **Prerequisite**: the supervisor must run as a service (`unbien install`).
  Without it there is no scheduler, and `cron` commands say so instead of
  silently pretending to schedule.
- **Audit**: every fire **and** every skip appends one line to
  `~/.pi/un-bien/cron.jsonl` with a `result` of `delivered`,
  `woke_and_delivered`, `deliver_failed`, `skipped_busy`, `skipped_down`, or
  `skipped_disabled` — read it with `unbien cron log`.

### Footer + title

- `📡 local (N)` — current agent session and peer count (local mesh)
- `🟢 relay` — relay connected, at least one device paired (globally)
- `🟡 relay waiting for pairing` — relay connected, no device paired yet
- `📱 <shortid>` — a mobile device is actively connected right now

Window title: `<agent-name> · On` when relay is up, `<agent-name> · Off`
otherwise. Tells your terminals apart at a glance in `cmux`/`tmux`/iTerm
tabs.

---

## Daemon mode

When you want a Pi to keep running in the background (responding to
mobile prompts at 3am, processing cron jobs, monitoring a folder while
you're not at the keyboard), promote it to a **daemon** managed by a
single OS-level supervisor.

See [`docs/daemon.md`](./docs/daemon.md) for troubleshooting.

### One-time setup

```bash
# Install the package globally so `unbien` and `pi-supervisord`
# are on your PATH (`pi install npm:@geohar/un-bien` alone makes the Pi
# extension available but does NOT expose the CLI binaries — see
# https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin).
npm install -g @geohar/un-bien

# Install the supervisor as a user-level system service. Linux uses
# systemd --user; macOS uses launchd LaunchAgent. Both auto-start at
# login and survive reboots.
unbien install
```

The `install` command:

- Writes `~/.config/systemd/user/unbien-supervisord.service` (Linux)
  or `~/Library/LaunchAgents/dev.unbien.supervisord.plist` (macOS)
- Activates it via `systemctl --user enable --now` or `launchctl bootstrap`
- The supervisor starts immediately and re-starts on every login

### Per-folder workflow

For each agent you want to keep alive 24/7:

```bash
# 1. Configure the agent interactively first (one time).
cd ~/Movies
pi                                 # /unbien → setup wizard, /unbien pair, etc

# 2. Promote to a daemon. The id is derived from the cwd
#    (sha256(realpath)[:8]), stable across machines.
unbien create ~/Movies --name "Video Editor"
# → Daemon registered: id=4e39152d name="Video Editor" cwd=/Users/x/Movies

# 3. Start it (supervisor spawns `pi --mode rpc` for this folder).
unbien daemon start
```

Now you can:

```bash
unbien daemons                     # list + state
unbien daemon status               # uptime, pid, restart count
unbien daemon send 4e39152d "Cut the first 30 seconds of latest clip"
unbien daemon stop                 # stop all
unbien daemon restart              # restart all
```

The agent receives the prompt as if a user typed it; its response flows
back through the relay/mesh you configured during interactive setup —
mobile app sees it live, other agents on the same machine can see it
via the local UDS mesh.

### Removing or uninstalling

```bash
unbien remove <id>                 # unregister one daemon (config preserved)
unbien uninstall                   # remove the supervisor service (registry kept)
```

`uninstall` is reversible — re-running `install` later brings every
registered daemon back. To wipe the registry entirely, `rm
~/.pi/un-bien/daemons.json`.

### Where to find logs

| Platform | Command                                          |
| -------- | ------------------------------------------------ |
| Linux    | `journalctl --user -u unbien-supervisord -f`     |
| macOS    | `tail -f ~/.pi/un-bien/supervisord.log`          |

Each spawned daemon's stderr is forwarded into the supervisor's log
with a `[<cwd>]` prefix, so a single log stream shows every agent.

### Caveats

- **Tool execution is not gated.** Daemons inherit the same Pi config
  the interactive run uses — Bash, Edit, Write etc. all execute without
  prompting. Configure Pi's tool permissions to taste before promoting
  a folder to daemon.
- **Pairing still happens interactively.** Daemons don't show a QR
  themselves; the keypair + paired devices come from the prior `pi`
  session in the same folder.
- **Single supervisor.** If `pi-supervisord` crashes all daemons go
  down with it. systemd/launchd restarts it within seconds; daemons
  come back automatically.
- **One daemon per cwd.** The `roomIdForCwd` derivation makes daemons
  by-path; two daemons in the same folder is rejected at `create` time.

---

## Configuration & settings

### Files

| Path                                          | Scope                 | What's in it                                                                          |
| --------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `~/.pi/extensions/un-bien.json`               | Per-user (global)     | `relay` URL, `defaults`, `identity`, `debug` — the global settings (see below)        |
| `<cwd>/.pi/un-bien/config.json`               | Per-directory         | `agent_name`, `auto_start_relay`, `allow_remote_launch`                               |
| `~/.pi/un-bien/identity.json`                 | Per-machine           | Paired identity keypair (file identity backend; `0600`)                               |
| `~/.pi/un-bien/peers.json`                    | Per-machine           | Paired mobile devices                                                                  |
| `~/.pi/un-bien/sessions/<name>/`              | Per-session           | Broker socket + `audit.jsonl`                                                          |
| `~/.pi/un-bien/daemons.json`                  | Per-machine           | Daemon registry                                                                        |
| `~/.pi/un-bien/cron.json` · `cron.jsonl`      | Per-machine           | Cron registry + fire/skip audit log                                                   |
| `~/.pi/un-bien/supervisor.sock`               | Per-machine           | Supervisor control socket                                                              |
| `~/.pi/un-bien/skills/agent-network/SKILL.md` | Per-user              | Agent skill the LLM reads                                                              |

### Global settings — `~/.pi/extensions/un-bien.json`

This is a Pi **extension config** (it lives beside the coding agent's own
settings, under `PI_CODING_AGENT_DIR/extensions/`, not in the state tree). All
fields are optional:

```jsonc
{
  // Relay URL in canonical http(s):// form. No default — unset means the
  // extension refuses to connect. Set via `/unbien set-relay <url>`.
  "relay": "https://relay.yourdomain.tld",

  // Machine-wide fallback for every per-cwd config that doesn't set the field.
  // Pin auto-start once instead of dropping a file into every repo.
  "defaults": { "auto_start_relay": true },

  // Machine-identity storage. `storage` selects the PRIMARY backend for this
  // Pi's long-term Ed25519 seed: "keychain" (OS-secured, default) or "file"
  // (a 0600 seed file — the SSH-private-key model: cat-able, portable,
  // works headless). `path` overrides the file-backend location
  // (default ~/.pi/un-bien/identity.json). The unselected backend is still
  // READ to recover an existing identity, but never written.
  "identity": { "storage": "keychain", "path": "~/.pi/un-bien/identity.json" },

  // File-based diagnostic logs. Off by default. Read from config (not env)
  // because the daemon fork usually runs detached without a shell's env.
  "debug": { "envelope": false, "panels": false }
}
```

### Per-directory settings — `<cwd>/.pi/un-bien/config.json`

Written by the `/unbien` setup wizard:

| Field                 | Default              | Meaning                                                                                    |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `agent_name`          | directory name       | Presentation leaf name for this agent (senders still use the opaque `list_peers` address)  |
| `auto_start_relay`    | `true`               | On a fresh terminal, `/unbien` auto-joins the mesh and starts the relay                     |
| `allow_remote_launch` | `false`              | Honor `session_launch` requests from a paired owner (spawn a new Pi session). Opt-in only.  |

### Environment variables

| Variable              | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `UNBIEN_RELAY`        | Relay URL override (highest precedence, ahead of the config file). CI / one-off use.                                       |
| `UNBIEN_DIR`          | Absolute override of the **state** dir itself (no `.pi/un-bien` suffix). The knob for an XDG-style relocation.             |
| `UNBIEN_HOME`         | Stand-in `$HOME`; state lives at `<UNBIEN_HOME>/.pi/un-bien`. When both are set, `UNBIEN_DIR` wins.                        |
| `PI_CODING_AGENT_DIR` | The Pi host's settings root (default `~/.pi`); the global config lives at `<PI_CODING_AGENT_DIR>/extensions/un-bien.json`.  |
| `UNBIEN_DIRECT_CONFIG`| Inline per-cwd config (JSON) instead of a `.pi/un-bien/config.json` file — used by the daemon supervisor.                   |

`UNBIEN_DIR`/`UNBIEN_HOME` relocate un-bien **state** (sessions, daemon
registries, cwd locks, paired identity). `PI_CODING_AGENT_DIR` relocates only
the global **config**, so it can sit beside the coding agent's own settings.

Override the relay for a single run without persisting:

```bash
UNBIEN_RELAY=https://staging.example.tld pi
```

---

## Troubleshooting

**Footer says `🟡 relay waiting for pairing` even though I paired a device.**
The icon reflects whether _any_ device has been paired on this machine, not
whether one is connected right now. If you really have a paired device in
`/unbien devices`, restart Pi — the cache may be stale (fixed in current
release; report a bug if it recurs).

**Mobile app times out connecting.** Verify the same relay URL is configured
on both sides. If you self-host behind a VPN, your phone must also be on the
VPN (Tailscale on iOS/Android works fine).

**`/unbien config` says the relay is `unset`.** un-bien has no default relay.
Self-host one and set it with `/unbien set-relay <url>` (or `UNBIEN_RELAY`).

**`agent_request` keeps timing out.** It is deprecated because it blocks the
turn while waiting for another agent's content reply. Migrate to `agent_send`;
a unicast waits only for the delivery ACK, and the receiver can reply later
with `agent_send` including `re: "<original-id>"` for correlation.

**Multiple terminals in the same directory.** Supported. They share the same
agent-network session (UDS broker) and the relay handles each Pi process
independently. If the relay refuses with `RoomAlreadyOpenError`, stop the
other terminal first.

---

## Links

- Repository: <https://github.com/georgeharker/un-bien>
- Documentation: <https://docs.georgeharker.com/un-bien>
- Pi coding agent: <https://github.com/earendil-works/pi>
- Relay (self-hosting guide): [`../relay/README.md`](../relay/README.md)
- Upstream project (remote-pi, MIT): <https://github.com/jacobaraujo7/remote_pi>

---

## License

MIT — derived from [remote-pi](https://github.com/jacobaraujo7/remote_pi) by
Jacob Moura. See [`LICENSE`](LICENSE).
