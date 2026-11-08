# @geohar/unbien-durable

A [pi-durable](https://github.com/earendil-works/pi) agent host on the
[un-bien](https://github.com/georgeharker/un-bien) mesh and relay. The
Un Bien app talks to a durable conversation exactly as it talks to a pi
session: the same transcript, live streaming, tool cards, model and thinking
controls, and pairing.

Durable conversations have stable ids and survive restarts, so the app
reconnects to the same room and its history after the host restarts.

```bash
npm install -g @geohar/unbien-durable
```

## Running the host

```bash
unbien-durable [--cwd <dir>] [--name <agent-name>] [--relay <url>]
               [--db <path>] [--model <provider/model>]
               [--thinking <level>] [--no-pairing-qr]
```

| Option | Meaning |
| --- | --- |
| `--cwd` | Working directory of the conversation (default: the current directory) |
| `--name` | Name shown in the app and on the mesh (default: `durable`) |
| `--relay` | Relay URL (default: the configured un-bien relay) |
| `--db` | JSONL storage directory (default: `~/.local/state/un-bien/durable/session`) |
| `--model` | `provider/modelId` for a new conversation |
| `--thinking` | Thinking level a conversation still at `off` starts at (default: `medium`, clamped to the model); `off` keeps pi-durable's default |
| `--no-pairing-qr` | Don't mint the rotating pairing QR; pair with `unbien pair-token` instead |

Provider API keys come from the environment, as for pi (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OLLAMA_API_KEY`, …). `UNBIEN_NO_PAIRING_QR` and
`UNBIEN_DURABLE_THINKING` match the flags.

## As a library

The package also exports the binding itself, for hosts that compose their own
harness (models, tools, extensions):

- `DurableBridge`: serves one conversation over the relay. Pass the harness's
  `models` to enable the app's model, thinking, rename and queue controls.
- `DurableSessionPort` / `DurableSessionControl` / `DurableAgentConfig`: the
  un-bien core ports over a durable `Conversation`.
- `ConversationViewSource` / `ViewTranslator`: the conversation view as pi's
  event plane.
- `createUnBienDurableExtension`: the mesh tools and `launch_pi_task`.

## Requirements

Node 22.19 or later. Built on `@earendil-works/pi-durable` 1.5.
