import { describe, expect, test } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { envelopeForEvent } from "./rpc_envelope.js"

/**
 * TS emit-direction conformance runner (design 01M25GXCQ3W7NKB2DJ4RM9T8EHW,
 * build step 3): for each scenario with an `actions.json`, drive the
 * extension's REAL outbound framing (`envelopeForEvent` — the same BUILDERS
 * map the live plane uses) and deep-equal the emitted rpc frames against the
 * scenario's committed `input.jsonl` (event-plane frames; the input's command
 * acks / extension_ui_request notifies ride other seams and are excluded from
 * byte comparison there).
 *
 * A divergence here = the extension would send the app frames the app's
 * reducer was never corpus-tested against — the exact class behind the
 * session_sync ask-replay miss (0.20.16).
 */

// <repo>/extension/src/session/ → <repo>/contracts/conformance/scenarios
const SCENARIOS = join(
  dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
  "contracts",
  "conformance",
  "scenarios",
)

interface Action {
  event: string
  payload: Record<string, unknown>
}

function scenarioNames(): string[] {
  if (!existsSync(SCENARIOS)) return []
  return readdirSync(SCENARIOS)
    .filter((name) => !name.startsWith("."))
    .sort()
}

describe("conformance harness — TS emit direction", () => {
  test("corpus is present", () => {
    const names = scenarioNames()
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(
        existsSync(join(SCENARIOS, name, "input.jsonl")),
        `${name}: input.jsonl missing`,
      ).toBe(true)
      expect(
        existsSync(join(SCENARIOS, name, "expected.json")),
        `${name}: expected.json must be committed`,
      ).toBe(true)
    }
  })

  for (const name of scenarioNames()) {
    const dir = join(SCENARIOS, name)
    const actionsPath = join(dir, "actions.jsonl")
    if (!existsSync(actionsPath)) continue // capture-only scenario: no emit script

    test(`${name}: extension emit path reproduces the committed input frames`, () => {
      const actions: Array<Action> = readFileSync(actionsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Action)
      expect(actions.length).toBeGreaterThan(0)

      // Drive the extension's real outbound framing with each scripted
      // pi event; envelopeForEvent returns null for events that emit nothing.
      const emitted: unknown[] = []
      for (const action of actions) {
        const env = envelopeForEvent(action.event, action.payload)
        if (env?.rpc) emitted.push(env.rpc)
      }

      // The committed input, filtered to the event plane (frames whose type
      // envelopeForEvent covers — command acks / notifies ride other seams).
      const input = readFileSync(join(dir, "input.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((frame) => !["response", "extension_ui_request", "error"].includes(frame["type"] as string))

      expect(emitted).toEqual(input)
    })
  }
})