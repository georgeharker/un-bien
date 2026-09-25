# Conformance Corpus — Fixture Format & Normalized Vocabulary (spec v1)

Design: `01M25GXCQ3W7NKB2DJ4RM9T8EHW` (conformance harness — cross-implementation:
un-bien Swift `SessionState` reducer + remote_pi TS fork interpretation, both
asserting against the SAME expected artifact).

## Scenario unit

`contracts/conformance/scenarios/<NNN-name>/`:

| File | Contents |
|---|---|
| `input.jsonl` | The exact wire frames, one JSON per line, **as delivered app-side**: bare rpc frames (wrapped by the runner as `{rpc:}`), `get_entries` pages, or `{evt}` envelopes — whatever the mode prescribes. Recorded from live sessions via the envelope debug log (`debug.envelope`), or authored. |
| `expected.json` | The normalized interpreted state — the vocabulary below — the single artifact BOTH implementations assert against. |
| `meta.json` | Provenance: `origin` (`real-capture` \| `synthetic`), source run / author, capture date, scrub notes, modes. |

## Modes

Each scenario declares `modes` in meta: one or both of

- `live` — frames delivered as pushes, in order, to a fresh `SessionState`/reducer.
- `replay` — the same logical content delivered as `get_entries` pages
  (`applyEntries` + leaf beacons).

Both runners run every declared mode; the interpreted state must be **identical
across modes and across implementations**.

## Normalized vocabulary (`expected.json`)

```json
{
  "version": 1,
  "items": [
    { "kind": "notice", "row": "<row-id>", "code": "...", "text": "<scrubbed>" },
    { "kind": "user", "row": "<row-id>", "text": "<scrubbed>", "images": 0 },
    { "kind": "assistant", "row": "<row-id>", "text": "<scrubbed>",
      "streaming": false, "images": 0 },
    { "kind": "reasoning", "row": "<row-id>", "text": "<scrubbed>", "streaming": true },
    { "kind": "tool", "row": "<row-id>", "tool": "<scrubbed>", "state": "running|ok|failed",
      "blocks": ["diff"|"code"|...], "images": 0 },
    { "kind": "compaction", "row": "<row-id>" }
  ],
  "flags": { "streaming": false, "ended": false }
}
```

- `items` is in render order. `n` is implicit (array index + 1).
- A block not on the derived path is **absent** (abandoned branch — retained
  data, no row): the projection's membership gate is part of the contract.
- `streaming` in `flags` = an in-flight turn exists (`activeTurnID != nil`).

## Row ids & scrubbing

- A row's `row` value is its **entry id when replay-stable** (`replayStable ==
  true` — pi entry ids are stable hex and identical across live/replay), else a
  **deterministic placeholder** `"<kind>#<seq>"` numbered by order of appearance
  (live synthetic ids are UUIDs — nondeterministic across runs, so the
  projection replaces them; seq numbers make failures debuggable).
- **Text scrub, in place, readable**: newlines → `\n` literals, truncate at
  48 chars with `…`. No hashing (george 2026-09-25: "scrubbed but readable is
  the right approach given it'll live in repo"). ANSI stripped.
- Tool `args`/`result` raw payloads are NOT emitted — only the card's rendered
  **block kinds** (`output[].kind`, `hunks` → `hunks`, images count). Content
  fidelity comes from the input frames; the expected file asserts the *shape*.
- Timestamps, token counts, session-start times: omitted (unstable).

## Golden regeneration

`expected.json` files are committed. A runner may regenerate goldens when
`UNBIEN_CONFORMANCE_REGENERATE=1` is set (writes the current projection into
`expected.json`); CI always asserts. A golden change in a PR is a reviewable
behaviour change.

## Adding a scenario

Create the directory; both runners pick it up by convention. Zero runner
changes. If a scenario needs new vocabulary, extend this spec first, both
runners in the same commit.