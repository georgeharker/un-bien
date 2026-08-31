// Disposal semantics for subagent rooms (docs/subagent-events.md §4/§5):
// `child:disposed` is a TERMINAL STATUS STAMP on the panel row, then splits on
// whether the child ever attached in-process —
//   in-process  → LINGER: the room keeps serving the finished transcript until
//                 parent teardown (relay.close NOT called).
//   keeper-only → release the keeper (close), row stays stamped.
// plus the keeperReleased TOMBSTONE: a build still connecting when the marker
// lands must be disposed on completion, never registered.
//
// initSubagentRooms is driven directly with a fake root pi (EventEmitter bus),
// mocked RelayClient/storage/config — the seams the module already has.

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { ServerMessage } from "./protocol/types.js"
import { roomIdFor, roomIdForSession } from "./rooms.js"

// ── Mocks ─────────────────────────────────────────────────────────────────────

const relayInstances: MockRelay[] = []
// Swappable default connect impl so a test can hold a build in-flight
// (the disposed-while-building tombstone race).
let _connectImpl: () => Promise<void> = async () => undefined

class MockRelay extends EventEmitter {
  static OPEN = 1
  readyState = MockRelay.OPEN
  connectOpts: unknown
  connect = vi.fn(async (opts?: unknown) => {
    this.connectOpts = opts
    return _connectImpl()
  })
  send = vi.fn()
  sendControl = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    this.emit("close")
  })
  isOpen = vi.fn(() => this.readyState === MockRelay.OPEN)
  constructor() {
    super()
    relayInstances.push(this)
  }
}

vi.mock("./transport/relay_client.js", () => ({
  RelayClient: MockRelay,
}))

vi.mock("./pairing/storage.js", () => ({
  getOrCreateEd25519Keypair: async () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32),
  }),
}))

vi.mock("./pairing/peer_trust.js", () => ({
  _findKnownPeer: async () => null,
}))

vi.mock("./config.js", () => ({
  loadConfig: () => ({
    subagents: { rooms: true },
    relay: "http://relay.test",
  }),
  resolveRelayUrl: () => ({ url: "http://relay.test", source: "config" }),
}))

const { initSubagentRooms, normalizeChildRoomId } =
  await import("./subagent_rooms.js")

// ── Harness ───────────────────────────────────────────────────────────────────

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Flush the async connect + .then registration chain. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

function makeHarness() {
  const events = new EventEmitter()
  const rootPi = { events } as unknown as ExtensionAPI
  const panels: ServerMessage[] = []
  const rooms = initSubagentRooms(rootPi, {
    getParentRoomId: () => "parent-room",
    getParentSessionId: () => "parent-sid",
    broadcastPanel: (p) => panels.push(p),
  })
  return { events, rooms, panels }
}

function childCtx(sid: string, sessionFile?: string): ExtensionContext {
  return {
    cwd: "/tmp/x",
    sessionManager: {
      getSessionId: () => sid,
      getEntries: () => [],
      getLeafId: () => null,
      getHeader: () => ({ timestamp: new Date().toISOString() }),
      ...(sessionFile ? { getSessionFile: () => sessionFile } : {}),
    },
  } as unknown as ExtensionContext
}

const childPi = { on: () => () => undefined } as unknown as ExtensionAPI

/** The panel row for a child session, from the last broadcast panel. */
function rowFor(panels: ServerMessage[], sid: string) {
  const last = panels.at(-1) as unknown as {
    data?: { items?: Array<{ id: string; status: string; title?: string }> }
  }
  return last?.data?.items?.find((i) => i.id === `agent:${sid}`)
}

beforeEach(() => {
  relayInstances.length = 0
  _connectImpl = async () => undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  // Drop any fake published subagents service between tests.
  delete (globalThis as Record<symbol, unknown>)[
    Symbol.for("@gotgenes/pi-subagents:service")
  ]
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("subagent room disposal semantics", () => {
  test("in-process child: disposal LINGERS — room stays open, row stamped terminal", async () => {
    const h = makeHarness()
    // Marker (gotgenes pre-bind) with a record id, then the in-process attach.
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-1",
      parentSessionId: "parent-sid",
      id: "rec-1",
    })
    await flush()
    h.rooms.onChildSession(childPi, childCtx("child-1"))
    // Terminal record event BEFORE the finally's disposed — stamps "failed".
    h.events.emit("subagents:failed", { id: "rec-1" })

    h.events.emit("subagents:child:disposed", { sessionId: "child-1" })

    const relay = relayInstances.at(-1)!
    expect(relay.close).not.toHaveBeenCalled() // linger, not teardown
    expect(rowFor(h.panels, "child-1")?.status).toBe("failed")
  })

  test("in-process child: disposed with no terminal record falls back to stopped, room kept", async () => {
    const h = makeHarness()
    h.events.emit("unbien:subagent:child", { sessionId: "child-2" })
    await flush()
    h.rooms.onChildSession(childPi, childCtx("child-2"))

    h.events.emit("unbien:subagent:disposed", { sessionId: "child-2" })

    expect(relayInstances.at(-1)!.close).not.toHaveBeenCalled()
    expect(rowFor(h.panels, "child-2")?.status).toBe("stopped")
  })

  test("keeper-only child (never attached): disposal releases the keeper, row stays", async () => {
    const h = makeHarness()
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-3",
      parentSessionId: "parent-sid",
    })
    await flush()
    const relay = relayInstances.at(-1)!
    expect(relay.connectOpts).toMatchObject({
      roomId: roomIdForSession("child-3"),
    })

    h.events.emit("subagents:child:disposed", { sessionId: "child-3" })

    expect(relay.close).toHaveBeenCalledTimes(1) // keeper released
    expect(rowFor(h.panels, "child-3")?.status).toBe("stopped") // row kept
  })

  test("tombstone: disposed while the keeper build is still connecting disposes it on completion", async () => {
    const gate = deferred()
    _connectImpl = () => gate.promise
    const h = makeHarness()
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-4",
      parentSessionId: "parent-sid",
    })
    // Let the build reach the (gated) connect — instance exists, still pending.
    await flush(2)
    // The child dies before the connect resolves.
    h.events.emit("subagents:child:disposed", { sessionId: "child-4" })
    const relay = relayInstances.at(-1)!
    expect(relay.connect).toHaveBeenCalledTimes(1) // in flight, gated
    expect(relay.close).not.toHaveBeenCalled() // not built yet

    gate.resolve()
    await flush()

    expect(relay.close).toHaveBeenCalledTimes(1) // disposed, not registered
    expect(rowFor(h.panels, "child-4")?.status).toBe("stopped")
  })

  test("session_start racing the build: disposal lingers and the attach still lands", async () => {
    const gate = deferred()
    _connectImpl = () => gate.promise
    const h = makeHarness()
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-5",
      parentSessionId: "parent-sid",
    })
    // session_start lands while the keeper is still connecting → in-process.
    h.rooms.onChildSession(childPi, childCtx("child-5"))
    // The child finishes before the build completes — in-process ⇒ linger.
    h.events.emit("subagents:child:disposed", { sessionId: "child-5" })

    gate.resolve()
    await flush()

    const relay = relayInstances.at(-1)!
    expect(relay.close).not.toHaveBeenCalled() // lingered (attach drained)
    expect(rowFor(h.panels, "child-5")?.status).toBe("stopped")
  })

  test("background gotgenes spawn: created → marker → session_start → started binds → completed stamps", async () => {
    const h = makeHarness()
    // BACKGROUND order: created {id} fires at spawn (before its session
    // exists — it does NOT bind), then marker → session_start tags the entry,
    // then started pops it.
    h.events.emit("subagents:created", {
      id: "rec-9",
      type: "Explore",
      description: "scan the repo",
    })
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-7",
      parentSessionId: "parent-sid",
    })
    await flush()
    h.rooms.onChildSession(childPi, childCtx("child-7"))
    h.events.emit("subagents:started", { id: "rec-9" })

    h.events.emit("subagents:completed", { id: "rec-9", result: "done" })

    expect(rowFor(h.panels, "child-7")?.status).toBe("completed")
  })

  test("foreground gotgenes spawn: marker + session_start BEFORE any record event — started binds late", async () => {
    const h = makeHarness()
    // FOREGROUND order (the parent-twin path): child marker (pre-bind, NO
    // record id — created is background-only in gotgenes) → session_start →
    // started {id} (post-bind) → completed {id}. The symmetric queue must bind
    // at started so completed can stamp the row.
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-8",
      parentSessionId: "parent-sid",
    })
    await flush()
    h.rooms.onChildSession(childPi, childCtx("child-8"))

    h.events.emit("subagents:started", {
      id: "rec-8",
      type: "general-purpose",
      description: "twin run",
    })
    h.events.emit("subagents:completed", { id: "rec-8", result: "done" })

    const row = rowFor(h.panels, "child-8")
    expect(row?.status).toBe("completed")
    expect(row?.title).toBe("twin run") // labels enriched from the record
  })

  test("authoritative layer: gotgenes service outputFile match binds even a terminal event with no started", async () => {
    // Publish a fake service (exactly how gotgenes does: globalThis under
    // Symbol.for) whose record rec-10 points at child-10's session file.
    ;(globalThis as Record<symbol, unknown>)[
      Symbol.for("@gotgenes/pi-subagents:service")
    ] = {
      getRecord: (id: string) =>
        id === "rec-10"
          ? { outputFile: "/tmp/sessions/child-10.jsonl" }
          : undefined,
    }
    const h = makeHarness()
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-10",
      parentSessionId: "parent-sid",
    })
    await flush()
    h.rooms.onChildSession(
      childPi,
      childCtx("child-10", "/tmp/sessions/child-10.jsonl"),
    )

    // NO started at all — completed arrives unbound and the service match
    // must bind + stamp in one step.
    h.events.emit("subagents:completed", { id: "rec-10", result: "done" })

    expect(rowFor(h.panels, "child-10")?.status).toBe("completed")
  })

  test("forward-compat: a record event carrying sessionId (future upstream) binds directly — no heuristics", async () => {
    const h = makeHarness()
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-11",
      parentSessionId: "parent-sid",
    })
    await flush()
    h.rooms.onChildSession(childPi, childCtx("child-11"))

    // Neither implementation emits this today — but if one adds the child
    // sessionId to its record events, the bind is exact on the spot.
    h.events.emit("subagents:started", {
      id: "rec-11",
      type: "general-purpose",
      description: "future payload",
      sessionId: "child-11",
    })
    h.events.emit("subagents:completed", { id: "rec-11", result: "done" })

    expect(rowFor(h.panels, "child-11")?.status).toBe("completed")
  })

  test("keeper advertises parent at connect AND re-advertises via room_meta_update on build", async () => {
    const h = makeHarness()
    h.events.emit("subagents:child:session-created", {
      sessionId: "child-6",
      parentSessionId: "parent-sid",
    })
    await flush()
    const relay = relayInstances.at(-1)!
    // EARLY: the connect room_meta already carries the parent link.
    expect(relay.connectOpts).toMatchObject({
      roomId: roomIdForSession("child-6"),
      roomMeta: expect.objectContaining({
        parent: "parent-room",
        parentSessionId: "parent-sid",
      }),
    })
    // Build-completion re-advertise (covers the child-first-conn ordering race).
    expect(relay.sendControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "room_meta_update",
        room_id: roomIdForSession("child-6"),
        meta: expect.objectContaining({
          parent: "parent-room",
          parentSessionId: "parent-sid",
        }),
      }),
    )
  })
})

// ── design 01M1CAW0: fail-loud parentage guards ───────────────────────────────

describe("parentage guards (design 01M1CAW0)", () => {
  test("marker WITHOUT parentSessionId: room built WITHOUT parent — not guessing", async () => {
    const h = makeHarness()
    // No parentSessionId on the marker. The OLD chain fell back to
    // opts.getParentSessionId() (the receiving process's root) and stamped
    // set-once parentage onto a child that was never ours to nest.
    h.events.emit("subagents:child:session-created", { sessionId: "child-20" })
    await flush()

    const relay = relayInstances.at(-1)!
    // The room still exists (identity + transcript surface)…
    expect(relay.connectOpts).toMatchObject({
      roomId: roomIdForSession("child-20"),
    })
    // …but carries NO parentage — neither at connect…
    const meta = (relay.connectOpts as { roomMeta?: Record<string, unknown> })
      .roomMeta
    expect(meta).toBeDefined()
    expect(meta!["parent"]).toBeUndefined()
    expect(meta!["parentSessionId"]).toBeUndefined()
    // …nor via a later room_meta_update (relay parent merge is SET-ONCE).
    expect(relay.sendControl).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "room_meta_update",
        meta: expect.objectContaining({ parent: expect.anything() }),
      }),
    )
    // The panel row is still registered — identity without parentage.
    expect(rowFor(h.panels, "child-20")).toBeTruthy()
  })

  test("marker WITHOUT parent: the in-process attach still sets parentage authoritatively", async () => {
    const h = makeHarness()
    h.events.emit("unbien:subagent:child", { sessionId: "child-21" })
    await flush()
    // The child attaches in-process — onChildSession uses the root's own
    // sessionId AUTHORITATIVELY (unchanged path), so parentage lands late.
    h.rooms.onChildSession(childPi, childCtx("child-21"))
    await flush()

    const relay = relayInstances.at(-1)!
    expect(relay.sendControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "room_meta_update",
        room_id: roomIdForSession("child-21"),
        meta: expect.objectContaining({
          parent: "parent-room",
          parentSessionId: "parent-sid",
        }),
      }),
    )
  })

  test("normalizeChildRoomId: a mismatched (cwd-derived residue) id is refused", () => {
    // No candidate → the sid-hash id.
    expect(normalizeChildRoomId("child-30")).toBe(roomIdForSession("child-30"))
    // The sid-hash candidate is kept verbatim.
    expect(normalizeChildRoomId("child-30", roomIdForSession("child-30"))).toBe(
      roomIdForSession("child-30"),
    )
    // A foreign id — e.g. the retired cwd-derived room, identical for
    // same-cwd processes — is refused in favor of the sid-hash id.
    const cwdDerived = roomIdFor("/home/user", "agent")
    expect(cwdDerived).not.toBe(roomIdForSession("child-30"))
    expect(normalizeChildRoomId("child-30", cwdDerived)).toBe(
      roomIdForSession("child-30"),
    )
  })
})
