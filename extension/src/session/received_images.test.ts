/**
 * Received-image preview pipeline tests — colocated with
 * session/received_images.ts (carved out of extension.test.ts's
 * "multi-channel broadcast (W2D)" describe; the mock harness is a verbatim
 * copy so this file stays hermetic and isolated from the core-lifecycle test
 * file). Tests keep importing ../index.js for the harness: the pipeline is
 * threaded through index.ts's ImagePipelineDeps, so the extension factory is
 * the entry point.
 */
import { describe, expect, test, vi, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
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
          if (filtered.length !== before) return { outcome: "not_found" }
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
  _resetBridgeOwnersForTest,
  _setPiForTest,
  _connectForTest,
  _resetSessionsForTest,
  _seedRootSessionForTest,
} = indexModule

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

function makeMockCtx(cwd = "/home/user/projects/remote_pi") {
  return { ui: { notify: vi.fn() }, cwd, abort: vi.fn() }
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

// ── Event-handler capture ─────────────────────────────────────────────────────

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

// ── Received-image preview pipeline ───────────────────────────────────────────
//
// Carved out of extension.test.ts's "multi-channel broadcast (W2D)" describe.
// The generic pure-data context-filter test stayed with the core-lifecycle
// file (it pins the issue-#105 filter that lives in index.ts, not the image
// pipeline).

describe("received-image previews", () => {
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
})
