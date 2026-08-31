import { writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  generateEd25519Keypair,
  ed25519KeypairFromSeed,
  type Ed25519Keypair,
} from "./crypto.js"
import { canonicalizeEd25519PublicKey } from "../mesh/encoding.js"
import { unbienStateHome } from "../paths.js"
import { loadConfig } from "../config.js"

/**
 * Pi-secret storage (plan/27 Wave E1).
 *
 * The Ed25519 long-term identity of this Pi lives in the platform keyring
 * via `@napi-rs/keyring` (Keychain on macOS, libsecret on Linux desktop,
 * Credential Manager on Windows — DPAPI-backed). When the keyring is
 * unavailable (headless Linux without a D-Bus session, Docker containers,
 * VPS without GNOME Keyring/KWallet running) we fall back to a
 * file-backed store at `~/.pi/un-bien/identity.json` with `0o600`
 * permissions and the parent dir at `0o700`.
 *
 * **Migration**: previous builds used `keytar` against service
 * `dev.unbien.mac`. This module reads from the old service if the new
 * service is empty, copies the entry to the new service `dev.unbien.pi`,
 * and deletes the old one. Both keytar and `@napi-rs/keyring` address the
 * same OS-level credential store on every supported platform, so the read
 * succeeds without keeping the deprecated `keytar` dependency.
 */

const NEW_SERVICE = "dev.unbien.pi" // platform-neutral
const OLD_SERVICE = "dev.unbien.mac" // legacy keytar service (pre-2026-05-25)
const ACCOUNT = "longterm-ed25519"

/**
 * The keyring read can THROW transiently rather than permanently — most
 * notably a macOS Keychain that's still locked right after login/wake (the
 * machine sat idle for days). Treating that throw as "backend unavailable"
 * and minting a fresh identity silently orphans the paired key (the
 * "lost pairing after a week idle" failure). So we retry the read a few times
 * before ever concluding the keyring is truly unavailable. Overridable for
 * tests via `_setKeyringRetryForTest`. */
let _keyringReadAttempts = 3
let _keyringRetryDelayMs = 300

/** Raised when the keyring is unreadable on a platform where it's a core OS
 *  service (macOS Keychain, Windows Credential Manager) AND no prior file
 *  identity exists. We refuse to generate a NEW identity here because that
 *  would break existing pairing — the caller surfaces this so the user can
 *  unlock the keychain and retry instead of silently re-pairing. */
export class KeyringUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "Platform keyring is unreadable and no file-backed identity exists. " +
        "Refusing to generate a NEW identity (that would break existing " +
        "pairing). Unlock your keychain / start your secret service and retry, " +
        'or select the file backend with `"identity": { "storage": "file" }` ' +
        "in un-bien.json for a headless host. " +
        `Cause: ${String(cause)}`,
    )
    this.name = "KeyringUnavailableError"
  }
}

/** Raised when no identity can be resolved (keyring unreadable, no identity
 *  file) BUT `peers.json` already lists paired devices. Minting a fresh key
 *  here would make SelfRevoke wipe those pairings — see issues #95 / #69. */
export class PairedIdentityMissingError extends Error {
  constructor(pairedCount: number, cause: unknown) {
    super(
      `No identity could be read, but ${pairedCount} device(s) are already ` +
        "paired. Refusing to generate a NEW identity — that would revoke every " +
        "paired device. This usually means this process cannot reach the same " +
        "keyring as the session that paired (e.g. a systemd --user daemon vs. " +
        "your desktop session). Fix the service's keyring access, or pin the " +
        "identity by copying the paired keypair to ~/.pi/un-bien/identity.json " +
        "(0600), which both contexts read first. " +
        `Cause: ${String(cause)}`,
    )
    this.name = "PairedIdentityMissingError"
  }
}

/** Raised when the file-backend identity EXISTS but cannot be read or parsed
 *  (bad permissions, corruption). Treating that as "no identity" would let the
 *  resolver mint a fresh seed over a real one — the file-side version of the
 *  flop — so we FAIL LOUD instead of minting. */
export class FileIdentityUnreadableError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `The identity file at ${path} exists but could not be read/parsed. ` +
        "Refusing to generate a NEW identity (that would break existing " +
        "pairing). Fix the file's permissions/contents and retry, or point " +
        "`identity.path` at the correct file. " +
        `Cause: ${String(cause)}`,
    )
    this.name = "FileIdentityUnreadableError"
  }
}

const PI_DIR = unbienStateHome()
const IDENTITY_FILE = join(PI_DIR, "identity.json")
const PEERS_PATH = join(PI_DIR, "peers.json")

// ── KeyStore abstraction ─────────────────────────────────────────────────────

/**
 * Minimal backend interface for credential reads/writes. Swappable so
 * tests can inject a controlled in-memory store without touching the OS
 * keyring (which is shared with the developer's own credentials).
 *
 * Errors thrown by `read`/`write`/`delete` signal "backend unavailable on
 * this platform" — callers fall back to the file store on first failure.
 * Returning `undefined` from `read` means "no such entry" (a normal,
 * non-error condition).
 */
export interface KeyStoreBackend {
  read(service: string, account: string): Promise<string | undefined>
  write(service: string, account: string, value: string): Promise<void>
  delete(service: string, account: string): Promise<boolean>
}

/**
 * Per-operation timeout for native keyring calls (gnome-keyring / libsecret
 * via @napi-rs/keyring). A healthy secret service settles in milliseconds; 3s
 * is generous. The point is NOT speed — it is converting a HANG into a thrown
 * error. The native getPassword()/setPassword() can block indefinitely when
 * gnome-keyring waits on a GUI authorization prompt that cannot be shown in
 * a headless / tmux / non-interactive context. A hang never settles, so
 * without this guard the promise never rejects and the retry + file-fallback
 * logic in getOrCreateEd25519Keypair() is unreachable — freezing the entire
 * /unbien pair bootstrap. Raising a real error here lets that fallback
 * chain run as designed.
 */
const KEYRING_OP_TIMEOUT_MS = 3_000

function _withTimeout<T>(
  p: Promise<T>,
  op: string,
  ms: number = KEYRING_OP_TIMEOUT_MS,
): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`keyring ${op} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ])
}

/**
 * Lazily loaded `@napi-rs/keyring` binding — issue #113.
 *
 * A STATIC `import { AsyncEntry } from "@napi-rs/keyring"` is evaluated when
 * the extension module is loaded, so a native binding that cannot be resolved
 * takes the WHOLE extension down at load time ("Failed to load extension …:
 * Cannot find native binding"). That happens on a Bun-compiled `pi`: the
 * loader's first branch (`require("./keyring.<triple>.node")`) is fine, but its
 * fallback (`require("@napi-rs/keyring-<triple>")`, a bare package whose `main`
 * IS the .node file) resolves under Node and not under Bun — and the message it
 * prints then blames npm's optional-dependency bug, sending users off to delete
 * node_modules and losing their other pi packages.
 *
 * Loading on first use turns that fatal load error into an ordinary backend
 * failure, which the existing retry + file-identity fallback already handles.
 */
let _asyncEntryCtor: typeof import("@napi-rs/keyring").AsyncEntry | null = null
let _nativeBindingError: unknown = null

async function _loadAsyncEntry(): Promise<
  typeof import("@napi-rs/keyring").AsyncEntry
> {
  if (_asyncEntryCtor) return _asyncEntryCtor
  if (_nativeBindingError) throw _nativeBindingError
  try {
    const mod = await import("@napi-rs/keyring")
    _asyncEntryCtor = mod.AsyncEntry
    return _asyncEntryCtor
  } catch (err) {
    _nativeBindingError = err
    throw err
  }
}

/**
 * Did the native binding fail to LOAD (as opposed to an operation failing)?
 *
 * A load failure is deterministic and platform-wide: no retry, no unlock, no
 * amount of waiting brings the keyring back in this process. So it must NOT be
 * treated like a transiently locked Keychain — on macOS/Windows that would
 * throw `KeyringUnavailableError` and leave the user with no working path at
 * all. The file-identity fallback (with its loud warning) is the only usable
 * route here, exactly as on headless Linux.
 */
function _nativeBindingUnavailable(): boolean {
  return _nativeBindingError !== null
}

/** Test-only: force (or clear with `null`) a memoized binding-load failure, so
 *  the Bun/no-native-binding branch is reachable without a Bun host. */
export function _setNativeBindingErrorForTest(err: unknown): void {
  _asyncEntryCtor = null
  _nativeBindingError = err
}

class NapiKeyringBackend implements KeyStoreBackend {
  async read(service: string, account: string): Promise<string | undefined> {
    const AsyncEntry = await _loadAsyncEntry()
    const entry = new AsyncEntry(service, account)
    return _withTimeout(entry.getPassword(), `read(${service})`) // undefined on no-entry
  }
  async write(service: string, account: string, value: string): Promise<void> {
    const AsyncEntry = await _loadAsyncEntry()
    const entry = new AsyncEntry(service, account)
    await _withTimeout(entry.setPassword(value), `write(${service})`)
  }
  async delete(service: string, account: string): Promise<boolean> {
    let entry: InstanceType<typeof import("@napi-rs/keyring").AsyncEntry>
    try {
      const AsyncEntry = await _loadAsyncEntry()
      entry = new AsyncEntry(service, account)
    } catch {
      return false
    }
    try {
      return await _withTimeout(entry.deleteCredential(), `delete(${service})`)
    } catch {
      return false
    }
  }
}

let _backend: KeyStoreBackend | null = null

function _getBackend(): KeyStoreBackend {
  if (!_backend) _backend = new NapiKeyringBackend()
  return _backend
}

/** Test-only: swap (or clear with `null`) the keyring backend. */
export function _setKeyStoreBackendForTest(
  backend: KeyStoreBackend | null,
): void {
  _backend = backend
}

/**
 * Is the platform keyring a CORE OS service we should expect to be present?
 * macOS (Keychain) and Windows (Credential Manager) always have one, so a read
 * that throws there is transient/locked, NOT "headless" — we must not mint a
 * new identity. On Linux/other the secret service may be genuinely absent
 * (headless, no D-Bus), so the documented file fallback applies. Overridable
 * for tests via `_setKeyringExpectedForTest`. */
let _keyringExpectedOverride: boolean | null = null
function _keyringExpectedAvailable(): boolean {
  if (_keyringExpectedOverride !== null) return _keyringExpectedOverride
  // Binding never loaded (Bun-built pi, issue #113) → there is no keyring on
  // this platform *for this process*, whatever the OS normally offers.
  if (_nativeBindingUnavailable()) return false
  return process.platform === "darwin" || process.platform === "win32"
}

/** Test-only: force `_keyringExpectedAvailable()` (so a darwin test host can
 *  exercise the Linux/headless branch and vice-versa). `null` restores the
 *  real platform check. */
export function _setKeyringExpectedForTest(value: boolean | null): void {
  _keyringExpectedOverride = value
}

/** Test-only: shrink retry attempts/delay so the persistent-failure path is
 *  fast. `null`/omitted restores defaults. */
export function _setKeyringRetryForTest(
  attempts: number | null,
  delayMs?: number,
): void {
  _keyringReadAttempts = attempts ?? 3
  _keyringRetryDelayMs = delayMs ?? 300
}

function _sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
}

// ── Keypair serialization ────────────────────────────────────────────────────

interface SerializedKeypair {
  pk: string
  sk: string
}

function _serialize(kp: Ed25519Keypair): string {
  const payload: SerializedKeypair = {
    pk: Buffer.from(kp.publicKey).toString("base64"),
    sk: Buffer.from(kp.secretKey).toString("base64"),
  }
  return JSON.stringify(payload)
}

function _deserialize(stored: string): Ed25519Keypair {
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch (err) {
    throw new Error(
      `identity is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as SerializedKeypair).pk !== "string" ||
    typeof (parsed as SerializedKeypair).sk !== "string"
  ) {
    throw new Error(
      "identity JSON must be an object with base64 `pk` and `sk` strings",
    )
  }
  const { pk, sk } = parsed as SerializedKeypair
  const publicKey = Buffer.from(pk, "base64")
  const secretKey = Buffer.from(sk, "base64")
  if (publicKey.length !== 32) {
    throw new Error(
      `identity public key must decode to 32 bytes (got ${publicKey.length})`,
    )
  }
  return { publicKey, secretKey }
}

// ── Storage-backend selection (un-bien.json `identity`) ─────────────────────

export type IdentityStorageBackend = "keychain" | "file"

/**
 * The operator-selected PRIMARY store (`identity.storage` in un-bien.json),
 * default keychain. Forced to `"file"` when this process has no usable keyring
 * (Bun-built pi / native binding failed to load) — there is no keychain to
 * select. Note the config may still say `"keychain"` on headless Linux; the
 * read simply throws there and the genuine-first-run mint falls to a file
 * identity exactly as before.
 */
function _selectedStorageBackend(): IdentityStorageBackend {
  if (_nativeBindingUnavailable()) return "file"
  return loadConfig().identity?.storage === "file" ? "file" : "keychain"
}

/** Resolved file-backend path (`identity.path` in un-bien.json), default
 *  `~/.pi/un-bien/identity.json`. */
function _identityFilePath(): string {
  const p = loadConfig().identity?.path
  return p && p.length > 0 ? p : IDENTITY_FILE
}

function _isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  )
}

// ── env override ────────────────────────────────────────────────────────────

/**
 * `UNBIEN_IDENTITY_SEED` — a read-only override that always WINS when set. The
 * operator populates it themselves (e.g. `cat` the identity file into it, or a
 * base64 32-byte seed); un-bien NEVER writes it. Accepts either the identity
 * JSON (`{pk,sk}`, i.e. the file's contents) or a bare base64 32-byte Ed25519
 * seed. A malformed value THROWS rather than being silently ignored — a
 * supplied-but-broken override is an operator error worth surfacing.
 */
function _keypairFromEnvOverride(): Ed25519Keypair | null {
  const raw = process.env["UNBIEN_IDENTITY_SEED"]
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith("{")) return _deserialize(trimmed)
  const seed = Buffer.from(trimmed, "base64")
  if (seed.length !== 32) {
    throw new Error(
      "UNBIEN_IDENTITY_SEED must be the identity JSON ({pk,sk}) or a base64 " +
        `32-byte Ed25519 seed (decoded to ${seed.length} bytes).`,
    )
  }
  return ed25519KeypairFromSeed(seed)
}

// ── File backend ────────────────────────────────────────────────────────────

/**
 * Reads a file-backed identity, distinguishing "genuinely absent" (ENOENT →
 * `null`, a safe first-run signal) from "present but unreadable/corrupt" (→
 * `FileIdentityUnreadableError`). The distinction is load-bearing: treating a
 * corrupt or permission-denied file as "no identity" would let the resolver
 * MINT over an identity that is really there.
 */
async function _readKeypairFromFile(
  path: string,
): Promise<Ed25519Keypair | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if (_isENOENT(err)) return null
    throw new FileIdentityUnreadableError(path, err)
  }
  try {
    return _deserialize(raw)
  } catch (err) {
    throw new FileIdentityUnreadableError(path, err)
  }
}

async function _writeKeypairToFile(
  kp: Ed25519Keypair,
  path: string,
): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Best-effort tighten in case the dir pre-existed with looser permissions
  // (mkdir's mode is only applied to NEW dirs).
  try {
    await chmod(dir, 0o700)
  } catch {
    /* not fatal */
  }
  await writeFile(path, _serialize(kp), { mode: 0o600 })
  try {
    await chmod(path, 0o600)
  } catch {
    /* not fatal */
  }
}

// ── Keychain backend ────────────────────────────────────────────────────────

type KeychainReadResult =
  { ok: true; kp: Ed25519Keypair | null } | { ok: false; error: unknown }

/**
 * Retried read of the keychain: the new service, then the legacy service
 * (`dev.unbien.mac`, promoted to the new one + deleted — a same-identity
 * service rename, not a mint). `ok:true` with `kp:null` means both reads
 * SUCCEEDED and found nothing (a genuine empty keychain). `ok:false` means the
 * read threw on every attempt (locked/denied/unavailable) — the caller must
 * NOT treat that as empty, or it mints over a possibly-present identity.
 */
async function _readKeychain(
  backend: KeyStoreBackend,
  promote = true,
): Promise<KeychainReadResult> {
  let lastError: unknown
  for (let attempt = 0; attempt < _keyringReadAttempts; attempt++) {
    try {
      const existing = await backend.read(NEW_SERVICE, ACCOUNT)
      if (existing) return { ok: true, kp: _deserialize(existing) }

      const legacy = await backend.read(OLD_SERVICE, ACCOUNT)
      if (legacy) {
        const kp = _deserialize(legacy)
        // `promote=false` keeps the read side-effect-free (e.g. describeIdentity
        // for `show`); the resolver promotes the legacy entry once.
        if (promote) {
          await backend.write(NEW_SERVICE, ACCOUNT, legacy)
          await backend.delete(OLD_SERVICE, ACCOUNT)
        }
        return { ok: true, kp }
      }
      return { ok: true, kp: null }
    } catch (err) {
      lastError = err
      if (attempt < _keyringReadAttempts - 1) {
        // Linear backoff — a locked Keychain usually frees within seconds.
        await _sleep(_keyringRetryDelayMs * (attempt + 1))
      }
    }
  }
  return { ok: false, error: lastError }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns this Pi's long-term Ed25519 identity, minting one only on a genuine
 * first run. The seed is portable and its public key (epk) is what the relay
 * routes on and what devices pair against — so this resolver's ONE job is to
 * never change the identity out from under an existing pairing (the "flop").
 *
 * Resolution (operator-selectable backend — see design):
 *   0. `UNBIEN_IDENTITY_SEED` env override — always wins, read-only.
 *   1. The SELECTED backend (`identity.storage`, default keychain): keychain
 *      (retried — a locked Keychain throws, which is NOT "empty") or the 0600
 *      file at `identity.path`.
 *   2. Migration READ-IN-PLACE of the OTHER backend — recovers an existing
 *      identity (a keychain key when file is selected, or a file when keychain
 *      is selected) WITHOUT writing it through.
 *   3. Generate + persist to the selected backend, but ONLY when every
 *      consulted source was genuinely empty. A keychain that THREW on a
 *      core-OS-keyring platform (macOS/Windows) is possibly-present →
 *      `KeyringUnavailableError`, never minted over. Existing pairings →
 *      `PairedIdentityMissingError`. A present-but-unreadable file →
 *      `FileIdentityUnreadableError`. This is write-only-if-nonexistent: the
 *      resolver's only mutation is a genuine-first-run mint.
 *
 * Idempotent. On headless Linux / a Bun-built pi (no usable keyring) the file
 * backend is used automatically.
 */
export async function getOrCreateEd25519Keypair(): Promise<Ed25519Keypair> {
  // ── Override: an env-supplied seed always wins (read-only) ──────────────
  const override = _keypairFromEnvOverride()
  if (override) return override

  const backend = _getBackend()
  const selected = _selectedStorageBackend()
  const filePath = _identityFilePath()

  let keychain: KeychainReadResult | null = null

  if (selected === "keychain") {
    keychain = await _readKeychain(backend)
    if (keychain.ok && keychain.kp) return keychain.kp
    // Migration read-in-place of the file backend (never written through).
    const fromFile = await _readKeypairFromFile(filePath)
    if (fromFile) return fromFile
  } else {
    const fromFile = await _readKeypairFromFile(filePath)
    if (fromFile) return fromFile
    // Migration read-in-place of the keychain — only where one could exist.
    if (_keyringExpectedAvailable()) {
      keychain = await _readKeychain(backend)
      if (keychain.ok && keychain.kp) return keychain.kp
    }
  }

  // ── Nothing found. Mint — but only when it is SAFE to. ──────────────────
  const keychainThrew = keychain !== null && keychain.ok === false
  const keychainError =
    keychain !== null && keychain.ok === false ? keychain.error : null

  // A keychain that THREW on a platform where it's a core OS service isn't
  // "empty" — it's locked/denied and may hold the real identity. Minting now
  // is exactly the flop. Fail loud so the operator unlocks and retries.
  if (keychainThrew && _keyringExpectedAvailable()) {
    throw new KeyringUnavailableError(keychainError)
  }

  // Devices already paired ⇒ an identity provably existed; "not found" here is
  // a broken environment (classically a systemd --user daemon that can't reach
  // the desktop keyring), not a first run. Minting would let SelfRevoke wipe
  // the pairings (issues #95/#69). Fail loud on every platform.
  const paired = await listPeers()
  if (paired.length > 0) {
    throw new PairedIdentityMissingError(paired.length, keychainError)
  }

  // ── Genuine first run: mint once into the selected backend ──────────────
  const fresh = generateEd25519Keypair()
  const keychainUsable = !_nativeBindingUnavailable() && !keychainThrew
  if (selected === "keychain" && keychainUsable) {
    await backend.write(NEW_SERVICE, ACCOUNT, _serialize(fresh))
    return fresh
  }
  // File backend — either selected, or keychain selected but unusable in this
  // process (headless Linux / Bun-built pi), which degrades to a file identity.
  if (selected === "keychain") {
    console.warn(
      _nativeBindingUnavailable()
        ? "[un-bien] @napi-rs/keyring native binding could not be loaded in " +
            `this runtime; using file-backed identity at ${filePath} (0600) ` +
            "instead. Expected on a Bun-built pi. Paired devices keyed to a " +
            `previous keyring identity must be re-paired. ${String(keychainError)}`
        : "[un-bien] keyring unavailable; using file-backed identity at " +
            `${filePath}. ${String(keychainError)}`,
    )
  }
  await _writeKeypairToFile(fresh, filePath)
  return fresh
}

// ── Read-only identity inspection (for `unbien identity show`) ──────────────

export interface IdentityInfo {
  /** Base64 Ed25519 public key (epk) — PUBLIC, safe to display. `null` when no
   *  identity exists yet (one is minted on first real use). */
  readonly epk: string | null
  /** The selected/effective storage backend. */
  readonly backend: IdentityStorageBackend
  /** Where the identity resolved from (or would come from). */
  readonly source: "env-override" | "keychain" | "file" | "none" | "error"
  /** Resolved file-backend path. */
  readonly filePath: string
  /** Human note (migration recovery, error cause, first-run hint). */
  readonly detail?: string
}

/**
 * Reports the CURRENT identity state WITHOUT minting or mutating anything — the
 * read-only backing for `unbien identity show`. Returns only NON-SECRET fields
 * (epk is public); the private seed is NEVER included, since command output is
 * LLM-visible. Read errors are surfaced as `source:"error"` with a `detail`,
 * not thrown — this is a diagnostic.
 */
export async function describeIdentity(): Promise<IdentityInfo> {
  const backend = _selectedStorageBackend()
  const filePath = _identityFilePath()
  const epkOf = (kp: Ed25519Keypair): string =>
    Buffer.from(kp.publicKey).toString("base64")

  try {
    const override = _keypairFromEnvOverride()
    if (override)
      return {
        epk: epkOf(override),
        backend,
        source: "env-override",
        filePath,
      }
  } catch (err) {
    return {
      epk: null,
      backend,
      source: "error",
      filePath,
      detail: `env override invalid: ${String(err)}`,
    }
  }

  const store = _getBackend()
  const readFileSafe = async (): Promise<{
    kp?: Ed25519Keypair
    err?: unknown
  }> => {
    try {
      const kp = await _readKeypairFromFile(filePath)
      return kp ? { kp } : {}
    } catch (err) {
      return { err }
    }
  }
  const readKcSafe = async (): Promise<{
    kp?: Ed25519Keypair
    err?: unknown
  }> => {
    const r = await _readKeychain(store, false)
    return r.ok ? (r.kp ? { kp: r.kp } : {}) : { err: r.error }
  }

  if (backend === "keychain") {
    const kc = await readKcSafe()
    if (kc.kp)
      return { epk: epkOf(kc.kp), backend, source: "keychain", filePath }
    const f = await readFileSafe()
    if (f.kp)
      return {
        epk: epkOf(f.kp),
        backend,
        source: "file",
        filePath,
        detail: "recovered from the file backend (migration read)",
      }
    if (kc.err)
      return {
        epk: null,
        backend,
        source: "error",
        filePath,
        detail: `keychain unreadable: ${String(kc.err)}`,
      }
    if (f.err)
      return {
        epk: null,
        backend,
        source: "error",
        filePath,
        detail: `file unreadable: ${String(f.err)}`,
      }
  } else {
    const f = await readFileSafe()
    if (f.kp) return { epk: epkOf(f.kp), backend, source: "file", filePath }
    if (f.err)
      return {
        epk: null,
        backend,
        source: "error",
        filePath,
        detail: `file unreadable: ${String(f.err)}`,
      }
    if (_keyringExpectedAvailable()) {
      const kc = await readKcSafe()
      if (kc.kp)
        return {
          epk: epkOf(kc.kp),
          backend,
          source: "keychain",
          filePath,
          detail: "recovered from the keychain (migration read)",
        }
      if (kc.err)
        return {
          epk: null,
          backend,
          source: "error",
          filePath,
          detail: `keychain unreadable: ${String(kc.err)}`,
        }
    }
  }

  return {
    epk: null,
    backend,
    source: "none",
    filePath,
    detail: "no identity yet — one is minted on first use",
  }
}

// ── peers.json ────────────────────────────────────────────────────────────────

export interface PeerRecord {
  name: string
  remote_epk: string // raw standard/base64url 32B Ed25519 Owner handle; preserved exactly
  paired_at: string // ISO-8601
}

export async function listPeers(): Promise<PeerRecord[]> {
  try {
    const raw = await readFile(PEERS_PATH, "utf8")
    const parsed = JSON.parse(raw) as { peers?: unknown }
    return Array.isArray(parsed.peers) ? (parsed.peers as PeerRecord[]) : []
  } catch {
    return []
  }
}

/**
 * Authoritative container read for SelfRevoke's token path. Public readers
 * intentionally remain best-effort; only a missing file is proof of emptiness
 * here. Valid array elements are returned verbatim for corruption isolation.
 */
async function _readPeerContainerStrict(): Promise<unknown[]> {
  let raw: string
  try {
    raw = await readFile(PEERS_PATH, "utf8")
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return []
    }
    throw error
  }
  let parsed: { peers?: unknown }
  try {
    parsed = JSON.parse(raw) as { peers?: unknown }
  } catch (err) {
    throw new Error(
      `peers.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!Array.isArray(parsed.peers)) {
    throw new Error("Invalid peers.json container")
  }
  return parsed.peers
}

let _peerMutationQueue: Promise<void> = Promise.resolve()
const _ownerSlotTokens = new Map<string, OwnerStorageToken>()
const _ownerStorageTokenBrand: unique symbol = Symbol("owner-storage-token")

/** Opaque, process-local provenance for one canonical Owner storage slot. */
export type OwnerStorageToken = {
  readonly [_ownerStorageTokenBrand]: true
}

export interface OwnerStorageSnapshotRecord {
  readonly rawOwnerPubkey: unknown
  readonly token: OwnerStorageToken
}

export type ConditionalPeerRemoval =
  | { readonly outcome: "removed"; readonly nextToken: OwnerStorageToken }
  | { readonly outcome: "stale" | "not_found" | "no_authority" }

function _ownerSlotKey(rawOwnerPubkey: unknown): string {
  if (typeof rawOwnerPubkey !== "string") {
    // Invalid non-string records remain in snapshots, but SelfRevoke skips
    // them before conditional removal; quarantine-key collisions cannot
    // authorize a removal.
    return `raw:quarantine:${typeof rawOwnerPubkey}`
  }
  try {
    return `owner:${canonicalizeEd25519PublicKey(rawOwnerPubkey, "Owner record")}`
  } catch {
    return `raw:string:${rawOwnerPubkey}`
  }
}

function _tokenForSlot(slot: string): OwnerStorageToken {
  const existing = _ownerSlotTokens.get(slot)
  if (existing) return existing
  const token = Object.freeze({
    [_ownerStorageTokenBrand]: true,
  }) as OwnerStorageToken
  _ownerSlotTokens.set(slot, token)
  return token
}

function _invalidateOwnerSlot(rawOwnerPubkey: unknown): OwnerStorageToken {
  const slot = _ownerSlotKey(rawOwnerPubkey)
  const token = Object.freeze({
    [_ownerStorageTokenBrand]: true,
  }) as OwnerStorageToken
  _ownerSlotTokens.set(slot, token)
  return token
}

function _serializePeerMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = _peerMutationQueue.then(mutation, mutation)
  _peerMutationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function addPeer(record: PeerRecord): Promise<void> {
  return _serializePeerMutation(async () => {
    const peers = (await listPeers()) as unknown[]
    const idx = peers.findIndex(
      (peer) =>
        !!peer &&
        typeof peer === "object" &&
        (peer as { remote_epk?: unknown }).remote_epk === record.remote_epk,
    )
    if (idx >= 0) {
      peers[idx] = record // idempotent re-pair
    } else {
      peers.push(record)
    }
    await mkdir(dirname(PEERS_PATH), { recursive: true })
    await writeFile(PEERS_PATH, JSON.stringify({ peers }, null, 2))
    // A successful re-pair is a new storage provenance event even when the
    // record bytes happen to be identical.
    _invalidateOwnerSlot(record.remote_epk)
  })
}

/**
 * Returns the set of distinct `remote_epk` values in peers.json.
 *
 * In the current pairing model (plan/23 + plan/24), each `remote_epk` is the
 * Owner's Ed25519 pubkey — and we treat each as a distinct Owner the Pi has
 * been paired with. Used by the mesh self-revoke poller (plan/24 Wave 3) to
 * know which Owners' mesh blobs to fetch.
 */
export async function listOwnerPubkeys(): Promise<unknown[]> {
  const peers = (await listPeers()) as unknown[]
  const seen = new Set<unknown>()
  for (const peer of peers) {
    if (!peer || typeof peer !== "object") {
      seen.add(peer)
      continue
    }
    seen.add((peer as { remote_epk?: unknown }).remote_epk)
  }
  return [...seen]
}

/**
 * Atomically snapshots raw Owner handles and their canonical-slot provenance.
 * The token is deliberately process-local and opaque to callers.
 */
export function snapshotOwnerPubkeys(): Promise<
  readonly OwnerStorageSnapshotRecord[]
> {
  return _serializePeerMutation(async () => {
    const peers = await _readPeerContainerStrict()
    const rawOwners = new Set<unknown>()
    for (const peer of peers) {
      if (!peer || typeof peer !== "object") {
        rawOwners.add(peer)
      } else {
        rawOwners.add((peer as { remote_epk?: unknown }).remote_epk)
      }
    }
    return [...rawOwners].map((rawOwnerPubkey) => ({
      rawOwnerPubkey,
      token: _tokenForSlot(_ownerSlotKey(rawOwnerPubkey)),
    }))
  })
}

/**
 * Removes one exact raw handle only when its snapshot provenance still owns
 * the target canonical Owner slot. The final authority/token checks and sync
 * write share the existing serialized mutation lane.
 */
export function conditionalRemovePeer(
  remoteEpk: string,
  expectedToken: OwnerStorageToken,
  canCommit?: () => boolean,
): Promise<ConditionalPeerRemoval> {
  return _serializePeerMutation(async () => {
    const slot = _ownerSlotKey(remoteEpk)
    // Provenance belongs to the canonical Owner slot, not the exact raw
    // spelling. A stale slot must therefore win over an absent old spelling.
    if (_tokenForSlot(slot) !== expectedToken) return { outcome: "stale" }
    const peers = await _readPeerContainerStrict()
    const filtered = peers.filter(
      (peer) =>
        !peer ||
        typeof peer !== "object" ||
        (peer as { remote_epk?: unknown }).remote_epk !== remoteEpk,
    )
    if (filtered.length === peers.length) return { outcome: "not_found" }
    await mkdir(dirname(PEERS_PATH), { recursive: true })
    // No await may intervene between the final token/authority checks and
    // synchronous write, preserving the lane's fail-closed commit boundary.
    if (_tokenForSlot(slot) !== expectedToken) return { outcome: "stale" }
    if (canCommit) {
      let authorized = false
      try {
        authorized = canCommit()
      } catch {
        return { outcome: "no_authority" }
      }
      if (!authorized) return { outcome: "no_authority" }
    }
    writeFileSync(PEERS_PATH, JSON.stringify({ peers: filtered }, null, 2))
    return { outcome: "removed", nextToken: _invalidateOwnerSlot(remoteEpk) }
  })
}

export function removePeer(
  remoteEpk: string,
  canCommit?: () => boolean,
): Promise<boolean> {
  return _serializePeerMutation(async () => {
    const peers = (await listPeers()) as unknown[]
    const filtered = peers.filter(
      (peer) =>
        !peer ||
        typeof peer !== "object" ||
        (peer as { remote_epk?: unknown }).remote_epk !== remoteEpk,
    )
    if (filtered.length === peers.length) return false
    await mkdir(dirname(PEERS_PATH), { recursive: true })

    const serialized = JSON.stringify({ peers: filtered }, null, 2)
    if (canCommit) {
      // Guarded SelfRevoke commits must be atomic with their final authority
      // check at the JavaScript level: fail closed on false/throw, then perform
      // the tiny JSON rewrite synchronously with no interruptible await between.
      let authorized = false
      try {
        authorized = canCommit()
      } catch {
        return false
      }
      if (!authorized) return false
      writeFileSync(PEERS_PATH, serialized)
    } else {
      // Manual removals keep the established asynchronous storage behavior.
      await writeFile(PEERS_PATH, serialized)
    }
    const removed = true
    if (removed) _invalidateOwnerSlot(remoteEpk)
    return removed
  })
}

// ── Test-only helpers ────────────────────────────────────────────────────────

/** Test-only: expose the identity-file path so tests can clean it. */
export const _IDENTITY_FILE_FOR_TEST = IDENTITY_FILE
/** Test-only: expose unlink for cleanup. */
export const _unlinkIdentityFileForTest = async (): Promise<void> => {
  try {
    await unlink(IDENTITY_FILE)
  } catch {
    /* fine if missing */
  }
}
