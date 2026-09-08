<p align="center">
  <img src="https://raw.githubusercontent.com/georgeharker/un-bien/main/app/icons/un-bien-macos-1024.png" alt="Un Bien" width="96" />
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

## Use

Pair once per machine — run `/unbien pair` in a Pi session and copy the invite:

```bash
unbien connect 'unbien://pair?t=…&epk=…'
```

Pairing is machine-level, so later runs need no token:

```bash
unbien connect --list                    # sessions on that machine
unbien connect                           # pick one interactively
unbien connect --session <id>
unbien connect --session-name un-bien
```

`--relay` defaults to `$UNBIEN_RELAY`; a remembered machine uses the relay it
was paired on. `--theme <name>` overrides your pi theme, and `--list-themes`
shows what's available.

Type to prompt. Slash commands:

|                                                                |                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `/help`                                                        | list commands                                                        |
| `/tree`                                                        | browse turns — `f` forks a new session, `b` branches in place        |
| `/fork`, `/branch`                                             | same, by entry id                                                    |
| `/plan`, `/subagents`                                          | pin a panel above the composer (`toggle`/`expand`/`collapse`/`hide`) |
| `/plan filter done`, `/plan filter context`, `/plan lines <n>` | what the plan shows                                                  |
| `/model`, `/thinking`, `/compact`, `/abort`                    | pi's own session verbs                                               |
| `/set`                                                         | client settings (thinking stream, panel modes)                       |
| `/quit`                                                        | detach; the remote session keeps running                             |

Ctrl-C exits. Settings live in `~/.config/unbien-cli/settings.json`.

## Offline rendering

`unbien replay <capture.jsonl>` renders a captured rpc-envelope stream — useful
for looking at a transcript, or for checking rendering without a live session.

## How it relates to the app

The un-bien wire carries **byte-faithful pi rpc frames**, so this is a second
renderer over the stream the app already reads, not a second protocol. History
(`get_entries`) replays through the _same_ reducer as live frames.

Requires a paired Pi running the [`@geohar/un-bien`](https://www.npmjs.com/package/@geohar/un-bien)
extension and a relay you host. Machine administration (launcher daemon,
devices, revocation) lives in that package's `unbien-admin` CLI.

MIT © George Harker.
