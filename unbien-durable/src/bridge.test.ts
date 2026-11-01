/**
 * Bridge pairing tests — the pair-on-startup QR minting + the pair_request
 * handshake, round-tripped through ONE DurableBridge. The feature's whole
 * point: the qrSession that MINTS the invite is the same one the
 * pair_request handler consumes from, so mint → scan → pair_ok never
 * crosses a process boundary and "token was not issued by this host" is
 * structurally impossible.
 *
 * Hermetic: temp state root (identity.json + peers.json under
 * $UNBIEN_STATE_DIR, pinned before the bridge's transitive storage import
 * freezes it), a locked keyring (the file-identity fallback exactly as a
 * headless box takes), a fake RelayClient (no socket), and a shrunk
 * rotation cadence so rotation is observable in real milliseconds.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "@earendil-works/chord"
import type { Conversation, Harness } from "@earendil-works/pi-durable"
import type {
  Ed25519Keypair,
  KeyStoreBackend,
  RelayClient,
} from "@geohar/un-bien/durable"
// Type-only: erased at runtime, so it does not trigger the bridge's
// transitive storage import before the env is pinned below.
import type { DurableBridgeOptions } from "./bridge.js"

// The pairing storage module freezes the state root (identity.json /
// peers.json paths) at import, so the env must land BEFORE the bridge (and
// its transitive storage import) is first evaluated — same discipline as
// the CLI's --state-dir.
const TMP_HOME = mkdtempSync(join(tmpdir(), "unbien-bridge-"))
const STATE_DIR = join(TMP_HOME, "state")
process.env.UNBIEN_STATE_DIR = STATE_DIR
// The config resolver reads un-bien.json under the agent dir; pinning it
// keeps the developer's real config out of the identity backend decision.
process.env.PI_CODING_AGENT_DIR = join(TMP_HOME, ".pi")
delete process.env.UNBIEN_IDENTITY_SEED
delete process.env.UNBIEN_RELAY

const { DurableBridge } = await import("./bridge.js")
const storage = await import("@geohar/un-bien/durable")
const {
  generateEd25519Keypair,
  roomIdForSession,
} = storage

/** A keyring that is permanently locked: every read/write throws, so the
 *  resolver takes the file-identity fallback without touching the OS. */
class LockedKeyring implements KeyStoreBackend {
  async read(): Promise<string | undefined> {
    throw new Error("simulated locked keyring")
  }
  async write(): Promise<void> {
    throw new Error("simulated locked keyring")
  }
  async delete(): Promise<boolean> {
    return false
  }
}

/** RelayClient double: records everything sent, lets the test deliver
 *  inbound lines. The bridge touches connect / on / off / send /
 *  sendControl / close — nothing else. */
class FakeRelay {
  readonly sent: string[] = []
  readonly control: unknown[] = []
  private readonly messageHandlers = new Set<(line: string) => void>()
  private readonly closeHandlers = new Set<(line: string) => void>()
  closed = false

  async connect(): Promise<void> {
    /* accept any room */
  }
  on(event: string, handler: (line: string) => void): void {
    if (event === "message") this.messageHandlers.add(handler)
    else if (event === "close") this.closeHandlers.add(handler)
  }
  off(event: string, handler: (line: string) => void): void {
    if (event === "message") this.messageHandlers.delete(handler)
  }
  send(line: string): void {
    this.sent.push(line)
  }
  sendControl(frame: unknown): void {
    this.control.push(frame)
  }
  close(): void {
    this.closed = true
  }
  deliver(line: string): void {
    for (const handler of [...this.messageHandlers]) handler(line)
  }
}

/** The bridge serves this.conversation's room and the handshake's
 *  attachOwner reads this.port.sessionId; the full attach() needs a live
 *  pi-durable harness, out of scope for the pairing surface. The seam sets
 *  exactly those two privates. */
function makeBridge(opts?: {
  rotationMs?: number
  pairingQr?: boolean
  shutdownHost?: () => Promise<void>
}): {
  bridge: InstanceType<typeof DurableBridge>
  relay: FakeRelay
  logs: string[]
} {
  const relay = new FakeRelay()
  const logs: string[] = []
  const options: DurableBridgeOptions = {
    harness: {} as Harness,
    context: {} as Context,
    relayUrl: "http://relay.test",
    displayName: "durable-test",
    cwd: TMP_HOME,
    log: (message) => {
      logs.push(message)
    },
    shutdownHost: opts?.shutdownHost ?? (async () => {}),
    createRelay: (_wsUrl: string, _keypair: Ed25519Keypair) =>
      relay as unknown as RelayClient,
  }
  if (opts?.rotationMs !== undefined)
    options.pairingRotationMs = opts.rotationMs
  if (opts?.pairingQr !== undefined) options.pairingQr = opts.pairingQr
  const bridge = new DurableBridge(options)
  const seam = bridge as unknown as {
    conversation: Conversation
    port: { sessionId: string }
  }
  seam.conversation = { id: 1 } as unknown as Conversation
  seam.port = { sessionId: "sess-1" }
  return { bridge, relay, logs }
}

/** Real-timer settle: the rotation + handshake chains are fs-async, a few
 *  event-loop turns each. */
const flush = (ms = 15): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const URI_RE = /unbien:\/\/pair\?\S+/

function pairingUris(logs: readonly string[]): string[] {
  const uris: string[] = []
  for (const line of logs.join("\n").split("\n")) {
    const match = URI_RE.exec(line)
    if (match) uris.push(match[0])
  }
  return uris
}

function tokenOf(uri: string): string {
  return new URL(uri).searchParams.get("t") ?? ""
}

/** The relay's outer wire frame for a peer-directed inner message. */
function outerFrame(
  appPeerId: string,
  inner: Record<string, unknown>,
): string {
  return JSON.stringify({
    peer: appPeerId,
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
  })
}

function parseSent(
  line: string,
): { peer: string; inner: Record<string, unknown> } {
  const outer = JSON.parse(line) as { peer: string; ct: string }
  return {
    peer: outer.peer,
    inner: JSON.parse(
      Buffer.from(outer.ct, "base64").toString("utf8"),
    ) as Record<string, unknown>,
  }
}

/** A fresh app identity (the scanning phone's Ed25519 handle). */
function appPeerId(): string {
  return Buffer.from(generateEd25519Keypair().publicKey).toString(
    "base64",
  )
}

/** Wipe peers.json (the revoke path) — absence reads as "no peers". */
function rmPeers(): void {
  try {
    rmSync(join(STATE_DIR, "peers.json"))
  } catch {
    /* already absent */
  }
}

beforeEach(() => {
  storage._setKeyStoreBackendForTest(new LockedKeyring())
  storage._setKeyringExpectedForTest(false)
  storage._setKeyringRetryForTest(1, 0)
  rmPeers()
})

afterEach(() => {
  storage._setKeyStoreBackendForTest(null)
  storage._setKeyringExpectedForTest(null)
  storage._setKeyringRetryForTest(null)
})

describe("DurableBridge pair-on-startup QR", () => {
  it("start() unpaired mints an invite the same bridge's handler consumes into pair_ok", async () => {
    const { bridge, relay, logs } = makeBridge()
    await bridge.start()
    await flush()

    // The invite is in the host log (the docker logs surface), QR + URI.
    const [uri] = pairingUris(logs)
    expect(uri).toBeDefined()
    expect(logs.join("\n")).toContain("█")
    const url = new URL(uri!)
    expect(url.searchParams.get("n")).toBe("durable-test")
    expect(url.searchParams.get("rm")).toBe(roomIdForSession("1"))
    const kp = await storage.getOrCreateEd25519Keypair()
    expect(url.searchParams.get("epk")).toBe(
      Buffer.from(kp.publicKey).toString("base64url"),
    )

    // The scan: pair_request carrying the JUST-minted token, delivered on
    // the fake relay to the bridge's own auto-listener.
    const peer = appPeerId()
    relay.deliver(
      outerFrame(peer, {
        type: "pair_request",
        id: "pr-1",
        token: tokenOf(uri!),
        device_name: "Pixel Test",
      }),
    )
    await flush()

    const pairOk = relay.sent
      .map(parseSent)
      .find((f) => f.peer === peer && f.inner["type"] === "pair_ok")
    expect(pairOk).toBeDefined()
    expect(pairOk!.inner["in_reply_to"]).toBe("pr-1")
    expect(pairOk!.inner["session_name"]).toBe("durable-test")
    expect(pairOk!.inner["room_id"]).toBe(roomIdForSession("1"))

    // The owner landed in peers.json and the allow-list re-push admitted it.
    const peers = await storage.listPeers()
    expect(peers.map((p) => p.remote_epk)).toContain(peer)
    expect(
      relay.control.some((f) => (f as { type?: string }).type === "pairing_set"),
    ).toBe(true)

    await bridge.stop()
  })

  it("start() with a paired peer prints no QR", async () => {
    await storage.addPeer({
      name: "Existing Phone",
      remote_epk: appPeerId(),
      paired_at: new Date().toISOString(),
    })
    // A shrunk cadence: had the arming ignored peers.json, a QR would show
    // within the first ticks.
    const { bridge, logs } = makeBridge({ rotationMs: 25 })
    await bridge.start()
    await flush(90)
    expect(pairingUris(logs)).toEqual([])
    await bridge.stop()
  })

  it("start() with pairingQr:false never mints — no QR, no tokens issued", async () => {
    // The host's --no-pairing-qr / UNBIEN_NO_PAIRING_QR suppression: no
    // auto-minted invite while unpaired, and qrSession issued nothing a
    // later scan could consume.
    const { bridge, relay, logs } = makeBridge({ rotationMs: 25, pairingQr: false })
    await bridge.start()
    await flush(90)
    expect(pairingUris(logs)).toEqual([])

    // Even a pair_request with a guessable/forged token is refused.
    const peer = appPeerId()
    relay.deliver(
      outerFrame(peer, {
        type: "pair_request",
        id: "pr-suppressed",
        token: "forged",
        device_name: "Sneaky Phone",
      }),
    )
    await flush()
    const pairOk = relay.sent
      .map(parseSent)
      .find((f) => f.peer === peer && f.inner["type"] === "pair_ok")
    expect(pairOk).toBeUndefined()
    expect((await storage.listPeers()).map((p) => p.remote_epk)).not.toContain(
      peer,
    )
    await bridge.stop()
  })

  it("rotates fresh tokens while unpaired — a superseded invite is dead", async () => {
    const { bridge, relay, logs } = makeBridge({ rotationMs: 25 })
    await bridge.start()
    await flush()
    expect(pairingUris(logs)).toHaveLength(1)
    const firstToken = tokenOf(pairingUris(logs)[0]!)

    await flush(90) // a few rotation ticks
    const uris = pairingUris(logs)
    expect(uris.length).toBeGreaterThan(1)
    const latestToken = tokenOf(uris[uris.length - 1]!)
    expect(latestToken).not.toBe(firstToken)

    // The FIRST token no longer answers: issueToken replaced it, so a late
    // scan of the stale QR gets token_unknown (the app re-scans the
    // current QR).
    const peer = appPeerId()
    relay.deliver(
      outerFrame(peer, {
        type: "pair_request",
        id: "pr-stale",
        token: firstToken,
        device_name: "Stale Scan",
      }),
    )
    await flush()
    const stale = relay.sent
      .map(parseSent)
      .find((f) => f.inner["in_reply_to"] === "pr-stale")
    expect(stale?.inner["type"]).toBe("pair_error")
    expect(stale?.inner["code"]).toBe("token_unknown")
    expect((await storage.listPeers()).map((p) => p.remote_epk)).not.toContain(
      peer,
    )

    await bridge.stop()
  })

  it("stops rotating once a device pairs — and the consumed invite stops answering", async () => {
    // Generous cadence: the pair handshake (fs-async) must win the race
    // against the next tick, so the test pairs with the CURRENT invite.
    const { bridge, relay, logs } = makeBridge({ rotationMs: 250 })
    await bridge.start()
    await flush()
    const urisAtStart = pairingUris(logs)
    expect(urisAtStart).toHaveLength(1)

    const peer = appPeerId()
    relay.deliver(
      outerFrame(peer, {
        type: "pair_request",
        id: "pr-1",
        token: tokenOf(urisAtStart[0]!),
        device_name: "Pixel Test",
      }),
    )
    await flush()
    expect(
      relay.sent
        .map(parseSent)
        .some((f) => f.peer === peer && f.inner["type"] === "pair_ok"),
    ).toBe(true)

    // Long past several cadences — no further invite was minted.
    await flush(700)
    expect(pairingUris(logs)).toHaveLength(1)

    // A re-scan of the (now consumed) invite is refused, not re-paired.
    const stranger = appPeerId()
    relay.deliver(
      outerFrame(stranger, {
        type: "pair_request",
        id: "pr-2",
        token: tokenOf(urisAtStart[0]!),
        device_name: "Stale Scan",
      }),
    )
    await flush()
    const stale = relay.sent
      .map(parseSent)
      .find((f) => f.inner["in_reply_to"] === "pr-2")
    expect(stale?.inner["type"]).toBe("pair_error")
    expect(stale?.inner["code"]).toBe("token_consumed")
    expect((await storage.listPeers()).map((p) => p.remote_epk)).not.toContain(
      stranger,
    )

    await bridge.stop()
  })

  it("re-arms after revocation: the next start() mints again", async () => {
    // Pair through one bridge run…
    const first = makeBridge()
    await first.bridge.start()
    await flush()
    const uri = pairingUris(first.logs)[0]!
    const peer = appPeerId()
    first.relay.deliver(
      outerFrame(peer, {
        type: "pair_request",
        id: "pr-1",
        token: tokenOf(uri),
        device_name: "Pixel Test",
      }),
    )
    await flush()
    expect(
      first.relay.sent
        .map(parseSent)
        .some((f) => f.peer === peer && f.inner["type"] === "pair_ok"),
    ).toBe(true)
    await first.bridge.stop()

    // …then revocation empties peers.json and the next start() rotates
    // again (fresh token on the shared qrSession, same machine identity).
    rmPeers()
    const second = makeBridge()
    await second.bridge.start()
    await flush()
    const uris = pairingUris(second.logs)
    expect(uris).toHaveLength(1)
    expect(tokenOf(uris[0]!)).not.toBe(tokenOf(uri))
    await second.bridge.stop()
  })
})

describe("DurableBridge ub-plane session_fork / session_navigate", () => {
  /** Pair a peer through the real handshake (active owner channel),
   *  optionally injecting a session-control double via the test seam. */
  async function pairedBridge(opts?: {
    control?: { fork: unknown; navigateTree: unknown }
    shutdownHost?: () => Promise<void>
  }): Promise<{
    bridge: InstanceType<typeof DurableBridge>
    relay: FakeRelay
    logs: string[]
    peer: string
  }> {
    const made = makeBridge(
      opts?.shutdownHost ? { shutdownHost: opts.shutdownHost } : undefined,
    )
    if (opts?.control !== undefined) {
      const seam = made.bridge as unknown as { control: unknown }
      seam.control = opts.control
    }
    await made.bridge.start()
    await flush()
    const uri = pairingUris(made.logs)[0]!
    const peer = appPeerId()
    made.relay.deliver(
      outerFrame(peer, {
        type: "pair_request",
        id: "pr-1",
        token: tokenOf(uri),
        device_name: "Pixel Test",
      }),
    )
    await flush()
    return { ...made, peer }
  }

  /** The app's wire shape (RelayConnection.mapToWire): the ClientMessage is
   *  a ub-plane ENVELOPE — `{type:"ub", ub:{…}}` — routed by the owner
   *  channel to the bridge's ub dispatcher. */
  function ubEnvelope(
    peer: string,
    ub: Record<string, unknown>,
  ): string {
    return outerFrame(peer, { type: "ub", ts: 1, protocolVersion: 1, ub })
  }

  /** The ub error frames the bridge replied, off the sent wire. */
  function ubErrors(relay: FakeRelay): Array<Record<string, unknown>> {
    return relay.sent
      .map(parseSent)
      .map((f) => f.inner)
      .filter(
        (i) =>
          i["type"] === "ub" &&
          (i["ub"] as Record<string, unknown> | undefined)?.["type"] === "error",
      )
      .map((i) => i["ub"] as Record<string, unknown>)
  }

  it("session_fork with no conversation attached replies a correlated ub error", async () => {
    // The makeBridge seam leaves `control` unset (no attach() ran) — the
    // pre-fix behavior was a SILENT drop; the app's fork tile never came.
    const { bridge, relay, peer } = await pairedBridge()
    relay.deliver(
      ubEnvelope(peer, {
        type: "session_fork",
        id: "req-1",
        entry_id: "5",
        position: "at",
      }),
    )
    await flush()
    const [err] = ubErrors(relay)
    expect(err).toBeDefined()
    expect(err!["in_reply_to"]).toBe("req-1")
    expect(String(err!["message"])).toContain("No conversation attached")
    await bridge.stop()
  })

  it("session_fork wires through to the session control's fork", async () => {
    const fork = vi.fn(async () => {})
    const { bridge, relay, peer } = await pairedBridge({
      control: { fork, navigateTree: async () => {} },
    })
    relay.deliver(
      ubEnvelope(peer, {
        type: "session_fork",
        id: "req-2",
        entry_id: "11",
        position: "at",
      }),
    )
    await flush()
    expect(fork).toHaveBeenCalledWith("11", {
      position: "at",
      requestId: "req-2",
    })
    expect(ubErrors(relay)).toEqual([])
    await bridge.stop()
  })

  it("a failed fork replies an error frame, not a silent drop", async () => {
    const fork = vi.fn(async () => {
      throw new Error("Entry not found: 999")
    })
    const { bridge, relay, peer } = await pairedBridge({
      control: { fork, navigateTree: async () => {} },
    })
    relay.deliver(
      ubEnvelope(peer, {
        type: "session_fork",
        id: "req-3",
        entry_id: "999",
        position: "at",
      }),
    )
    await flush()
    const [err] = ubErrors(relay)
    expect(err).toBeDefined()
    expect(err!["in_reply_to"]).toBe("req-3")
    expect(String(err!["message"])).toContain("Entry not found: 999")
    await bridge.stop()
  })

  it("session_navigate wires through to navigateTree", async () => {
    const navigateTree = vi.fn(async () => {})
    const { bridge, relay, peer } = await pairedBridge({
      control: { fork: async () => {}, navigateTree },
    })
    relay.deliver(
      ubEnvelope(peer, {
        type: "session_navigate",
        id: "req-4",
        entry_id: "7",
      }),
    )
    await flush()
    expect(navigateTree).toHaveBeenCalledWith("7")
    expect(ubErrors(relay)).toEqual([])
    await bridge.stop()
  })

  it("the navigateTree refusal (not implemented on durable) replies an error frame", async () => {
    const navigateTree = vi.fn(async () => {
      throw new Error("navigateTree is not implemented")
    })
    const { bridge, relay, peer } = await pairedBridge({
      control: { fork: async () => {}, navigateTree },
    })
    relay.deliver(
      ubEnvelope(peer, {
        type: "session_navigate",
        id: "req-5",
        entry_id: "8",
      }),
    )
    await flush()
    expect(ubErrors(relay).map((e) => e["in_reply_to"])).toEqual([
      "req-5",
    ])
    expect(String(ubErrors(relay)[0]!["message"])).toContain(
      "navigateTree is not implemented",
    )
    await bridge.stop()
  })
})

describe("DurableBridge terminate(ub)", () => {
  /** The app's terminate wire shape: a ub-plane envelope through the
   *  owner channel (same shape as the fork/navigate frames above). */
  function terminateEnvelope(peer: string, id: string): string {
    return outerFrame(peer, {
      type: "ub",
      ts: 1,
      protocolVersion: 1,
      ub: { type: "terminate", id },
    })
  }

  it("shuts the host down by default (the app IS the UI on a headless box)", async () => {
    const shutdownHost = vi.fn(async () => {})
    const made = makeBridge({ shutdownHost })
    await made.bridge.start()
    await flush()
    const uri = pairingUris(made.logs)[0]!
    const peer = appPeerId()
    made.relay.deliver(
      outerFrame(peer, {
        type: "pair_request",
        id: "pr-1",
        token: tokenOf(uri),
        device_name: "Pixel Test",
      }),
    )
    await flush()
    made.relay.deliver(terminateEnvelope(peer, "term-1"))
    await flush()
    expect(shutdownHost).toHaveBeenCalledTimes(1)
    await made.bridge.stop()
  })

  it("refuses when the config opts out (allow_remote_terminate: false)", async () => {
    // UNBIEN_DIRECT_CONFIG is the daemon/headless escape hatch — it wins
    // over every on-disk layer, so the refusal is hermetic.
    process.env.UNBIEN_DIRECT_CONFIG = '{"allow_remote_terminate":false}'
    try {
      const shutdownHost = vi.fn(async () => {})
      const made = makeBridge({ shutdownHost })
      await made.bridge.start()
      await flush()
      const uri = pairingUris(made.logs)[0]!
      const peer = appPeerId()
      made.relay.deliver(
        outerFrame(peer, {
          type: "pair_request",
          id: "pr-1",
          token: tokenOf(uri),
          device_name: "Pixel Test",
        }),
      )
      await flush()
      made.relay.deliver(terminateEnvelope(peer, "term-2"))
      await flush()
      expect(shutdownHost).not.toHaveBeenCalled()
      expect(
        made.logs.join("\n").includes("remote terminate disabled"),
      ).toBe(true)
      await made.bridge.stop()
    } finally {
      delete process.env.UNBIEN_DIRECT_CONFIG
    }
  })
})