# Follow-ups — to capture in crib

Backlog from the `feat/rpc-envelope` session (commit `5090c5f`). Cribsheet was
unreachable at the time, so these are staged here for transcription into the
design/plan graph, then this file can be deleted.

## Decisions (design_add)

- **Envelope is the only session wire; stock protocol retired.**
  `ClientMessage`/`ServerMessage` session protocol (`session_sync` →
  `session_history`) is gone. Reconstruction is envelope-native: the app sends
  `{rpc:{type:"session_sync", id, limit?}}`; the extension replays the last-N history
  as `{rpc}` live frames folded by the SAME `applyRPC` as the live stream.
  Rejected: keeping a parallel stock path (dual maintenance, drift).

- **`session_sync` metadata rides a trailing `session_sync_end` terminator.**
  The stock `session_history` bundled `session_started_at` / `truncated` / `eos`;
  the envelope replay is N separate frames with nowhere to hang that. So the extension
  emits `{rpc:{type:"session_sync_end", in_reply_to, session_started_at,
  truncated}}` AFTER the replay frames. Its arrival IS the `eos` (no flag).
  Server-side limit clamp is an invariant: `min(client limit ?? server default,
  server default)` — a client can never pull more than `UNBIEN_SYNC_LIMIT`.
  Always sent, even for empty history, so the app learns the session clock.
  Depends on the "envelope is the only wire" decision above.

## Tasks (plan_add)

- **Fixtures: decide regen vs in-place scrub.** The extension contract-fixture
  tests were repointed from the stale `.orchestration/contracts/fixtures` path to
  the in-repo `app/Tests/UnBienCoreTests/Fixtures` (the ported copies). Those are
  only partially fixed-up — `pair_ok.jsonl`, `rooms.jsonl`, `room_announced.jsonl`
  still carry stale `remote_pi` string values (display data, not protocol fields,
  so tests pass). Canonical source is likely remote_pi's `.orchestration`. Decide:
  regen from canonical, or scrub the ported copies in place. **Do NOT copy the old
  remote_pi fixtures back** if the ported ones are the fixed-up version.

- **Model picker: show provider on the collapsed label.** The picker menu rows
  already render `name — provider` (`TranscriptView.swift:141`), but the collapsed
  current-model label (`TranscriptView.swift:178`) shows bare `.name`. Add provider.

## Notes (note_store)

- **extension_ui elicitation facade works over the envelope.** Ask-user flows
  (select / confirm / input dialogs) forward Pi → app and answer back correctly;
  confirmed working this session.
