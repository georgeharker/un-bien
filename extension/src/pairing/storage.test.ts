import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Tests import the module after stubbing `os.homedir` so the fallback
// path writes inside a temp dir instead of the dev's real ~/.pi/un-bien.
// vi.mock must run before the real module load.
const _tmpHome = mkdtempSync(join(tmpdir(), "pi-storage-"))
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>()
  return { ...orig, homedir: () => _tmpHome }
})

// Re-import after the mock is installed.
const storage = await import("./storage.js")
const {
  getOrCreateEd25519Keypair,
  KeyringUnavailableError,
  _setKeyStoreBackendForTest,
  _setKeyringExpectedForTest,
  _setKeyringRetryForTest,
  _unlinkIdentityFileForTest,
  _IDENTITY_FILE_FOR_TEST,
  _setNativeBindingErrorForTest,
} = storage
import type { KeyStoreBackend } from "./storage.js"

// ── In-memory backend for migration / round-trip tests ──────────────────────

class InMemoryBackend implements KeyStoreBackend {
  readonly store = new Map<string, string>()
  readonly reads: { service: string; account: string }[] = []
  readonly writes: { service: string; account: string; value: string }[] = []
  readonly deletes: { service: string; account: string }[] = []
  private _failOn?: "read" | "write" | "delete"
  private _failAllOn?: "read" | "write" | "delete"

  failNext(op: "read" | "write" | "delete" | undefined) {
    this._failOn = op
  }

  /** Persistent failure — every op of this kind throws (simulates a keyring
   *  that's locked/unavailable for the whole call, surviving retries). */
  failAll(op: "read" | "write" | "delete" | undefined) {
    this._failAllOn = op
  }

  async read(service: string, account: string) {
    this.reads.push({ service, account })
    if (this._failAllOn === "read") throw new Error("simulated keyring locked")
    if (this._failOn === "read") {
      this._failOn = undefined
      throw new Error("simulated keyring unavailable")
    }
    return this.store.get(`${service}|${account}`)
  }
  async write(service: string, account: string, value: string) {
    this.writes.push({ service, account, value })
    if (this._failOn === "write") {
      this._failOn = undefined
      throw new Error("simulated keyring write failure")
    }
    this.store.set(`${service}|${account}`, value)
  }
  async delete(service: string, account: string) {
    this.deletes.push({ service, account })
    const key = `${service}|${account}`
    const had = this.store.has(key)
    this.store.delete(key)
    return had
  }
}

const NEW_SERVICE = "dev.unbien.pi"
const OLD_SERVICE = "dev.unbien.mac"
const ACCOUNT = "longterm-ed25519"

// The resolver reads un-bien.json (identity.storage/path) via unbienConfigHome(),
// which honors PI_CODING_AGENT_DIR. Pin it inside the temp home so tests never
// pick up the developer's real config, and start each test from an absent one.
const _origPiAgentDir = process.env.PI_CODING_AGENT_DIR
function writeUnbienConfig(cfg: Record<string, unknown>): void {
  const dir = join(_tmpHome, ".pi", "extensions")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "un-bien.json"), JSON.stringify(cfg))
}

beforeEach(async () => {
  process.env.PI_CODING_AGENT_DIR = join(_tmpHome, ".pi")
  rmSync(join(_tmpHome, ".pi", "extensions", "un-bien.json"), { force: true })
  // Silence the migration / fallback console output during tests so the
  // vitest output isn't polluted.
  vi.spyOn(console, "info").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  // Zero retry delay so persistent-failure tests don't sleep.
  _setKeyringRetryForTest(3, 0)
  await _unlinkIdentityFileForTest()
  // peers.json now gates identity minting (issues #95/#69), so a container left
  // by a previous test would make an unrelated "fresh install" case throw.
  rmSync(join(_tmpHome, ".pi", "un-bien", "peers.json"), { force: true })
})

afterEach(() => {
  _setKeyStoreBackendForTest(null)
  _setKeyringExpectedForTest(null)
  _setKeyringRetryForTest(null)
  _setNativeBindingErrorForTest(null)
  delete process.env.UNBIEN_IDENTITY_SEED
  if (_origPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = _origPiAgentDir
  vi.restoreAllMocks()
})

// ── Keyring path ────────────────────────────────────────────────────────────

describe("getOrCreateEd25519Keypair — keyring path", () => {
  test("returns existing entry from new service without writing", async () => {
    const backend = new InMemoryBackend()
    const original = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(2)).toString("base64"),
    })
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, original)
    _setKeyStoreBackendForTest(backend)

    const kp = await getOrCreateEd25519Keypair()
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
    )
    expect(backend.writes.length).toBe(0)
    expect(backend.deletes.length).toBe(0)
  })

  test("generates + saves a fresh keypair when neither service has an entry", async () => {
    const backend = new InMemoryBackend()
    _setKeyStoreBackendForTest(backend)

    const kp = await getOrCreateEd25519Keypair()
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(backend.writes.length).toBe(1)
    expect(backend.writes[0]!.service).toBe(NEW_SERVICE)
    expect(backend.writes[0]!.account).toBe(ACCOUNT)
    expect(backend.deletes.length).toBe(0)
  })

  test("idempotent across two calls — second call returns same key without write", async () => {
    const backend = new InMemoryBackend()
    _setKeyStoreBackendForTest(backend)

    const first = await getOrCreateEd25519Keypair()
    const second = await getOrCreateEd25519Keypair()

    expect(Buffer.from(first.publicKey).toString("base64")).toBe(
      Buffer.from(second.publicKey).toString("base64"),
    )
    expect(backend.writes.length).toBe(1) // only the first call wrote
  })
})

// ── Migration path (legacy keytar service) ──────────────────────────────────

describe("getOrCreateEd25519Keypair — keytar migration (plan/27 E1)", () => {
  test("legacy entry → copies to new service + deletes old", async () => {
    const backend = new InMemoryBackend()
    const legacy = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(8)).toString("base64"),
    })
    backend.store.set(`${OLD_SERVICE}|${ACCOUNT}`, legacy)
    _setKeyStoreBackendForTest(backend)

    const kp = await getOrCreateEd25519Keypair()

    // Preserved identity
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
    )
    // New entry was written
    expect(backend.store.get(`${NEW_SERVICE}|${ACCOUNT}`)).toBe(legacy)
    // Old entry was deleted
    expect(backend.store.has(`${OLD_SERVICE}|${ACCOUNT}`)).toBe(false)
    expect(backend.deletes.find((d) => d.service === OLD_SERVICE)).toBeDefined()
  })

  test("new entry already present → does NOT touch legacy entry", async () => {
    const backend = new InMemoryBackend()
    const newVal = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(4)).toString("base64"),
    })
    const stale = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(9)).toString("base64"),
    })
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, newVal)
    backend.store.set(`${OLD_SERVICE}|${ACCOUNT}`, stale)
    _setKeyStoreBackendForTest(backend)

    const kp = await getOrCreateEd25519Keypair()
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    )
    // Legacy entry untouched (we never even read it)
    expect(backend.store.get(`${OLD_SERVICE}|${ACCOUNT}`)).toBe(stale)
    expect(backend.deletes.length).toBe(0)
  })
})

// ── Headless fallback ───────────────────────────────────────────────────────

describe("getOrCreateEd25519Keypair — headless Linux fallback", () => {
  test("keyring read throws persistently (no keyring expected) → falls back to identity.json (chmod 0o600)", async () => {
    const backend = new InMemoryBackend()
    backend.failAll("read")
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(false) // simulate headless Linux (no core keyring)

    const kp = await getOrCreateEd25519Keypair()
    expect(kp.publicKey.length).toBe(32)

    // File exists at the expected path with restrictive perms.
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true)
    // POSIX-only: `chmod 0o600` is a no-op on Windows (NTFS perms aren't the
    // POSIX bits + Node reports a fixed mode), so only assert the perm bits
    // off Windows. The file-creation + fallback behavior is checked above.
    if (process.platform !== "win32") {
      const stat = statSync(_IDENTITY_FILE_FOR_TEST)
      const perms = stat.mode & 0o777
      expect(perms & 0o077).toBe(0) // group + other bits zero
    }

    // Round-trip: parse and check it deserializes to the same key.
    const parsed = JSON.parse(
      readFileSync(_IDENTITY_FILE_FOR_TEST, "utf8"),
    ) as { pk: string; sk: string }
    expect(Buffer.from(parsed.pk, "base64").length).toBe(32)
  })

  test("fallback second call returns the file-stored key (no regen)", async () => {
    const backend = new InMemoryBackend()
    backend.failAll("read")
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(false)
    const first = await getOrCreateEd25519Keypair()

    // Reset the backend so it would throw again on a fresh read.
    const backend2 = new InMemoryBackend()
    backend2.failAll("read")
    _setKeyStoreBackendForTest(backend2)
    const second = await getOrCreateEd25519Keypair()

    expect(Buffer.from(first.publicKey).toString("base64")).toBe(
      Buffer.from(second.publicKey).toString("base64"),
    )
  })
})

// ── Locked-keychain protection (the "lost pairing after a week idle" bug) ────

// ── Native binding cannot load (issue #113 — Bun-built pi) ──────────────────

describe("getOrCreateEd25519Keypair — @napi-rs/keyring binding unavailable", () => {
  test("a binding that never loads falls back to the file identity even on a core-keyring platform", async () => {
    // A load failure is deterministic: no unlock or retry will fix it, so the
    // "keyring is locked, refuse to regenerate" guard must not fire — that
    // would leave the user with no working path at all (issue #113).
    const backend = new InMemoryBackend()
    backend.failAll("read")
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(null) // real platform check (darwin/win32 on CI hosts)
    _setNativeBindingErrorForTest(new Error("Cannot find native binding."))

    const kp = await getOrCreateEd25519Keypair()
    expect(kp.publicKey).toHaveLength(32)
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true)

    // Second call is stable — same identity, read straight off the file.
    const again = await getOrCreateEd25519Keypair()
    expect(Buffer.from(again.publicKey).toString("base64")).toBe(
      Buffer.from(kp.publicKey).toString("base64"),
    )
  })

  test("with the binding loadable, a locked core keyring still refuses to regenerate", async () => {
    const backend = new InMemoryBackend()
    backend.failAll("read")
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(null)
    _setNativeBindingErrorForTest(null)
    // Only meaningful on a platform whose keyring is a core OS service.
    if (process.platform !== "darwin" && process.platform !== "win32") return

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(
      KeyringUnavailableError,
    )
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false)
  })
})

describe("getOrCreateEd25519Keypair — locked keyring does NOT regenerate", () => {
  test("transient read failure recovers via retry → uses keyring entry, no file written", async () => {
    const backend = new InMemoryBackend()
    const original = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(6)).toString("base64"),
    })
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, original)
    backend.failNext("read") // first read throws, retry succeeds
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(true) // macOS/Windows: keyring is core

    const kp = await getOrCreateEd25519Keypair()
    // Recovered the ORIGINAL paired key — not a freshly minted one.
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
    )
    expect(backend.reads.length).toBeGreaterThanOrEqual(2) // retried
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false) // no file regen
  })

  test("persistent failure on a core-keyring platform with no file → throws (refuses to regen)", async () => {
    const backend = new InMemoryBackend()
    backend.failAll("read")
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(true) // macOS/Windows

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(
      KeyringUnavailableError,
    )
    // Critically: no new identity file was written (pairing not silently broken).
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false)
  })

  test("persistent failure but identity.json already exists → returns the FILE key (never throws, never regen)", async () => {
    // First, create a file identity via the headless path.
    const seed = new InMemoryBackend()
    seed.failAll("read")
    _setKeyStoreBackendForTest(seed)
    _setKeyringExpectedForTest(false)
    const fileKp = await getOrCreateEd25519Keypair()

    // Now the keyring is "core" but locked; the existing file must win.
    const locked = new InMemoryBackend()
    locked.failAll("read")
    _setKeyStoreBackendForTest(locked)
    _setKeyringExpectedForTest(true)
    const kp = await getOrCreateEd25519Keypair()

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    )
  })

  test("identity.storage=file mints a file identity even on a core-keyring platform (keychain empty)", async () => {
    const backend = new InMemoryBackend() // keychain readable + empty
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(true)
    writeUnbienConfig({ identity: { storage: "file" } })

    const kp = await getOrCreateEd25519Keypair()
    expect(kp.publicKey.length).toBe(32)
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true)
    // Minted into the FILE, not the keychain.
    expect(backend.writes.length).toBe(0)
  })
})

// ── UNBIEN_IDENTITY_SEED override (read-only, always wins) ───────────────────

describe("getOrCreateEd25519Keypair — UNBIEN_IDENTITY_SEED override", () => {
  test("identity JSON in env wins, touches no backend", async () => {
    const backend = new InMemoryBackend()
    backend.store.set(
      `${NEW_SERVICE}|${ACCOUNT}`,
      JSON.stringify({
        pk: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
        sk: Buffer.from(new Uint8Array(32).fill(2)).toString("base64"),
      }),
    )
    _setKeyStoreBackendForTest(backend)
    process.env.UNBIEN_IDENTITY_SEED = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
      sk: Buffer.from(new Uint8Array(32).fill(8)).toString("base64"),
    })

    const kp = await getOrCreateEd25519Keypair()
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
    )
    expect(backend.reads.length).toBe(0)
    expect(backend.writes.length).toBe(0)
  })

  test("base64 32-byte seed in env derives the keypair, touches no backend", async () => {
    const backend = new InMemoryBackend()
    _setKeyStoreBackendForTest(backend)
    const seed = new Uint8Array(32).fill(3)
    process.env.UNBIEN_IDENTITY_SEED = Buffer.from(seed).toString("base64")

    const kp = await getOrCreateEd25519Keypair()
    expect(kp.secretKey.length).toBe(32)
    expect(Buffer.from(kp.secretKey)).toEqual(Buffer.from(seed))
    expect(kp.publicKey.length).toBe(32)
    expect(backend.reads.length).toBe(0)
  })

  test("a malformed env override throws instead of being silently ignored", async () => {
    const backend = new InMemoryBackend()
    _setKeyStoreBackendForTest(backend)
    process.env.UNBIEN_IDENTITY_SEED = "not-a-valid-seed"

    await expect(getOrCreateEd25519Keypair()).rejects.toThrow()
  })
})

// ── Unreadable identity file fails loud (never mints over it) ────────────────

describe("getOrCreateEd25519Keypair — unreadable identity file", () => {
  test("a corrupt identity.json throws FileIdentityUnreadableError, never mints", async () => {
    mkdirSync(join(_tmpHome, ".pi", "un-bien"), { recursive: true })
    writeFileSync(_IDENTITY_FILE_FOR_TEST, "{ not valid json")
    const backend = new InMemoryBackend() // keychain readable + empty
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(true)

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(
      storage.FileIdentityUnreadableError,
    )
    // Left untouched — not overwritten with a fresh mint.
    expect(readFileSync(_IDENTITY_FILE_FOR_TEST, "utf8")).toBe(
      "{ not valid json",
    )
    expect(backend.writes.length).toBe(0)
  })
})

// ── Cross-backend migration read-in-place (no write-through) ─────────────────

describe("getOrCreateEd25519Keypair — cross-backend migration read-in-place", () => {
  test("keychain backend, keychain empty, file present → returns file key without writing keychain", async () => {
    // Seed a file identity via the headless path.
    const seedBackend = new InMemoryBackend()
    seedBackend.failAll("read")
    _setKeyStoreBackendForTest(seedBackend)
    _setKeyringExpectedForTest(false)
    const fileKp = await getOrCreateEd25519Keypair()

    // Now: keychain backend (default), keychain readable + empty, file present.
    const kc = new InMemoryBackend()
    _setKeyStoreBackendForTest(kc)
    _setKeyringExpectedForTest(true)
    const kp = await getOrCreateEd25519Keypair()

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    )
    // Read in place — did NOT write-through into the keychain.
    expect(kc.writes.length).toBe(0)
  })
})

// ── Never mint a new identity over existing pairings (issues #95 / #69) ──────

describe("getOrCreateEd25519Keypair — paired devices block identity minting", () => {
  function seedPairedDevice(): void {
    mkdirSync(join(_tmpHome, ".pi", "un-bien"), { recursive: true })
    writeFileSync(
      join(_tmpHome, ".pi", "un-bien", "peers.json"),
      JSON.stringify({
        peers: [
          {
            name: "Phone",
            remote_epk: "AAAA",
            paired_at: new Date(0).toISOString(),
          },
        ],
      }),
    )
  }

  test("unreadable keyring + existing pairings → throws instead of minting (daemon case)", async () => {
    // systemd --user resolves a different secret-service store than the desktop
    // session that paired; minting here makes SelfRevoke wipe peers.json.
    seedPairedDevice()
    const backend = new InMemoryBackend()
    backend.failAll("read")
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(false) // headless Linux — used to mint silently

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(
      storage.PairedIdentityMissingError,
    )
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false)
  })

  test("paired devices block minting even with the file backend selected", async () => {
    seedPairedDevice()
    const backend = new InMemoryBackend() // keychain readable + empty
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(true)
    writeUnbienConfig({ identity: { storage: "file" } })

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(
      storage.PairedIdentityMissingError,
    )
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false)
  })

  test("no pairings yet → a genuine first run still mints normally", async () => {
    const backend = new InMemoryBackend()
    backend.failAll("read")
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(false)

    const kp = await getOrCreateEd25519Keypair()
    expect(kp.publicKey).toHaveLength(32)
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true)
  })
})

// ── describeIdentity (read-only, non-secret) ─────────────────────────────────

describe("describeIdentity — non-secret, read-only", () => {
  test("keychain backend with a key → reports epk + source keychain, no writes", async () => {
    const backend = new InMemoryBackend()
    const pk = Buffer.from(new Uint8Array(32).fill(11)).toString("base64")
    backend.store.set(
      `${NEW_SERVICE}|${ACCOUNT}`,
      JSON.stringify({
        pk,
        sk: Buffer.from(new Uint8Array(32).fill(12)).toString("base64"),
      }),
    )
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(true)

    const info = await storage.describeIdentity()
    expect(info.backend).toBe("keychain")
    expect(info.source).toBe("keychain")
    expect(info.epk).toBe(pk)
    // Read-only: no promotion/mint side effects.
    expect(backend.writes.length).toBe(0)
    expect(backend.deletes.length).toBe(0)
  })

  test("no identity anywhere → epk null, source none, mints nothing", async () => {
    const backend = new InMemoryBackend() // readable + empty
    _setKeyStoreBackendForTest(backend)
    _setKeyringExpectedForTest(true)

    const info = await storage.describeIdentity()
    expect(info.epk).toBeNull()
    expect(info.source).toBe("none")
    expect(backend.writes.length).toBe(0)
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false)
  })

  test("env override → source env-override, touches no backend", async () => {
    const backend = new InMemoryBackend()
    _setKeyStoreBackendForTest(backend)
    const pk = Buffer.from(new Uint8Array(32).fill(5)).toString("base64")
    process.env.UNBIEN_IDENTITY_SEED = JSON.stringify({
      pk,
      sk: Buffer.from(new Uint8Array(32).fill(6)).toString("base64"),
    })

    const info = await storage.describeIdentity()
    expect(info.source).toBe("env-override")
    expect(info.epk).toBe(pk)
    expect(backend.reads.length).toBe(0)
  })

  test("file backend with a key → source file, keychain not consulted", async () => {
    // Seed a file identity via the headless path.
    const seed = new InMemoryBackend()
    seed.failAll("read")
    _setKeyStoreBackendForTest(seed)
    _setKeyringExpectedForTest(false)
    const fileKp = await getOrCreateEd25519Keypair()

    writeUnbienConfig({ identity: { storage: "file" } })
    const kc = new InMemoryBackend()
    _setKeyStoreBackendForTest(kc)
    _setKeyringExpectedForTest(true)

    const info = await storage.describeIdentity()
    expect(info.backend).toBe("file")
    expect(info.source).toBe("file")
    expect(info.epk).toBe(Buffer.from(fileKp.publicKey).toString("base64"))
    expect(kc.reads.length).toBe(0)
  })
})

// ── Corrupt peer record isolation ────────────────────────────────────────────

describe("peer record corruption isolation", () => {
  const peersPath = join(_tmpHome, ".pi", "un-bien", "peers.json")

  function writePeers(peers: unknown): void {
    mkdirSync(join(_tmpHome, ".pi", "un-bien"), { recursive: true })
    writeFileSync(peersPath, JSON.stringify({ peers }, null, 2))
  }

  test.each([null, 42, "not-an-array", { remote_epk: "not-an-array" }])(
    "treats a non-array peers value as empty: %j",
    async (peers) => {
      writePeers(peers)

      await expect(storage.listPeers()).resolves.toEqual([])
      await expect(storage.listOwnerPubkeys()).resolves.toEqual([])
    },
  )

  test("a false commit guard preserves the exact raw peer record", async () => {
    const rawHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE"
    const peers = [
      {
        name: "Re-paired Owner",
        remote_epk: rawHandle,
        paired_at: "replacement",
      },
    ]
    writePeers(peers)

    await expect(storage.removePeer(rawHandle, () => false)).resolves.toBe(
      false,
    )
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({ peers })
  })

  test("removes only the exact raw handle while preserving corrupt entries", async () => {
    const urlSafeHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE"
    const standardHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE="
    const originalPeers = [
      null,
      42,
      { name: "missing handle" },
      { name: "null handle", remote_epk: null, paired_at: "first" },
      { name: "URL-safe", remote_epk: urlSafeHandle, paired_at: "second" },
      { name: "standard", remote_epk: standardHandle, paired_at: "third" },
    ]
    writePeers(originalPeers)

    await expect(storage.listPeers()).resolves.toEqual(originalPeers)
    await expect(storage.listOwnerPubkeys()).resolves.toEqual([
      null,
      42,
      undefined,
      urlSafeHandle,
      standardHandle,
    ])
    await expect(storage.removePeer(urlSafeHandle)).resolves.toBe(true)

    const expectedPeers = originalPeers.filter(
      (peer) =>
        !peer ||
        typeof peer !== "object" ||
        (peer as { remote_epk?: unknown }).remote_epk !== urlSafeHandle,
    )
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({
      peers: expectedPeers,
    })
    await expect(storage.removePeer(urlSafeHandle)).resolves.toBe(false)
    await expect(storage.removePeer(standardHandle)).resolves.toBe(true)
  })
})

// ── Backend precedence: the SELECTED backend wins, other is migration-read ──
//
// The flop was a bogus minted identity.json (file) MASKING the real keychain
// key under the old "file always wins" rule: the extension announced the file key
// while the mobile stayed paired to keychain. The operator-selectable model
// fixes it by precedence — the SELECTED backend (default keychain) wins; the
// other is READ IN PLACE only when the selected one is empty, and never minted
// over. never-mint-over also means a genuine machine never ends up with
// DIFFERENT keys in both backends (whichever exists first blocks minting the
// other), so the conflict below only arises from external tampering.

describe("getOrCreateEd25519Keypair — backend precedence (default keychain)", () => {
  /** Seed a file-backed identity via the headless path and return its key. */
  async function seedFileIdentity() {
    const seed = new InMemoryBackend()
    seed.failAll("read")
    _setKeyStoreBackendForTest(seed)
    _setKeyringExpectedForTest(false) // headless Linux → writes identity.json
    const fileKp = await getOrCreateEd25519Keypair()
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true)
    return fileKp
  }

  test("present keychain key WINS over a stray file identity (the flop fix)", async () => {
    await seedFileIdentity() // a stray/bogus file identity on disk

    // The real identity lives in the keychain (where the mobile paired).
    const keyring = new InMemoryBackend()
    const realPk = Buffer.from(new Uint8Array(32).fill(42)).toString("base64")
    keyring.store.set(
      `${NEW_SERVICE}|${ACCOUNT}`,
      JSON.stringify({
        pk: realPk,
        sk: Buffer.from(new Uint8Array(64).fill(43)).toString("base64"),
      }),
    )
    _setKeyStoreBackendForTest(keyring)
    _setKeyringExpectedForTest(true)

    const kp = await getOrCreateEd25519Keypair()
    // The keychain key wins — a stray file can no longer mask it (the flop).
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(realPk)
    // Read-only: the resolver never rewrote the keychain.
    expect(keyring.writes.length).toBe(0)
  })

  test("keychain empty + file present → file recovered via migration read, never minted over", async () => {
    const fileKp = await seedFileIdentity()

    // A readable but EMPTY keyring (default backend) — the file is the only
    // identity, and must be recovered in place, not minted over.
    const keyring = new InMemoryBackend()
    _setKeyStoreBackendForTest(keyring)
    _setKeyringExpectedForTest(true)

    const kp = await getOrCreateEd25519Keypair()
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    )
    // Critically: no fresh key was minted into the keychain over the file
    // identity (that write is exactly what broke pairing in the flop).
    expect(keyring.writes.length).toBe(0)
  })
})

describe("owner snapshot mutation tokens", () => {
  const peersPath = join(_tmpHome, ".pi", "un-bien", "peers.json")
  const snapshotStorage = storage as typeof storage & {
    snapshotOwnerPubkeys(): Promise<
      readonly { rawOwnerPubkey: unknown; token: unknown }[]
    >
    conditionalRemovePeer(
      remoteEpk: string,
      expectedToken: unknown,
    ): Promise<{ outcome: string }>
  }

  function writePeers(peers: unknown): void {
    mkdirSync(join(_tmpHome, ".pi", "un-bien"), { recursive: true })
    writeFileSync(peersPath, JSON.stringify({ peers }, null, 2))
  }

  test("stale re-pair token preserves the replacement record", async () => {
    const rawHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE="
    const original = {
      name: "first",
      remote_epk: rawHandle,
      paired_at: "first",
    }
    const replacement = {
      name: "replacement",
      remote_epk: rawHandle,
      paired_at: "replacement",
    }
    writePeers([original])

    const [snapshot] = await snapshotStorage.snapshotOwnerPubkeys()
    await storage.addPeer(replacement)
    await expect(
      snapshotStorage.conditionalRemovePeer(rawHandle, snapshot!.token),
    ).resolves.toMatchObject({ outcome: "stale" })
    expect(readFileSync(peersPath, "utf8")).toBe(
      JSON.stringify({ peers: [replacement] }, null, 2),
    )
  })

  test("current token removes only its exact raw representation", async () => {
    const urlSafeHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE"
    const standardHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE="
    writePeers([
      { name: "url", remote_epk: urlSafeHandle, paired_at: "first" },
      { name: "standard", remote_epk: standardHandle, paired_at: "second" },
    ])

    const snapshot = await snapshotStorage.snapshotOwnerPubkeys()
    const token = snapshot.find(
      (entry) => entry.rawOwnerPubkey === urlSafeHandle,
    )!.token
    await expect(
      snapshotStorage.conditionalRemovePeer(urlSafeHandle, token),
    ).resolves.toMatchObject({ outcome: "removed" })
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({
      peers: [
        { name: "standard", remote_epk: standardHandle, paired_at: "second" },
      ],
    })
  })
})
