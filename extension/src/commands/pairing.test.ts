/**
 * `/unbien revoke` + devices listing — command-surface tests, colocated
 * with commands/pairing.ts (carved out of extension.test.ts; the mock
 * harness is a verbatim copy so this file stays hermetic and isolated
 * from the core-lifecycle test file).
 */
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

vi.mock("../transport/relay_client.js", () => ({
  RelayClient: MockRelay,
  RoomAlreadyOpenError: MockRoomAlreadyOpenError,
}))

// ── Mock storage ──────────────────────────────────────────────────────────────

type StoredPeer = { name: string; remote_epk: string; paired_at: string }
const _knownPeers: StoredPeer[] = []
const _addedPeers: StoredPeer[] = []
const _removedPeers: string[] = []
let _meshOwnerDiscoveryEnabled = false

vi.mock("../pairing/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../pairing/storage.js")>()
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

vi.mock("../config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../config.js")>()
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

vi.mock("../pairing/qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../pairing/qr.js")>()
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

vi.mock("../mesh/self_revoke.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../mesh/self_revoke.js")>()
  class CapturingSelfRevoke extends original.SelfRevoke {
    constructor(options: ConstructorParameters<typeof original.SelfRevoke>[0]) {
      super(options)
      ;(selfRevokeHarness.options as unknown[]).push(options)
    }
  }
  return { ...original, SelfRevoke: CapturingSelfRevoke }
})

// Import AFTER mocks
const indexModule = await import("../index.js")
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
  _seedRootSessionForTest,
  _handleControl,
  _deliverMeshMessageToAgentForTest,
  CTRL_PREFIX,
} = indexModule
const { acquireCwdLock } = await import("../session/cwd_lock.js")

// Keyed per-session state (_sessions Map + _rootSessionId) is module-global;
// reset it at every test boundary so it can't leak across tests. NOT in
// _resetBridgeOwnersForTest — that fires mid-test on each captureEventHandler.
beforeEach(() => {
  _resetSessionsForTest()
  // design 01M1CAW0: no room announce before the session id exists — seed the
  // root session so relay-bringing-up tests run post-session (production
  // always has one by the time /unbien runs).
  _seedRootSessionForTest()
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

// ── /unbien revoke <shortid> ───────────────────────────────────────────────

describe("/unbien revoke", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _knownPeers.length = 0
    _addedPeers.length = 0
    _removedPeers.length = 0
    _consumeCalls.length = 0
    _tokenStatus = "ok"
    relayRef.current = null
    const qr = await import("../pairing/qr.js")
    ;(
      qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((token: string) => {
      _consumeCalls.push(token)
      return _tokenStatus
    })
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("empty arg → usage warning", async () => {
    _knownPeers.push({
      name: "Phone",
      remote_epk: "abcd1234efghIJKL",
      paired_at: "now",
    })

    const revoke = captureHandler("unbien revoke")
    const ctx = makeMockCtx()
    await revoke("", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /unbien revoke"),
      "warning",
    )
    expect(_removedPeers).toHaveLength(0)
  })

  test("idle (relay off) → refuses instead of a silent peers.json edit", async () => {
    _knownPeers.push({
      name: "Phone",
      remote_epk: "aaaa1111zzzz",
      paired_at: "now",
    })

    // beforeEach stopped the relay; an isolated empty cwd guarantees no local
    // config on every OS, so revoke bails (mirrors pair) rather than editing
    // the file offline. (Fresh tmpdir — see the "pair without start" test.)
    const cwd = mkdtempSync(join(tmpdir(), "pi-ext-cwd-"))
    const revoke = captureHandler("unbien revoke")
    const ctx = makeMockCtx(cwd)
    await revoke("aaaa1111", ctx)

    expect(_removedPeers).toHaveLength(0)
    expect(_knownPeers).toHaveLength(1)
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("First-time setup needed"),
      "warning",
    )
    rmSync(cwd, { recursive: true, force: true })
  })

  test("valid shortid → peer removed + success notify", async () => {
    _knownPeers.push({
      name: "Phone A",
      remote_epk: OWNER_STANDARD_FIXTURE,
      paired_at: "now",
    })
    _knownPeers.push({
      name: "Phone B",
      remote_epk: OTHER_OWNER_STANDARD_FIXTURE,
      paired_at: "now",
    })

    // Revoke now requires the relay (mirrors pair) — bring it up first.
    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    const revoke = captureHandler("unbien revoke")
    const ctx = makeMockCtx()
    await revoke(OWNER_STANDARD_FIXTURE.slice(0, 8), ctx)

    expect(_removedPeers).toEqual([OWNER_STANDARD_FIXTURE])
    expect(_knownPeers.map((p) => p.name)).toEqual(["Phone B"])
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Revoked: Phone A"),
      "info",
    )
  })

  test("unknown shortid → no peer matching warning, peers untouched", async () => {
    _knownPeers.push({
      name: "Phone",
      remote_epk: "cccc3333",
      paired_at: "now",
    })

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    const revoke = captureHandler("unbien revoke")
    const ctx = makeMockCtx()
    await revoke("ffffffff", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No peer matching that shortid"),
      "warning",
    )
    expect(_removedPeers).toHaveLength(0)
    expect(_knownPeers).toHaveLength(1)
  })

  test("ambiguous shortid (>1 match) → ambiguity warning, peers untouched", async () => {
    _knownPeers.push({
      name: "A",
      remote_epk: "abcd1111-invalid",
      paired_at: "now",
    })
    _knownPeers.push({
      name: "B",
      remote_epk: "abcd2222-invalid",
      paired_at: "now",
    })

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    const revoke = captureHandler("unbien revoke")
    const ctx = makeMockCtx()
    await revoke("abcd", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Ambiguous shortid"),
      "warning",
    )
    expect(_removedPeers).toHaveLength(0)
    expect(_knownPeers).toHaveLength(2)
  })

  test("revoke of currently-attached owner → channel removed, relay stays started", async () => {
    // Multi-channel (W2D): revoking the only attached owner removes their
    // channel from _activePeers but leaves the relay up. Pre-W2D this went
    // all the way back to `idle` via _goIdle; that's no longer the case.
    _tokenStatus = "ok"
    const ACTIVE_PEER = OWNER_STANDARD_FIXTURE

    captureHandler("unbien")
    await _connectForTest(makeMockCtx())

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: ACTIVE_PEER,
        ct: Buffer.from(
          JSON.stringify({
            type: "pair_request",
            id: "req-1",
            token: "test-token",
            device_name: "Active Phone",
          }),
        ).toString("base64"),
      }),
    )
    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })

    const revoke = captureHandler("unbien revoke")
    const ctx = makeMockCtx()
    await revoke(OWNER_STANDARD_FIXTURE.slice(0, 8), ctx)

    // Channel torn down, but relay still listening for new pairings.
    expect(_hasActivePeerForTest(ACTIVE_PEER)).toBe(false)
    expect(_getState()).toBe("started")
    expect(_removedPeers).toEqual([ACTIVE_PEER])
    expect(_knownPeers).toHaveLength(0)
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Revoked: Active Phone"),
      "info",
    )
  })

  test("URL-safe raw records revoke exactly one record and detach by canonical identity", async () => {
    const malformedRawOwner = "malformed-owner/+not-a-public-key"
    _knownPeers.push(
      {
        name: "URL-safe Owner",
        remote_epk: OWNER_URL_SAFE_FIXTURE,
        paired_at: "now",
      },
      { name: "Malformed", remote_epk: malformedRawOwner, paired_at: "now" },
      {
        name: "Other Owner",
        remote_epk: OTHER_OWNER_STANDARD_FIXTURE,
        paired_at: "now",
      },
    )

    await _connectForTest(makeMockCtx())
    relayRef.current!.emit(
      "message",
      makeInnerLine(OWNER_STANDARD_FIXTURE, {
        type: "ping",
        id: "url-safe-owner",
      }),
    )
    relayRef.current!.emit(
      "message",
      makeInnerLine(OTHER_OWNER_STANDARD_FIXTURE, {
        type: "ping",
        id: "other-owner",
      }),
    )
    await vi.waitFor(() => expect(_getActivePeerCountForTest()).toBe(2))

    const revoke = captureHandler("unbien revoke")
    await revoke(OWNER_URL_SAFE_FIXTURE, makeMockCtx())
    expect(_removedPeers).toEqual([OWNER_URL_SAFE_FIXTURE])
    expect(_hasActivePeerForTest(OWNER_STANDARD_FIXTURE)).toBe(false)
    expect(_hasActivePeerForTest(OTHER_OWNER_STANDARD_FIXTURE)).toBe(true)

    await revoke(malformedRawOwner, makeMockCtx())
    expect(_removedPeers).toEqual([OWNER_URL_SAFE_FIXTURE, malformedRawOwner])
    expect(_hasActivePeerForTest(OTHER_OWNER_STANDARD_FIXTURE)).toBe(true)
  })

  test("strict Owner snapshot detaches and reports only the absent active Owner", async () => {
    _meshOwnerDiscoveryEnabled = true
    _knownPeers.push(
      {
        name: "URL-safe Owner",
        remote_epk: OWNER_URL_SAFE_FIXTURE,
        paired_at: "now",
      },
      {
        name: "Other Owner",
        remote_epk: OTHER_OWNER_STANDARD_FIXTURE,
        paired_at: "now",
      },
    )
    const sendMessage = vi.fn()
    const fetchMock = vi.fn(
      async () => ({ status: 404, json: async () => ({}) }) as Response,
    )
    vi.stubGlobal("fetch", fetchMock)

    try {
      captureHandler("unbien")
      _setPiForTest({ sendMessage, sendUserMessage: () => undefined })
      await _connectForTest(makeMockCtx())
      expect(fetchMock).toHaveBeenCalledTimes(2)

      relayRef.current!.emit(
        "message",
        makeInnerLine(OWNER_STANDARD_FIXTURE, {
          type: "ping",
          id: "absent-owner-active",
        }),
      )
      relayRef.current!.emit(
        "message",
        makeInnerLine(OTHER_OWNER_STANDARD_FIXTURE, {
          type: "ping",
          id: "surviving-owner-active",
        }),
      )
      await vi.waitFor(() => expect(_getActivePeerCountForTest()).toBe(2))

      _knownPeers.splice(
        _knownPeers.findIndex(
          (peer) => peer.remote_epk === OWNER_URL_SAFE_FIXTURE,
        ),
        1,
      )
      await _checkSelfRevokeForTest()

      expect(_hasActivePeerForTest(OWNER_STANDARD_FIXTURE)).toBe(false)
      expect(_hasActivePeerForTest(OTHER_OWNER_STANDARD_FIXTURE)).toBe(true)
      const reports = sendMessage.mock.calls
        .map(
          ([message]) => message as { customType?: string; content?: string },
        )
        .filter((message) => message.customType === "un-bien:mesh-revoked")
      expect(reports).toHaveLength(1)
      expect(reports[0]?.content).toContain(
        createHash("sha256")
          .update(OWNER_PUBLIC_FIXTURE)
          .digest("hex")
          .slice(0, 8),
      )
    } finally {
      _meshOwnerDiscoveryEnabled = false
      vi.unstubAllGlobals()
    }
  })

  test("devices listing marks online/offline per attached channel", async () => {
    _tokenStatus = "ok"
    const ACTIVE_PEER = OWNER_STANDARD_FIXTURE
    _knownPeers.push({
      name: "Idle Peer",
      remote_epk: OTHER_OWNER_STANDARD_FIXTURE,
      paired_at: "now",
    })

    await _connectForTest(makeMockCtx())

    relayRef.current!.emit(
      "message",
      JSON.stringify({
        peer: ACTIVE_PEER,
        ct: Buffer.from(
          JSON.stringify({
            type: "pair_request",
            id: "req-1",
            token: "test-token",
            device_name: "Active Phone",
          }),
        ).toString("base64"),
      }),
    )
    await vi.waitFor(() => expect(_getState()).toBe("paired"), {
      timeout: 2000,
    })

    const devices = captureHandler("unbien devices")
    const ctx = makeMockCtx()
    await devices("", ctx)

    const text = ctx.ui.notify.mock.calls[0]![0] as string
    // The attached owner shows online; the un-attached one shows offline.
    expect(text).toContain(
      `${OWNER_STANDARD_FIXTURE.slice(0, 8)} — Active Phone 🟢 online`,
    )
    expect(text).toContain(
      `${OTHER_OWNER_STANDARD_FIXTURE.slice(0, 8)} — Idle Peer ⚪ offline`,
    )
  })
})
