import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { initTheme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { entriesToEnvelopes, reduce, toEnvelope } from "./reduce.js"
import { renderTranscript } from "./render.js"

const FIXTURE = fileURLToPath(
  new URL(
    "../../app/Tests/Fixtures/rpc-stream/subagent-run.envelope.jsonl",
    import.meta.url,
  ),
)

function liveEnvelopes() {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      const env = toEnvelope(JSON.parse(line))
      return env ? [env] : []
    })
}

/** Rebuild the entries the session log would have persisted for this capture. */
function persistedEntries() {
  return liveEnvelopes().flatMap((env) => {
    const rpc = env.rpc as { type?: string; message?: unknown } | undefined
    return rpc?.type === "message_end"
      ? [{ type: "message", message: rpc.message }]
      : []
  })
}

describe("history replay folds identically to the live stream", () => {
  it("produces the same transcript items", () => {
    const live = reduce(liveEnvelopes()).filter((i) => i.kind !== "notice")
    const history = reduce(entriesToEnvelopes(persistedEntries()))
    expect(history.map((i) => i.kind)).toEqual(live.map((i) => i.kind))
  })

  it("renders byte-identically", () => {
    initTheme("dark", false)
    const live = reduce(liveEnvelopes()).filter((i) => i.kind !== "notice")
    const history = reduce(entriesToEnvelopes(persistedEntries()))
    expect(renderTranscript(history, 80, "/repo")).toEqual(
      renderTranscript(live, 80, "/repo"),
    )
  })

  it("drops ephemeral notices, which the session log never persists", () => {
    const live = reduce(liveEnvelopes())
    const history = reduce(entriesToEnvelopes(persistedEntries()))
    expect(live.some((i) => i.kind === "notice")).toBe(true)
    expect(history.some((i) => i.kind === "notice")).toBe(false)
  })
})
