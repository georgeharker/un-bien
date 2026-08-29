---
title: "un-bien"
---

<p align="center">
  <img src="app/icons/un-bien.svg" width="140" alt="un-bien logo" />
</p>

## What is un-bien?

**un-bien is remote control for your [Pi coding agent](https://github.com/earendil-works/pi)
sessions** — a native macOS and iOS app that **attaches to a running Pi session,
or launches a new one**, and lets you drive it from your phone.

Pair your device once by QR, over a relay you host yourself, and Pi's session
comes with you: streaming responses, **styled summaries of edits and tool
results**, tool-call cards you can approve or reject, and live model/thinking
controls — all rendered natively.

The same plumbing carries a second capability: a **local agent mesh**, where
multiple Pi sessions on your machines can discover and message each other.

### At a glance

- **Native macOS / iOS app** — attach to running Pi sessions or launch new ones.
- **Self-hosted relay** — a small WebSocket server you run to connect the app to
  your machine. No default relay, no third party in the path.
- **Styled transcripts** — Markdown + syntax highlighting, with readable
  summaries for edits and tool results rather than raw diffs and JSON.
- **Tool approval from your phone** — approve or reject tool calls remotely.
- **Model & thinking control** — switch models and thinking levels on the fly.
- **Image attach** — send a photo inline with your prompt to vision models.
- **Local agent mesh** — several Pi sessions coordinating over a local broker,
  optionally bridged across machines through the relay.
- **Daemon mode** — keep a Pi running in the background, answering prompts and
  cron jobs while you're away.

> **Status:** WIP and actively maturing — functional and usable today, with
> polish landing toward the first public release.

---

## Where to next

| I want to…                     | Document                                        |
| ------------------------------ | ----------------------------------------------- |
| Get the big picture            | [Overview (README)](README.md)                  |
| Install & set everything up    | [Install & setup](docs/install.md)              |
| Use the extension & commands   | [Extension guide](extension/README.md)          |
| Understand how it works        | [Design & protocol](docs/design.md)             |
| Deploy / sign the app          | [Deployment & signing](DEPLOY.md)               |
| Try the features by hand       | [Feature test drive](TESTING.md)                |

---

un-bien is derived from [remote-pi](https://github.com/jacobaraujo7/remote_pi)
by Jacob Moura (MIT); see the [README](README.md#attribution) for attribution.
