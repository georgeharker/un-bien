/**
 * Bounded-poll selection for `--session` / `--session-name` (connect flow):
 *  - an explicit miss re-gathers up to SESSION_WAIT_RETRIES times before
 *    giving up (the create-session handoff races room propagation)
 *  - each retry logs one calm line with its attempt number
 *  - ambiguous names refuse immediately, before any polling
 *  - the multi-relay name filter keeps its exact semantics
 *  - id matching is by prefix (sessionId) or exact room_id
 *
 * The selection lives in this module rather than connect.ts because
 * connect.ts is a top-level script: importing it runs the whole attach flow.
 */
import { describe, expect, it } from "vitest"
import {
  findFlaggedSession,
  matchesSessionId,
  SESSION_WAIT_RETRIES,
  type SessionChoice,
} from "./session-select.js"

function room(over: Partial<SessionChoice>): SessionChoice {
  return {
    room_id: "r0",
    name: undefined,
    sessionId: undefined,
    relayUrl: "wss://relay-a",
    relayLabel: "relay-a",
    ...over,
  }
}

/** A regather stub with a script: each snapshot it returns in order. */
function scriptedRegather(snapshots: SessionChoice[][]) {
  const calls: number[] = []
  const regather = async (): Promise<SessionChoice[]> => {
    calls.push(calls.length)
    return snapshots[calls.length - 1] ?? []
  }
  return { regather, calls }
}

describe("matchesSessionId", () => {
  it("matches a sessionId by prefix", () => {
    expect(matchesSessionId(room({ sessionId: "abcdef123" }), "abc")).toBe(true)
  })
  it("matches a room_id exactly, never by prefix", () => {
    expect(matchesSessionId(room({ room_id: "r-xyz" }), "r-xyz")).toBe(true)
    expect(matchesSessionId(room({ room_id: "r-xyz" }), "r-x")).toBe(false)
  })
  it("misses when neither identity matches", () => {
    expect(
      matchesSessionId(room({ room_id: "r0", sessionId: "sess-1" }), "zzz"),
    ).toBe(false)
  })
})

describe("findFlaggedSession — id polling", () => {
  it("returns an immediate match without regathering", async () => {
    const target = room({ sessionId: "sess-42", name: "fresh" })
    const { regather, calls } = scriptedRegather([])
    const result = await findFlaggedSession({
      choices: [room({}), target],
      multiRelay: false,
      relayUrl: "wss://relay-a",
      wantedId: "sess-4",
      regather,
    })
    expect(result.chosen).toBe(target)
    expect(result.ambiguous).toBeNull()
    expect(calls).toEqual([])
  })

  it("finds the room on a later snapshot, one log line per retry", async () => {
    const target = room({ sessionId: "sess-42", name: "fresh" })
    const { regather, calls } = scriptedRegather([[target]])
    const logs: string[] = []
    const result = await findFlaggedSession({
      choices: [],
      multiRelay: false,
      relayUrl: "wss://relay-a",
      wantedId: "sess-42",
      regather,
      log: (line) => logs.push(line),
    })
    expect(result.chosen).toBe(target)
    expect(calls).toEqual([0])
    expect(logs).toEqual([
      '[sessions] id "sess-42" not visible yet — waiting for it to arrive (1/3)…',
    ])
  })

  it("gives up after the bounded budget with no match", async () => {
    const { regather, calls } = scriptedRegather([
      [],
      [],
      [],
    ])
    const logs: string[] = []
    const result = await findFlaggedSession({
      choices: [],
      multiRelay: false,
      relayUrl: "wss://relay-a",
      wantedId: "nope",
      regather,
      log: (line) => logs.push(line),
    })
    expect(result.chosen).toBeNull()
    expect(result.ambiguous).toBeNull()
    // initial snapshot + exactly SESSION_WAIT_RETRIES re-gathers
    expect(calls.length).toBe(SESSION_WAIT_RETRIES)
    expect(logs.map((l) => l.match(/\((\d\/3)\)/)?.[1])).toEqual([
      "1/3",
      "2/3",
      "3/3",
    ])
  })
})

describe("findFlaggedSession — name semantics", () => {
  it("matches a unique name from the initial snapshot", async () => {
    const target = room({ name: "worker", relayUrl: "wss://relay-a" })
    const { regather, calls } = scriptedRegather([])
    const result = await findFlaggedSession({
      choices: [target, room({ name: "other" })],
      multiRelay: false,
      relayUrl: "wss://relay-a",
      wantedName: "worker",
      regather,
    })
    expect(result.chosen).toBe(target)
    expect(calls).toEqual([])
  })

  it("refuses an ambiguous name immediately, without polling", async () => {
    const a = room({ name: "worker", room_id: "ra" })
    const b = room({ name: "worker", room_id: "rb" })
    const { regather, calls } = scriptedRegather([])
    const result = await findFlaggedSession({
      choices: [a, b],
      multiRelay: false,
      relayUrl: "wss://relay-a",
      wantedName: "worker",
      regather,
    })
    expect(result.chosen).toBeNull()
    expect(result.ambiguous).toEqual([a, b])
    expect(calls).toEqual([])
  })

  it("under multi-relay, a same-named room on another relay does not count", async () => {
    const mine = room({ name: "worker", relayUrl: "wss://relay-a" })
    const other = room({
      name: "worker",
      room_id: "rb",
      relayUrl: "wss://relay-b",
      relayLabel: "relay-b",
    })
    const { regather } = scriptedRegather([])
    const result = await findFlaggedSession({
      choices: [mine, other],
      multiRelay: true,
      relayUrl: "wss://relay-a",
      wantedName: "worker",
      regather,
    })
    expect(result.chosen).toBe(mine)
    expect(result.ambiguous).toBeNull()
  })

  it("under multi-relay, two same-named rooms on the target relay are still ambiguous", async () => {
    const a = room({ name: "worker", room_id: "ra" })
    const b = room({ name: "worker", room_id: "rb" })
    const { regather } = scriptedRegather([])
    const result = await findFlaggedSession({
      choices: [a, b],
      multiRelay: true,
      relayUrl: "wss://relay-a",
      wantedName: "worker",
      regather,
    })
    expect(result.ambiguous).toEqual([a, b])
  })

  it("polls a missing name and finds it after propagation", async () => {
    const target = room({ name: "fresh-room", sessionId: "sess-9" })
    const { regather } = scriptedRegather([[target]])
    const logs: string[] = []
    const result = await findFlaggedSession({
      choices: [],
      multiRelay: false,
      relayUrl: "wss://relay-a",
      wantedName: "fresh-room",
      regather,
      log: (line) => logs.push(line),
    })
    expect(result.chosen).toBe(target)
    expect(logs).toEqual([
      '[sessions] name "fresh-room" not visible yet — waiting for it to arrive (1/3)…',
    ])
  })
})