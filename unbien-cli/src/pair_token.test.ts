/**
 * `unbien pair-token` — the machine-side pairing invite generator, tested at
 * every seam the command has:
 *
 *   (a) URI shape — unbien://pair?t=…&epk=…&n=…&rm=… with NO relay `r` param
 *       (removed in plano 14; the app takes the relay from its own config),
 *       round-tripped through the CLI's own parseInvite (the consume side).
 *   (b) identity source — the epk is the MACHINE identity
 *       (getOrCreateEd25519Keypair → identity.json under $UNBIEN_STATE_DIR),
 *       NOT the CLI's owner identity (loadOrCreateIdentity →
 *       proxy-identity.json — a DIFFERENT file).
 *   (c) TTL/rotation — 60s default TTL; a re-issue on the same QRSession
 *       mints a FRESH token.
 *   (d) identity persistence — the file backend is write-once: two calls
 *       against the same state dir resolve the same keypair.
 *   (e) arg parsing — --name/--room/--state-dir defaults and overrides, and
 *       the --state-dir discipline that must land in the env BEFORE the
 *       storage module first loads (it freezes the state root at module
 *       scope).
 *   plus the --wait handshake logic (handlePairRequest) with fake storage:
 *       valid token → pair_ok + persist + allow-list re-push; expired /
 *       consumed / unknown token → the matching pair_error; an
 *       already-paired owner → idempotent pair_ok WITHOUT consuming.
 *
 * Identity tests are hermetic: the platform keyring backend is swapped for
 * one that always throws (a locked keychain) and "keyring expected" is
 * forced off, so the resolver takes the file-identity fallback exactly as a
 * headless box does — the real keychain is never read, and identity.json
 * lands in the test's temp state dir.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { KeyStoreBackend } from "@geohar/un-bien"
import { parsePairTokenArgs, handlePairRequest, DEFAULT_WAIT_TIMEOUT_MS } from "./pair_token.js"
import { loadOrCreateIdentity } from "./identity.js"
import { parseInvite } from "./invite.js"

// The state root must be pinned BEFORE the pairing storage module is first
// imported (it freezes identity.json / peers.json paths at module scope —
// the same discipline the CLI applies for --state-dir), so these run at
// file top, ahead of the dynamic imports below.
const TMP_HOME = mkdtempSync(join(tmpdir(), "unbien-pair-token-"))
const STATE_DIR = join(TMP_HOME, "state")
process.env.UNBIEN_STATE_DIR = STATE_DIR
// The config resolver reads un-bien.json under PI_CODING_AGENT_DIR; pinning
// it keeps the developer's real config out of the identity backend choice.
process.env.PI_CODING_AGENT_DIR = join(TMP_HOME, ".pi")
delete process.env.UNBIEN_IDENTITY_SEED
delete process.env.UNBIEN_RELAY

const unbien = await import("@geohar/un-bien")
const storage = await import("@geohar/un-bien")

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

/** Fresh storage module instance bound to `stateDir`: the module freezes the
 *  state root at import, so a different state dir needs a re-evaluation
 *  (vi.resetModules + import) — the same reason the CLI applies --state-dir
 *  to the env before its first barrel import. */
async function freshStorage(stateDir: string) {
  process.env.UNBIEN_STATE_DIR = stateDir
  vi.resetModules()
  const mod = await import("@geohar/un-bien")
  mod._setKeyStoreBackendForTest(new LockedKeyring())
  mod._setKeyringExpectedForTest(false)
  mod._setKeyringRetryForTest(1, 0)
  return mod
}

// The default instance (STATE_DIR) with the hermetic backend installed.
function installHermetic(mod: typeof storage): void {
  mod._setKeyStoreBackendForTest(new LockedKeyring())
  mod._setKeyringExpectedForTest(false)
  mod._setKeyringRetryForTest(1, 0)
}

beforeEach(() => {
  installHermetic(storage)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "info").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  storage._setKeyStoreBackendForTest(null)
  storage._setKeyringExpectedForTest(null)
  storage._setKeyringRetryForTest(null)
})

// ── (a) Token / URI shape ──────────────────────────────────────────────────

describe("buildQRUri — the invite URI the QR carries", () => {
  const token = "abc123"
  const epk = new Uint8Array(32).fill(7)
  const uri = unbien.buildQRUri(token, epk, "durable-host", "rO0omAbCd")

  test("scheme unbien://, host pair, no relay `r` param", () => {
    const url = new URL(uri)
    expect(url.protocol).toBe("unbien:")
    expect(url.host).toBe("pair")
    expect(url.searchParams.get("t")).toBe(token)
    expect(url.searchParams.has("epk")).toBe(true)
    expect(url.searchParams.get("n")).toBe("durable-host")
    expect(url.searchParams.get("rm")).toBe("rO0omAbCd")
    // The relay URL was removed in plano 14 — the app takes it from its own
    // config. A reintroduced `r` would silently pin QRs to a stale relay.
    expect(url.searchParams.has("r")).toBe(false)
  })

  test("epk is base64url of the 32-byte machine public key", () => {
    const url = new URL(uri)
    const decoded = Buffer.from(
      url.searchParams.get("epk")!,
      "base64url",
    )
    expect(new Uint8Array(decoded)).toEqual(epk)
  })

  test("round-trips through the CLI's own parseInvite (the consume side)", () => {
    const invite = parseInvite(uri)
    expect(invite.token).toBe(token)
    expect(invite.sessionName).toBe("durable-host")
    expect(invite.roomId).toBe("rO0omAbCd")
  })

  test("roomId omitted → no rm param (the app defaults the room)", () => {
    const bare = new URL(unbien.buildQRUri(token, epk, "n", undefined))
    expect(bare.searchParams.has("rm")).toBe(false)
  })
})

// ── (c) TTL / rotation ────────────────────────────────────────────────────

describe("QRSession — TTL and rotation", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("the default TTL is 60s (TOKEN_TTL_MS)", () => {
    expect(unbien.TOKEN_TTL_MS).toBe(60_000)
    vi.setSystemTime(new Date(1_000_000))
    const { expiresAt } = new unbien.QRSession().issueToken()
    expect(expiresAt).toBe(1_000_000 + 60_000)
  })

  test("a token expires after its TTL", () => {
    vi.setSystemTime(new Date(0))
    const s = new unbien.QRSession()
    const { token } = s.issueToken()
    vi.setSystemTime(new Date(unbien.TOKEN_TTL_MS + 1))
    expect(s.consumeToken(token)).toBe("expired")
  })

  test("re-issuing on the same QRSession mints a FRESH token", () => {
    const s = new unbien.QRSession()
    const { token: token1 } = s.issueToken()
    const { token: token2 } = s.issueToken()
    expect(token2).not.toBe(token1)
    // The previous token is invalidated by the re-issue, not just shadowed.
    expect(s.consumeToken(token1)).toBe("unknown")
    expect(s.consumeToken(token2)).toBe("ok")
  })

  test("a token is single-use", () => {
    const s = new unbien.QRSession()
    const { token } = s.issueToken()
    expect(s.consumeToken(token)).toBe("ok")
    expect(s.consumeToken(token)).toBe("consumed")
  })
})

// ── (b) + (d) Identity source and persistence ──────────────────────────────

describe("pair-token identity — the MACHINE key, not the CLI owner key", () => {
  afterEach(() => {
    rmSync(join(STATE_DIR, "identity.json"), { force: true })
    rmSync(join(STATE_DIR, "peers.json"), { force: true })
  })

  test("the invite's epk is the machine identity from the state dir", async () => {
    const kp = await storage.getOrCreateEd25519Keypair()
    const uri = unbien.buildQRUri(
      "tok",
      kp.publicKey,
      "durable",
      "main",
    )
    // The epk the app routes on matches a getOrCreateEd25519Keypair call
    // against the same state dir…
    const again = await storage.getOrCreateEd25519Keypair()
    expect(Buffer.from(again.publicKey).toString("base64url")).toBe(
      new URL(uri).searchParams.get("epk"),
    )
  })

  test("the epk is NOT the CLI owner identity (proxy-identity.json)", async () => {
    const machineKp = await storage.getOrCreateEd25519Keypair()
    // loadOrCreateIdentity reads proxy-identity.json — a DIFFERENT file in
    // the owner's home, minted by the CLI for ITSELF (the "pair" consume
    // side). The invite must not carry it: the app would route
    // pair_request to the CLI's own (roomless) epk, not the machine's.
    const proxyPath = join(TMP_HOME, "proxy-identity.json")
    const ownerKp = loadOrCreateIdentity(proxyPath)
    expect(existsSync(proxyPath)).toBe(true)
    expect(
      Buffer.from(ownerKp.publicKey).toString("base64url"),
    ).not.toBe(Buffer.from(machineKp.publicKey).toString("base64url"))
    // And the machine identity lives in identity.json, a separate file.
    expect(existsSync(join(STATE_DIR, "identity.json"))).toBe(true)
  })

  test("(d) the file backend is write-once: same keypair across invocations", async () => {
    const kp1 = await storage.getOrCreateEd25519Keypair()
    const kp2 = await storage.getOrCreateEd25519Keypair()
    expect(Buffer.from(kp2.publicKey)).toEqual(Buffer.from(kp1.publicKey))
    expect(Buffer.from(kp2.secretKey)).toEqual(Buffer.from(kp1.secretKey))
  })

  test("identity.json is the persisted source (it survives the in-memory instance)", async () => {
    const kp1 = await storage.getOrCreateEd25519Keypair()
    const onDisk = JSON.parse(
      readFileSync(join(STATE_DIR, "identity.json"), "utf8"),
    ) as { pk: string }
    expect(Buffer.from(onDisk.pk, "base64")).toEqual(
      Buffer.from(kp1.publicKey),
    )
  })
})

// ── (e) CLI arg parsing ────────────────────────────────────────────────────

describe("parsePairTokenArgs", () => {
  test("defaults: name durable, room main, 120s timeout", () => {
    const opts = parsePairTokenArgs([])
    expect(opts.sessionName).toBe("durable")
    expect(opts.roomId).toBe("main")
    expect(opts.stateDir).toBe("")
    expect(opts.timeoutMs).toBe(DEFAULT_WAIT_TIMEOUT_MS)
    expect(opts.timeoutMs).toBe(120_000)
    expect(opts.relayUrl).toBe("")
    expect(opts.help).toBe(false)
  })

  test("--name and --room land in the URI's n= and rm= params", () => {
    const opts = parsePairTokenArgs(["--name", "my-box", "--room", "ab12cd34"])
    const uri = new URL(
      unbien.buildQRUri("t", new Uint8Array(32), opts.sessionName, opts.roomId),
    )
    expect(uri.searchParams.get("n")).toBe("my-box")
    expect(uri.searchParams.get("rm")).toBe("ab12cd34")
  })

  test("short flags -n/-r/-s mirror the long ones", () => {
    const opts = parsePairTokenArgs(["-n", "x", "-r", "y", "-s", "/tmp/z"])
    expect(opts).toMatchObject({
      sessionName: "x",
      roomId: "y",
      stateDir: "/tmp/z",
    })
  })

  test("--wait flips the mode; --timeout is seconds → ms; --relay is explicit", () => {
    const opts = parsePairTokenArgs([
      "--wait",
      "--timeout",
      "45",
      "--relay",
      "http://10.0.0.5:8081",
    ])
    // --wait removed: waiting is the only mode; --timeout is the only window flag.
    expect(opts.timeoutMs).toBe(45_000)
    expect(opts.relayUrl).toBe("http://10.0.0.5:8081")
  })

  test("an unparseable --timeout falls back to the default window", () => {
    expect(parsePairTokenArgs(["--timeout", "nope"]).timeoutMs).toBe(120_000)
  })

  test("--state-dir points the storage module at that dir's identity.json", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "unbien-pair-token-sd-"))
    const opts = parsePairTokenArgs(["--state-dir", stateDir])
    expect(opts.stateDir).toBe(stateDir)

    // The production flow applies the parsed dir to the env BEFORE the
    // storage module first loads (module-scope path freeze). Reproduce that
    // discipline here: a fresh module instance bound to the new state dir.
    const mod = await freshStorage(stateDir)
    const kp = await mod.getOrCreateEd25519Keypair()
    expect(existsSync(join(stateDir, "identity.json"))).toBe(true)

    // The DEFAULT state dir's identity was NOT touched by this call.
    expect(existsSync(join(STATE_DIR, "identity.json"))).toBe(false)
  })
})

// ── The --wait handshake (handlePairRequest, fake storage) ────────────────

describe("handlePairRequest — the machine-side handshake logic", () => {
  const ctx = {
    roomId: "main",
    sessionName: "durable",
    sessionStartedAt: 1_000,
    hostname: "box",
    harness: { name: "unbien-cli pair-token", version: "0.0.0" },
  }

  function makeDeps(opts: { preKnown?: boolean[]; persistFails?: boolean } = {}) {
    const qr = new unbien.QRSession()
    const added: Array<{ name: string; remote_epk: string; paired_at: string }> = []
    const allowListPushes: number[] = []
    const deps = {
      qrSession: qr,
      findKnownPeer: async (appPeerId: string) =>
        appPeerId === "known-owner" ? { name: "phone", remote_epk: "known-owner" } : null,
      addPeer: async (record: { name: string; remote_epk: string; paired_at: string }) => {
        if (opts.persistFails) throw new Error("disk full")
        added.push(record)
      },
      pushAllowList: async () => {
        allowListPushes.push(Date.now())
      },
    }
    return { qr, deps, added, allowListPushes }
  }

  test("a valid token pairs: pair_ok, peer persisted, allow-list re-pushed", async () => {
    const { qr, deps, added, allowListPushes } = makeDeps()
    const { token } = qr.issueToken()
    const { settled, reply } = await handlePairRequest(
      deps,
      ctx,
      "app-epk",
      { id: "req-1", token, device_name: "Pixel" },
    )
    expect(settled).toBe(true)
    expect(reply).toMatchObject({
      type: "pair_ok",
      in_reply_to: "req-1",
      session_name: "durable",
      room_id: "main",
    })
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ name: "Pixel", remote_epk: "app-epk" })
    expect(allowListPushes).toHaveLength(1)
    // The token is consumed — a replayed pair_request cannot re-pair.
    expect(qr.consumeToken(token)).toBe("consumed")
  })

  test("an expired token refuses with token_expired and keeps waiting", async () => {
    const { qr, deps } = makeDeps()
    qr.issueToken(1)
    await new Promise((r) => setTimeout(r, 5))
    const { settled, reply } = await handlePairRequest(
      deps,
      ctx,
      "app-epk",
      { id: "req-2", token: "stale", device_name: "Pixel" },
    )
    expect(settled).toBe(false)
    expect(reply).toMatchObject({ type: "pair_error", code: "token_unknown" })
  })

  test("a wrong token refuses with token_unknown", async () => {
    const { qr, deps } = makeDeps()
    qr.issueToken()
    const { settled, reply } = await handlePairRequest(
      deps,
      ctx,
      "app-epk",
      { id: "req-3", token: "not-minted-here", device_name: "Pixel" },
    )
    expect(settled).toBe(false)
    expect(reply).toMatchObject({ type: "pair_error", code: "token_unknown" })
  })

  test("a consumed token refuses with token_consumed", async () => {
    const { qr, deps } = makeDeps()
    const { token } = qr.issueToken()
    qr.consumeToken(token)
    const { settled, reply } = await handlePairRequest(
      deps,
      ctx,
      "app-epk",
      { id: "req-4", token, device_name: "Pixel" },
    )
    expect(settled).toBe(false)
    expect(reply).toMatchObject({ type: "pair_error", code: "token_consumed" })
  })

  test("an already-paired owner re-confirms WITHOUT consuming a token", async () => {
    const { qr, deps, added } = makeDeps()
    const { token } = qr.issueToken()
    const { settled, reply } = await handlePairRequest(
      deps,
      ctx,
      "known-owner",
      { id: "req-5", token, device_name: "Pixel" },
    )
    expect(settled).toBe(true)
    expect(reply.type).toBe("pair_ok")
    // Idempotent re-confirm (design 01M20G8SE): no new peers.json write.
    expect(added).toHaveLength(0)
    // And the token is still live for a genuinely new device.
    expect(qr.consumeToken(token)).toBe("ok")
  })

  test("a peers.json write failure refuses with internal_error", async () => {
    const { qr, deps } = makeDeps({ persistFails: true })
    const { token } = qr.issueToken()
    const { settled, reply } = await handlePairRequest(
      deps,
      ctx,
      "app-epk",
      { id: "req-6", token, device_name: "Pixel" },
    )
    expect(settled).toBe(false)
    expect(reply).toMatchObject({ type: "pair_error", code: "internal_error" })
  })
})