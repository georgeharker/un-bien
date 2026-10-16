<p align="center">
  <img src="../docs/images/icon-192.png" alt="Un Bien" width="96" />
</p>

# unbien-cli

A terminal client for **remote [Pi coding agent](https://github.com/earendil-works/pi)
sessions**. Attach to a session running on another machine over an
[un-bien](https://github.com/georgeharker/un-bien) relay and drive it from your
shell — the same sessions the iOS/macOS app talks to.

It renders with **pi's own interactive components**, so a remote session looks
like a local one: CommonMark + syntax highlighting, native edit-diff / read /
bash tool cards, thinking blocks, and your configured pi theme (including
package-contributed ones such as `tokyo-night`).

```bash
npm install -g @geohar/unbien-cli
```

## Commands

| Command                    | What it does                                         |
| -------------------------- | ---------------------------------------------------- |
| `unbien`                   | Connect (default — same as `unbien connect`)         |
| `unbien connect [options]` | Attach to a live pi session                          |
| `unbien pair <invite>`     | Pair with a machine (paste its `unbien://` URI)      |
| `unbien relay <sub>`       | Manage remembered relays (`add` / `remove` / `list`) |
| `unbien replay <file>`     | Render a captured envelope stream offline            |
| `unbien --version`         | Print the version                                    |

## `unbien connect`

```bash
unbien                              # connect (default) — pick a session interactively
unbien connect '<unbien://pair?t=…&epk=…>'   # first run: pair with a machine
unbien connect --list              # list sessions on that machine
unbien connect --session <id>      # attach by pi session id
unbien connect --session-name <n>  # attach by name (must be unambiguous)
unbien connect <peer-name>         # attach to a specific paired machine
```

### Options

| Flag                 | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `--relay <url>`      | Relay URL (default: `$UNBIEN_RELAY`, then the peer's own relay)              |
| `--session <id>`     | Attach to a specific session by id                                           |
| `--session-name <n>` | Attach by session name                                                       |
| `--name <device>`    | Device name shown in the machine's `/unbien devices` (default: `unbien-cli`) |
| `--theme <name>`     | Override your pi theme                                                       |
| `--list`             | List sessions and exit                                                       |
| `--list-themes`      | Show available themes and exit                                               |
| `--debug`            | Print envelope traces to stderr                                              |

### Multi-relay sessions

When you have machines paired on multiple relays, `unbien` fans out to every
relay, lists sessions from all machines, and shows one picker with relay
provenance tags. Unreachable relays are skipped with a note. Pick a session
and the CLI keeps that relay's connection, closing the rest.

## `unbien pair`

```bash
unbien pair '<unbien://pair?t=…&epk=…&rm=…>'
unbien pair --name my-laptop '<unbien://pair?…>'
```

Standalone pairing — no full connect round-trip needed. Re-pair after a
revoke, or pair a second machine. Run with no arguments to see remembered
machines.

| Flag                | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `--name, -n <name>` | Device name (default: `unbien-cli`)                           |
| `--relay, -r <url>` | Relay URL (default: `$UNBIEN_RELAY`, then the relay registry) |

Relay resolution order: `--relay` flag → `$UNBIEN_RELAY` env → single
remembered relay (auto-picked) → multiple remembered (listed for explicit pick).

## `unbien create-session` / `unbien resume-session`

```bash
unbien create-session <machine> [--dir <cwd>] [--name <name>] [--relay <url>]
unbien resume-session <machine> [--dir <cwd>] [--name <name>] [--all]
```

Spawns a fresh pi session (or resumes a stored one) on a machine's launcher
daemon — the same path the app's Launch control uses. `<machine>` is a paired
machine name or epk prefix.

**Remote (federated) machines work too**: the machine is also resolved from
the local relay's federated peer list — `unbien create-session droplet` from
`cascade` launches pi on droplet. Routing goes through your LOCAL relay; the
cross-relay hop is invisible.

## `unbien relay`

```bash
unbien relay pair [url] [--name <name>]       # print a pairing URL for THIS relay (alias of peer pair)
unbien relay peer pair [url] [--name <name>]  # same
unbien relay peer add relay-pair://<b64>       # add + pin pubkey from a pairing URL (the only form)
unbien relay peer remove <name>                # remove a peer
unbien relay peer federation on|off|status     # the federation gate (default off)
unbien relay peer list                         # peers + gate state + pending invitations
unbien relay list                              # local relay + remembered + peers (default)
unbien relay add <url> [name]                  # remember a relay
unbien relay remove <url|name>                 # forget a relay
```

- `relay list` shows the local relay's identity (name, URL, pubkey) — pipe a
  pairing URL from `unbien relay pair | pbcopy`.
- Federation is opt-in: `federation.enabled` in `~/.config/un-bien/relay.json`
  (the relay refuses `/relay-peer` while off). `peer add` auto-enables it.
- Pairing is the one-pair flow: mint on one relay, consume on the other —
  the issuer auto-adds the consumer back, so one action pairs both
  directions. The legacy plain form (`peer add <url> <name>`) is refused —
  pinned pairing is mandatory. See the un-bien docs
  (`docs/relay-peering.md`) for the full walkthrough.
- Peers live in `~/.local/state/un-bien/relay-peers.json` (per-machine state);
  the gate in the config root (settings). No restart needed — the relay
  watches the file and connects within seconds.

## Slash commands

Once connected, the prompt accepts slash commands:

| Command              | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| `/help`              | List commands                                                                 |
| `/connect`           | Switch to a different session (also `/sessions`)                              |
| `/tree`              | Browse turns — `f` forks a new session, `b` branches in place                 |
| `/fork <id>`         | Fork a new session from an earlier message                                    |
| `/branch <id>`       | Branch in place from an earlier message                                       |
| `/plan [verb]`       | Pin the plan panel (`toggle`/`expand`/`collapse`/`hide`/`filter`/`lines <n>`) |
| `/subagents [verb]`  | Pin the subagents panel (`toggle`/`expand`/`collapse`/`hide`)                 |
| `/model`             | Switch model                                                                  |
| `/thinking <level>`  | Set thinking level                                                            |
| `/compact`           | Compact the session context                                                   |
| `/abort`             | Abort the current turn                                                        |
| `/set <key> <value>` | Client settings (e.g. `/set streamThinking on`)                               |
| `/queue <text>`      | Queue a message to run after the current turn ends                            |
| `/quit`              | Detach; the remote session keeps running                                      |

Ctrl-C exits (the terminal is restored cleanly). Ctrl-D also exits.

### Busy-state routing

Typing while the agent is working **steers** into the running turn (mid-turn
injection). Typing while idle starts a fresh turn. You never pick the verb;
the CLI routes based on the same busy signal that drives the spinner. Use
`/queue <text>` when you want the message to wait until the turn ends.

## Offline rendering

```bash
unbien replay <capture.jsonl>
```

Renders a captured rpc-envelope stream — useful for looking at a transcript,
or for checking rendering without a live session.

## How it relates to the app

The un-bien wire carries **byte-faithful pi rpc frames**, so this is a second
renderer over the stream the app already reads, not a second protocol. History
(`get_entries`) replays through the _same_ reducer as live frames.

Requires a paired Pi running the [`@geohar/un-bien`](https://www.npmjs.com/package/@geohar/un-bien)
extension and a relay you host. Machine administration (launcher daemon,
devices, revocation) lives in that package's `unbien-admin` CLI.

## Files

| Path                                         | Purpose                                        |
| -------------------------------------------- | ---------------------------------------------- |
| `~/.config/unbien-cli/settings.json`         | Client settings (theme, thinking, panel modes) |
| `~/.local/state/un-bien/proxy-identity.json` | This device's Ed25519 keypair                  |
| `~/.local/state/un-bien/proxy-peers.json`    | Remembered paired machines                     |
| `~/.local/state/un-bien/proxy-relays.json`   | Remembered relays                              |

MIT © George Harker.
