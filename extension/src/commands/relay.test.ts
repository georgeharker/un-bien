/**
 * `/unbien set-relay` + `relay` verbs + config/status — command-surface
 * tests, colocated with commands/relay.ts (carved out of
 * extension.test.ts; the mock harness is a verbatim copy so this file
 * stays hermetic and isolated from the core-lifecycle test file).
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

// ── /unbien set-relay + /unbien config ──────────────────────────────────

describe("/unbien set-relay + config", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    _savedRelayUrl = null
    _setRelayCalls.length = 0
    delete process.env["UNBIEN_RELAY"]
    relayRef.current = null
    const stop = captureHandler("unbien stop")
    await stop("", makeMockCtx())
  })

  test("set-relay empty arg → usage warning, nothing saved", async () => {
    const setRelay = captureHandler("unbien set-relay")
    const ctx = makeMockCtx()
    await setRelay("", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /unbien set-relay"),
      "warning",
    )
    expect(_setRelayCalls).toHaveLength(0)
  })

  test("set-relay stores http:// as-is (canonical scheme)", async () => {
    const setRelay = captureHandler("unbien set-relay")
    const ctx = makeMockCtx()
    await setRelay("http://foo:3000", ctx)

    expect(_setRelayCalls).toEqual(["http://foo:3000"])
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("http://foo:3000"),
      "info",
    )
  })

  test("set-relay stores https:// as-is (canonical scheme)", async () => {
    const setRelay = captureHandler("unbien set-relay")
    const ctx = makeMockCtx()
    await setRelay("https://relay.example.tld", ctx)

    expect(_setRelayCalls).toEqual(["https://relay.example.tld"])
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("https://relay.example.tld"),
      "info",
    )
  })

  test("set-relay rejects ws:// scheme with conversion hint", async () => {
    const setRelay = captureHandler("unbien set-relay")
    const ctx = makeMockCtx()
    await setRelay("ws://foo:3000", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Use http:// or https://"),
      "error",
    )
    expect(_setRelayCalls).toHaveLength(0)
  })

  test("set-relay rejects wss:// scheme with conversion hint", async () => {
    const setRelay = captureHandler("unbien set-relay")
    const ctx = makeMockCtx()
    await setRelay("wss://relay.example.tld", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Use http:// or https://"),
      "error",
    )
    expect(_setRelayCalls).toHaveLength(0)
  })

  test("set-relay rejects malformed URL", async () => {
    const setRelay = captureHandler("unbien set-relay")
    const ctx = makeMockCtx()
    await setRelay("not a url at all", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid URL"),
      "error",
    )
    expect(_setRelayCalls).toHaveLength(0)
  })

  test("set-relay persists http:// URL via saveConfig (canonical form)", async () => {
    const setRelay = captureHandler("unbien set-relay")
    const ctx = makeMockCtx()
    await setRelay("http://192.168.1.10:3000", ctx)

    expect(_setRelayCalls).toEqual(["http://192.168.1.10:3000"])
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Relay set to http://192.168.1.10:3000"),
      "info",
    )
  })

  // Issue #119: `relay url` / `relay stop` were documented in the README but
  // had no handler — every `relay …` fell through to the status panel, so a
  // user following the README silently stayed on the community relay.
  test("relay url persists the URL through the same writer as set-relay", async () => {
    const relay = captureHandler("unbien relay")
    const ctx = makeMockCtx()
    await relay("url http://192.168.1.20:3000", ctx)

    expect(_setRelayCalls).toEqual(["http://192.168.1.20:3000"])
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Relay set to http://192.168.1.20:3000"),
      "info",
    )
  })

  test("relay url rejects ws:// like set-relay does", async () => {
    const relay = captureHandler("unbien relay")
    const ctx = makeMockCtx()
    await relay("url ws://foo:3000", ctx)

    expect(_setRelayCalls).toHaveLength(0)
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Use http:// or https://"),
      "error",
    )
  })

  test("relay stop on an idle relay reports it instead of silently reprinting status", async () => {
    const relay = captureHandler("unbien relay")
    const ctx = makeMockCtx()
    await relay("stop", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already disconnected"),
      "info",
    )
  })

  test("relay with an unknown verb prints usage", async () => {
    const relay = captureHandler("unbien relay")
    const ctx = makeMockCtx()
    await relay("frobnicate", ctx)

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /unbien relay"),
      "warning",
    )
  })

  test("resolveRelayUrl: env > config > unset (all canonicalized to http(s)://)", async () => {
    const cfg = await import("../config.js")
    const { resolveRelayUrl } = cfg

    // 1) Nothing set → unset (no built-in default)
    expect(resolveRelayUrl()).toEqual({
      url: null,
      source: "unset",
    })

    // 2) Config set, no env → config. Legacy ws:// in config gets coerced
    // back to canonical http(s):// by resolveRelayUrl.
    _savedRelayUrl = "ws://config.test"
    expect(resolveRelayUrl()).toEqual({
      url: "http://config.test",
      source: "config",
    })

    // 3) Env set → env wins over config. Same defensive coercion.
    process.env["UNBIEN_RELAY"] = "wss://env.test"
    expect(resolveRelayUrl()).toEqual({
      url: "https://env.test",
      source: "env",
    })
    delete process.env["UNBIEN_RELAY"]
  })

  test("/unbien status shows the saved URL after set-relay", async () => {
    const setRelay = captureHandler("unbien set-relay")
    await setRelay("http://10.0.0.5:4000", makeMockCtx())

    const status = captureHandler("unbien status")
    const ctx = makeMockCtx()
    await status("", ctx)

    const text = ctx.ui.notify.mock.calls[0]![0] as string
    expect(text).toContain("http://10.0.0.5:4000")
  })

  test("/unbien status shows 'not configured' when nothing set (no built-in default)", async () => {
    _savedRelayUrl = null
    const status = captureHandler("unbien status")
    const ctx = makeMockCtx()
    await status("", ctx)

    const text = ctx.ui.notify.mock.calls[0]![0] as string
    expect(text).toContain("not configured")
    expect(text).not.toContain("relay-rp1.jacobmoura.work")
  })

  test("/unbien status reflects env override (canonicalized to https://)", async () => {
    // Env var with wss:// is coerced back to https:// by resolveRelayUrl.
    process.env["UNBIEN_RELAY"] = "wss://from-env.test"
    const status = captureHandler("unbien status")
    const ctx = makeMockCtx()
    await status("", ctx)

    const text = ctx.ui.notify.mock.calls[0]![0] as string
    expect(text).toContain("https://from-env.test")
    delete process.env["UNBIEN_RELAY"]
  })

  test("saved URL is used by _cmdStart on next connect (http:// stored as-is)", async () => {
    const setRelay = captureHandler("unbien set-relay")
    await setRelay("http://10.0.0.5:4000", makeMockCtx())

    captureHandler("unbien")
    const ctx = makeMockCtx()
    await _connectForTest(ctx)

    expect(_getState()).toBe("started")
    // The "Connecting to relay <url>" notify shows the canonical http(s)://
    // form. Transport converts to ws(s):// internally before opening WS.
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("http://10.0.0.5:4000"),
      "info",
    )
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("source: config"),
      "info",
    )
  })
})
