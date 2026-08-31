/**
 * Integration tests: extension default export + pair_request flow + reconnect.
 *
 * Post plano 06: no Noise XX. Pairing is `pair_request → pair_ok|pair_error`
 * over an opaque outer envelope whose `ct` is base64(JSON.stringify(inner)).
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui"
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent"

const _convertToPngMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ data: string; mimeType: string } | null> => null),
)

// ── Mock RelayClient ──────────────────────────────────────────────────────────

const relayRef: { current: MockRelay | null } = { current: null }
const relayInstances: MockRelay[] = []
// Tests can swap this to inject failing connects across all future instances.
// Receives the `options` arg so tests can assert what was passed in.
let _defaultConnectImpl: (opts?: unknown) => Promise<void> = async () =>
  undefined

class MockRelay extends EventEmitter {
  static OPEN = 1
  readyState = MockRelay.OPEN
  connect = vi
    .fn()
    .mockImplementation((opts?: unknown) => _defaultConnectImpl(opts))
  send = vi.fn()
  sendControl = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
  })
  isOpen = vi.fn(() => this.readyState === MockRelay.OPEN)
  constructor() {
    super()
    relayRef.current = this
    relayInstances.push(this)
  }
}

class MockRoomAlreadyOpenError extends Error {
  constructor(public readonly roomId: string | undefined) {
    super(`room ${roomId} already open`)
    this.name = "RoomAlreadyOpenError"
  }
}

vi.mock("./transport/relay_client.js", () => ({
  RelayClient: MockRelay,
  RoomAlreadyOpenError: MockRoomAlreadyOpenError,
}))

// ── Mock storage ──────────────────────────────────────────────────────────────

type StoredPeer = { name: string; remote_epk: string; paired_at: string }
const _knownPeers: StoredPeer[] = []
const _addedPeers: StoredPeer[] = []
const _removedPeers: string[] = []
let _meshOwnerDiscoveryEnabled = false

vi.mock("./pairing/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./pairing/storage.js")>()
  return {
    ...orig,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    }),
    listPeers: vi.fn().mockImplementation(async () => [..._knownPeers]),
    // Hermetic: derive owners from the in-memory _knownPeers instead of the
    // real ~/.pi/un-bien/peers.json. The unmocked `listOwnerPubkeys` calls the
    // module-internal (real) `listPeers`, so it would read this dev machine's
    // actual owners → SelfRevoke would HTTP-fetch the production mesh blob and
    // seed real siblings (e.g. "MacMini"), making BrokerRemote emit stray
    // peers_request envelopes that break send-count / decode assertions. Empty
    // by default → SelfRevoke finds no owners → no network, no siblings.
    listOwnerPubkeys: vi.fn().mockImplementation(async () =>
      _meshOwnerDiscoveryEnabled
        ? [
            ...new Set(
              (_knownPeers as unknown[]).map((peer) => {
                if (!peer || typeof peer !== "object") return peer
                return (peer as { remote_epk?: unknown }).remote_epk
              }),
            ),
          ]
        : [],
    ),
    addPeer: vi.fn().mockImplementation(async (p: StoredPeer) => {
      _addedPeers.push(p)
      const index = _knownPeers.findIndex(
        (peer) => peer.remote_epk === p.remote_epk,
      )
      if (index >= 0) _knownPeers[index] = p
      else _knownPeers.push(p)
    }),
    snapshotOwnerPubkeys: vi.fn().mockImplementation(async () => {
      if (!_meshOwnerDiscoveryEnabled) {
        throw new Error("strict Owner snapshot unavailable in this test")
      }
      return [
        ...new Set(
          (_knownPeers as unknown[]).map((peer) => {
            if (!peer || typeof peer !== "object") return peer
            return (peer as { remote_epk?: unknown }).remote_epk
          }),
        ),
      ].map((rawOwnerPubkey) => ({ rawOwnerPubkey, token: rawOwnerPubkey }))
    }),
    conditionalRemovePeer: vi
      .fn()
      .mockImplementation(
        async (
          epk: string,
          _expectedToken: unknown,
          canCommit?: () => boolean,
        ) => {
          if (canCommit && !canCommit()) return { outcome: "no_authority" }
          const before = _knownPeers.length
          const filtered = _knownPeers.filter((peer) => peer.remote_epk !== epk)
          if (filtered.length === before) return { outcome: "not_found" }
          _knownPeers.length = 0
          _knownPeers.push(...filtered)
          _removedPeers.push(epk)
          return { outcome: "removed", nextToken: epk }
        },
      ),
    removePeer: vi.fn().mockImplementation(async (epk: string) => {
      const before = _knownPeers.length
      const filtered = (_knownPeers as unknown[]).filter((peer) => {
        if (!peer || typeof peer !== "object") return true
        return (peer as { remote_epk?: unknown }).remote_epk !== epk
      }) as StoredPeer[]
      _knownPeers.length = 0
      _knownPeers.push(...filtered)
      if (filtered.length !== before) {
        _removedPeers.push(epk)
        return true
      }
      return false
    }),
  }
})

// ── Mock config (no real fs writes) ───────────────────────────────────────────

let _savedRelayUrl: string | null = "https://relay.test"
const _setRelayCalls: string[] = []

vi.mock("./config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./config.js")>()
  return {
    ...orig,
    loadConfig: vi.fn().mockImplementation(() => ({
      ...(_savedRelayUrl ? { relay: _savedRelayUrl } : {}),
    })),
    saveConfig: vi.fn().mockImplementation((patch: { relay?: string }) => {
      _setRelayCalls.push(patch.relay ?? "")
      if (patch.relay !== undefined) _savedRelayUrl = patch.relay
    }),
    resolveRelayUrl: vi.fn().mockImplementation(() => {
      const env = process.env["UNBIEN_RELAY"]
      if (env && env.length > 0)
        return { url: orig.toHttpUrl(env), source: "env" as const }
      if (_savedRelayUrl && _savedRelayUrl.length > 0) {
        return {
          url: orig.toHttpUrl(_savedRelayUrl),
          source: "config" as const,
        }
      }
      return { url: null, source: "unset" as const }
    }),
    // isValidRelayUrl + isWebSocketScheme + toHttpUrl
    // + toWebSocketUrl come from orig (...spread).
  }
})

// ── Mock qrSession.consumeToken control ───────────────────────────────────────

let _tokenStatus: "ok" | "expired" | "consumed" | "unknown" = "ok"
const _consumeCalls: string[] = []

vi.mock("./pairing/qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./pairing/qr.js")>()
  return {
    ...orig,
    displayQR: vi.fn(), // suppress side effects (terminal spawn) in tests
    qrSession: {
      issueToken: vi.fn().mockReturnValue({
        token: "test-token",
        expiresAt: Date.now() + 60_000,
      }),
      consumeToken: vi.fn().mockImplementation((token: string) => {
        _consumeCalls.push(token)
        return _tokenStatus
      }),
      clear: vi.fn(),
      generateToken: vi.fn().mockReturnValue("test-token"),
    },
  }
})

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
  return { ...orig, convertToPng: _convertToPngMock }
})

interface CapturedSelfRevokeOptions {
  onRevoke?: (
    rawOwnerPubkey: string,
    canonicalOwnerPubkey: string,
  ) => void | Promise<void>
  onAuthoritativeOwners?: (
    canonicalOwnerPubkeys: readonly string[],
  ) => void | Promise<void>
  onTopologyChanged?: (snapshot: unknown) => void | Promise<void>
}

const selfRevokeHarness = vi.hoisted(() => ({
  options: [] as CapturedSelfRevokeOptions[],
}))

vi.mock("./mesh/self_revoke.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./mesh/self_revoke.js")>()
  class CapturingSelfRevoke extends original.SelfRevoke {
    constructor(options: ConstructorParameters<typeof original.SelfRevoke>[0]) {
      super(options)
      ;(selfRevokeHarness.options as unknown[]).push(options)
    }
  }
  return { ...original, SelfRevoke: CapturingSelfRevoke }
})

// Import AFTER mocks
const indexModule = await import("./index.js")
const {
  default: extension,
  _getState,
  _onPeerDisconnect,
  _resetBridgeOwnersForTest,
  _setSessionStartedAtForTest,
  _hasPendingReconnect,
  _setCurrentModelForTest,
  _setPiForTest,
  _getCurrentTurnIdForTest,
  _connectForTest,
  _startRelayForTest,
  _getCachedPublicKeyForTest,
  _hasActivePeerForTest,
  _getActivePeerCountForTest,
  _checkSelfRevokeForTest,
  _setDisposedForTest,
  _resetAutoInitedForTest,
  _setAutoInitedForTest,
  _hasMeshNodeForTest,
  _getLockedNameForTest,
  _resetCwdLockForTest,
  _resetSessionsForTest,
  _handleControl,
  _deliverMeshMessageToAgentForTest,
  CTRL_PREFIX,
} = indexModule
const { acquireCwdLock } = await import("./session/cwd_lock.js")

// Keyed per-session state (_sessions Map + _rootSessionId) is module-global;
// reset it at every test boundary so it can't leak across tests. NOT in
// _resetBridgeOwnersForTest — that fires mid-test on each captureEventHandler.
beforeEach(() => {
  _resetSessionsForTest()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockPi(): { pi: ExtensionAPI; registeredCommands: string[] } {
  const registeredCommands: string[] = []
  const pi = {
    on: () => undefined,
    registerCommand(name: string, _opts: unknown) {
      registeredCommands.push(name)
    },
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI
  return { pi, registeredCommands }
}

function makeMockCtx(cwd = "/home/user/projects/remote_pi") {
  return { ui: { notify: vi.fn() }, cwd, abort: vi.fn() }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type CmdHandler = (
  args: string,
  ctx: ReturnType<typeof makeMockCtx>,
) => Promise<void>

function captureHandler(commandName: string): CmdHandler {
  let captured: CmdHandler | undefined
  const pi = {
    on: () => undefined,
    registerCommand(name: string, opts: { handler: CmdHandler }) {
      if (name === commandName) captured = opts.handler
    },
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI
  ;(extension as ExtensionFactory)(pi)
  if (!captured) throw new Error(`command "${commandName}" not registered`)
  return captured
}

function makeInnerLine(
  peer: string,
  inner: { type: string; [k: string]: unknown },
): string {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64")
  return JSON.stringify({ peer, ct })
}

function decodeSentCt(raw: string): {
  peer: string
  inner: { type: string; [k: string]: unknown }
} {
  const outer = JSON.parse(raw) as { peer: string; ct: string }
  const inner = JSON.parse(
    Buffer.from(outer.ct, "base64").toString("utf8"),
  ) as {
    type: string
    [k: string]: unknown
  }
  return { peer: outer.peer, inner }
}

// ── Envelope session_sync helpers (stock protocol retired) ──────────────────
// The app now requests reconstruction as {rpc:{type:"session_sync",...}}. A bare
// stock session_sync falls through the retired switch, so tests drive the real
// channel path: emit an envelope frame for the paired peer and let onRpc route
// it to _routeRpcCommandFrom.
function emitEnvelopeSync(
  peer: string,
  id: string,
  limit?: number,
): Promise<void> {
  relayRef.current!.emit(
    "message",
    JSON.stringify({
      peer,
      ct: Buffer.from(
        JSON.stringify({
          ub: {
            type: "session_sync",
            id,
            ...(limit == null ? {} : { limit }),
          },
        }),
      ).toString("base64"),
    }),
  )
  return new Promise<void>((r) => setImmediate(r))
}

/** Decoded `{rpc}` frames from a slice of relay sends, in order. */
function rpcFramesFrom(raws: string[]): Array<Record<string, unknown>> {
  return raws
    .map(decodeSentCt)
    .map((d) => d.inner["rpc"])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
}

/** Decoded `{ub}` frames (un-bien plane) from a slice of relay sends, in order. */
function ubFramesFrom(raws: string[]): Array<Record<string, unknown>> {
  return raws
    .map(decodeSentCt)
    .map((d) => d.inner["ub"])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
}

/** The `message_end` replay frames (transcript rows) from a slice of sends. */
function replayMessageEnds(raws: string[]): Array<{
  role: string
  text: string
  id?: string
}> {
  return rpcFramesFrom(raws)
    .filter((f) => f["type"] === "message_end")
    .map((f) => {
      const m = (f["message"] ?? {}) as Record<string, unknown>
      // Faithful replay forwards the raw message, so user content can be a bare
      // string (UserMessage.content: string | block[]); handle both shapes.
      const content = m["content"]
      const textBlock = Array.isArray(content)
        ? (content as Array<Record<string, unknown>>).find(
            (c) => c?.["type"] === "text",
          )
        : undefined
      const text =
        typeof content === "string"
          ? content
          : String(textBlock?.["text"] ?? "")
      return {
        role: String(m["role"] ?? ""),
        text,
        ...(m["id"] == null ? {} : { id: String(m["id"]) }),
      }
    })
}

/** The single `session_sync_end` terminator frame from a slice of sends. */
function syncEndFrame(raws: string[]): Record<string, unknown> | undefined {
  // session_sync_end is un-bien's own terminator on the un plane.
  return ubFramesFrom(raws).find((f) => f["type"] === "session_sync_end")
}

const OWNER_PUBLIC_FIXTURE = Buffer.from(
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "hex",
)
const OTHER_OWNER_PUBLIC_FIXTURE = Buffer.from(
  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
  "hex",
)
const OWNER_STANDARD_FIXTURE = OWNER_PUBLIC_FIXTURE.toString("base64")
const OWNER_URL_SAFE_FIXTURE = OWNER_PUBLIC_FIXTURE.toString("base64url")
const OTHER_OWNER_STANDARD_FIXTURE =
  OTHER_OWNER_PUBLIC_FIXTURE.toString("base64")

// ── State machine + pair_request flow ─────────────────────────────────────────

describe("state machine + pair_request flow", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _tokenStatus = "ok"
    relayRef.current = null
    // Restore default consumeToken behavior — earlier tests can override it.
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    // Force idle via stop
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("start: idle → started", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())
    expect(_getState()).toBe("started")
  })

  test("pair without start → warning, state stays idle", async () => {
    expect(_getState()).toBe("idle")
    // Isolated empty cwd so `localConfigExists` is deterministically false on
    // every OS. The old fake path (`/home/user/...`) is non-writable on macOS
    // (config never exists → first-time path) but writable on Windows (a config
    // could exist → wrong auto-bootstrap path, slow real-socket work).
    const cwd = mkdtempSync(join(tmpdir(), "pi-ext-cwd-"))
    const pair = captureHandler("unbien pair")
    const ctx = makeMockCtx(cwd)
    await pair("", ctx)
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Run /unbien"),
      "warning",
    )
    expect(_getState()).toBe("idle")
    rmSync(cwd, { recursive: true, force: true })
  })

  test("valid pair_request → pair_ok + state paired + peer persisted", async () => {
    _tokenStatus = "ok"
    const APP_PEER_ID = "valid-app-peer-base64"

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())
    expect(_getState()).toBe("started")

    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_ID, {
        type: "pair_request",
        id: "req-1",
        token: "test-token",
        device_name: "iPhone do Jacob",
      }),
    )

    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })

    // pair_ok must have been sent back to the app peer
    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const pairOks = sent
      .map(decodeSentCt)
      .filter((d) => d.inner.type === "pair_ok")
    expect(pairOks).toHaveLength(1)
    expect(pairOks[0]!.peer).toBe(APP_PEER_ID)
    expect(pairOks[0]!.inner).toMatchObject({
      type: "pair_ok",
      in_reply_to: "req-1",
    })

    // Plan/27 Wave A: pair_ok carries harness + hostname so the app can
    // render a meaningful device row. Both are required in every NEW
    // pairing emitted by this code path (wire type still has them
    // optional for backward-compat with older Pi builds).
    const inner = pairOks[0]!.inner as {
      harness?: { name: string; version: string }
      hostname?: string
    }
    expect(inner.harness).toBeDefined()
    expect(inner.harness!.name).toBe("Pi coding agent")
    expect(typeof inner.harness!.version).toBe("string")
    expect(inner.harness!.version.length).toBeGreaterThan(0)
    expect(typeof inner.hostname).toBe("string")
    expect(inner.hostname!.length).toBeGreaterThan(0)

    // Peer must have been persisted
    expect(_addedPeers).toHaveLength(1)
    expect(_addedPeers[0]).toMatchObject({
      name: "iPhone do Jacob",
      remote_epk: APP_PEER_ID,
    })
  })

  test("expired token → pair_error{token_expired} + state stays started", async () => {
    _tokenStatus = "expired"
    const APP_PEER_ID = "stale-token-peer"

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_ID, {
        type: "pair_request",
        id: "req-x",
        token: "test-token",
        device_name: "iPhone",
      }),
    )

    await new Promise((r) => setTimeout(r, 50))

    expect(_getState()).toBe("started")
    expect(_addedPeers).toHaveLength(0)

    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const errs = sent
      .map(decodeSentCt)
      .filter((d) => d.inner.type === "pair_error")
    expect(errs).toHaveLength(1)
    expect(errs[0]!.inner).toMatchObject({
      type: "pair_error",
      in_reply_to: "req-x",
      code: "token_expired",
    })
  })

  test("consumed token → pair_error{token_consumed} on second pair_request", async () => {
    // First call returns ok (consumes); second returns consumed.
    let calls = 0
    _tokenStatus = "ok"
    // override consumeToken to return ok once, then consumed
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      calls += 1
      return calls === 1 ? "ok" : "consumed"
    })

    const APP_PEER_A = "peer-a"
    const APP_PEER_B = "peer-b"

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    // First pair_request from peer A → ok
    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_A, {
        type: "pair_request",
        id: "req-a",
        token: "test-token",
        device_name: "Phone A",
      }),
    )
    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })

    // Disconnect so we're back in started state for the second attempt
    _onPeerDisconnect()
    expect(_getState()).toBe("started")

    // Second pair_request from peer B with same token → consumed
    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_B, {
        type: "pair_request",
        id: "req-b",
        token: "test-token",
        device_name: "Phone B",
      }),
    )
    await new Promise((r) => setTimeout(r, 50))

    expect(_getState()).toBe("started") // didn't transition
    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const errs = sent
      .map(decodeSentCt)
      .filter(
        (d) =>
          d.inner.type === "pair_error" && d.inner["in_reply_to"] === "req-b",
      )
    expect(errs).toHaveLength(1)
    expect(errs[0]!.inner).toMatchObject({ code: "token_consumed" })
  })

  test("paired peer ignores subsequent pair_request (idempotent)", async () => {
    _tokenStatus = "ok"
    const APP_PEER_ID = "already-paired"

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    // First pair_request → paired
    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_ID, {
        type: "pair_request",
        id: "req-1",
        token: "test-token",
        device_name: "Phone",
      }),
    )
    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })

    const sendsBefore = relayRef.current!.send.mock.calls.length

    // Second pair_request from same peer while paired → routed through
    // PlainPeerChannel.onMessage → routeClientMessage which ignores it.
    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_ID, {
        type: "pair_request",
        id: "req-2",
        token: "test-token",
        device_name: "Phone",
      }),
    )
    await new Promise((r) => setTimeout(r, 50))

    expect(_getState()).toBe("paired")
    // No additional outbound messages from this second pair_request
    expect(relayRef.current!.send.mock.calls.length).toBe(sendsBefore)
  })

  test("known peer reconnect: any non-pair message from peers.json → paired", async () => {
    const APP_PEER_ID = OWNER_STANDARD_FIXTURE
    _knownPeers.push({
      name: "Known App",
      remote_epk: APP_PEER_ID,
      paired_at: new Date().toISOString(),
    })

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())
    expect(_getState()).toBe("started")

    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_ID, {
        type: "ping",
        id: "ping-reconnect",
      }),
    )

    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })
  })

  test("unknown peer non-pair message → state stays started, no peer added", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    relayRef.current!.emit(
      "message",
      makeInnerLine("unknown-peer", {
        type: "ping",
        id: "ping-x",
      }),
    )
    await new Promise((r) => setTimeout(r, 50))

    expect(_getState()).toBe("started")
    expect(_addedPeers).toHaveLength(0)
  })

  test("unknown peer + user_message → relay receives error{unknown_peer}", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    relayRef.current!.emit(
      "message",
      makeInnerLine("revoked-peer", {
        type: "user_message",
        id: "msg-x",
        text: "are you there",
      }),
    )
    await new Promise((r) => setTimeout(r, 50))

    expect(_getState()).toBe("started")
    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const errors = sent
      .map(decodeSentCt)
      .filter(
        (d) => d.inner.type === "error" && d.inner["code"] === "unknown_peer",
      )
    expect(errors).toHaveLength(1)
    expect(errors[0]!.peer).toBe("revoked-peer")
    expect(errors[0]!.inner).toMatchObject({
      type: "error",
      code: "unknown_peer",
    })
  })

  test("unknown peer + pair_request → NOT replied with error{unknown_peer}", async () => {
    // Pair_request is the legitimate path for unknown peers — handler must
    // respond with pair_ok or pair_error, never with the generic
    // error{unknown_peer}. Use token_unknown to keep peer unknown afterwards.
    _tokenStatus = "unknown"
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    relayRef.current!.emit(
      "message",
      makeInnerLine("stranger", {
        type: "pair_request",
        id: "req-stranger",
        token: "test-token",
        device_name: "Stranger",
      }),
    )
    await new Promise((r) => setTimeout(r, 50))

    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const unknownPeerErrs = sent
      .map(decodeSentCt)
      .filter(
        (d) => d.inner.type === "error" && d.inner["code"] === "unknown_peer",
      )
    expect(unknownPeerErrs).toHaveLength(0)

    // Sanity: a pair_error{token_unknown} should have been sent instead.
    const pairErrs = sent
      .map(decodeSentCt)
      .filter((d) => d.inner.type === "pair_error")
    expect(pairErrs).toHaveLength(1)
    expect(pairErrs[0]!.inner).toMatchObject({ code: "token_unknown" })
  })

  test("_onPeerDisconnect: paired → started, listener re-installed", async () => {
    _tokenStatus = "ok"
    const APP_PEER_ID = OWNER_STANDARD_FIXTURE

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_ID, {
        type: "pair_request",
        id: "req-1",
        token: "test-token",
        device_name: "Phone",
      }),
    )
    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })

    _onPeerDisconnect()
    expect(_getState()).toBe("started")

    // Reconnect via a ping (known peer now) → paired again
    relayRef.current!.emit(
      "message",
      makeInnerLine(APP_PEER_ID, {
        type: "ping",
        id: "ping-reconnect",
      }),
    )
    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })
  })
})

// ── Fixture roundtrip ─────────────────────────────────────────────────────────

describe("contract fixtures: pair_*", () => {
  const fixtureDir = fileURLToPath(
    new URL("../../app/Tests/UnBienCoreTests/Fixtures", import.meta.url),
  )

  test("pair_request.jsonl parses into ClientMessage shape", () => {
    const lines = readFileSync(`${fixtureDir}/pair_request.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const obj = JSON.parse(line) as {
        type: string
        id: string
        token: string
        device_name: string
      }
      expect(obj.type).toBe("pair_request")
      expect(typeof obj.id).toBe("string")
      expect(typeof obj.token).toBe("string")
      expect(typeof obj.device_name).toBe("string")
    }
  })

  test("pair_ok.jsonl parses into ServerMessage shape", () => {
    const lines = readFileSync(`${fixtureDir}/pair_ok.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const obj = JSON.parse(line) as {
        type: string
        in_reply_to: string
        session_name: string
      }
      expect(obj.type).toBe("pair_ok")
      expect(typeof obj.in_reply_to).toBe("string")
      expect(typeof obj.session_name).toBe("string")
    }
  })

  test("pair_error.jsonl parses with valid code", () => {
    const lines = readFileSync(`${fixtureDir}/pair_error.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const validCodes = new Set([
      "token_expired",
      "token_consumed",
      "token_unknown",
      "internal_error",
    ])
    for (const line of lines) {
      const obj = JSON.parse(line) as {
        type: string
        in_reply_to: string
        code: string
        message: string
      }
      expect(obj.type).toBe("pair_error")
      expect(validCodes.has(obj.code)).toBe(true)
    }
  })

  test("all 20 fixture files present", () => {
    const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".jsonl"))
    expect(files).toHaveLength(20)
  })
})

// Removed obsolete _state_isIdle helper — tests now check _getState() or
// _hasActivePeerForTest directly. Kept the void below to anchor the new
// `_getActivePeerCountForTest` import so it isn't flagged as unused even
// when only some tests in this file consume it.
void _getActivePeerCountForTest

// ── agent-network mesh delivery ──────────────────────────────────────────────

describe("agent-network mesh delivery", () => {
  test("holds messages until agent_end listeners finish and starts one turn for the batch", async () => {
    const harness = captureEventHarness()
    const sendMessage = vi.fn()
    _setPiForTest({ sendMessage, sendUserMessage: () => undefined })
    harness.handler("agent_start")({ type: "agent_start" })

    _deliverMeshMessageToAgentForTest({
      id: "mesh-message-1",
      from: "/work/repo@reviewer",
      re: null,
      body: { status: "first" },
    })
    _deliverMeshMessageToAgentForTest({
      id: "mesh-message-2",
      from: "/work/repo@worker",
      re: "mesh-message-1",
      body: { status: "second" },
    })
    await Promise.resolve()

    expect(sendMessage).not.toHaveBeenCalled()

    harness.handler("agent_end")({ type: "agent_end" })
    expect(sendMessage).not.toHaveBeenCalled()

    harness.handler("agent_start")({ type: "agent_start" })
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(sendMessage).not.toHaveBeenCalled()

    harness.handler("agent_end")({ type: "agent_end" })
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[0]).toEqual([
      expect.objectContaining({
        customType: "un-bien:mesh-message",
        display: true,
        content: expect.stringContaining("mesh-message-1"),
      }),
      { triggerTurn: false },
    ])
    expect(sendMessage.mock.calls[1]).toEqual([
      expect.objectContaining({
        customType: "un-bien:mesh-message",
        display: true,
        content: expect.stringContaining("mesh-message-2"),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    ])

    harness.handler("agent_end")({ type: "agent_end" })
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  })
})

// ── user_input mirroring (local terminal / RPC) ───────────────────────────────

type AnyEvent = { type: string; [k: string]: unknown }
type EventHandler = (event: AnyEvent, ctx?: unknown) => unknown

function captureEventHandler(eventName: string): EventHandler {
  let captured: EventHandler | undefined
  const pi = {
    on(e: string, h: EventHandler) {
      if (e === eventName) captured = h
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI
  // Shared test process: clear globalThis bridge ownership so THIS pi claims it
  // (root) — the turn-lifecycle handlers gate on the factory's root-session flag,
  // so a non-root capture pi would register handlers that no-op.
  _resetBridgeOwnersForTest()
  ;(extension as ExtensionFactory)(pi)
  if (!captured) throw new Error(`event "${eventName}" handler not registered`)
  return captured
}

function captureEventHarness(): {
  handler: (eventName: string) => EventHandler
  emitBus: (channel: string, data: unknown) => void
  busListenerCount: (channel: string) => number
} {
  const handlers = new Map<string, EventHandler>()
  const busHandlers = new Map<string, Array<(data: unknown) => void>>()
  const pi = {
    on(e: string, h: EventHandler) {
      handlers.set(e, h)
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of busHandlers.get(channel) ?? []) h(data)
      },
      on(channel: string, h: (data: unknown) => void) {
        const list = busHandlers.get(channel) ?? []
        list.push(h)
        busHandlers.set(channel, list)
        return () => {
          const current = busHandlers.get(channel) ?? []
          busHandlers.set(
            channel,
            current.filter((item) => item !== h),
          )
        }
      },
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI
  // Shared test process: clear globalThis bridge ownership so THIS harness's pi
  // claims it (root) and its bridges are built, rather than skipping because an
  // earlier test's pi still owns the slot.
  _resetBridgeOwnersForTest()
  ;(extension as ExtensionFactory)(pi)
  return {
    handler(eventName: string) {
      const h = handlers.get(eventName)
      if (!h) throw new Error(`event "${eventName}" handler not registered`)
      return h
    },
    emitBus(channel: string, data: unknown) {
      ;(
        pi.events as unknown as {
          emit: (channel: string, data: unknown) => void
        }
      ).emit(channel, data)
    },
    busListenerCount(channel: string) {
      return busHandlers.get(channel)?.length ?? 0
    },
  }
}

function captureMessageRenderer(): {
  getRenderer(): (
    message: { details?: unknown },
    options: unknown,
    theme: unknown,
  ) => unknown
} {
  let renderer:
    | ((
        message: { details?: unknown },
        options: unknown,
        theme: unknown,
      ) => unknown)
    | undefined
  const pi = {
    on() {
      /* no-op */
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer(type: string, callback: unknown) {
      if (type === "un-bien:received-image") {
        renderer = callback as (
          message: { details?: unknown },
          options: unknown,
          theme: unknown,
        ) => unknown
      }
    },
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI
  ;(extension as ExtensionFactory)(pi)
  if (!renderer) throw new Error("custom image renderer not registered")
  return {
    getRenderer(): (
      message: { details?: unknown },
      options: unknown,
      theme: unknown,
    ) => unknown {
      if (!renderer) throw new Error("custom image renderer not registered")
      return renderer
    },
  }
}

async function _pairForTest(appPeerId: string): Promise<void> {
  captureHandler("unbien")
  await _connectForTest(makeMockCtx())
  relayRef.current!.emit(
    "message",
    JSON.stringify({
      peer: appPeerId,
      ct: Buffer.from(
        JSON.stringify({
          type: "pair_request",
          id: "req-1",
          token: "test-token",
          device_name: "Phone",
        }),
      ).toString("base64"),
    }),
  )
  await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 })
}

/** Adds a second pair_request from a new peer to an already-running Pi.
 *  Used by multi-channel tests to verify the catch-22 is gone. */
async function _pairAdditionalForTest(
  appPeerId: string,
  deviceName: string,
): Promise<void> {
  relayRef.current!.emit(
    "message",
    JSON.stringify({
      peer: appPeerId,
      ct: Buffer.from(
        JSON.stringify({
          type: "pair_request",
          id: `req-${appPeerId.slice(0, 6)}`,
          token: "test-token",
          device_name: deviceName,
        }),
      ).toString("base64"),
    }),
  )
  await vi.waitFor(() => expect(_hasActivePeerForTest(appPeerId)).toBe(true), {
    timeout: 2000,
  })
}

async function _pairForTestWithCtx(
  appPeerId: string,
  connectCtx: {
    ui: { notify: ReturnType<typeof vi.fn> }
    cwd?: string
    abort?: ReturnType<typeof vi.fn>
  },
): Promise<void> {
  captureHandler("unbien")
  await _connectForTest(connectCtx)
  relayRef.current!.emit(
    "message",
    JSON.stringify({
      peer: appPeerId,
      ct: Buffer.from(
        JSON.stringify({
          type: "pair_request",
          id: "req-1",
          token: "test-token",
          device_name: "Phone",
        }),
      ).toString("base64"),
    }),
  )
  await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 })
}

// ── Multi-channel (plan/24 W2D) ──────────────────────────────────────────────
//
// These tests pin down the new contract: N owners can be connected at the
// same time; broadcast events (agent_chunk, tool_*) fan out; per-request
// replies (session_history, cancelled, pong) go back only to the sender;
// revoking or disconnecting one owner doesn't affect the others.

describe("multi-channel broadcast (W2D)", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("two owners pair simultaneously → both attach (catch-22 fixed)", async () => {
    await _pairForTest("ownerA__1234567890")
    await _pairAdditionalForTest("ownerB__abcdefghij", "Android")
    expect(_getActivePeerCountForTest()).toBe(2)
    expect(_hasActivePeerForTest("ownerA__1234567890")).toBe(true)
    expect(_hasActivePeerForTest("ownerB__abcdefghij")).toBe(true)
  })

  test("/unbien pair without config (idle, first-time) → warns + no QR", async () => {
    // Isolated empty cwd → no local config on every OS, so we expect the
    // focused first-time message instead of an auto-bootstrap. (Fresh tmpdir —
    // see the "pair without start" test for the cross-platform rationale.)
    expect(_getState()).toBe("idle")
    const cwd = mkdtempSync(join(tmpdir(), "pi-ext-cwd-"))
    const pair = captureHandler("unbien pair")
    const ctx = makeMockCtx(cwd)
    await pair("", ctx)

    const calls = ctx.ui.notify.mock.calls.map((c) => c[0] as string)
    expect(calls.some((m) => m.includes("First-time setup needed"))).toBe(true)
    expect(calls.every((m) => !m.includes("QR ready"))).toBe(true)
    rmSync(cwd, { recursive: true, force: true })
  })

  test("/unbien pair generates QR even when an owner is already attached", async () => {
    await _pairForTest("ownerA__1234567890")
    expect(_getActivePeerCountForTest()).toBe(1)

    // QR generation must succeed (no "Already paired" rejection).
    const pair = captureHandler("unbien pair")
    const ctx = makeMockCtx()
    await pair("", ctx)

    // Should have notified about a QR being ready, not warned about
    // an existing pairing.
    const calls = ctx.ui.notify.mock.calls.map((c) => c[0] as string)
    expect(calls.some((m) => m.includes("QR ready"))).toBe(true)
    expect(calls.every((m) => !m.includes("Already paired"))).toBe(true)
  })

  test("session_sync from owner A → sync reply (terminator) only to A", async () => {
    await _pairForTest("ownerA__1234567890")
    await _pairAdditionalForTest("ownerB__abcdefghij", "Android")
    const sendsBefore = relayRef.current!.send.mock.calls.length

    // Owner A asks for history.
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            ub: { type: "session_sync", id: "sync-1", limit: 50 },
          }),
        ).toString("base64"),
      }),
    )
    // Let the handler run.
    await new Promise<void>((r) => setImmediate(r))

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
    // The sync reply is per-sender: the terminator lands on A's wire only.
    // (Caps now ride the `hello` handshake, not the sync reply.)
    const ends = sent.filter(
      (d) =>
        (d.inner["ub"] as Record<string, unknown> | undefined)?.["type"] ===
        "session_sync_end",
    )
    expect(ends).toHaveLength(1)
    expect(ends[0]!.peer).toBe("ownerA__1234567890")
  })

  test("revoke of owner A → A's channel closed, B keeps running", async () => {
    await _pairForTest(OWNER_STANDARD_FIXTURE)
    await _pairAdditionalForTest(OTHER_OWNER_STANDARD_FIXTURE, "Android")

    const revoke = captureHandler("unbien revoke")
    await revoke(OWNER_STANDARD_FIXTURE.slice(0, 8), makeMockCtx())

    expect(_hasActivePeerForTest(OWNER_STANDARD_FIXTURE)).toBe(false)
    expect(_hasActivePeerForTest(OTHER_OWNER_STANDARD_FIXTURE)).toBe(true)
    expect(_getState()).toBe("paired") // derived: at least one owner still on
  })

  // ── Source-of-truth fan-out (plan/24 W2D) ──────────────────────────────────
  //
  // The user's own bubble now renders from the extension forwarding pi's
  // message_end/message_start events as {rpc} envelopes (the stock echo is
  // gone). _broadcastEnvelope must fan every such frame out to EVERY attached
  // peer, so each paired device's session view stays bit-identical.
  test("extension-forwarded message_end envelope reaches both owner A and owner B", async () => {
    await _pairForTest("ownerA__1234567890")
    await _pairAdditionalForTest("ownerB__abcdefghij", "Android")
    const sendsBefore = relayRef.current!.send.mock.calls.length

    // The extension forwards pi's message_end as a {rpc} envelope via the producer.
    const onMsgEnd = captureEventHandler("message_end")
    onMsgEnd({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "oi" }] },
    })

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
    const ends = sent.filter(
      (d) =>
        (d.inner["rpc"] as Record<string, unknown> | undefined)?.["type"] ===
        "message_end",
    )
    // One frame per attached owner, both recipients present.
    const recipients = new Set(ends.map((d) => d.peer))
    expect(recipients).toEqual(
      new Set(["ownerA__1234567890", "ownerB__abcdefghij"]),
    )
  })

  test("plan/30: user_message with an image → save preview + send metadata-only custom message", async () => {
    await _pairForTest("ownerA__1234567890")
    // Override _pi with a spy to capture the multimodal content sent to the SDK.
    const sentToAgent: unknown[] = []
    const sentMessages: unknown[][] = []
    const timeline: string[] = []
    const messageId = "msg with spaces/and##symbols"
    _setPiForTest({
      sendUserMessage: (c: unknown) => {
        timeline.push("agent")
        sentToAgent.push(c)
      },
      sendMessage: (...messageArgs: unknown[]) => {
        timeline.push("preview")
        sentMessages.push(messageArgs)
      },
    })
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: messageId,
              message: "what is this?",
              images: [{ data: "QUJD", mime: "image/png" }],
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    // Preview is appended before SDK handoff so it cannot steer this turn.
    expect(timeline).toEqual(["preview", "agent"])
    expect(sentToAgent).toHaveLength(1)
    expect(sentToAgent[0]).toEqual([
      { type: "image", data: "QUJD", mimeType: "image/png" },
      { type: "text", text: "what is this?" },
    ])

    const previewCall = sentMessages.find((message) => {
      const current = message[0] as { customType?: unknown }
      return current.customType === "un-bien:received-image"
    })
    const preview = previewCall?.[0] as
      | {
          content?: string
          display?: boolean
          details?: {
            messageId?: string
            mime?: string
            path?: string
            size?: number
            index?: number
            text?: string
            error?: string
            reason?: string
          }
        }
      | undefined
    expect(preview).toBeDefined()
    expect(previewCall?.[1]).toBeUndefined()
    expect(preview?.content).toBe("")
    expect(preview?.display).toBe(true)
    expect(preview?.details).toMatchObject({
      messageId,
      index: 0,
      mime: "image/png",
      size: 3,
      text: "what is this?",
    })
    expect(preview?.details).not.toHaveProperty("data")
    expect(preview?.details?.error).toBeUndefined()
    expect(preview?.details?.reason).toBeUndefined()

    const expectedBasename = "msg-with-spaces-and-symbols-0.png"
    expect(preview?.details?.path).toContain(tmpdir())
    expect(preview?.details?.path).toContain("pi-app-")
    expect(readFileSync(preview!.details!.path!, "utf8")).toBe("ABC")
    expect(basename(preview?.details?.path ?? "")).toBe(expectedBasename)
    if (preview?.details?.path && process.platform !== "win32") {
      const st = statSync(preview.details.path)
      expect(st.mode & 0o777).toBe(0o600)
      const stDir = statSync(dirname(preview.details.path))
      expect(stDir.mode & 0o777).toBe(0o700)
    }
  })

  test("JPEG user_message generates optional private PNG preview when converter is available", async () => {
    _convertToPngMock.mockResolvedValueOnce({
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    })

    await _pairForTest("ownerA__1234567890")
    const sentMessages: unknown[][] = []
    _setPiForTest({
      sendUserMessage: () => undefined,
      sendMessage: (...messageArgs: unknown[]) => {
        sentMessages.push(messageArgs)
      },
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "jpeg-msg",
              message: "jpeg caption",
              images: [{ data: "QUJD", mime: "image/jpeg" }],
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    const previewCall = sentMessages.find((message) => {
      const current = message[0] as { customType?: unknown }
      return current.customType === "un-bien:received-image"
    })
    const preview = previewCall?.[0] as
      { details?: { path?: string; previewPath?: string } } | undefined
    const previewPath = preview?.details?.previewPath
    expect(preview?.details?.path).toContain("jpeg-msg-0.jpg")
    expect(previewPath).toContain("jpeg-msg-0.preview.png")
    expect(readFileSync(previewPath!)).toEqual(
      Buffer.from("89504e470d0a1a0a", "hex"),
    )
    if (process.platform !== "win32") {
      expect(statSync(previewPath!).mode & 0o777).toBe(0o600)
    }
  })

  test("converted preview output over 10 MiB falls back to saved original only", async () => {
    _convertToPngMock.mockResolvedValueOnce({
      data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      mimeType: "image/png",
    })

    await _pairForTest("ownerA__1234567890")
    const sentMessages: unknown[][] = []
    _setPiForTest({
      sendUserMessage: () => undefined,
      sendMessage: (...messageArgs: unknown[]) => {
        sentMessages.push(messageArgs)
      },
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "jpeg-big-preview",
              message: "jpeg caption",
              images: [{ data: "QUJD", mime: "image/jpeg" }],
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    const previewCall = sentMessages.find((message) => {
      const current = message[0] as { customType?: unknown }
      return current.customType === "un-bien:received-image"
    })
    const preview = previewCall?.[0] as
      { details?: { path?: string; previewPath?: string } } | undefined
    expect(preview?.details?.path).toContain("jpeg-big-preview-0.jpg")
    expect(preview?.details?.previewPath).toBeUndefined()
  })

  test("active image steering defers local preview until agent_end", async () => {
    await _pairForTest("ownerA__1234567890")
    const onInput = captureEventHandler("input")
    const onAgentEnd = captureEventHandler("agent_end")
    onInput({ type: "input", text: "already running", source: "interactive" })

    const sentToAgent: unknown[] = []
    const sentMessages: unknown[][] = []
    _setPiForTest({
      sendUserMessage: (content: unknown) => {
        sentToAgent.push(content)
      },
      sendMessage: (...messageArgs: unknown[]) => {
        sentMessages.push(messageArgs)
      },
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "steer-image",
              message: "extra photo",
              streamingBehavior: "steer",
              images: [{ data: "QUJD", mime: "image/png" }],
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    expect(sentToAgent).toHaveLength(1)
    expect(sentMessages).toHaveLength(0)

    onAgentEnd({ type: "agent_end", messages: [] })
    expect(sentMessages).toHaveLength(1)
    expect((sentMessages[0][0] as { customType?: unknown }).customType).toBe(
      "un-bien:received-image",
    )
  })

  test("slow idle JPEG conversion defers preview if another turn starts first", async () => {
    let resolveConversion:
      ((value: { data: string; mimeType: string }) => void) | undefined
    _convertToPngMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConversion = resolve
      }),
    )

    await _pairForTest("ownerA__1234567890")
    const onInput = captureEventHandler("input")
    const onAgentEnd = captureEventHandler("agent_end")
    const sentMessages: unknown[][] = []
    _setPiForTest({
      sendUserMessage: () => undefined,
      sendMessage: (...messageArgs: unknown[]) => {
        sentMessages.push(messageArgs)
      },
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "slow-jpeg",
              message: "slow photo",
              images: [{ data: "QUJD", mime: "image/jpeg" }],
            },
          }),
        ).toString("base64"),
      }),
    )
    await vi.waitFor(() => expect(_convertToPngMock).toHaveBeenCalled())

    onInput({
      type: "input",
      text: "overtaking local turn",
      source: "interactive",
    })
    resolveConversion?.({ data: "iVBORw0KGgo=", mimeType: "image/png" })
    await new Promise<void>((r) => setImmediate(r))

    expect(sentMessages).toHaveLength(0)

    onAgentEnd({ type: "agent_end", messages: [] })
    expect(sentMessages).toHaveLength(1)
    expect((sentMessages[0][0] as { customType?: unknown }).customType).toBe(
      "un-bien:received-image",
    )
  })

  test("received-image preview messages are filtered out of provider and compaction context", () => {
    const previewMessage = {
      role: "custom",
      customType: "un-bien:received-image",
      content: "",
      display: true,
      details: { path: "/tmp/photo.png" },
    }
    const keepCustom = {
      role: "custom",
      customType: "un-bien:mesh-message",
      content: "keep",
      display: true,
    }
    const keepUser = { role: "user", content: "hello" }

    const onContext = captureEventHandler("context")
    const result = onContext({
      type: "context",
      messages: [keepCustom, previewMessage, keepUser],
    }) as { messages?: unknown[] }
    expect(result.messages).toEqual([keepCustom, keepUser])

    const onBeforeCompact = captureEventHandler("session_before_compact")
    const preparation = {
      messagesToSummarize: [previewMessage, keepUser],
      turnPrefixMessages: [keepCustom, previewMessage],
    }
    onBeforeCompact({
      type: "session_before_compact",
      preparation,
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    })
    expect(preparation.messagesToSummarize).toEqual([keepUser])
    expect(preparation.turnPrefixMessages).toEqual([keepCustom])
  })

  test("pure-data (display:false) un-bien events are filtered out of provider and compaction context", () => {
    // Issue #105: display:false only hides from the TUI; the entry still enters
    // the LLM context, so relay flaps / name collisions were replayed to the
    // model on every call.
    const relayState = {
      role: "custom",
      customType: "un-bien:relay-state",
      content: "Relay connected",
      display: false,
    }
    const nameAssigned = {
      role: "custom",
      customType: "un-bien:name-assigned",
      content: "Mesh name reassigned",
      display: false,
    }
    const paired = {
      role: "custom",
      customType: "un-bien:paired",
      content: "Paired with Phone",
      display: false,
    }
    const keepCustom = {
      role: "custom",
      customType: "un-bien:mesh-message",
      content: "keep",
      display: true,
    }
    const keepForeign = {
      role: "custom",
      customType: "other-ext:data",
      content: "keep",
      display: false,
    }
    const keepUser = { role: "user", content: "hello" }

    const onContext = captureEventHandler("context")
    const result = onContext({
      type: "context",
      messages: [
        relayState,
        keepCustom,
        nameAssigned,
        keepForeign,
        paired,
        keepUser,
      ],
    }) as { messages?: unknown[] }
    expect(result.messages).toEqual([keepCustom, keepForeign, keepUser])

    const onBeforeCompact = captureEventHandler("session_before_compact")
    const preparation = {
      messagesToSummarize: [relayState, keepUser],
      turnPrefixMessages: [paired, keepCustom],
    }
    onBeforeCompact({
      type: "session_before_compact",
      preparation,
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    })
    expect(preparation.messagesToSummarize).toEqual([keepUser])
    expect(preparation.turnPrefixMessages).toEqual([keepCustom])
  })

  test("registers and uses un-bien image renderer with Saved fallback", () => {
    const { getRenderer } = captureMessageRenderer()
    const theme = {
      fg: (token: string, text: string) => `${token}:${text}`,
      bg: (token: string, text: string) => `${token}:${text}`,
    }
    const dir = mkdtempSync(join(tmpdir(), "pi-ext-render-missing-"))
    const message = {
      customType: "un-bien:received-image",
      content: "",
      display: true,
      details: {
        messageId: "msg-missing",
        index: 2,
        path: join(dir, "missing.png"),
        mime: "image/png",
        size: 123,
        error: "missing file",
        reason: "not present on disk",
      },
    }
    const renderer = getRenderer()
    const component = renderer(message, { expanded: false }, theme)
    const rendered = (component as { render: (width: number) => string[] })
      .render(120)
      .join("\n")
    expect(rendered).toContain("📷 Photo from Android (msg-missing #2)")
    expect(rendered).toContain("Saved: ")
    expect(rendered).toContain(message.details.path)
    expect(rendered).toContain("Error: missing file")
    rmSync(dir, { recursive: true, force: true })
  })

  test("renders JPEG inline when previewPath points to generated PNG", () => {
    const { getRenderer } = captureMessageRenderer()
    const theme = {
      fg: (token: string, text: string) => `${token}:${text}`,
      bg: (token: string, text: string) => `${token}:${text}`,
    }
    const dir = mkdtempSync(join(tmpdir(), "pi-ext-render-jpeg-preview-"))
    const imagePath = join(dir, "photo.jpg")
    const previewPath = join(dir, "photo.preview.png")

    writeFileSync(
      imagePath,
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x49, 0x46]),
    )
    writeFileSync(
      previewPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )

    const prevCaps = getCapabilities()
    const message = {
      customType: "un-bien:received-image",
      content: "",
      display: true,
      details: {
        messageId: "msg-jpeg-preview",
        index: 2,
        path: imagePath,
        previewPath,
        mime: "image/jpeg",
        size: 10,
      },
    }
    setCapabilities({ ...prevCaps, images: "kitty" as const })

    try {
      const renderer = getRenderer()
      const component = renderer(message, { expanded: false }, theme)
      const renderedLines = (
        component as { render: (width: number) => string[] }
      ).render(120)
      const rendered = renderedLines.join("\n")
      const imageLineIndex = renderedLines.findIndex((line) =>
        line.includes("\x1b_G"),
      )
      expect(rendered).toContain("📷 Photo from Android (msg-jpeg-preview #2)")
      expect(imageLineIndex).toBeGreaterThanOrEqual(0)
      expect(
        renderedLines.slice(imageLineIndex + 1).some((line) => line === ""),
      ).toBe(true)
      expect(rendered).toContain(imagePath)
    } finally {
      setCapabilities(prevCaps)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("plan/43: active steering calls sendUserMessage(deliverAs='steer')", async () => {
    await _pairForTest("ownerA__1234567890")
    const onInput = captureEventHandler("input")
    onInput({ type: "input", text: "primary", source: "interactive" })
    await new Promise<void>((r) => setImmediate(r))

    const sendUserMessage = vi.fn()
    _setPiForTest({
      sendUserMessage,
      sendMessage: () => undefined,
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "msg-steer",
              message: "refine this",
              streamingBehavior: "steer",
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    expect(sendUserMessage).toHaveBeenCalledTimes(1)
    expect(sendUserMessage).toHaveBeenCalledWith("refine this", {
      deliverAs: "steer",
    })
  })

  test("plan/43: steering without a known turn id still reaches SDK as steer", async () => {
    await _pairForTest("ownerA__1234567890")
    expect(_getCurrentTurnIdForTest()).toBeNull()
    const sendUserMessage = vi.fn()
    _setPiForTest({
      sendUserMessage,
      sendMessage: () => undefined,
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "msg-stale-steer",
              message: "refine while stale",
              streamingBehavior: "steer",
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    expect(sendUserMessage).toHaveBeenCalledTimes(1)
    expect(sendUserMessage).toHaveBeenCalledWith("refine while stale", {
      deliverAs: "steer",
    })
    expect(_getCurrentTurnIdForTest()).toBe("msg-stale-steer")
  })

  test("plan/43: busy app message without wire behavior is defensively steered", async () => {
    await _pairForTest("ownerA__1234567890")
    const onTurnStart = captureEventHandler("turn_start")
    onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 0 })
    expect(_getCurrentTurnIdForTest()).toBeNull()
    const sendUserMessage = vi.fn()
    // No wire behavior: rely on the handler's mechanical steer-when-streaming
    // net (pi.isStreaming), not extension-side steer inference.
    _setPiForTest({
      sendUserMessage,
      sendMessage: () => undefined,
      isStreaming: true,
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "msg-busy-no-mode",
              message: "late correction",
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    expect(sendUserMessage).toHaveBeenCalledTimes(1)
    expect(sendUserMessage).toHaveBeenCalledWith("late correction", {
      deliverAs: "steer",
    })
    expect(_getCurrentTurnIdForTest()).toBe("msg-busy-no-mode")
  })

  // The rpc `prompt` handler is the path the APP actually uses
  // (mapToWire -> {rpc:{type:"prompt", streamingBehavior}}). Per design
  // 01M14T6J5W it PASSES the app's verb straight to pi's deliverAs (no extension
  // steer inference), so a busy followUp queues instead of steering.
  function emitRpcPrompt(peer: string, frame: Record<string, unknown>): void {
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer,
        ct: Buffer.from(
          JSON.stringify({ rpc: { type: "prompt", ...frame } }),
        ).toString("base64"),
      }),
    )
  }

  test("rpc prompt: busy followUp is delivered as followUp (not steered)", async () => {
    await _pairForTest("ownerA__1234567890")
    const sendUserMessage = vi.fn()
    _setPiForTest({
      sendUserMessage,
      sendMessage: () => undefined,
      isStreaming: true,
    })
    emitRpcPrompt("ownerA__1234567890", {
      id: "q1",
      message: "after you're done",
      streamingBehavior: "followUp",
    })
    await new Promise<void>((r) => setImmediate(r))
    expect(sendUserMessage).toHaveBeenCalledWith("after you're done", {
      deliverAs: "followUp",
    })
  })

  test("rpc prompt: busy steer is delivered as steer", async () => {
    await _pairForTest("ownerA__1234567890")
    const sendUserMessage = vi.fn()
    _setPiForTest({
      sendUserMessage,
      sendMessage: () => undefined,
      isStreaming: true,
    })
    emitRpcPrompt("ownerA__1234567890", {
      id: "q2",
      message: "refine now",
      streamingBehavior: "steer",
    })
    await new Promise<void>((r) => setImmediate(r))
    expect(sendUserMessage).toHaveBeenCalledWith("refine now", {
      deliverAs: "steer",
    })
  })

  test("rpc prompt: busy send with NO behavior defensively steers (mechanical net)", async () => {
    await _pairForTest("ownerA__1234567890")
    const sendUserMessage = vi.fn()
    _setPiForTest({
      sendUserMessage,
      sendMessage: () => undefined,
      isStreaming: true,
    })
    emitRpcPrompt("ownerA__1234567890", { id: "q3", message: "oops racing" })
    await new Promise<void>((r) => setImmediate(r))
    expect(sendUserMessage).toHaveBeenCalledWith("oops racing", {
      deliverAs: "steer",
    })
  })

  test("rpc prompt: IDLE send runs fresh (deliverAs undefined, behavior ignored)", async () => {
    await _pairForTest("ownerA__1234567890")
    const sendUserMessage = vi.fn()
    _setPiForTest({
      sendUserMessage,
      sendMessage: () => undefined,
      isStreaming: false,
    })
    emitRpcPrompt("ownerA__1234567890", {
      id: "q4",
      message: "hello",
      streamingBehavior: "steer",
    })
    await new Promise<void>((r) => setImmediate(r))
    // idle: extension forwards the app's behavior; pi's prompt() ignores it and runs
    // fresh. The extension does not fabricate a deliverAs when idle.
    expect(sendUserMessage).toHaveBeenCalledWith("hello", {
      deliverAs: "steer",
    })
  })

  test("plan/43: steering sendUserMessage throw returns correlated error and no echo", async () => {
    await _pairForTest("ownerA__1234567890")
    const onInput = captureEventHandler("input")
    onInput({ type: "input", text: "primary", source: "interactive" })
    await new Promise<void>((r) => setImmediate(r))
    const priorTurn = _getCurrentTurnIdForTest()
    expect(priorTurn).toMatch(/^local_/)

    _setPiForTest({
      sendUserMessage: vi.fn(() => {
        throw new Error("steer rejected")
      }),
      sendMessage: () => undefined,
    })
    const sendsBefore = relayRef.current!.send.mock.calls.length

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            rpc: {
              type: "prompt",
              id: "msg-steer-fail",
              message: "bad steer",
              streamingBehavior: "steer",
            },
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    expect(_getCurrentTurnIdForTest()).toBe(priorTurn)
    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
    // The stock echo is gone, so there is trivially no outbound user_message.
    expect(sent.some((d) => d.inner.type === "user_message")).toBe(false)
    // The correlated failure now rides an rpc error RESPONSE to the sender.
    const error = sent.find(
      (d) =>
        (d.inner["rpc"] as Record<string, unknown> | undefined)?.["type"] ===
        "response",
    )
    expect(error?.inner["rpc"]).toMatchObject({
      type: "response",
      command: "prompt",
      success: false,
      id: "msg-steer-fail",
    })
    expect(
      (error?.inner["rpc"] as { error?: string } | undefined)?.error,
    ).toContain("steer rejected")
  })

  test("plan/43: steering does not overwrite current turn id", async () => {
    await _pairForTest("ownerA__1234567890")
    // Seed by terminal input (local user turn) so _currentTurnId exists.
    const onInput = captureEventHandler("input")
    onInput({ type: "input", text: "primary", source: "interactive" })

    // Wait for async input handler effects.
    await new Promise<void>((r) => setImmediate(r))
    expect(_getCurrentTurnIdForTest()).toMatch(/^local_/)
    const priorTurn = _getCurrentTurnIdForTest()
    expect(priorTurn).toBeTruthy()

    _setPiForTest({
      sendUserMessage: () => undefined,
      sendMessage: () => undefined,
    })

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "ownerA__1234567890",
        ct: Buffer.from(
          JSON.stringify({
            type: "user_message",
            id: "msg-steer",
            text: "steer this",
            streaming_behavior: "steer",
          }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    expect(_getCurrentTurnIdForTest()).toBe(priorTurn)
  })

  test("normal assistant turn (stopReason:stop) → no error forwarded", async () => {
    await _pairForTest("ownerA__1234567890")
    const onMsgEnd = captureEventHandler("message_end")
    const sendsBefore = relayRef.current!.send.mock.calls.length

    onMsgEnd({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      },
    })

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
    expect(sent.some((d) => d.inner.type === "error")).toBe(false)
  })
})

describe("routeClientMessage cancel handling", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Reset the globalThis root-session slot so this describe's activation
    // re-claims root and sets `_pi` (it now binds only to the root session).
    _resetBridgeOwnersForTest()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-cancel-reset",
    } as ReturnType<typeof makeMockCtx>)
  })

  test("cancel uses freshest session_start ctx and ignores stale _lastCtx abort", async () => {
    const staleAbort = vi.fn()
    const freshAbort = vi.fn()

    await _pairForTestWithCtx("owner-cancel-1", {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-cancel-stale",
    })

    const status = captureHandler("unbien status")
    await status("", {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-cancel-stale",
      abort: staleAbort,
    })

    const onSessionStart = captureEventHandler("session_start")
    onSessionStart({ type: "session_start" }, {
      abort: freshAbort,
      compact: vi.fn(),
    } as unknown as {
      abort: ReturnType<typeof vi.fn>
      compact: ReturnType<typeof vi.fn>
    })

    const sendsBefore = relayRef.current!.send.mock.calls.length
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "owner-cancel-1",
        ct: Buffer.from(
          JSON.stringify({
            type: "cancel",
            id: "cancel-stale",
            target_id: "msg-stale",
          }),
        ).toString("base64"),
      }),
    )

    await new Promise<void>((r) => setImmediate(r))

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
      .filter((d) => d.peer === "owner-cancel-1")
    // No stock `cancelled` frame is emitted (dropped in the envelope purge) —
    // the app sees the turn end via the envelope turn_end/agent_settled. The
    // abort routing (fresh ctx, not stale) is what this test guards.
    const cancelled = sent.filter((d) => d.inner.type === "cancelled")
    expect(cancelled).toHaveLength(0)
    expect(staleAbort).not.toHaveBeenCalled()
    expect(freshAbort).toHaveBeenCalledTimes(1)
  })

  test("owner reconnect after session replacement does not throw on stale _lastCtx.ui (#55)", async () => {
    // Regression: _refreshFooter/_attachOwner used captured _lastCtx.ui; after
    // session replacement the SDK ui getter throws via assertActive and the
    // uncaught exception killed the whole pi process on peer reconnect.
    const freshNotify = vi.fn()
    const freshSetStatus = vi.fn()
    const freshSetTitle = vi.fn()

    const owner = OWNER_STANDARD_FIXTURE
    await _pairForTestWithCtx(owner, {
      ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
      cwd: "/tmp/unbien-stale-ui",
    } as Parameters<typeof _pairForTestWithCtx>[1])

    // Plant a command ctx whose ui GETTER throws (real SDK stale-ctx behaviour).
    // The status handler assigns _lastCtx = ctx before touching ui.
    const status = captureHandler("unbien status")
    const staleCtx = {
      cwd: "/tmp/unbien-stale-ui",
      get ui() {
        throw new Error(
          "This extension ctx is stale after session replacement or reload.",
        )
      },
    }
    await expect(
      status("", staleCtx as unknown as ReturnType<typeof makeMockCtx>),
    ).rejects.toThrow(/stale/)

    // Rebind the always-fresh session_start ctx (module-reuse path after /new).
    const onSessionStart = captureEventHandler("session_start")
    onSessionStart({ type: "session_start" }, {
      abort: vi.fn(),
      compact: vi.fn(),
      ui: {
        notify: freshNotify,
        setStatus: freshSetStatus,
        setTitle: freshSetTitle,
      },
    } as unknown as {
      abort: ReturnType<typeof vi.fn>
      compact: ReturnType<typeof vi.fn>
      ui: {
        notify: ReturnType<typeof vi.fn>
        setStatus: ReturnType<typeof vi.fn>
        setTitle: ReturnType<typeof vi.fn>
      }
    })

    // Drop the owner, then reconnect via the known-peer auto-listener path
    // (the exact stack in the bug: onMsg → _attachOwner → _refreshFooter).
    _onPeerDisconnect(owner)
    expect(_hasActivePeerForTest(owner)).toBe(false)

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: owner,
        ct: Buffer.from(
          JSON.stringify({ type: "ping", id: "ping-stale-ui" }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    expect(_hasActivePeerForTest(owner)).toBe(true)
    // Footer refresh preferred the fresh session_start ui, not the throwing one.
    expect(freshSetStatus).toHaveBeenCalled()
    expect(freshNotify).toHaveBeenCalled()
  })

  test("cancel is handled before the strict pi binding guard", async () => {
    const freshAbort = vi.fn()

    await _pairForTestWithCtx("owner-cancel-nopi", {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-cancel-nopi",
    })

    const onSessionStart = captureEventHandler("session_start")
    onSessionStart({ type: "session_start" }, {
      abort: freshAbort,
      compact: vi.fn(),
    } as unknown as {
      abort: ReturnType<typeof vi.fn>
      compact: ReturnType<typeof vi.fn>
    })
    _setPiForTest(null)

    const sendsBefore = relayRef.current!.send.mock.calls.length
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "owner-cancel-nopi",
        ct: Buffer.from(
          JSON.stringify({
            type: "cancel",
            id: "cancel-nopi",
            target_id: "msg-nopi",
          }),
        ).toString("base64"),
      }),
    )

    await new Promise<void>((r) => setImmediate(r))

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
      .filter((d) => d.peer === "owner-cancel-nopi")
    // No stock `cancelled` frame (dropped in the envelope purge); the abort
    // still runs ahead of the strict pi-binding guard, which is the point here.
    const cancelled = sent.filter((d) => d.inner.type === "cancelled")
    expect(cancelled).toHaveLength(0)
    expect(freshAbort).toHaveBeenCalledTimes(1)
  })

  test("cancel with no real abort context returns error and does not send cancelled", async () => {
    await _pairForTestWithCtx("owner-cancel-2", {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-cancel-nonreal",
      // Intentionally omit abort: the router must not claim success.
    } as unknown as { ui: { notify: ReturnType<typeof vi.fn> }; cwd: string })

    const onSessionStart = captureEventHandler("session_start")
    onSessionStart({ type: "session_start" }, {
      compact: vi.fn(),
    } as unknown as {
      compact: ReturnType<typeof vi.fn>
    })

    const sendsBefore = relayRef.current!.send.mock.calls.length
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "owner-cancel-2",
        ct: Buffer.from(
          JSON.stringify({
            type: "cancel",
            id: "cancel-nonreal",
            target_id: "msg-nonreal",
          }),
        ).toString("base64"),
      }),
    )

    await new Promise<void>((r) => setImmediate(r))

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
      .filter((d) => d.peer === "owner-cancel-2")
    const errors = sent.filter((d) => d.inner.type === "error")
    const cancelled = sent.filter((d) => d.inner.type === "cancelled")
    expect(errors).toHaveLength(1)
    expect(errors[0]!.inner).toMatchObject({
      type: "error",
      in_reply_to: "cancel-nonreal",
      code: "internal_error",
    })
    expect(cancelled).toHaveLength(0)
  })

  test("abort throw sends error, and the router still handles a later ping", async () => {
    const aborting = vi.fn(() => {
      throw new Error("abort boom")
    })

    await _pairForTestWithCtx("owner-cancel-3", {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-cancel-throw",
      abort: aborting,
    })

    const onSessionStart = captureEventHandler("session_start")
    onSessionStart({ type: "session_start" }, {
      abort: aborting,
      compact: vi.fn(),
    } as unknown as {
      abort: ReturnType<typeof vi.fn>
      compact: ReturnType<typeof vi.fn>
    })

    const sendsBefore = relayRef.current!.send.mock.calls.length
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "owner-cancel-3",
        ct: Buffer.from(
          JSON.stringify({
            type: "cancel",
            id: "cancel-throw",
            target_id: "msg-throw",
          }),
        ).toString("base64"),
      }),
    )

    await new Promise<void>((r) => setImmediate(r))

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "owner-cancel-3",
        ct: Buffer.from(
          JSON.stringify({ type: "ping", id: "ping-after-cancel" }),
        ).toString("base64"),
      }),
    )
    await new Promise<void>((r) => setImmediate(r))

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
      .map(decodeSentCt)
      .filter((d) => d.peer === "owner-cancel-3")

    const errors = sent.filter((d) => d.inner.type === "error")
    const pongs = sent.filter((d) => d.inner.type === "pong")

    expect(aborting).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.inner).toMatchObject({
      type: "error",
      in_reply_to: "cancel-throw",
      code: "internal_error",
    })
    expect(pongs).toHaveLength(1)
    expect(pongs[0]!.inner).toMatchObject({
      type: "pong",
      in_reply_to: "ping-after-cancel",
    })
  })
})

// ── QR no longer carries `r` (relay URL) ──────────────────────────────────────

describe("QR payload (no r field, with rm)", () => {
  test("buildQRUri produces URI with t + epk + n (no r)", async () => {
    const { buildQRUri } = await import("./pairing/qr.js")
    const epk = Buffer.alloc(32, 0x42)
    const uri = buildQRUri("token-abc", epk, "feature/x")
    expect(uri.startsWith("unbien://pair?")).toBe(true)
    const url = new URL(uri.replace("unbien:", "https:"))
    expect(url.searchParams.get("t")).toBe("token-abc")
    expect(url.searchParams.get("epk")).toBeTruthy()
    expect(url.searchParams.get("n")).toBe("feature/x")
    expect(url.searchParams.get("r")).toBeNull() // ← key assertion: no relay URL
    expect(uri).not.toContain("r=")
  })

  test("buildQRUri includes rm=<12-char roomId> when provided", async () => {
    const { buildQRUri } = await import("./pairing/qr.js")
    const epk = Buffer.alloc(32, 0x42)
    const uri = buildQRUri("token-abc", epk, "feature/x", "aB12CD34eF56")
    const url = new URL(uri.replace("unbien:", "https:"))
    expect(url.searchParams.get("rm")).toBe("aB12CD34eF56")
    expect(url.searchParams.get("rm")).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  test("buildQRUri without roomId omits rm field (backward-compat)", async () => {
    const { buildQRUri } = await import("./pairing/qr.js")
    const epk = Buffer.alloc(32, 0x42)
    const uri = buildQRUri("token-abc", epk, "feature/x")
    const url = new URL(uri.replace("unbien:", "https:"))
    expect(url.searchParams.get("rm")).toBeNull()
  })
})

// ── rooms: _cmdStart sends roomId/roomMeta; PeerChannel includes room ────────

describe("rooms wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    delete process.env["UNBIEN_RELAY"]
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("_cmdStart calls relay.connect with roomId and roomMeta derived from cwd", async () => {
    const capturedOpts: unknown[] = []
    _defaultConnectImpl = async (opts?: unknown) => {
      capturedOpts.push(opts)
    }

    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-test-room"))

    expect(capturedOpts).toHaveLength(1)
    const opts = capturedOpts[0] as {
      roomId?: string
      roomMeta?: { name: string; cwd: string }
    }
    expect(opts.roomId).toBeTruthy()
    expect(opts.roomId).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(opts.roomMeta?.cwd).toBe("/tmp/unbien-test-room")
    expect(opts.roomMeta?.name).toContain("unbien-test-room")
  })

  test("_cmdStart with different cwds uses different roomIds", async () => {
    const capturedOpts: Array<{ roomId?: string }> = []
    _defaultConnectImpl = async (opts?: unknown) => {
      capturedOpts.push(opts as { roomId?: string })
    }

    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-A"))

    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())

    await _connectForTest(makeMockCtx("/tmp/unbien-B"))

    expect(capturedOpts).toHaveLength(2)
    expect(capturedOpts[0]!.roomId).not.toBe(capturedOpts[1]!.roomId)
  })

  test("RoomAlreadyOpenError closes its initial Relay candidate before reporting", async () => {
    _defaultConnectImpl = async () => {
      throw new MockRoomAlreadyOpenError("AbCdEfGhIjKl")
    }

    captureHandler("unbien")
    const ctx = makeMockCtx("/tmp/unbien-dup")
    await _connectForTest(ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Already running in this cwd"),
      "error",
    )
    expect(relayRef.current?.close).toHaveBeenCalledTimes(1)
    expect(_getState()).toBe("idle")
  })

  test("generic initial Relay failure closes its candidate before reporting", async () => {
    const failure = new Error("initial Relay failed")
    _defaultConnectImpl = async () => {
      throw failure
    }

    captureHandler("unbien")
    const ctx = makeMockCtx("/tmp/unbien-initial-failure")
    await _connectForTest(ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(failure.message),
      "error",
    )
    expect(relayRef.current?.close).toHaveBeenCalledTimes(1)
    expect(_getState()).toBe("idle")
  })

  test("PeerChannel outer envelope omits `room` field (defensive, until W1.A/C ready)", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-room-test"))

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "peer-room-test",
        ct: Buffer.from(
          JSON.stringify({
            type: "pair_request",
            id: "req-1",
            token: "test-token",
            device_name: "Phone",
          }),
        ).toString("base64"),
      }),
    )
    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })

    // Trigger a channel-sent frame via ping (post-pair).
    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: "peer-room-test",
        ct: Buffer.from(JSON.stringify({ type: "ping", id: "p1" })).toString(
          "base64",
        ),
      }),
    )
    await new Promise((r) => setTimeout(r, 30))

    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const allFrames = sent.map(
      (line) => JSON.parse(line) as { peer: string; room?: string; ct: string },
    )
    const channelFrames = allFrames.filter((o) => o.peer === "peer-room-test")
    expect(channelFrames.length).toBeGreaterThan(0)
    // Defensive: no frame should carry `room` until downstream is ready.
    for (const f of channelFrames) {
      expect(f.room).toBeUndefined()
    }
  })
})

// ── session_sync (catch-up replay) ────────────────────────────────────────────

describe("session sync", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
    _setSessionStartedAtForTest(null)
  })

  test("session_sync → no transcript replay (that's get_entries); terminator lands with the session clock", async () => {
    await _pairForTest("peer-ss-1")
    _setSessionStartedAtForTest(null) // simulate edge: paired but no session

    const sendsBefore = relayRef.current!.send.mock.calls.length
    await emitEnvelopeSync("peer-ss-1", "req-1")

    const sent = relayRef
      .current!.send.mock.calls.slice(sendsBefore)
      .map((c) => c[0] as string)
    // session_sync NEVER replays the transcript now (that's the app's get_entries
    // rpc) — it carries only panels/ui + the terminator. `truncated` is gone.
    expect(replayMessageEnds(sent)).toHaveLength(0)
    expect(syncEndFrame(sent)).toMatchObject({
      type: "session_sync_end",
      in_reply_to: "req-1",
      session_started_at: 0,
    })
  })

  test("pair_ok carries session_started_at = _sessionStartedAt", async () => {
    const beforePair = Date.now()
    await _pairForTest("peer-ss-5")
    const afterPair = Date.now()

    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const pairOks = sent
      .map(decodeSentCt)
      .filter((d) => d.inner.type === "pair_ok")
    expect(pairOks).toHaveLength(1)
    const tsField = pairOks[0]!.inner["session_started_at"] as number
    expect(typeof tsField).toBe("number")
    expect(tsField).toBeGreaterThanOrEqual(beforePair)
    expect(tsField).toBeLessThanOrEqual(afterPair)
  })

  test("pair_ok carries room_id so the app can address subsequent inners", async () => {
    await _pairForTest("peer-ss-room")

    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string)
    const pairOks = sent
      .map(decodeSentCt)
      .filter((d) => d.inner.type === "pair_ok")
    expect(pairOks).toHaveLength(1)
    const roomId = pairOks[0]!.inner["room_id"] as unknown
    expect(typeof roomId).toBe("string")
    expect(roomId as string).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })
})

// ── explicit bye on stop / revoke-active ──────────────────────────────────────

describe("bye on teardown", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("/unbien stop invalidates Relay and producer before a deferred mesh leave", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())
    const relay = relayRef.current!
    const staleProducer = selfRevokeHarness.options.at(-1)!
    const stop = captureHandler("unbien stop")
    const sendMessage = vi.fn()
    _setPiForTest({ sendMessage, sendUserMessage: () => undefined })

    const meshNodeModule = await import("./session/mesh_node.js")
    const peerModule = await import("./session/peer.js")
    const topologySpy = vi.spyOn(
      meshNodeModule.MeshNode.prototype,
      "setTopology",
    )
    const originalLeave = peerModule.SessionPeer.prototype.leave
    const leaveGate = deferred<void>()
    let stateAtLeave: string | undefined
    let relayClosedAtLeave = false
    let staleTopologyCallback = Promise.resolve()
    const leaveSpy = vi
      .spyOn(peerModule.SessionPeer.prototype, "leave")
      .mockImplementation(async function (
        this: InstanceType<typeof peerModule.SessionPeer>,
      ) {
        stateAtLeave = _getState()
        relayClosedAtLeave = relay.close.mock.calls.length > 0
        staleTopologyCallback = (async () => {
          await staleProducer.onTopologyChanged?.({
            self: {
              pcLabel: "stale-self",
              pcPubkey: Buffer.alloc(32).toString("base64"),
              legacyPcLabel: "stale-self",
            },
            siblings: [],
          })
        })()
        void staleProducer.onRevoke?.(
          OWNER_URL_SAFE_FIXTURE,
          OWNER_STANDARD_FIXTURE,
        )
        const actualLeave = originalLeave.call(this)
        await Promise.all([actualLeave, leaveGate.promise])
      })

    let stopping: Promise<void> | undefined
    try {
      stopping = stop("", makeMockCtx())
      expect(stateAtLeave).toBe("idle")
      expect(relayClosedAtLeave).toBe(true)
      expect(_hasMeshNodeForTest()).toBe(false)
      await staleTopologyCallback
      expect(topologySpy).not.toHaveBeenCalled()
      expect(
        sendMessage.mock.calls.some(
          ([message]) =>
            (message as { customType?: string }).customType ===
            "un-bien:mesh-revoked",
        ),
      ).toBe(false)
    } finally {
      leaveGate.resolve(undefined)
      await stopping
      leaveSpy.mockRestore()
      topologySpy.mockRestore()
    }
  })

  test("revoke of attached owner → channel is closed, relay stays started", async () => {
    _tokenStatus = "ok"
    const ACTIVE = OWNER_STANDARD_FIXTURE
    // Attach the peer so it lives in _activePeers
    await _pairForTest(ACTIVE)

    const revoke = captureHandler("unbien revoke")
    await revoke(OWNER_STANDARD_FIXTURE.slice(0, 8), makeMockCtx())

    // Multi-channel (W2D): only this owner's channel is closed; the relay
    // stays up, ready for new pairings. Pre-W2D this dropped to idle.
    expect(_hasActivePeerForTest(ACTIVE)).toBe(false)
    expect(_getState()).toBe("started")
  })
})

// ── session_shutdown teardown (cockpit double-conn fix) ────────────────────────

describe("session_shutdown teardown", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    _setDisposedForTest(false) // shared module — clear the per-instance flag
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  // Regression: the Pi SDK re-evaluates this module FRESH on every session
  // replacement (jiti `moduleCache: false`), and in daemon mode the fresh
  // instance re-runs `_cmdRoot` on load. Without releasing the OUTGOING
  // instance's mesh + relay first, the Cockpit's boot-time `switch_session`
  // leaves two live connections (the "double mesh connection" bug). The SDK
  // emits + awaits `session_shutdown` on the outgoing runner before the
  // replacement loads, so the handler MUST exist and tear everything down.
  test("a session_shutdown handler is registered", () => {
    expect(() => captureEventHandler("session_shutdown")).not.toThrow()
  })

  test("session replacement disposes then rebinds pi-ask bridge listeners", async () => {
    const harness = captureEventHarness()
    const started = "@eko24ive/pi-ask:started"
    const completed = "@eko24ive/pi-ask:completed"
    const submitResult = "@eko24ive/pi-ask:submit-result"

    expect(harness.busListenerCount(started)).toBe(1)
    expect(harness.busListenerCount(completed)).toBe(1)
    expect(harness.busListenerCount(submitResult)).toBe(1)

    await harness.handler("session_shutdown")({
      type: "session_shutdown",
      reason: "resume",
    })

    expect(harness.busListenerCount(started)).toBe(0)
    expect(harness.busListenerCount(completed)).toBe(0)
    expect(harness.busListenerCount(submitResult)).toBe(0)

    harness.handler("session_start")({ type: "session_start" }, makeMockCtx())

    expect(harness.busListenerCount(started)).toBe(1)
    expect(harness.busListenerCount(completed)).toBe(1)
    expect(harness.busListenerCount(submitResult)).toBe(1)
  })

  test("firing session_shutdown while started tears down mesh + relay → idle", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())
    expect(_getState()).toBe("started")
    const relay = relayRef.current!

    const shutdown = captureEventHandler("session_shutdown")
    await shutdown({ type: "session_shutdown", reason: "resume" })

    // Relay WS closed + state back to idle: the outgoing instance is gone, so
    // the re-evaluated instance starts from a clean slate (one connection).
    expect(relay.close).toHaveBeenCalled()
    expect(_getState()).toBe("idle")
  })

  test("root session_shutdown with an active peer broadcasts rpc:session_shutdown", async () => {
    await _pairForTest("peer-shutdown-1")
    const relay = relayRef.current!
    const sendsBefore = relay.send.mock.calls.length

    const shutdown = captureEventHandler("session_shutdown")
    await shutdown({ type: "session_shutdown", reason: "resume" })

    const sent = relay.send.mock.calls
      .slice(sendsBefore)
      .map((c) => c[0] as string)
    const shutdownFrames = rpcFramesFrom(sent).filter(
      (f) => f["type"] === "session_shutdown",
    )
    expect(shutdownFrames).toHaveLength(1)
  })

  test("session_shutdown invalidates before a deferred mesh leave", async () => {
    await _pairForTest(OWNER_STANDARD_FIXTURE)
    const relay = relayRef.current!
    const peerModule = await import("./session/peer.js")
    const originalLeave = peerModule.SessionPeer.prototype.leave
    const leaveGate = deferred<void>()
    let stateAtLeave: string | undefined
    let relayClosedAtLeave = false
    const leaveSpy = vi
      .spyOn(peerModule.SessionPeer.prototype, "leave")
      .mockImplementation(async function (
        this: InstanceType<typeof peerModule.SessionPeer>,
      ) {
        stateAtLeave = _getState()
        relayClosedAtLeave = relay.close.mock.calls.length > 0
        const actualLeave = originalLeave.call(this)
        await Promise.all([actualLeave, leaveGate.promise])
      })

    const shutdown = captureEventHandler("session_shutdown")
    let shuttingDown: Promise<unknown> | undefined
    try {
      shuttingDown = Promise.resolve(
        shutdown({
          type: "session_shutdown",
          reason: "resume",
        }),
      )
      expect(stateAtLeave).toBe("idle")
      expect(relayClosedAtLeave).toBe(true)
      expect(_hasMeshNodeForTest()).toBe(false)
    } finally {
      leaveGate.resolve(undefined)
      await shuttingDown
      leaveSpy.mockRestore()
    }
  })

  test("firing session_shutdown while idle is a no-op (no throw)", async () => {
    const shutdown = captureEventHandler("session_shutdown")
    expect(_getState()).toBe("idle")
    await expect(
      shutdown({ type: "session_shutdown", reason: "quit" }),
    ).resolves.toBeUndefined()
    expect(_getState()).toBe("idle")
  })

  // Race guard: the daemon defers its connect (`setTimeout(_cmdRoot, 0)`), so a
  // shutdown can land while that connect is still in flight. The flag must make
  // the in-flight connect abort instead of resurrecting a mute ghost peer.
  test("session_shutdown sets _disposed → a deferred connect brings up NOTHING (mesh + relay both bail)", async () => {
    const shutdown = captureEventHandler("session_shutdown")
    await shutdown({ type: "session_shutdown", reason: "resume" })

    // Now the deferred connect runs AFTER shutdown. Both halves must bail:
    // _cmdJoin connects-then-leaves (no lingering mesh node), and _cmdStart's
    // pre-side-effect authority check returns immediately after key lookup — no
    // Relay candidate or WebSocket is constructed at all.
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())
    expect(_hasMeshNodeForTest()).toBe(false)
    expect(_getState()).toBe("idle")
    expect(relayInstances).toHaveLength(0)
  })

  // The precise Cockpit race: switch_session → session_shutdown lands WHILE
  // `_cmdStart` is parked in `relay.connect()` (network RTT). At that moment
  // `_state` is still "idle" (cmdStart only sets "started" after connect), so
  // the shutdown handler's `_goIdle()` is skipped and cannot see the in-flight
  // relay. Without the post-connect `_disposed` guard the WS finishes
  // connecting as a ghost that holds the room — and the replacement instance is
  // then refused with `room_already_open`, never entering the cross-PC mesh.
  test("session_shutdown DURING _cmdStart's relay.connect() closes the relay (no ghost holds the room)", async () => {
    captureHandler("unbien")

    // Park relay.connect() until we release it — emulates the RTT window.
    let releaseConnect!: () => void
    _defaultConnectImpl = () =>
      new Promise<void>((resolve) => {
        releaseConnect = resolve
      })

    // Kick off the connect but do NOT await — it blocks inside relay.connect().
    const connecting = _connectForTest(makeMockCtx())
    // Wait until _cmdJoin finished and _cmdStart constructed + called connect.
    await vi.waitFor(() => expect(relayRef.current).not.toBeNull())
    const relay = relayRef.current!
    expect(_getState()).toBe("idle") // still mid-connect — not yet "started"

    // session_shutdown fires mid-connect (the outgoing instance is discarded).
    const shutdown = captureEventHandler("session_shutdown")
    await shutdown({ type: "session_shutdown", reason: "resume" })

    // The parked connect now resolves: the guard must close it, not promote it.
    releaseConnect()
    await connecting

    expect(relay.close).toHaveBeenCalled() // ghost WS closed → room available
    expect(_getState()).toBe("idle") // never transitioned to "started"
  })

  test("same-module session replacement closes a pending initial Relay success and starts a fresh root", async () => {
    const firstConnect = deferred<void>()
    let firstSettled = false
    let connectAttempts = 0
    let outgoingRoot: Promise<void> | undefined
    const cwd = `/tmp/unbien-session-relay-success-${process.pid}-${Date.now()}`
    const outgoingCtx = makeMockCtx(cwd)
    const replacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "session-relay-success",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)
      _defaultConnectImpl = () => {
        connectAttempts += 1
        return connectAttempts === 1 ? firstConnect.promise : Promise.resolve()
      }

      const root = captureHandler("unbien")
      outgoingRoot = root("", outgoingCtx)
      await vi.waitFor(() => expect(relayInstances).toHaveLength(1))
      const outgoingRelay = relayInstances[0]!

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)

      firstSettled = true
      firstConnect.resolve(undefined)
      await outgoingRoot

      await vi.waitFor(() => {
        expect(relayInstances).toHaveLength(2)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(_getState()).toBe("started")
      })
      expect(outgoingRelay.close).toHaveBeenCalledTimes(1)
    } finally {
      if (!firstSettled) firstConnect.resolve(undefined)
      await outgoingRoot?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
    }
  })

  test("same-module session replacement silences a pending initial Relay rejection and starts fresh", async () => {
    const firstConnect = deferred<void>()
    let firstSettled = false
    let connectAttempts = 0
    let outgoingRoot: Promise<void> | undefined
    const cwd = `/tmp/unbien-session-relay-reject-${process.pid}-${Date.now()}`
    const outgoingCtx = makeMockCtx(cwd)
    const replacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "session-relay-reject",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)
      _defaultConnectImpl = () => {
        connectAttempts += 1
        return connectAttempts === 1 ? firstConnect.promise : Promise.resolve()
      }

      const root = captureHandler("unbien")
      outgoingRoot = root("", outgoingCtx)
      await vi.waitFor(() => expect(relayInstances).toHaveLength(1))
      const outgoingRelay = relayInstances[0]!

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)

      firstSettled = true
      firstConnect.reject(new Error("outgoing Relay failed late"))
      await outgoingRoot

      await vi.waitFor(() => {
        expect(relayInstances).toHaveLength(2)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(_getState()).toBe("started")
      })
      expect(outgoingRelay.close).toHaveBeenCalledTimes(1)
      expect(outgoingCtx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("relay connect failed"),
        "error",
      )
    } finally {
      if (!firstSettled) firstConnect.resolve(undefined)
      await outgoingRoot?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
    }
  })

  test("same-module session replacement closes a pending mesh-join success and starts a fresh root", async () => {
    const firstJoin = deferred<string>()
    let firstSettled = false
    let connectAttempts = 0
    let outgoingRoot: Promise<void> | undefined
    let outgoingCloseSpy: ReturnType<typeof vi.spyOn> | undefined
    const meshNodeModule = await import("./session/mesh_node.js")
    const connectSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "connect")
      .mockImplementation(() => {
        connectAttempts += 1
        return connectAttempts === 1
          ? firstJoin.promise
          : Promise.resolve("session-mesh-success")
      })
    const cwd = `/tmp/unbien-session-mesh-success-${process.pid}-${Date.now()}`
    const outgoingCtx = makeMockCtx(cwd)
    const replacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "session-mesh-success",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)
      const root = captureHandler("unbien")
      outgoingRoot = root("", outgoingCtx)
      await vi.waitFor(() => expect(connectSpy).toHaveBeenCalledTimes(1))
      const outgoingCandidate = connectSpy.mock.instances[0]! as unknown as {
        close: () => Promise<void>
      }
      outgoingCloseSpy = vi
        .spyOn(outgoingCandidate, "close")
        .mockResolvedValue(undefined)

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)

      firstSettled = true
      firstJoin.resolve("session-mesh-success")
      await outgoingRoot

      await vi.waitFor(() => {
        expect(connectSpy).toHaveBeenCalledTimes(2)
        expect(relayInstances).toHaveLength(1)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(_getState()).toBe("started")
      })
      expect(outgoingCloseSpy).toHaveBeenCalledTimes(1)
    } finally {
      if (!firstSettled) firstJoin.resolve("session-mesh-success")
      await outgoingRoot?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
      outgoingCloseSpy?.mockRestore()
      connectSpy.mockRestore()
    }
  })

  test("same-module session replacement silences a pending mesh-join rejection and starts fresh", async () => {
    const firstJoin = deferred<string>()
    let firstSettled = false
    let connectAttempts = 0
    let outgoingRoot: Promise<void> | undefined
    let outgoingCloseSpy: ReturnType<typeof vi.spyOn> | undefined
    const meshNodeModule = await import("./session/mesh_node.js")
    const connectSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "connect")
      .mockImplementation(() => {
        connectAttempts += 1
        return connectAttempts === 1
          ? firstJoin.promise
          : Promise.resolve("session-mesh-reject")
      })
    const cwd = `/tmp/unbien-session-mesh-reject-${process.pid}-${Date.now()}`
    const outgoingCtx = makeMockCtx(cwd)
    const replacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "session-mesh-reject",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)
      const root = captureHandler("unbien")
      outgoingRoot = root("", outgoingCtx)
      await vi.waitFor(() => expect(connectSpy).toHaveBeenCalledTimes(1))
      const outgoingCandidate = connectSpy.mock.instances[0]! as unknown as {
        close: () => Promise<void>
      }
      outgoingCloseSpy = vi
        .spyOn(outgoingCandidate, "close")
        .mockResolvedValue(undefined)

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)

      firstSettled = true
      firstJoin.reject(new Error("outgoing mesh join failed late"))
      await outgoingRoot

      await vi.waitFor(() => {
        expect(connectSpy).toHaveBeenCalledTimes(2)
        expect(relayInstances).toHaveLength(1)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(_getState()).toBe("started")
      })
      expect(outgoingCloseSpy).toHaveBeenCalledTimes(1)
      expect(outgoingCtx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("join failed"),
        "error",
      )
    } finally {
      if (!firstSettled) firstJoin.resolve("session-mesh-reject")
      await outgoingRoot?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
      outgoingCloseSpy?.mockRestore()
      connectSpy.mockRestore()
    }
  })

  test("same-module session replacement starts fresh after the outgoing root rejects", async () => {
    const firstLockGate = deferred<Awaited<ReturnType<typeof acquireCwdLock>>>()
    const outgoingFailure = new Error("outgoing cwd lock failed late")
    const releaseFreshLock = vi.fn()
    let firstLockSettled = false
    let acquireAttempts = 0
    let observedOutgoing:
      | Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }>
      | undefined
    const cwdLockModule = await import("./session/cwd_lock.js")
    const acquireSpy = vi
      .spyOn(cwdLockModule, "acquireCwdLock")
      .mockImplementation(() => {
        acquireAttempts += 1
        return acquireAttempts === 1
          ? firstLockGate.promise
          : Promise.resolve({ ok: true as const, release: releaseFreshLock })
      })
    const cwd = `/tmp/unbien-root-lock-reject-${process.pid}-${Date.now()}`
    const outgoingCtx = makeMockCtx(cwd)
    const replacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "root-lock-reject",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)

      const root = captureHandler("unbien")
      const outgoingRoot = root("", outgoingCtx)
      observedOutgoing = outgoingRoot.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      )
      await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(1))

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)

      firstLockSettled = true
      firstLockGate.reject(outgoingFailure)
      await expect(observedOutgoing).resolves.toEqual({
        status: "rejected",
        error: outgoingFailure,
      })

      await vi.waitFor(() => {
        expect(acquireSpy).toHaveBeenCalledTimes(2)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(relayInstances).toHaveLength(1)
        expect(_getState()).toBe("started")
      })
      expect(releaseFreshLock).not.toHaveBeenCalled()
      expect(outgoingCtx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining(outgoingFailure.message),
        expect.anything(),
      )
    } finally {
      if (!firstLockSettled) firstLockGate.reject(outgoingFailure)
      await observedOutgoing?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
      acquireSpy.mockRestore()
    }
  })

  test("/unbien stop cancels a replacement root pending cwd-lock publication", async () => {
    const lockGate = deferred<Awaited<ReturnType<typeof acquireCwdLock>>>()
    const releaseAcquiredLock = vi.fn()
    let lockSettled = false
    const cwdLockModule = await import("./session/cwd_lock.js")
    const acquireSpy = vi
      .spyOn(cwdLockModule, "acquireCwdLock")
      .mockImplementation(() => lockGate.promise)
    const cwd = `/tmp/unbien-root-lock-stop-${process.pid}-${Date.now()}`
    const replacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "root-lock-stop",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)
      await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(1))

      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)

      lockSettled = true
      lockGate.resolve({ ok: true, release: releaseAcquiredLock })
      await vi.waitFor(() =>
        expect(releaseAcquiredLock).toHaveBeenCalledTimes(1),
      )

      expect(_hasMeshNodeForTest()).toBe(false)
      expect(relayInstances).toHaveLength(0)
      expect(_getState()).toBe("idle")
    } finally {
      if (!lockSettled)
        lockGate.resolve({ ok: true, release: releaseAcquiredLock })
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
      acquireSpy.mockRestore()
    }
  })

  test("relay:off cancels a replacement root pending cwd-lock publication", async () => {
    const lockGate = deferred<Awaited<ReturnType<typeof acquireCwdLock>>>()
    const releaseAcquiredLock = vi.fn()
    let lockSettled = false
    const cwdLockModule = await import("./session/cwd_lock.js")
    const acquireSpy = vi
      .spyOn(cwdLockModule, "acquireCwdLock")
      .mockImplementation(() => lockGate.promise)
    const cwd = `/tmp/unbien-root-lock-relay-off-${process.pid}-${Date.now()}`
    const replacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "root-lock-relay-off",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)
      await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(1))

      await _handleControl("relay:off")

      lockSettled = true
      lockGate.resolve({ ok: true, release: releaseAcquiredLock })
      await vi.waitFor(() =>
        expect(releaseAcquiredLock).toHaveBeenCalledTimes(1),
      )

      expect(_hasMeshNodeForTest()).toBe(false)
      expect(relayInstances).toHaveLength(0)
      expect(_getState()).toBe("idle")
    } finally {
      if (!lockSettled)
        lockGate.resolve({ ok: true, release: releaseAcquiredLock })
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
      acquireSpy.mockRestore()
    }
  })

  test("a newer session replacement supersedes a root pending cwd-lock publication", async () => {
    const firstLockGate = deferred<Awaited<ReturnType<typeof acquireCwdLock>>>()
    const releaseSupersededLock = vi.fn()
    const releaseNewestLock = vi.fn()
    let firstLockSettled = false
    let acquireAttempts = 0
    const cwdLockModule = await import("./session/cwd_lock.js")
    const acquireSpy = vi
      .spyOn(cwdLockModule, "acquireCwdLock")
      .mockImplementation(() => {
        acquireAttempts += 1
        return acquireAttempts === 1
          ? firstLockGate.promise
          : Promise.resolve({ ok: true as const, release: releaseNewestLock })
      })
    const cwd = `/tmp/unbien-root-lock-replacement-${process.pid}-${Date.now()}`
    const firstReplacementCtx = makeMockCtx(cwd)
    const newestReplacementCtx = makeMockCtx(cwd)

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "root-lock-replacement",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)

      const firstShutdown = captureEventHandler("session_shutdown")
      await firstShutdown({ type: "session_shutdown", reason: "resume" })
      const firstSessionStart = captureEventHandler("session_start")
      void firstSessionStart({ type: "session_start" }, firstReplacementCtx)
      await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(1))

      const secondShutdown = captureEventHandler("session_shutdown")
      await secondShutdown({ type: "session_shutdown", reason: "resume" })
      const secondSessionStart = captureEventHandler("session_start")
      void secondSessionStart({ type: "session_start" }, newestReplacementCtx)

      firstLockSettled = true
      firstLockGate.resolve({ ok: true, release: releaseSupersededLock })

      await vi.waitFor(() => {
        expect(releaseSupersededLock).toHaveBeenCalledTimes(1)
        expect(acquireSpy).toHaveBeenCalledTimes(2)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(relayInstances).toHaveLength(1)
        expect(_getState()).toBe("started")
      })
      expect(releaseNewestLock).not.toHaveBeenCalled()
    } finally {
      if (!firstLockSettled) {
        firstLockGate.resolve({ ok: true, release: releaseSupersededLock })
      }
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", newestReplacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
      acquireSpy.mockRestore()
    }
  })

  test("after a clean reset, connect works again (flag is per-instance, not sticky)", async () => {
    // beforeEach already reset _disposed → a fresh connect must join the mesh.
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())
    expect(_hasMeshNodeForTest()).toBe(true)
  })
})

// ── un-bien:name-assigned event (Cockpit consumes the effective name) ────────

describe("un-bien:name-assigned event", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    _setDisposedForTest(false)
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  // Contract for the Cockpit: on join the extension emits a pure-data
  // (display:false) custom message carrying the requested + effective mesh
  // name, so the client can rename the agent when the broker appended a `#N`.
  test("join emits un-bien:name-assigned with requested + assigned + changed", async () => {
    const sendMessage = vi.fn()
    const spyPi = {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: () => undefined,
      registerShortcut: () => undefined,
      registerFlag: () => undefined,
      getFlag: () => undefined,
      registerMessageRenderer: () => undefined,
      sendMessage,
      sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI
    captureHandler("unbien") // factory side-effects (matches other connect tests)
    _setPiForTest(spyPi) // …then route sendMessage through the spy
    expect(_hasMeshNodeForTest()).toBe(false)

    const ctx = makeMockCtx(
      `/tmp/unbien-name-assigned-${process.pid}-${Date.now()}`,
    )
    await _connectForTest(ctx)
    expect(_hasMeshNodeForTest()).toBe(true) // join succeeded → emit ran

    const ev = sendMessage.mock.calls
      .map(
        (c) =>
          c[0] as {
            customType?: string
            display?: boolean
            details?: Record<string, unknown>
          },
      )
      .find((m) => m?.customType === "un-bien:name-assigned")
    expect(ev).toBeDefined()
    expect(ev!.display).toBe(false)
    expect(ev!.details).toMatchObject({ changed: false })
    expect(typeof ev!.details!["requested"]).toBe("string")
    // No collision in this isolated broker → assigned === requested.
    expect(ev!.details!["assigned"]).toBe(ev!.details!["requested"])
  })
})

// ── Local config owns mesh name ───────────────────────────────────────────────
describe("local config owns mesh name", () => {
  test("join ignores the Pi session display name", async () => {
    process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
      agent_name: "crow",
      auto_start_relay: false,
    })
    const root = captureHandler("unbien")
    _setPiForTest({ getSessionName: () => "pi-subagent-poison" })
    const cwd = `/tmp/unbien-name-config-${process.pid}-${Date.now()}`

    await root("", makeMockCtx(cwd))

    expect(_getLockedNameForTest()?.replace(/#\d+$/, "")).toBe("crow")
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx(cwd))
    _resetCwdLockForTest()
  })
})

// ── relay control channel + relay-state event (Cockpit on/off button) ──────────

describe("relay control channel + relay-state event", () => {
  function makeSpyPi(sendMessage: ReturnType<typeof vi.fn>) {
    return {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: () => undefined,
      registerShortcut: () => undefined,
      registerFlag: () => undefined,
      getFlag: () => undefined,
      registerMessageRenderer: () => undefined,
      sendMessage,
      sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI
  }
  const lastRelayState = (sendMessage: ReturnType<typeof vi.fn>) =>
    sendMessage.mock.calls
      .map(
        (c) =>
          c[0] as {
            customType?: string
            display?: boolean
            details?: Record<string, unknown>
          },
      )
      .reverse()
      .find((m) => m?.customType === "un-bien:relay-state")

  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    _setDisposedForTest(false)
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  // Transparency: a CTRL_PREFIX-tagged input is swallowed by the `input` hook
  // so it never reaches the LLM or the transcript — the path the Cockpit button
  // uses to toggle the relay without a visible turn.
  test("input hook swallows a CTRL_PREFIX control message (action:handled)", () => {
    const input = captureEventHandler("input")
    const result = input({
      type: "input",
      text: `${CTRL_PREFIX}relay:status`,
      source: "rpc",
    })
    expect(result).toEqual({ action: "handled" })
  })

  test("a normal (non-control) input is NOT swallowed", () => {
    const input = captureEventHandler("input")
    const result = input({ type: "input", text: "hello world", source: "rpc" })
    expect(result).toBeUndefined()
  })

  test("relay:status emits un-bien:relay-state 'disconnected' while idle", async () => {
    const sendMessage = vi.fn()
    captureHandler("unbien")
    _setPiForTest(makeSpyPi(sendMessage))
    expect(_getState()).toBe("idle")

    await _handleControl("relay:status")

    const ev = lastRelayState(sendMessage)
    expect(ev).toBeDefined()
    expect(ev!.display).toBe(false)
    expect(ev!.details).toMatchObject({
      status: "disconnected",
      connected: false,
    })
  })

  test("relay:on → relay up + 'connected'; relay:off → relay down + 'disconnected'", async () => {
    const sendMessage = vi.fn()
    captureHandler("unbien")
    _setPiForTest(makeSpyPi(sendMessage))

    await _handleControl("relay:on")
    expect(_getState()).toBe("started")
    expect(lastRelayState(sendMessage)!.details).toMatchObject({
      status: "connected",
      connected: true,
    })

    sendMessage.mockClear()
    await _handleControl("relay:off")
    expect(_getState()).toBe("idle")
    expect(lastRelayState(sendMessage)!.details).toMatchObject({
      status: "disconnected",
      connected: false,
    })
  })

  test("relay:toggle flips idle → started → idle", async () => {
    captureHandler("unbien")
    _setPiForTest(makeSpyPi(vi.fn()))
    expect(_getState()).toBe("idle")
    await _handleControl("relay:toggle")
    expect(_getState()).toBe("started")
    await _handleControl("relay:toggle")
    expect(_getState()).toBe("idle")
  })

  test("rename:<name> renames live (broker re-register + relay swap), process/session survive", async () => {
    const sendMessage = vi.fn()
    captureHandler("unbien")
    _setPiForTest(makeSpyPi(sendMessage))
    await _connectForTest(makeMockCtx())
    expect(_getState()).toBe("started")
    expect(_hasMeshNodeForTest()).toBe(true)

    sendMessage.mockClear()
    await _handleControl("rename:Renamed")

    // The mesh node + relay survive (no process restart); relay back up.
    expect(_hasMeshNodeForTest()).toBe(true)
    expect(_getState()).toBe("started")
    // Cockpit is told the new effective name via un-bien:name-assigned.
    const ev = sendMessage.mock.calls
      .map(
        (c) =>
          c[0] as {
            customType?: string
            display?: boolean
            details?: Record<string, unknown>
          },
      )
      .reverse()
      .find((m) => m?.customType === "un-bien:name-assigned")
    expect(ev).toBeDefined()
    expect(ev!.display).toBe(false)
    expect(ev!.details).toMatchObject({
      requested: "Renamed",
      assigned: "Renamed",
      changed: false,
    })

    // Clean up: rename churns the real UDS broker (leave+rejoin) and leaves the
    // mesh/relay live — tear down so it can't leak into later tests (an orphaned
    // broker socket makes a subsequent bind flaky).
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
    _resetCwdLockForTest()
  })

  test("empty rename is a no-op", async () => {
    captureHandler("unbien")
    _setPiForTest(makeSpyPi(vi.fn()))
    await expect(_handleControl("rename:")).resolves.toBeUndefined()
  })
})

// ── multi-agent in the same folder: lock suffixes instead of refusing ──────────

describe("same-folder same-name → #N suffix (no refusal)", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    _setDisposedForTest(false)
    _resetCwdLockForTest()
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  // The reported case: a folder already has an agent "Backoffice"; creating a
  // second "Backoffice" must NOT be refused — it comes up as "Backoffice#2"
  // (and the name-assigned event reports the change), matching the broker.
  test("a second same-name agent joins as <name>#2 instead of being refused", async () => {
    process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
      agent_name: "Backoffice",
      auto_start_relay: false, // keep the test off the relay
    })
    const cwd = "/home/user/projects/remote_pi"
    // Simulate the first agent already holding (cwd, "Backoffice").
    const first = await acquireCwdLock(cwd, "Backoffice")
    expect(first.ok).toBe(true)
    try {
      const root = captureHandler("unbien")
      await root("", makeMockCtx(cwd))
      // Lock seeker skipped the taken base name and reserved the #2 variant…
      expect(_getLockedNameForTest()).toBe("Backoffice#2")
      // …and the agent actually joined the mesh (not refused).
      expect(_hasMeshNodeForTest()).toBe(true)
    } finally {
      if (first.ok) first.release()
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      _resetCwdLockForTest()
    }
  })

  test("concurrent startup in one extension instance does not self-suffix", async () => {
    process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
      agent_name: "Backoffice",
      auto_start_relay: false,
    })
    const cwd = "/home/user/projects/remote_pi-concurrent"
    try {
      const root = captureHandler("unbien")
      await Promise.all([
        root("", makeMockCtx(cwd)),
        root("", makeMockCtx(cwd)),
      ])

      expect(_getLockedNameForTest()).toBe("Backoffice")
      expect(_hasMeshNodeForTest()).toBe(true)
    } finally {
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      _resetCwdLockForTest()
    }
  })

  test("a supervised daemon refuses a busy base lock instead of joining as <name>#2", async () => {
    process.env["UNBIEN_DAEMON"] = "1"
    process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
      agent_name: "Backoffice",
      auto_start_relay: false,
    })
    const cwd = "/home/user/projects/remote_pi"
    const first = await acquireCwdLock(cwd, "Backoffice")
    expect(first.ok).toBe(true)
    try {
      const root = captureHandler("unbien")
      const ctx = makeMockCtx(cwd)
      await root("", ctx)

      expect(_getLockedNameForTest()).toBeNull()
      expect(_hasMeshNodeForTest()).toBe(false)
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Daemon not started"),
        "warning",
      )
    } finally {
      if (first.ok) first.release()
      delete process.env["UNBIEN_DAEMON"]
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      _resetCwdLockForTest()
    }
  })
})

// ── print/-p mode never auto-starts the relay (issue #44) ────────────────────
describe("session_start auto-init skips relay in print/-p mode (#44)", () => {
  const savedArgv = process.argv
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _consumeCalls.length = 0
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    _setDisposedForTest(false)
    _resetAutoInitedForTest()
    _resetCwdLockForTest()
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
    _resetAutoInitedForTest()
  })
  afterEach(() => {
    process.argv = savedArgv
    delete process.env["UNBIEN_DIRECT_CONFIG"]
    _resetCwdLockForTest()
  })

  // A one-shot `pi -p "..."` prints its answer and must exit. Auto-starting the
  // relay opens a WS that is never `.unref()`'d, so the process would hang.
  test("`pi -p` does NOT bring up the mesh/relay on session_start", async () => {
    process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
      agent_name: "PrintAgent",
      auto_start_relay: true,
    })
    process.argv = ["node", "pi", "-p", "Say hello in one word."]
    const onSessionStart = captureEventHandler("session_start")
    _resetAutoInitedForTest()
    onSessionStart(
      { type: "session_start" },
      makeMockCtx("/home/user/projects/rp-print"),
    )
    await new Promise<void>((r) => setTimeout(r, 20))

    expect(_hasMeshNodeForTest()).toBe(false)
    expect(relayInstances).toHaveLength(0)
  })

  // Guard the negative: a normal interactive session_start (no -p/--print) still
  // auto-starts exactly as before, so the fix doesn't disable auto-init at large.
  test("interactive session_start (no -p) still auto-starts the mesh", async () => {
    process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
      agent_name: "InteractiveAgent",
      auto_start_relay: true,
    })
    process.argv = ["node", "pi"]
    const onSessionStart = captureEventHandler("session_start")
    _resetAutoInitedForTest()
    onSessionStart(
      { type: "session_start" },
      makeMockCtx("/home/user/projects/rp-interactive"),
    )
    await new Promise<void>((r) => setTimeout(r, 20))

    expect(_hasMeshNodeForTest()).toBe(true)
  })
})

// ── relay reconnect with backoff ──────────────────────────────────────────────

describe("relay reconnect", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("/unbien stop cancels a pending mesh join before Relay startup", async () => {
    const joinGate = deferred<string>()
    let joinReleased = false
    let rootPromise: Promise<void> | undefined
    const meshNodeModule = await import("./session/mesh_node.js")
    const connectSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "connect")
      .mockImplementation(() => joinGate.promise)
    const attachBridgeSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "attachBridge")
      .mockResolvedValue(undefined)
    let candidateCloseSpy: ReturnType<typeof vi.spyOn> | undefined
    const cwd = `/tmp/unbien-join-cancel-${process.pid}-${Date.now()}`

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "join-cancel",
        auto_start_relay: true,
      })
      const root = captureHandler("unbien")
      rootPromise = root("", makeMockCtx(cwd))
      await vi.waitFor(() => expect(connectSpy).toHaveBeenCalledTimes(1))
      const candidate = connectSpy.mock.instances[0]! as unknown as {
        close: () => Promise<void>
      }
      candidateCloseSpy = vi
        .spyOn(candidate, "close")
        .mockResolvedValue(undefined)
      expect(_hasMeshNodeForTest()).toBe(false)
      expect(_getState()).toBe("idle")

      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx(cwd))

      joinReleased = true
      joinGate.resolve("join-cancel")
      await rootPromise

      expect(candidateCloseSpy).toHaveBeenCalledTimes(1)
      expect(_hasMeshNodeForTest()).toBe(false)
      expect(_getState()).toBe("idle")
      expect(relayInstances).toHaveLength(0)
      expect(attachBridgeSpy).not.toHaveBeenCalled()
    } finally {
      if (!joinReleased) joinGate.resolve("join-cancel")
      await rootPromise?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx(cwd))
      _resetCwdLockForTest()
      candidateCloseSpy?.mockRestore()
      attachBridgeSpy.mockRestore()
      connectSpy.mockRestore()
    }
  })

  test("/unbien stop cancels delayed keypair resolve before any Relay side effect", async () => {
    const storage = await import("./pairing/storage.js")
    const getKeypair = vi.mocked(storage.getOrCreateEd25519Keypair)
    const keypairGate =
      deferred<Awaited<ReturnType<typeof storage.getOrCreateEd25519Keypair>>>()
    const staleKeypair = {
      publicKey: new Uint8Array(32).fill(0x11),
      secretKey: new Uint8Array(32).fill(0x22),
    }
    const cacheBefore = _getCachedPublicKeyForTest()
    const ctx = makeMockCtx("/tmp/unbien-keypair-stop-resolve")
    let settled = false
    let starting: Promise<void> | undefined

    try {
      getKeypair.mockImplementationOnce(() => keypairGate.promise)
      starting = _startRelayForTest(ctx)
      await vi.waitFor(() => expect(getKeypair).toHaveBeenCalledTimes(1))

      const stop = captureHandler("unbien stop")
      await stop("", ctx)

      settled = true
      keypairGate.resolve(staleKeypair)
      await starting

      expect(_getCachedPublicKeyForTest()).toBe(cacheBefore)
      expect(
        ctx.ui.notify.mock.calls.some(([message]) =>
          String(message).includes("Connecting to relay"),
        ),
      ).toBe(false)
      expect(relayInstances).toHaveLength(0)
      expect(_getState()).toBe("idle")
    } finally {
      if (!settled) keypairGate.resolve(staleKeypair)
      await starting?.catch(() => undefined)
      const stop = captureHandler("unbien stop")
      await stop("", ctx)
    }
  })

  test("/unbien stop silences delayed keypair rejection before any Relay side effect", async () => {
    const storage = await import("./pairing/storage.js")
    const getKeypair = vi.mocked(storage.getOrCreateEd25519Keypair)
    const keypairGate =
      deferred<Awaited<ReturnType<typeof storage.getOrCreateEd25519Keypair>>>()
    const staleFailure = new storage.KeyringUnavailableError(
      "late keyring denial",
    )
    const cacheBefore = _getCachedPublicKeyForTest()
    const ctx = makeMockCtx("/tmp/unbien-keypair-stop-reject")
    let settled = false
    let starting: Promise<void> | undefined

    try {
      getKeypair.mockImplementationOnce(() => keypairGate.promise)
      starting = _startRelayForTest(ctx)
      await vi.waitFor(() => expect(getKeypair).toHaveBeenCalledTimes(1))

      const stop = captureHandler("unbien stop")
      await stop("", ctx)

      settled = true
      keypairGate.reject(staleFailure)
      await expect(starting).resolves.toBeUndefined()

      expect(_getCachedPublicKeyForTest()).toBe(cacheBefore)
      expect(
        ctx.ui.notify.mock.calls.some(([message]) =>
          String(message).includes("Could not read this machine's identity"),
        ),
      ).toBe(false)
      expect(relayInstances).toHaveLength(0)
      expect(_getState()).toBe("idle")
    } finally {
      if (!settled) keypairGate.reject(staleFailure)
      await starting?.catch(() => undefined)
      const stop = captureHandler("unbien stop")
      await stop("", ctx)
    }
  })

  test("same-module replacement supersedes delayed keypair resolve before Relay construction", async () => {
    const storage = await import("./pairing/storage.js")
    const getKeypair = vi.mocked(storage.getOrCreateEd25519Keypair)
    const keypairGate =
      deferred<Awaited<ReturnType<typeof storage.getOrCreateEd25519Keypair>>>()
    const staleKeypair = {
      publicKey: new Uint8Array(32).fill(0x33),
      secretKey: new Uint8Array(32).fill(0x44),
    }
    const cwd = `/tmp/unbien-keypair-replace-resolve-${process.pid}-${Date.now()}`
    const outgoingCtx = makeMockCtx(cwd)
    const replacementCtx = makeMockCtx(cwd)
    let settled = false
    let outgoingRoot: Promise<void> | undefined

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "keypair-replace-resolve",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)
      getKeypair.mockImplementationOnce(() => keypairGate.promise)

      const root = captureHandler("unbien")
      outgoingRoot = root("", outgoingCtx)
      await vi.waitFor(() => expect(getKeypair).toHaveBeenCalledTimes(1))
      expect(_hasMeshNodeForTest()).toBe(true)

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)

      settled = true
      keypairGate.resolve(staleKeypair)
      await outgoingRoot

      await vi.waitFor(() => {
        expect(getKeypair).toHaveBeenCalledTimes(2)
        expect(relayInstances).toHaveLength(1)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(_getState()).toBe("started")
      })
      expect(_getCachedPublicKeyForTest()).not.toBe(
        Buffer.from(staleKeypair.publicKey).toString("base64"),
      )
      expect(
        outgoingCtx.ui.notify.mock.calls.some(([message]) =>
          String(message).includes("Connecting to relay"),
        ),
      ).toBe(false)
      expect(relayInstances[0]!.connect).toHaveBeenCalledTimes(1)
    } finally {
      if (!settled) keypairGate.resolve(staleKeypair)
      await outgoingRoot?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
    }
  })

  test("same-module replacement silences delayed generic keypair rejection and starts fresh", async () => {
    const storage = await import("./pairing/storage.js")
    const getKeypair = vi.mocked(storage.getOrCreateEd25519Keypair)
    const keypairGate =
      deferred<Awaited<ReturnType<typeof storage.getOrCreateEd25519Keypair>>>()
    const staleFailure = new Error("outgoing keypair lookup failed late")
    const cwd = `/tmp/unbien-keypair-replace-reject-${process.pid}-${Date.now()}`
    const outgoingCtx = makeMockCtx(cwd)
    const replacementCtx = makeMockCtx(cwd)
    let settled = false
    let observedOutgoing:
      | Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }>
      | undefined

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "keypair-replace-reject",
        auto_start_relay: true,
      })
      _setAutoInitedForTest(true)
      getKeypair.mockImplementationOnce(() => keypairGate.promise)

      const root = captureHandler("unbien")
      const outgoingRoot = root("", outgoingCtx)
      observedOutgoing = outgoingRoot.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      )
      await vi.waitFor(() => expect(getKeypair).toHaveBeenCalledTimes(1))

      const shutdown = captureEventHandler("session_shutdown")
      await shutdown({ type: "session_shutdown", reason: "resume" })
      const sessionStart = captureEventHandler("session_start")
      void sessionStart({ type: "session_start" }, replacementCtx)

      settled = true
      keypairGate.reject(staleFailure)
      await expect(observedOutgoing).resolves.toEqual({ status: "resolved" })

      await vi.waitFor(() => {
        expect(getKeypair).toHaveBeenCalledTimes(2)
        expect(relayInstances).toHaveLength(1)
        expect(_hasMeshNodeForTest()).toBe(true)
        expect(_getState()).toBe("started")
      })
      expect(
        outgoingCtx.ui.notify.mock.calls.some(
          ([message]) =>
            String(message).includes("Connecting to relay") ||
            String(message).includes(staleFailure.message),
        ),
      ).toBe(false)
      expect(relayInstances[0]!.connect).toHaveBeenCalledTimes(1)
    } finally {
      if (!settled) keypairGate.reject(staleFailure)
      await observedOutgoing?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", replacementCtx)
      _resetCwdLockForTest()
      _setAutoInitedForTest(false)
    }
  })

  test("relay close schedules reconnect; advancing past 1s triggers a new connect", async () => {
    vi.useFakeTimers()
    try {
      captureHandler("unbien")
      await _connectForTest(makeMockCtx())
      expect(relayInstances).toHaveLength(1)
      expect(_getState()).toBe("started")

      relayInstances[0]!.emit("close")
      expect(_hasPendingReconnect()).toBe(true)
      // State stays 'started' during reconnect window (not idle)
      expect(_getState()).toBe("started")
      // Still only 1 RelayClient constructed
      expect(relayInstances).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1_000)
      // Reconnect attempt fired
      expect(relayInstances).toHaveLength(2)
      expect(_hasPendingReconnect()).toBe(false)
      expect(_getState()).toBe("started")
    } finally {
      vi.useRealTimers()
    }
  })

  test("backoff progression 1s, 2s, 5s, 10s, 30s, 30s (capped) when connects keep failing", async () => {
    vi.useFakeTimers()
    try {
      captureHandler("unbien")
      await _connectForTest(makeMockCtx())
      expect(relayInstances).toHaveLength(1)

      // From here on, every new MockRelay.connect rejects.
      _defaultConnectImpl = () => Promise.reject(new Error("ECONNREFUSED"))

      relayInstances[0]!.emit("close")
      const backoffs = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000]
      let prevCount = relayInstances.length
      for (const delay of backoffs) {
        await vi.advanceTimersByTimeAsync(delay)
        expect(relayInstances.length).toBe(prevCount + 1)
        expect(relayInstances.at(-1)!.close).toHaveBeenCalledTimes(1)
        prevCount = relayInstances.length
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test("/unbien stop during reconnect cancels the timer and no new RelayClient is created", async () => {
    vi.useFakeTimers()
    try {
      captureHandler("unbien")
      await _connectForTest(makeMockCtx())
      expect(relayInstances).toHaveLength(1)

      relayInstances[0]!.emit("close")
      expect(_hasPendingReconnect()).toBe(true)

      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx())
      expect(_hasPendingReconnect()).toBe(false)
      expect(_getState()).toBe("idle")

      // Advance well past the largest backoff — no new attempt
      await vi.advanceTimersByTimeAsync(60_000)
      expect(relayInstances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("stale reconnect candidate cannot replace a stop/start Relay lifecycle", async () => {
    const staleConnect = deferred<void>()
    let staleConnectReleased = false
    let cleanedUp = false
    const meshNodeModule = await import("./session/mesh_node.js")
    const attachBridgeSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "attachBridge")
      .mockResolvedValue(undefined)

    try {
      _knownPeers.push({
        name: "Known Owner",
        remote_epk: OWNER_STANDARD_FIXTURE,
        paired_at: "now",
      })
      captureHandler("unbien")
      await _connectForTest(makeMockCtx())
      const originalRelay = relayInstances[0]!

      let deferNextConnect = true
      _defaultConnectImpl = () => {
        if (deferNextConnect) {
          deferNextConnect = false
          return staleConnect.promise
        }
        return Promise.resolve()
      }

      vi.useFakeTimers()
      originalRelay.emit("close")
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relayInstances).toHaveLength(2)
      const staleRelay = relayInstances[1]!
      expect(staleRelay.connect).toHaveBeenCalledTimes(1)
      vi.useRealTimers()

      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx())
      expect(_getState()).toBe("idle")

      await _connectForTest(makeMockCtx())
      expect(relayInstances).toHaveLength(3)
      const replacementRelay = relayInstances[2]!
      expect(_getState()).toBe("started")
      expect(attachBridgeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ relay: replacementRelay }),
      )

      staleConnectReleased = true
      staleConnect.resolve(undefined)
      await staleConnect.promise
      await Promise.resolve()

      expect(staleRelay.close).toHaveBeenCalledTimes(1)
      expect(
        attachBridgeSpy.mock.calls.some(
          ([options]) => (options.relay as unknown) === staleRelay,
        ),
      ).toBe(false)

      staleRelay.emit(
        "message",
        makeInnerLine(OWNER_STANDARD_FIXTURE, {
          type: "ping",
          id: "stale-route",
        }),
      )
      replacementRelay.emit(
        "message",
        makeInnerLine(OWNER_STANDARD_FIXTURE, {
          type: "ping",
          id: "replacement-route",
        }),
      )
      await vi.waitFor(() => expect(replacementRelay.send).toHaveBeenCalled())
      const replacementMessages = replacementRelay.send.mock.calls.map(
        (call) => decodeSentCt(call[0] as string).inner,
      )
      expect(replacementMessages).toContainEqual(
        expect.objectContaining({
          type: "pong",
          in_reply_to: "replacement-route",
        }),
      )
      expect(staleRelay.send).not.toHaveBeenCalled()
      expect(_hasPendingReconnect()).toBe(false)

      const relayCount = relayInstances.length
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(relayInstances).toHaveLength(relayCount)
      vi.useRealTimers()

      await stop("", makeMockCtx())
      cleanedUp = true
      expect(replacementRelay.close).toHaveBeenCalledTimes(1)
      expect(staleRelay.close).toHaveBeenCalledTimes(1)
      expect(_getState()).toBe("idle")
    } finally {
      vi.useRealTimers()
      if (!staleConnectReleased) staleConnect.resolve(undefined)
      await staleConnect.promise
      await Promise.resolve()
      if (!cleanedUp) {
        const stop = captureHandler("unbien stop")
        await stop("", makeMockCtx())
      }
      attachBridgeSpy.mockRestore()
    }
  })

  test("stale reconnect rejection after stop/start closes once and cannot retry", async () => {
    const staleConnect = deferred<void>()
    let staleSettled = false
    let cleanedUp = false
    const meshNodeModule = await import("./session/mesh_node.js")
    const attachBridgeSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "attachBridge")
      .mockResolvedValue(undefined)

    try {
      _knownPeers.push({
        name: "Known Owner",
        remote_epk: OWNER_STANDARD_FIXTURE,
        paired_at: "now",
      })
      captureHandler("unbien")
      await _connectForTest(makeMockCtx())
      const originalRelay = relayInstances[0]!

      let deferNextConnect = true
      _defaultConnectImpl = () => {
        if (deferNextConnect) {
          deferNextConnect = false
          return staleConnect.promise
        }
        return Promise.resolve()
      }

      vi.useFakeTimers()
      originalRelay.emit("close")
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relayInstances).toHaveLength(2)
      const staleRelay = relayInstances[1]!
      expect(staleRelay.connect).toHaveBeenCalledTimes(1)
      vi.useRealTimers()

      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx())
      await _connectForTest(makeMockCtx())
      expect(relayInstances).toHaveLength(3)
      const replacementRelay = relayInstances[2]!
      expect(_getState()).toBe("started")

      staleSettled = true
      staleConnect.reject(new Error("stale reconnect failed late"))
      await staleConnect.promise.catch(() => undefined)
      await vi.waitFor(() => expect(staleRelay.close).toHaveBeenCalledTimes(1))

      expect(replacementRelay.close).not.toHaveBeenCalled()
      expect(
        attachBridgeSpy.mock.calls.some(
          ([options]) => (options.relay as unknown) === staleRelay,
        ),
      ).toBe(false)
      expect(_hasPendingReconnect()).toBe(false)
      expect(_getState()).toBe("started")

      const relayCount = relayInstances.length
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(relayInstances).toHaveLength(relayCount)
      expect(_hasPendingReconnect()).toBe(false)
      vi.useRealTimers()

      await stop("", makeMockCtx())
      cleanedUp = true
      expect(replacementRelay.close).toHaveBeenCalledTimes(1)
      expect(staleRelay.close).toHaveBeenCalledTimes(1)
      expect(_getState()).toBe("idle")
    } finally {
      vi.useRealTimers()
      if (!staleSettled) staleConnect.reject(new Error("test cleanup"))
      await staleConnect.promise.catch(() => undefined)
      if (!cleanedUp) {
        const stop = captureHandler("unbien stop")
        await stop("", makeMockCtx())
      }
      attachBridgeSpy.mockRestore()
    }
  })

  test("/unbien stop cancels a deferred initial Relay lifecycle", async () => {
    const connectGate = deferred<void>()
    let connectReleased = false
    let connecting: Promise<void> | undefined
    const meshNodeModule = await import("./session/mesh_node.js")
    const attachBridgeSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "attachBridge")
      .mockResolvedValue(undefined)

    try {
      captureHandler("unbien")
      _defaultConnectImpl = () => connectGate.promise
      connecting = _connectForTest(makeMockCtx())
      await vi.waitFor(() => expect(relayInstances).toHaveLength(1))
      const candidateRelay = relayInstances[0]!
      expect(candidateRelay.connect).toHaveBeenCalledTimes(1)
      expect(_getState()).toBe("idle")

      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx())
      expect(_getState()).toBe("idle")

      connectReleased = true
      connectGate.resolve(undefined)
      await connecting

      expect(candidateRelay.close).toHaveBeenCalledTimes(1)
      expect(_getState()).toBe("idle")
      expect(attachBridgeSpy).not.toHaveBeenCalled()
    } finally {
      if (!connectReleased) connectGate.resolve(undefined)
      await connecting?.catch(() => undefined)
      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx())
      attachBridgeSpy.mockRestore()
    }
  })

  test("relay:off cancels a deferred initial Relay lifecycle", async () => {
    const connectGate = deferred<void>()
    let connectReleased = false
    let starting: Promise<void> | undefined
    const meshNodeModule = await import("./session/mesh_node.js")
    const attachBridgeSpy = vi
      .spyOn(meshNodeModule.MeshNode.prototype, "attachBridge")
      .mockResolvedValue(undefined)
    const cwd = `/tmp/unbien-control-cancel-${process.pid}-${Date.now()}`

    try {
      process.env["UNBIEN_DIRECT_CONFIG"] = JSON.stringify({
        agent_name: "control-cancel",
        auto_start_relay: false,
      })
      const root = captureHandler("unbien")
      await root("", makeMockCtx(cwd))
      expect(_hasMeshNodeForTest()).toBe(true)
      expect(_getState()).toBe("idle")

      _defaultConnectImpl = () => connectGate.promise
      starting = _handleControl("relay:on")
      await vi.waitFor(() => expect(relayInstances).toHaveLength(1))
      const candidateRelay = relayInstances[0]!
      expect(candidateRelay.connect).toHaveBeenCalledTimes(1)

      await _handleControl("relay:off")
      expect(_getState()).toBe("idle")

      connectReleased = true
      connectGate.resolve(undefined)
      await starting

      expect(candidateRelay.close).toHaveBeenCalledTimes(1)
      expect(_getState()).toBe("idle")
      expect(attachBridgeSpy).not.toHaveBeenCalled()
    } finally {
      if (!connectReleased) connectGate.resolve(undefined)
      await starting?.catch(() => undefined)
      delete process.env["UNBIEN_DIRECT_CONFIG"]
      const stop = captureHandler("unbien stop")
      await stop("", makeMockCtx(cwd))
      _resetCwdLockForTest()
      attachBridgeSpy.mockRestore()
    }
  })

  test("successful reconnect keeps the session started (clock survives the drop)", async () => {
    vi.useFakeTimers()
    try {
      captureHandler("unbien")
      await _connectForTest(makeMockCtx())
      _setSessionStartedAtForTest(1_700_000_000_000)

      relayInstances[0]!.emit("close")
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relayInstances).toHaveLength(2)

      // A reconnect must NOT reset the session: _sessionStartedAt is preserved
      // (session_sync_end carries it for pi-restart detection) and the transcript
      // itself re-fetches via the app's get_entries rpc — no buffer to preserve.
      expect(_getState()).toBe("started")
    } finally {
      vi.useRealTimers()
    }
  })

  test("reconnect that succeeds clears attempt counter (next close starts at 1s again)", async () => {
    vi.useFakeTimers()
    try {
      captureHandler("unbien")
      await _connectForTest(makeMockCtx())

      // First close → reconnect after 1s (succeeds)
      relayInstances[0]!.emit("close")
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relayInstances).toHaveLength(2)

      // Second close → must reschedule at 1s (not 2s)
      relayInstances[1]!.emit("close")
      expect(_hasPendingReconnect()).toBe(true)
      // Advance just below 1s — no new attempt yet
      await vi.advanceTimersByTimeAsync(999)
      expect(relayInstances).toHaveLength(2)
      // Cross the 1s boundary — attempt fires
      await vi.advanceTimersByTimeAsync(1)
      expect(relayInstances).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── cumulative message buffer (post-fix 15) ───────────────────────────────────

// ── model meta in room_meta + model_select hook ──────────────────────────────

describe("model meta", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _setRelayCalls.length = 0
    _savedRelayUrl = "https://relay.test"
    _tokenStatus = "ok"
    relayRef.current = null
    relayInstances.length = 0
    _defaultConnectImpl = async () => undefined
    delete process.env["UNBIEN_RELAY"]
    _setCurrentModelForTest(undefined)
    const qr = await import("./pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("hello carries `model` in room_meta when ctx.model is set", async () => {
    const capturedOpts: Array<{
      roomMeta?: { model?: string; name?: string; cwd?: string }
    }> = []
    _defaultConnectImpl = async (opts?: unknown) => {
      capturedOpts.push(
        opts as { roomMeta?: { model?: string; name?: string; cwd?: string } },
      )
    }

    captureHandler("unbien")
    const ctx = {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-model-test",
      abort: vi.fn(),
      model: { id: "claude-sonnet-4-5", name: "claude-sonnet-4.5" },
    } as unknown as ReturnType<typeof makeMockCtx>
    await _connectForTest(ctx)

    expect(capturedOpts).toHaveLength(1)
    expect(capturedOpts[0]!.roomMeta?.model).toBe("claude-sonnet-4.5")
    expect(capturedOpts[0]!.roomMeta?.name).toBeTruthy()
    expect(capturedOpts[0]!.roomMeta?.cwd).toBe("/tmp/unbien-model-test")
  })

  test("hello carries `model` from getModel() when ctx.model is absent (daemon path)", async () => {
    const capturedOpts: Array<{ roomMeta?: { model?: string } }> = []
    _defaultConnectImpl = async (opts?: unknown) => {
      capturedOpts.push(opts as { roomMeta?: { model?: string } })
    }

    captureHandler("unbien")
    // A headless daemon never fires model_select and has no `ctx.model`, but
    // its session resolved a default model that getModel() exposes — the fix
    // seeds room_meta from there so the app no longer shows "unknown".
    const ctx = {
      ui: { notify: vi.fn() },
      cwd: "/tmp/unbien-daemon-model",
      abort: vi.fn(),
      getModel: () => ({ id: "claude-opus-4-8", name: "claude-opus-4.8" }),
    } as unknown as ReturnType<typeof makeMockCtx>
    await _connectForTest(ctx)

    expect(capturedOpts).toHaveLength(1)
    expect(capturedOpts[0]!.roomMeta?.model).toBe("claude-opus-4.8")
  })

  test("hello omits `model` when ctx has none AND no default is configured", async () => {
    // Isolate from the machine's global settings (PI_CODING_AGENT_DIR → a
    // non-existent dir) so the settings fallback finds no default model; the
    // /tmp cwd has no project .pi/settings.json either.
    const prevAgentDir = process.env["PI_CODING_AGENT_DIR"]
    process.env["PI_CODING_AGENT_DIR"] = "/tmp/pi-no-such-agent-dir-omit"
    try {
      const capturedOpts: Array<{ roomMeta?: { model?: string } }> = []
      _defaultConnectImpl = async (opts?: unknown) => {
        capturedOpts.push(opts as { roomMeta?: { model?: string } })
      }

      captureHandler("unbien")
      await _connectForTest(makeMockCtx("/tmp/unbien-no-model"))

      expect(capturedOpts).toHaveLength(1)
      expect(capturedOpts[0]!.roomMeta?.model).toBeUndefined()
    } finally {
      if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]
      else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir
    }
  })

  test("hello carries `model` from configured default settings (idle daemon path)", async () => {
    // A headless daemon has no ctx.model/getModel at connect (the SDK resolves
    // the session model lazily at the first turn). The fix reads the configured
    // default from <cwd>/.pi/settings.json — the model the daemon WILL use.
    const cwd = mkdtempSync(join(tmpdir(), "pi-daemon-cfg-"))
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultProvider: "acme",
        defaultModel: "acme-model-zzz",
      }),
    )
    const prevAgentDir = process.env["PI_CODING_AGENT_DIR"]
    process.env["PI_CODING_AGENT_DIR"] = "/tmp/pi-no-such-agent-dir-daemon"
    try {
      const capturedOpts: Array<{ roomMeta?: { model?: string } }> = []
      _defaultConnectImpl = async (opts?: unknown) => {
        capturedOpts.push(opts as { roomMeta?: { model?: string } })
      }

      captureHandler("unbien")
      await _connectForTest(makeMockCtx(cwd)) // ctx has no model/getModel

      expect(capturedOpts).toHaveLength(1)
      // The test registry won't know "acme-model-zzz" → falls back to the id.
      expect(capturedOpts[0]!.roomMeta?.model).toBe("acme-model-zzz")
    } finally {
      if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]
      else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("pi.on('model_select') fires room_meta_update via relay.sendControl", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-model-switch"))

    const onModelSelect = captureEventHandler("model_select")
    onModelSelect({
      type: "model_select",
      model: { id: "gpt-4o-2024-08-06", name: "gpt-4o" },
    })

    const sendControlCalls = relayRef.current!.sendControl.mock.calls.map(
      (c) =>
        c[0] as {
          type: string
          room_id?: string
          meta?: { model?: string }
        },
    )
    const updates = sendControlCalls.filter(
      (f) => f.type === "room_meta_update",
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]!.meta?.model).toBe("gpt-4o")
    expect(updates[0]!.room_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  test("plan/32: pi.on('turn_start') publishes working=true via room_meta_update", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-working-on"))

    const onTurnStart = captureEventHandler("turn_start")
    onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 0 })

    const updates = relayRef
      .current!.sendControl.mock.calls.map(
        (c) =>
          c[0] as {
            type: string
            room_id?: string
            meta?: { working?: boolean }
          },
      )
      .filter((f) => f.type === "room_meta_update")
    expect(updates).toHaveLength(1)
    expect(updates[0]!.meta?.working).toBe(true)
    expect(updates[0]!.room_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  test("plan/32: pi.on('turn_end') publishes working=false via room_meta_update", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-working-off"))

    const onTurnEnd = captureEventHandler("turn_end")
    onTurnEnd({ type: "turn_end", turnIndex: 0 })

    const updates = relayRef
      .current!.sendControl.mock.calls.map(
        (c) => c[0] as { type: string; meta?: { working?: boolean } },
      )
      .filter((f) => f.type === "room_meta_update")
    expect(updates).toHaveLength(1)
    expect(updates[0]!.meta?.working).toBe(false)
  })

  test("plan/32: pi.on('session_before_compact') publishes working=true", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-compact-working"))

    const onBefore = captureEventHandler("session_before_compact")
    onBefore({ type: "session_before_compact" })

    const updates = relayRef
      .current!.sendControl.mock.calls.map(
        (c) => c[0] as { type: string; meta?: { working?: boolean } },
      )
      .filter((f) => f.type === "room_meta_update")
    expect(updates).toHaveLength(1)
    expect(updates[0]!.meta?.working).toBe(true)
  })

  test("model_select with no model.name falls back to model.id", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-model-fallback"))

    const onModelSelect = captureEventHandler("model_select")
    onModelSelect({
      type: "model_select",
      model: { id: "internal-fallback-id" }, // no name
    })

    const updates = relayRef
      .current!.sendControl.mock.calls.map(
        (c) => c[0] as { type: string; meta?: { model?: string } },
      )
      .filter((f) => f.type === "room_meta_update")
    expect(updates).toHaveLength(1)
    expect(updates[0]!.meta?.model).toBe("internal-fallback-id")
  })

  test("model_select with no model (undefined) is silently ignored", async () => {
    captureHandler("unbien")
    await _connectForTest(makeMockCtx("/tmp/unbien-model-noop"))

    const sendControlBefore = relayRef.current!.sendControl.mock.calls.length
    const onModelSelect = captureEventHandler("model_select")
    onModelSelect({ type: "model_select" }) // event arrived but model field missing

    expect(relayRef.current!.sendControl.mock.calls.length).toBe(
      sendControlBefore,
    )
  })

  test("reconnect replays the same room_id + room_meta from _cmdStart (no phantom 'legacy session')", async () => {
    vi.useFakeTimers()
    try {
      const capturedOpts: Array<{
        roomId?: string
        roomMeta?: { name?: string; cwd?: string; model?: string }
      }> = []
      _defaultConnectImpl = async (opts?: unknown) => {
        capturedOpts.push(opts as (typeof capturedOpts)[number])
      }

      captureHandler("unbien")
      const ctx = {
        ui: { notify: vi.fn() },
        cwd: "/tmp/unbien-reconnect-room",
        abort: vi.fn(),
        model: { id: "claude-sonnet-4-5", name: "claude-sonnet-4.5" },
      } as unknown as ReturnType<typeof makeMockCtx>
      await _connectForTest(ctx)

      expect(capturedOpts).toHaveLength(1)
      const initialRoomId = capturedOpts[0]!.roomId!
      expect(capturedOpts[0]!.roomMeta?.model).toBe("claude-sonnet-4.5")

      // Drop relay → reconnect path fires
      relayInstances[0]!.emit("close")
      await vi.advanceTimersByTimeAsync(1_000)

      // Second connect call must carry the same roomId + roomMeta (CRITICAL:
      // without this fix the reconnect issued a bare hello and the relay
      // bucketed it as a default-room peer.)
      expect(capturedOpts).toHaveLength(2)
      expect(capturedOpts[1]!.roomId).toBe(initialRoomId)
      expect(capturedOpts[1]!.roomMeta?.cwd).toBe("/tmp/unbien-reconnect-room")
      expect(capturedOpts[1]!.roomMeta?.model).toBe("claude-sonnet-4.5")
    } finally {
      vi.useRealTimers()
    }
  })

  test("reconnect after model_select carries the updated model in room_meta", async () => {
    vi.useFakeTimers()
    try {
      const capturedOpts: Array<{ roomMeta?: { model?: string } }> = []
      _defaultConnectImpl = async (opts?: unknown) => {
        capturedOpts.push(opts as { roomMeta?: { model?: string } })
      }

      captureHandler("unbien")
      const ctx = {
        ui: { notify: vi.fn() },
        cwd: "/tmp/unbien-reconnect-model",
        abort: vi.fn(),
        model: { id: "claude-sonnet-4-5", name: "claude-sonnet-4.5" },
      } as unknown as ReturnType<typeof makeMockCtx>
      await _connectForTest(ctx)

      // User switches model
      const onModelSelect = captureEventHandler("model_select")
      onModelSelect({
        type: "model_select",
        model: { id: "gpt-4o-2024-08-06", name: "gpt-4o" },
      })

      // Relay drops → reconnect uses the NEW model in its hello
      relayInstances[0]!.emit("close")
      await vi.advanceTimersByTimeAsync(1_000)

      expect(capturedOpts).toHaveLength(2)
      expect(capturedOpts[0]!.roomMeta?.model).toBe("claude-sonnet-4.5") // initial
      expect(capturedOpts[1]!.roomMeta?.model).toBe("gpt-4o") // post-switch
    } finally {
      vi.useRealTimers()
    }
  })
})
