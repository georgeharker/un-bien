# un-bien — feature test drive

Manual test checklist. Column meaning: **Trigger** = what you do (in the app, or
from a Pi agent on a paired machine); **Expect** = what the app should show.

Legend: ☐ untested · ✅ pass · ❌ fail (note what happened) · ⬚ not built yet (skip).

---

## 1. Onboarding & Owner-key

- ☐ **First launch** → onboarding appears. Expect: "create owner key" flow, no sessions.
- ☐ **Create owner key** → lands on Sessions/Home. Expect: relay list (empty state).
- ☐ **Relaunch app** → onboarding does NOT reappear (owner key reloaded). Expect: straight to Home.
- ☐ **iCloud sync toggle** on/off → persists across relaunch.

## 2. Relay management

- ☐ **Add relay** (name + ws/wss URL). Expect: new section in list, header dot = connecting → online.
- ☐ **Bad URL / unreachable** → header dot = red "error"; app stays usable.
- ☐ **Remove relay** → section gone; its sessions & paired machines removed.
- ☐ **Two relays at once** → both connect independently; health is per-relay.

## 3. Pairing (paste-code fallback; QR camera = ⬚ not built)

- ☐ On the machine run Pi w/ remote-pi → it issues a pair token/code.
- ☐ **Pair a machine** → paste code → `pair_request`. Expect: `pair_ok`, machine persists.
- ☐ **Wrong/expired code** → `pair_error` shown gracefully.
- ☐ After pair, **re-subscribe** happens: that machine's sessions start appearing.

## 4. Session discovery & merged list

- ☐ Start a Pi session on a paired machine → **session row appears** under its relay.
- ☐ Row shows **name, cwd, model**.
- ☐ **Multiple sessions / machines** → grouped under the right relay, all visible.
- ☐ End the Pi session → row disappears (room ended).

## 5. Transcript render (open a session)

- ☐ **History replay**: prior conversation renders on open (user + assistant + tool cards).
- ☐ **Streaming text**: assistant reply streams in; Markdown formatting renders.
- ☐ **Code blocks**: fenced code is syntax-highlighted (highlight on close, no flicker).
- ☐ **Thinking/reasoning**: collapsible "Thinking…/Thought" block; expands to show reasoning.
- ☐ **Tool card**: request opens a card (name + input); result fills it; error → red state.
- ☐ **Mid-turn interleave**: text → tool card → more text stack in order.
- ☐ **Compaction**: trigger a compact → "Context compacted (N tokens)" marker.
- ☐ **Cross-device echo**: send from another device → your `user_message` bubble appears here too.
- ☐ **Agent graphics**: have the agent emit an image (plot/diagram) → it renders **inline in the
  assistant bubble**, in conversation order (not a separate row). Re-open the session → the image
  survives history replay.
- ☐ **Scroll stability**: in a long transcript with mid-turn tool cards (text → tool → text),
  scroll up/down fast → no rows vanish/flicker (was: duplicate row ids dropped bubbles).

## 6. Interactivity (Phase 5)

- ☐ **Send**: type + Return/Enter (or send button) → message goes; echoes as your bubble.
- ☐ **Queue message**: tray button while a turn runs → chip appears in the queued row.
  - ☐ Tap a chip → clears that queued item (`queued_message_clear`).
  - ☐ `queued_message_state` from agent → chips reflect server state.
- ☐ **Cancel**: while a turn is streaming, a **stop button** appears left of the input.
  - ☐ Tap it → turn stops; `cancelled` settles the open bubble; stop button disappears.
- ☐ **Model control**: toolbar slider menu → **Model** picker lists models (`models_list`).
  - ☐ Pick a model → `model_set`; current model reflects the choice.
- ☐ **Thinking control**: same menu → **Thinking** picker (off…xhigh) → `thinking_set`.

## 7. Asks / extension_ui prompts

Trigger each from an agent (pi-ask-user / ctx.ui). Expect a sheet; reply routes back.

- ☐ **select (single)** → radio list; pick one → response carries the value.
- ☐ **select (multi)** → checkboxes; pick several → response carries the set.
- ☐ **confirm** → Yes / No.
- ☐ **input** → freeform text field → returns text.
- ☐ **editor** → multiline editor → returns edited text.
- ☐ **notify** → informational, OK dismisses.
- ☐ **Cancel** any prompt → `cancelled: true`, sheet closes, agent sees cancel.
- ☐ **Rich ask flow** (pi-ask): single / multi / preview variants, freeform, notes all render.

## 8. Side panels (plan / subagents / generic)

Now end-to-end: the fork bridges `plan:*` + `subagents:*` in-process buses → `panel_update`
over the relay (remote_pi `panel_bridge.ts`). Needs a plan source (e.g. cribsheet) and/or
subagents running on the paired machine.

- ☐ **Plan panel**: run a task that emits a plan (cribsheet plan bus) → panel item in top
  bar; opens to the wave/dep renderer grouped into **Available now / Wave N / Cycle / Done**.
- ☐ **Subagents panel**: spawn subagents → a `subagents` panel appears. NOTE: currently
  renders as generic JSON (bespoke activity cards still pending), so verify the items/status
  are present, not their styling.
- ☐ **Late join replay**: open the session AFTER a plan/subagents already exist → panels
  populate immediately (session_sync replays current panels), not only on the next change.
- ☐ **Coalescing**: a burst of plan updates → panel updates smoothly (bridge coalesces ~60ms),
  no flicker/storm.
- ☐ **Change badge**: when a panel updates while closed → red dot badge on its top-bar item.
- ☐ **Open clears badge**: open the panel → badge clears; live updates while open stay read.
- ☐ **Generic panel_update**: any other panel source renders via the generic panel host.

## 9. Multi-relay resilience (Phase 6)

- ☐ Sessions from **different relays** coexist in one list, grouped per relay.
- ☐ Kill one relay's connection → only that relay goes offline; others keep working.
- ☐ **Reconnect/backoff**: drop a relay (stop it) → header goes offline; bring it back →
  auto-reconnects (retries at 1s,2s,4s…30s cap), header returns to online, sessions repopulate.
- ☐ **No storm**: while a relay stays down, retries space out (backoff), not a tight loop.
- ☐ **Remove during retry**: remove a relay mid-backoff → no reconnect fires afterward.

## Known not-yet-built (skip / expect absent)

- ⬚ QR **camera** scanning (paste-code only for now)
- ⬚ Settings screen / live theme picker
- ⬚ Image attach & inline image render in scrollback
- ⬚ Session status line (token/context usage, compaction status)
