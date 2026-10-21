import { describe, expect, test, vi, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { generateEd25519Keypair } from "../pairing/crypto.js"

// ── WS mock (class-based, vitest-hoisted) ─────────────────────────────────────
// Must use a proper class so `new WebSocket(...)` works inside RelayClient.

// Shared reference: set by the MockWS constructor so tests can access it.
const wsRef: { current: MockWS | null } = { current: null }

class MockWS extends EventEmitter {
  static OPEN = 1
  readyState = MockWS.OPEN
  readonly sent: string[] = []

  constructor(_url: string) {
    super()
    wsRef.current = this
    // Defer 'open' so RelayClient has time to attach its handlers first.
    setTimeout(() => this.emit("open"), 0)
  }

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.emit("close")
  }
  terminate(): void {
    this.readyState = 3
    this.emit("close")
  }
}

vi.mock("ws", () => ({ default: MockWS }))

// Import AFTER the mock so RelayClient picks up the mocked ws module.
const { RelayClient } = await import("./relay_client.js")

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentWs(): MockWS {
  if (!wsRef.current) throw new Error("no MockWS instance created yet")
  return wsRef.current
}

function simulateChallenge(ws: MockWS, nonceByte = 0xab): void {
  const nonce = Buffer.alloc(32, nonceByte)
  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }),
    ),
  )
}

async function connectWithAuth(
  client: InstanceType<typeof RelayClient>,
  nonceByte = 0xab,
): Promise<void> {
  const p = client.connect()
  await vi.waitFor(() => expect(currentWs().sent.length).toBeGreaterThan(0))
  simulateChallenge(currentWs(), nonceByte)
  await p
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RelayClient", () => {
  let keypair: ReturnType<typeof generateEd25519Keypair>

  beforeEach(() => {
    keypair = generateEd25519Keypair()
    wsRef.current = null
  })

  test("isOpen reflects the real WebSocket lifecycle", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair)
    expect(client.isOpen()).toBe(false)

    await connectWithAuth(client)
    expect(client.isOpen()).toBe(true)

    client.close()
    expect(client.isOpen()).toBe(false)
  })

  test("connect: sends hello with correct Ed25519 pubkey", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair)
    await connectWithAuth(client)

    const ws = currentWs()
    const hello = JSON.parse(ws.sent[0]) as { type: string; pubkey: string }
    expect(hello.type).toBe("hello")
    expect(hello.pubkey).toBe(Buffer.from(keypair.publicKey).toString("base64"))

    client.close()
  })

  test("connect: sends auth with 64-byte Ed25519 signature", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair)
    await connectWithAuth(client)

    const ws = currentWs()
    const auth = JSON.parse(ws.sent[1]) as { type: string; sig: string }
    expect(auth.type).toBe("auth")
    expect(Buffer.from(auth.sig, "base64")).toHaveLength(64)

    client.close()
  })

  test("connect: auth messages (hello + auth) are exactly 2 sends", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair)
    await connectWithAuth(client)

    // hello + auth = 2 sends during auth phase only
    expect(currentWs().sent).toHaveLength(2)
    client.close()
  })

  test("connect: challenge message NOT forwarded as public 'message' event", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair)
    const received: string[] = []
    client.on("message", (line) => received.push(line))

    await connectWithAuth(client)

    // Challenge should NOT appear in public events
    expect(received.some((l) => l.includes("challenge"))).toBe(false)
    client.close()
  })

  test("connect: post-auth outer envelopes are forwarded as 'message' events", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair)
    const received: string[] = []
    client.on("message", (line) => received.push(line))

    await connectWithAuth(client)

    const outer = JSON.stringify({ peer: "app_peer_1", ct: "AAAA" })
    currentWs().emit("message", Buffer.from(outer))

    expect(received).toContain(outer)
    client.close()
  })

  test("send: writes raw line to the WebSocket", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair)
    await connectWithAuth(client)

    const ws = currentWs()
    const before = ws.sent.length
    const outer = JSON.stringify({ peer: "x", ct: "BQID" })
    client.send(outer)
    expect(ws.sent[before]).toBe(outer)

    client.close()
  })

  // ── Liveness watchdog ───────────────────────────────────────────────────────
  // Regression for "daemon shows online but is dead after a few idle hours":
  // a silently half-open WS never fires `close`, so reconnect never triggers.

  async function connectFake(
    client: InstanceType<typeof RelayClient>,
  ): Promise<void> {
    const p = client.connect()
    await vi.advanceTimersByTimeAsync(1) // MockWS defers 'open' via setTimeout(0)
    simulateChallenge(currentWs()) // resolves auth's _nextMsg
    await p
  }

  test("liveness: force-closes (→ reconnect) after silence past the timeout", async () => {
    vi.useFakeTimers()
    try {
      const client = new RelayClient("ws://localhost:9999", keypair)
      await connectFake(client)
      let closed = false
      client.on("close", () => {
        closed = true
      })

      // No inbound frame for > 70s → watchdog terminates → close.
      await vi.advanceTimersByTimeAsync(90_000)
      expect(closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test("liveness: relay's ~25s pings keep it alive (no spurious close)", async () => {
    vi.useFakeTimers()
    try {
      const client = new RelayClient("ws://localhost:9999", keypair)
      await connectFake(client)
      let closed = false
      client.on("close", () => {
        closed = true
      })

      // Simulate the relay's keepalive ping every 25s for 2.5 min.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(25_000)
        currentWs().emit("ping")
      }
      expect(closed).toBe(false)
      client.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── P7: relay identity_ack (pin + TOFU) ──────────────────────────────
// Loaded from the dynamic-import surface as RelayClient (the vi.mock of
// "ws" must be active before relay_client.js first evaluates).

const {
  verifyRelayIdentityAck,
} = await import("./relay_client.js")
const { ed25519Sign, ed25519Verify } = await import("../pairing/crypto.js")
import type {
  RelayIdentityAckFrame,
} from "./relay_client.js"

function signedAckFrame(
  kp: { secretKey: Uint8Array; publicKey: Uint8Array },
  nonceB64: string,
  opts: {
    name?: string
    url?: string
    sigKey?: { secretKey: Uint8Array; publicKey: Uint8Array }
  } = {},
): RelayIdentityAckFrame {
  const signKey = opts.sigKey ?? kp
  const pkB64 = Buffer.from(kp.publicKey).toString("base64")
  const name = opts.name ?? "test-relay"
  const url = opts.url ?? ""
  const msg = `${nonceB64}|${pkB64}|${name}|${url}`
  const sig = ed25519Sign(signKey.secretKey, Buffer.from(msg, "utf8"))
  return {
    type: "identity_ack",
    relay_pubkey: pkB64,
    relay_name: name,
    relay_url: url,
    nonce: nonceB64,
    sig: Buffer.from(sig).toString("base64"),
  }
}

describe("relay identity ack (P7)", () => {
  test("valid signed ack verifies and binds the nonce", () => {
    const kp = generateEd25519Keypair()
    const nonceB64 = Buffer.alloc(32, 0x11).toString("base64")
    const check = verifyRelayIdentityAck(signedAckFrame(kp, nonceB64), nonceB64)
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(check.relayPubkey).toBe(
        Buffer.from(kp.publicKey).toString("base64"),
      )
    }
    // Sanity: the same frame against a DIFFERENT nonce is a replay → refuse.
    expect(
      verifyRelayIdentityAck(signedAckFrame(kp, nonceB64), "other-nonce").ok,
    ).toBe(false)
  })

  test("signature over different bytes fails; pin must match", () => {
    const kp = generateEd25519Keypair()
    const other = generateEd25519Keypair()
    const nonceB64 = Buffer.alloc(32, 0x22).toString("base64")
    // Signed by `other` while claiming kp's pubkey → bad_sig.
    const forged = signedAckFrame(kp, nonceB64, { sigKey: other })
    expect(verifyRelayIdentityAck(forged, nonceB64)).toEqual({
      ok: false,
      reason: "bad_sig",
    })
    // Legit ack + an unrelated pin → pin_mismatch (the MITM case).
    const legitim = signedAckFrame(kp, nonceB64)
    const pinnedOwner = Buffer.from(
      generateEd25519Keypair().publicKey,
    ).toString("base64")
    expect(
      verifyRelayIdentityAck(legitim, nonceB64, pinnedOwner),
    ).toMatchObject({ ok: false, reason: "pin_mismatch" })
  })

  test("malformed frames (no nonce/sig) refuse", () => {
    expect(verifyRelayIdentityAck({ type: "identity_ack" }, "n")).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  test("RelayClient stores a verified ack; a pinned mismatch terminates", async () => {
    const kp = generateEd25519Keypair()
    const client = new RelayClient("ws://relay.test", kp)
    await connectWithAuth(client, 0x31) // challenge nonce 0x31 * 32 bytes
    const nonceB64 = Buffer.alloc(32, 0x31).toString("base64")
    currentWs().emit(
      "message",
      Buffer.from(
        JSON.stringify(signedAckFrame(kp, nonceB64, { name: "crashtest" })),
      ),
    )
    const ident = client.relayIdentity()
    expect(ident?.relayName).toBe("crashtest")
    client.close()

    // Pinned client + a relay answering with someone ELSE's key: the ack must
    // verify against the pin → mismatch → the relayIdentityError event + dead
    // socket, before any caller traffic flows.
    const attacker = generateEd25519Keypair()
    const pinned = new RelayClient("ws://relay.test", kp, {
      expectRelayPubkey: Buffer.from(kp.publicKey).toString("base64"),
    })
    await connectWithAuth(pinned, 0x32)
    const errorPromise = new Promise<
      { reason: string; gotRelayPubkey?: string }
    >((resolve) => pinned.once("relayIdentityError", resolve))
    const nonce32 = Buffer.alloc(32, 0x32).toString("base64")
    currentWs().emit(
      "message",
      Buffer.from(
        JSON.stringify(
          signedAckFrame(attacker, nonce32, { name: "squatter" }),
        ),
      ),
    )
    const err = await errorPromise
    expect(err.reason).toBe("pin_mismatch")
    expect(currentWs().readyState).toBe(3) // terminated
  })
})
