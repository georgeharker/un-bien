# un-bien — a native iOS/macOS client for Pi

> A modern, native iOS/macOS app that **attaches to running Pi coding agent
> sessions — or launches new ones** — over the un-bien relay protocol, renders
> their chats beautifully, and aggregates **multiple relays** in one place.
>
> Not paseo. Same "client → server-hosted sessions" shape, but pi-only, native
> Swift, and multi-relay.

Status: **built, actively maturing** (WIP; functional by first public release).
The app lives under `app/` (`Sources/UnBienCore`), the Pi extension under
`extension/`, and the relay under `relay/`. This doc is the consolidated decision
record + architecture. The wire protocol and crypto were originally extracted
from the **remote-pi** reference implementation (MIT, Jacob Moura,
<https://github.com/jacobaraujo7/remote_pi>) and have since evolved as un-bien's
own.

---

## 1. Goals / non-goals

**Goals**
+ Attach to a running Pi session (or launch a new one) through a **relay** and
  render its transcript in real time — streaming text, tool-call cards,
  interactive prompts.
+ **Multiple relays** at once, sessions aggregated into one list.
+ First-class UX: proper Markdown + syntax-highlighted code, nice theming
  (match the terminal's tokyo-night).
+ Native iOS. No cross-platform toolkit.

**Non-goals**
+ No multi-provider abstraction (paseo's Claude Code / Codex / OpenCode layer).
  This is pi-only. There is nothing to abstract.
+ No embedded Python. The wire, crypto, keychain, and websocket work are all
  native-Swift strengths; there is no Python to reuse.
+ Not a session *host*. The Pi process + relay host the session; we are a client.

---

## 2. Scope decisions (the settled ground)

| Decision | Rationale |
| --- | --- |
| **Native iOS (SwiftUI), no toolkit** | The security model is iOS-native by design — Owner-key in iOS Keychain, iCloud-synced; Ed25519 first-class in CryptoKit. A toolkit *adds* a bridge here; native removes one. |
| **pi-only (drop multi-provider)** | Protocol is already pi-centric (`model_set`/`list_models` = pi's `ModelRegistry`). No abstraction to build. |
| **Multiple relays** | The differentiator over both paseo (multi-provider, own daemon) and the upstream remote-pi app (single-relay, basic UI). Pure client composition — no protocol change. |
| **Markdown: `gonzalezreal/swift-markdown-ui`** | CommonMark + GFM, SwiftUI-native, themeable, pluggable `CodeSyntaxHighlighter`. Apple's `AttributedString(markdown:)` is inline-only — insufficient. |
| **Highlighting: `Highlightr`** | highlight.js under the hood → 180+ languages + themes. Agents emit arbitrary languages, so Splash (Swift-focused) is wrong; tree-sitter is a v2 quality pass. |
| **Reference impl is MIT** | Reuse/reference freely; lift its test vectors to verify the Swift codec + handshake byte-for-byte. |

---

## 3. Architecture layers

```
SwiftUI views ── transcript · tool cards · interactive prompts · session list · pairing
      │
Render pipeline ── agent_chunk coalescing buffer → swift-markdown-ui + Highlightr (tokyo-night)
      │
Session model ── per-session transcript state, reduced from the event stream
      │
Relay actors ── one per relay: WSS + Ed25519 challenge-response + mesh membership
      │
Wire codec ── Codable tagged unions (ClientMessage / ServerMessage / history)
      │
Crypto ── CryptoKit Curve25519.Signing · SHA-256 · Keychain / iCloud Keychain
```

Multi-relay = N **Relay actors** feeding one aggregated store; sessions keyed
`(relayID, sessionID)`.

---

## 4. Wire protocol → Swift `Codable`

Source of truth: `extension/src/protocol/types.ts` (+ `codec.ts`). Every
message is a tagged union discriminated by `type`; each side maps to a Swift
`enum` with associated values and a custom `Codable` switching on `type`.

### Envelope (routing layer)

`{ from, to, id (UUIDv7), re, body }` — JSONL, 5 fields. Addresses are **opaque
routing keys**: local `<cwd>@<agent>`, public `[<alias>:]<cwd>@<agent>`. Echo
verbatim; never parse/normalize. ACK statuses: `received | busy | denied | timeout`.

### App → Pi (ClientMessage) — control surface

| type | fields |
| --- | --- |
| `pair_request` | `token, device_name` |
| `user_message` | `text, images?` (`WireImage = {data: base64, mime}`) |
| `approve_tool` | `tool_call_id, decision: "allow"｜"deny"` — **app is the permission surface** |
| `cancel` | `target_id` |
| `session_sync` | `limit?` → replays history |
| `session_new` / `session_compact` | — |
| `model_set` | `provider, model_id` |
| `thinking_set` | `level` (`off｜minimal｜low｜medium｜high｜xhigh`) |
| `list_models` | — |
| `queued_message_set` / `queued_message_clear` | `text` / `target_id?` |
| `ping` | — |
| `extension_ui_response` | reply to an interactive prompt |

### Pi → App (ServerMessage) — render + status surface

| type | fields | renders as |
| --- | --- | --- |
| `agent_chunk` | `in_reply_to, delta` | streaming assistant text |
| `agent_done` | `in_reply_to, usage?` | turn end + tokens |
| `agent_message` | `in_reply_to, text, usage?` | full assistant bubble |
| `tool_request` | `tool_call_id, tool, args` | tool-call card (name + input) |
| `tool_result` | `tool_call_id, result?, error?` | tool card result/error |
| `extension_ui_request` | `select｜confirm｜input｜editor｜notify` | interactive prompt |
| `user_message` | `text, images?` | echoed user bubble (broadcast to all devices) |
| `compaction` | `summary, tokens_before, ts?` | context-compact marker |
| `queued_message_state` | `items[]` | pending follow-ups |
| `pair_ok` / `pair_error` | `... session_started_at` / `code, message` | pairing result |
| `steer_consumed` / `cancelled` / `error` / `pong` / `bye` | — | status/lifecycle |

### History replay

`session_sync {limit?}` → `session_history` of entries
`{ ts, type: user_input | tool_request | tool_result | agent_message | compaction, … }`.
Rebuild the whole transcript on attach; then apply the live stream.

**Reducer:** `tool_request` opens a card keyed by `tool_call_id`; the later
`tool_result` with the same id fills it. `agent_chunk` deltas append to the
in-flight assistant message until `agent_done`.

---

## 5. Auth & pairing → CryptoKit

Sources: `extension/src/pairing/{qr,crypto,storage}.ts`,
`relay/src/auth/challenge.rs`, `extension/src/mesh/{verify,canonical}.ts`.
All Ed25519 (RFC 8032): `@noble/ed25519` (ext) / `ed25519-dalek` (relay) →
**CryptoKit `Curve25519.Signing`** is wire-identical. SHA-256 → CryptoKit.

### Three keys

| Key | Lives | Role |
| --- | --- | --- |
| **Owner-key** | phone — iOS Keychain, iCloud-synced | authority; signs `mesh_versions`; proves right to pair/revoke PCs |
| **Pi-key** | per-PC — system keychain | authenticates the PC's relay WS; canonical routing identity |
| **App-key** | ephemeral, per pairing session | authenticated channel during pair |

### QR pairing (`pairing/qr.ts`)
+ Pi issues a **16-byte random, base64url** token; TTL **60s**, rotating,
  **single-use** (atomic consume). Pair TTL clamp 10s–600s.
+ Phone scans (VisionKit) → `pair_request { token, device_name }` → `pair_ok`.

### Relay connection auth (`relay/src/auth/challenge.rs`)

Ed25519 challenge-response: relay → `Challenge { nonce }` (32 random bytes,
base64) → client signs the nonce → relay `verify_auth(nonce, verifying_key, line)`.
Small, self-contained. The phone authenticates with its Owner-key identity.

### Mesh authority (`mesh/verify.ts`)

`MeshEnvelope { blob, sig }`; `owner_pk` is **inside** the blob. Verify the
Ed25519 sig, **then** assert `sha256(owner_pk)` matches the expected hash slot
(anti-substitution — a valid-but-different-owner blob must not slot in).

---

## 6. Transport & multi-relay

+ One **`RelayConnection` actor per relay**: owns a `URLSessionWebSocketTask`,
  runs the challenge-response on connect, decodes frames → `ServerMessage`,
  encodes `ClientMessage`. Handles reconnect/backoff + heartbeat (`ping`/`pong`).
+ A **`Mesh` store** aggregates all relay actors. Sessions namespaced
  `(relayID, sessionID)`; the UI shows one merged, grouped list.
+ The **same iCloud-synced Owner-key** is the authority across every relay/mesh —
  multi-relay multiplies connection + credential bookkeeping, not crypto.
+ Per-relay: connection health, pairing state, credential entry.

---

## 7. Render pipeline (UX)

`agent_chunk` deltas → **coalescing buffer** → Markdown view.

+ **Markdown:** swift-markdown-ui, `Theme` driven from the **active app theme** (§11).
+ **Code blocks:** Highlightr as the `CodeSyntaxHighlighter`, using the active
  theme's matched highlight.js style.
+ **Theming:** two layers — swift-markdown-ui `Theme` for content + an app-level
  design-token `Environment` for chrome — both fed by the selected theme (§11).

**Streaming gotcha (the one real engineering nuance):**
+ **Debounce/coalesce** deltas (~50–100 ms) before re-parsing — never per token.
+ **Defer code-block highlighting until the closing fence arrives** — render an
  open ``` block as plain monospace; highlight on close (avoids flicker + wasted
  work).
+ Optionally re-parse only the **last block** as it grows; keep settled blocks static.

Everything else (tool cards, interactive prompts, session list) is plain SwiftUI
over the `Codable` events — no Markdown involved.

---

## 8. Open questions / risks

1. **Canonical byte encodings (top risk).** The exact bytes the signatures cover
   and the `mesh_versions` blob schema are where a Swift port can *silently*
   diverge. Mitigation: read `mesh/canonical.ts` + the relay auth line format,
   and lift the reference **test vectors** (MIT) into Swift unit tests for
   byte-for-byte conformance before trusting the handshake.
2. **Protocol stability.** The protocol descends from a single upstream
   maintainer's evolving project and now evolves under un-bien. Pin a protocol
   revision; version the codec.
3. **Trust boundary.** The relay sees routed **plaintext** (not E2E). Fine on a
   private Tailnet; matters the moment "multiple relays" spans networks you don't
   control. Surface which relays are trusted in the UI.

---

## 9. Build phases

1. **Wire codec** — port ClientMessage/ServerMessage/history to `Codable`;
   validate against reference vectors. (Blocks everything.)
2. **Crypto + pairing** — CryptoKit Ed25519, Keychain/iCloud custody, QR scan,
   challenge-response, mesh_versions verify. Conformance-test against §8.1.
3. **Single-relay attach + transcript** — one `RelayConnection`, reducer,
   session_sync replay + live stream, plain rendering.
4. **Render pipeline** — swift-markdown-ui + Highlightr + tokyo-night + streaming
   throttle.
5. **Interactivity** — `approve_tool`, `extension_ui_request` prompts, model/
   thinking control, queued messages, cancel.
6. **Multi-relay** — `Mesh` aggregation, per-relay health/credentials, merged list.
7. **Polish** — theming system, iPad/large-screen layout, backgrounding/reconnect.

---

## 11. Theming — curated multi-theme selection

Not a single hardcoded palette. A **Theme** = an app palette (background /
surface / text / accent + semantic tool / error / success) **plus** a matched
code-highlight style, applied through swift-markdown-ui `Theme` (content), an
app-level design-token `Environment` (chrome), and a Highlightr/highlight.js
style (code blocks).

Curated set (developer-recognizable; dark + light):
+ **Tokyo Night** (default — matches the terminal setup)
+ Catppuccin (Mocha / Latte)
+ Dracula
+ Nord
+ Gruvbox Dark
+ Solarized (Dark / Light)
+ One Dark
+ GitHub (Dark / Light)
+ **Follow system** (auto light/dark)

Each theme ships (a) SwiftUI palette tokens and (b) a mapped highlight.js style;
a `ThemePicker` in Settings switches live. Adding a theme = one palette + one
code-style mapping, **no view changes**.

---

## 12. Feature-parity floor + UX bar

un-bien must do **at least** what the reference app (`remote_pi` Flutter,
`app/lib/ui/*`) ships — then exceed it on polish (paseo-grade).

| Reference surface | un-bien |
| --- | --- |
| Onboarding (choose relay) | ✔ + multi-relay setup |
| QR pairing **+ “paste code” fallback** (60s single-use) | ✔ |
| Owner-key **sync-required** gate (iCloud Keychain) | ✔ |
| Sessions / peer list (mesh — all machines, one view) | ✔ aggregated across **multiple relays** |
| Live chat streaming | ✔ + proper Markdown + syntax highlight + themes |
| Interactive prompts (`extension_ui_request`: select/confirm/input) | ✔ (dedicated approve/reject `approve_tool` cards were dropped) |
| Image **render** of session-produced images | ✔ (inbound `user_message.images` ingest exists on the wire; no app attach UI yet) |
| Settings | ✔ + theme picker |
| Update prompt | native App Store (skip in-app) |
| Voice / two-way audio (`data/voice`) | **deferred** (post-parity; not in the store pitch) |

**UX bar (the paseo-grade delta):** themed animated transcript; tool cards with
collapsible input/output; sticky streaming indicator; per-relay session
grouping; keyboard-first prompt bar with queued-message chips; graceful
reconnect. The reference app is functional-plain — un-bien's differentiator is
**render quality + theming + multi-relay**.

---

## 10. Wire conformance (byte-level)

The three places a Swift port silently diverges. Verified against the reference
impl; **lift its test vectors** (`*.test.ts`, `auth_test.rs`) into Swift XCTest
before trusting any of this.

### 10.1 Base64 discipline — the self-revocation trap

`mesh/encoding.ts` documents a real bug: Dart emitted **standard** base64
(`+ / =`-padded) while the pairing layer emitted **URL-safe** (`- _`, no pad) —
same 32 bytes, different strings → **silent self-revocations**. Rules:
+ Ed25519 pubkeys / signatures / nonces at the **relay + mesh** boundary are
  **RFC 4648 STANDARD base64, padded**. Not URL-safe.
+ **Never compare keys as base64 strings.** Decode to the 32 raw bytes and
  compare bytes. `sha256(owner_pk)` is over the raw 32 bytes, never the string.
+ CryptoKit maps cleanly: `Curve25519.Signing.PublicKey.rawRepresentation` (32 B),
  `.base64EncodedString()` (standard), `privateKey.signature(for:)` (64 B).

### 10.2 Relay auth handshake (JSONL over WS, all standard base64)

> **Verified against the reference *app* (`app/lib/data/transport/`), not just
> the extension.** The APP's wire model has three layers, and differs from
> the extension's `pi_envelope`/`to_pc` shape below (that shape is how a PC
> connects, not the phone):
>
> 1. **Auth control** — `hello`/`challenge`/`auth`, raw JSON frames. The app's
>    hello is `{type:"hello", pubkey:<Owner-key std b64>, room_id:"main"}`;
>    it signs the DECODED nonce bytes with the **Owner-key**.
> 2. **Relay control** — raw JSON frames `subscribe_presence`/`subscribe_rooms`
>    /`presence_check`/`rooms_check` (out) and `presence`/`rooms`/`peer_online`
>    /`peer_offline`/`room_announced`/`room_ended`/`room_meta_updated` (in),
>    keyed by paired-peer EPK.
> 3. **Routed application** — outer envelope `{peer, room, ct}` where
>    `ct = base64(utf8(ClientMessage|ServerMessage JSON))`, NOT encrypted.
>    Inbound routed frames are demuxed by `room == activeRoom`.
> `pair_request` is a routed frame: set active room to the QR's `rm` (else
> `main`), then send the `pair_request` ClientMessage in a `{peer:<QR epk>,
> room, ct}` envelope. This is what `Sources/UnBienCore` implements + tests.

Source: `relay/src/auth/challenge.rs`, `transport/relay_client.ts`.

```
→ { "type": "hello",      "pubkey": "<32B Ed25519, std b64>", "room_id": "<per-session>", "model_name"? }
← { "type": "challenge",  "nonce":  "<32 random bytes, std b64>" }
→ { "type": "auth",       "sig":    "<64B Ed25519 sig, std b64>" }
```
+ **Sign the DECODED 32 nonce bytes**, NOT the base64 string: relay does
  `vk.verify(nonce_bytes, sig)` where `nonce_bytes: [u8;32]`. In Swift:
  `key.signature(for: Data(base64Encoded: nonceB64)!)`.
+ `HELLO_TIMEOUT_MS = 5000`. Relay pings ~25 s (liveness; missing pings = dead link).
+ `room_id` multiplexes N sessions under one pubkey (one pi-ext per cwd). Relay
  rejects a duplicate `(pubkey, room_id)` → treat as `RoomAlreadyOpen`.

### 10.3 Mesh canonical JSON — only when SIGNING mesh_versions

Source: `mesh/canonical.ts`. **Bit-compatibility contract across Dart/Rust/TS:**
+ object keys sorted by **UTF-16 code-unit order**; **no whitespace** between
  tokens; RFC-8259 string escapes; arrays keep insertion order; integers only
  (`version`, `issued_at`). Signed bytes = UTF-8 of that canonical string.
+ **Verification never re-serializes**: the receiver verifies the **raw blob
  bytes as-received** against `sig` with `owner_pk`, then asserts
  `sha256(owner_pk)` fills the expected slot. So un-bien needs the canonicalizer
  **only when the phone mints a mesh_version** (pairing/authorizing a PC);
  attaching + reading needs verify-only.
+ Swift risk: `JSONEncoder([.sortedKeys])` is **not guaranteed byte-identical**
  (sort order + escaping). Hand-roll a JCS-like encoder mirroring `canonicalize`,
  and gate it with the `canonical.test.ts` / `verify.test.ts` fixtures. **This is
  the single highest-conformance-risk item.**

### 10.4 Envelope, framing, pair token
+ **Framing:** one JSON object per WS **text frame** (JSONL semantics).
+ **Envelope:** `{ from, to, id (UUIDv7), re, body }`; addresses opaque — echo verbatim.
+ **QR pair token:** 16 random bytes, base64url — but treat as an **opaque
  string**; the phone puts it in `pair_request` and never decodes it. TTL 60 s,
  single-use.

### 10.5 Test-vector sources to port

`mesh/verify.test.ts` · `mesh/canonical.test.ts` · `mesh/encoding.test.ts` ·
`relay/src/auth/auth_test.rs` · `protocol/codec.test.ts` · `pairing/qr.test.ts`.

---

## Reference map

un-bien monorepo sources (the current source of truth):

+ Wire types/codec: `extension/src/protocol/{types,codec}.ts`
+ Pairing: `extension/src/pairing/{qr,crypto,storage}.ts`
+ Mesh authority: `extension/src/mesh/{verify,canonical,siblings}.ts`
+ Relay auth (Rust): `relay/src/auth/{challenge,mod}.rs`
+ Relay transport: `extension/src/transport/relay_client.ts`
+ Wire protocol doc: [`docs/rpc-envelope.md`](docs/rpc-envelope.md)

Upstream **remote-pi** (MIT, Jacob Moura) for comparison / test vectors:

+ Device identity (Flutter): `app/packages/remote_pi_identity/`
+ Canonical protocol doc (terse, PT-BR): `PROTOCOL.md`
