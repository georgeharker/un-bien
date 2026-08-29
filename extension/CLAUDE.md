# Un Bien — Pi Extension (Node + TypeScript)

Extension for the [Pi coding agent](https://github.com/earendil-works/pi) that
adds the `/unbien` slash command. It embeds the Pi SDK
(`@earendil-works/pi-coding-agent`) and connects to the relay over WebSocket.
Part of the cross-PC coding-agent mesh: each PC runs this extension with an
Ed25519 identity, the phone pairs via QR, and envelopes route between peers.

**Canonical docs (source of truth — prefer them over this summary):**

- Protocol, identities, ACK, cross-PC routing, trust model:
  [`../docs/rpc-envelope.md`](../docs/rpc-envelope.md)
- Machine identity (keychain/file backends, resolution order,
  `/unbien identity`, extracting/moving the seed):
  [`../docs/identity.md`](../docs/identity.md)

## Stack

- Node ≥ 20, TypeScript, **ESM only** (NodeNext) — imports carry the `.js`
  extension even in `.ts`.
- Package manager: **pnpm** (there's a `pnpm-lock.yaml`).
- SDK: `@earendil-works/pi-coding-agent` (+ `@earendil-works/pi-tui`).

## Commands

- `pnpm install`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — `tsc -p tsconfig.build.json` → `dist/`
- `pnpm dev` — `tsx src/index.ts`
- `pnpm test` — `vitest run`

> The fork loads the **built** `dist/`, not `src/` — run `pnpm build` and
> restart the fork after editing the extension.

## Relay configuration

Resolution order (via `config.ts`) — **there is no built-in default**:

1. `UNBIEN_RELAY` (env) — CI/ops escape hatch.
2. the `relay` field in `un-bien.json`
   (`<PI_CODING_AGENT_DIR>/extensions/un-bien.json`), written by
   `/unbien set-relay <url>`.
3. nothing configured ⇒ `source: "unset"` — the extension **refuses to
   connect** and prompts you to configure a relay.

`/unbien set-relay` only accepts `http(s)://` (rejects `ws(s)://`/empty/
malformed; the conversion to `ws(s)://` happens internally when opening the
WebSocket). `/unbien config` shows the effective URL and its source.

## Conventions

- **Strict TS**: no `any` — use `unknown` + narrow.
- Imports require the `.js` extension (ESM). Top-level await is fine.
- Errors: `class XxxError extends Error`, thrown early at the boundary.

## Don't

- Don't write CommonJS (`require`, `module.exports`).
- Don't commit `dist/` (already in the root `.gitignore`).
- Don't add a dependency that isn't ESM-friendly.

## Orchestrated mode

If you receive a prompt starting with `[ORCH:<task-id>]`, read
`../.orchestration/INSTRUCTIONS.md` before doing anything else — another agent
is coordinating and has specific rules (where to write results, not committing,
etc).
