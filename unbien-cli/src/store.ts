import {
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  ed25519KeypairFromSeed,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from "@geohar/un-bien/client"

/**
 * The pi machines this client has paired with. Pairing is machine-level, so one
 * successful pair reaches every session that pi hosts — the invite's room is
 * just where the token was issued, not a limit on what we can attach to.
 */
export interface PairedPeer {
  epk: string
  relayUrl: string
  name?: string
  pairedAt: string
}

const STORE_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "proxy-peers.json",
)

/** Version floor for this device's pairing_set pushes, persisted next to the
 *  identity (same trust root). Epoch-seconds alone collide when two CLI
 *  processes push in the same second — the relay's StaleVersion guard then
 *  drops the second push, which can silently discard a REAL allow-list
 *  change — so the mint is strictly monotonic across processes and restarts:
 *  max(epochSeconds, floor + 1). Matches the machine-side
 *  nextAllowListVersion semantics (extension/src/pairing/storage.ts). */
const ALLOW_VERSION_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "proxy-allow-version",
)
const ALLOW_VERSION_LOCK = `${ALLOW_VERSION_PATH}.lock`

/** Cross-process mint with an O_EXCL lockfile (the CLI is short-lived per
 *  invocation, so a small bounded retry suffices; the relay's monotonic
 *  check resolves any lost race benignly). */
export function nextProxyAllowVersion(): number {
  mkdirSync(dirname(ALLOW_VERSION_PATH), { recursive: true, mode: 0o700 })
  let lockFd: number | null = null
  try {
    for (let i = 0; i < 20; i++) {
      try {
        lockFd = openSync(ALLOW_VERSION_LOCK, "wx")
        break
      } catch (e) {
        const err = e as { code?: string }
        if (err.code !== "EEXIST") break
        // Reap a stale lock older than 3s (crashed holder).
        try {
          if (Date.now() - statSync(ALLOW_VERSION_LOCK).mtimeMs > 3_000) {
            unlinkSync(ALLOW_VERSION_LOCK)
            continue
          }
        } catch {
          /* lock vanished */
        }
        sleepBusy(15)
      }
    }
    let floor = 0
    try {
      floor = Number.parseInt(readFileSync(ALLOW_VERSION_PATH, "utf8"), 10) || 0
    } catch {
      /* first use */
    }
    const next = Math.max(Date.now(), floor + 1)
    writeFileSync(ALLOW_VERSION_PATH, String(next), { mode: 0o600 })
    return next
  } finally {
    if (lockFd !== null) {
      try {
        closeSync(lockFd)
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(ALLOW_VERSION_LOCK)
      } catch {
        /* racing releaser won */
      }
    }
  }
}

function sleepBusy(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* bounded spin: CLI lifetimes are short, retry window is ≤300ms */
  }
}

export function loadPeers(path = STORE_PATH): PairedPeer[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      peers?: PairedPeer[]
    }
    return parsed.peers ?? []
  } catch {
    return []
  }
}

export function rememberPeer(peer: PairedPeer, path = STORE_PATH): void {
  const peers = loadPeers(path).filter((p) => p.epk !== peer.epk)
  peers.push(peer)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ peers }, null, 2), { mode: 0o600 })
}

// ── Relay registry ─────────────────────────────────────────────────────────

export interface RememberedRelay {
  url: string
  name: string
  addedAt: string
  /** The relay's pinned Ed25519 pubkey (P7): recorded TOFU at the FIRST pair
   *  over this relay (the moment the user has just scanned a fresh QR), then
   *  verified on every later connection. Absent = no pin yet. */
  pubkey?: string
}

/** The pinned relay pubkey identity that has verified over `relayUrl` —
 *  routes through the identity registry (keyed by pubkey, endpoints known).
 *  Unknown endpoint → undefined → caller TOFUs. */
export function relayPinFor(relayUrl: string): string | undefined {
  return identityForEndpoint(relayUrl)
}

const RELAYS_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "proxy-relays.json",
)

export function loadRelays(path = RELAYS_PATH): RememberedRelay[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      relays?: RememberedRelay[]
    }
    return parsed.relays ?? []
  } catch {
    return []
  }
}

export function rememberRelay(
  relay: RememberedRelay,
  path = RELAYS_PATH,
): void {
  const relays = loadRelays(path).filter((r) => r.url !== relay.url)
  relays.push(relay)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ relays }, null, 2), { mode: 0o600 })
}

export function forgetRelay(urlOrName: string, path = RELAYS_PATH): boolean {
  const relays = loadRelays(path)
  const filtered = relays.filter(
    (r) => r.url !== urlOrName && r.name !== urlOrName,
  )
  if (filtered.length === relays.length) return false
  writeFileSync(path, JSON.stringify({ relays: filtered }, null, 2), {
    mode: 0o600,
  })
  return true
}

// ── Relay identity registry (P6 option A) ────────────────────────
// Keyed by the RELAY'S pubkey (one relay = one identity, no matter how many
// names it serves), with every endpoint it was verified or advertised over.
// `pair` records the first identity (TOFU); later connects to any known
// endpoint keep verifying against it and merge the ack's advertised
// endpoints so the selector can prefer a local bind.
export interface RelayIdentity {
  pubkey: string
  name: string
  /** Dialable endpoints verified or advertised for this identity. */
  endpoints: string[]
  firstSeenAt: string
}

const IDENTITIES_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "relay-identities.json",
)

export function loadRelayIdentities(
  path = IDENTITIES_PATH,
): RelayIdentity[] {
  let stored: RelayIdentity[] = []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      identities?: RelayIdentity[]
    }
    stored = parsed.identities ?? []
  } catch {
    /* first use */
  }
  // ONE-TIME-IN-EFFECT migration: P7's per-URL pins (proxy-relays.json
  // entries carrying a pubkey) fold in here, idempotently — same pubkey →
  // merged endpoint set. The old file stays (source of `unbien relay` names).
  for (const r of loadRelays()) {
    if (!r.pubkey) continue
    const match = stored.find((i) => i.pubkey === r.pubkey)
    if (match) {
      if (!match.endpoints.includes(r.url)) match.endpoints.push(r.url)
    } else {
      stored.push({
        pubkey: r.pubkey,
        name: r.name,
        endpoints: [r.url],
        firstSeenAt: r.addedAt,
      })
    }
  }
  if (stored.length > 0) persistRelayIdentities(stored, path)
  return stored
}

function persistRelayIdentities(
  identities: RelayIdentity[],
  path: string,
): void {
  // Atomic write (temp + rename, 0600) — mirrors writeRelayPeersDoc so a
  // concurrent process can never observe a half-written registry.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ identities }, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

/** Merge a verified (or newly-TOFU'd) relay identity: dedupes endpoints,
 *  keeps the first-seen name unless the stored one is empty. */
export function recordRelayIdentity(
  identity: {
    relayPubkey: string
    relayName?: string
    endpoint: string
    endpoints?: string[]
  },
  path = IDENTITIES_PATH,
): void {
  const identities = loadRelayIdentities(path)
  const match = identities.find((i) => i.pubkey === identity.relayPubkey)
  if (match) {
    const eps = [identity.endpoint, ...(identity.endpoints ?? [])]
    for (const ep of eps) {
      if (ep && !match.endpoints.includes(ep)) match.endpoints.push(ep)
    }
    if (identity.relayName && match.name === "") match.name = identity.relayName
  } else {
    identities.push({
      pubkey: identity.relayPubkey,
      name: identity.relayName ?? "",
      endpoints: [identity.endpoint, ...(identity.endpoints ?? [])].filter(
        Boolean,
      ),
      firstSeenAt: new Date().toISOString(),
    })
  }
  persistRelayIdentities(identities, path)
}

/** The pinned pubkey of any known identity verified over `url` (feed for
 *  `expectRelayPubkey`). Unknown endpoint → undefined → caller TOFUs. */
export function identityForEndpoint(relayUrl: string): string | undefined {
  return loadRelayIdentities().find((i) =>
    i.endpoints.includes(relayUrl),
  )?.pubkey
}

/**
 * Endpoint preference ranking (P6 option C, pure): loopback first, then
 * dotless hostnames (LAN machine names), then private-range IPs, then
 * tailnet/public names. Preserves relative order otherwise.
 */
export function rankEndpoints(urls: readonly string[]): string[] {
  const rank = (url: string): number => {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return 9
    }
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return 0
    if (!host.includes(".")) return 1
    if (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return 2
    }
    if (host.endsWith(".ts.net")) return 4
    return 5
  }
  const seen = new Set<string>()
  const unique = urls.filter((u) => {
    if (!u || seen.has(u)) return false
    seen.add(u)
    return true
  })
  return [...unique].sort((a, b) => rank(a) - rank(b))
}

/**
 * Pick the best dialable endpoint for the relay at `seedUrl` (P6 "local when
 * possible"): candidates = seed + this identity's known endpoints, ranked;
 * each gets a quick /health probe (tight budget, shortest for loopback) —
 * the FIRST healthy one wins. Falls back to the seed (today's behavior;
 * errors deferred to the caller's connect path) when nothing checks out.
 * Records nothing: endpoint bookkeeping happens at identity verification.
 */
export async function pickRelayEndpoint(
  seedUrl: string,
  timeoutMs = 3_000,
): Promise<string> {
  const identity = loadRelayIdentities().find((i) =>
    i.endpoints.includes(seedUrl),
  )
  const candidates = rankEndpoints([seedUrl, ...(identity?.endpoints ?? [])])
  for (const url of candidates) {
    const isLoopback = /localhost|127\.0\.0\.1|::1/.test(url)
    const budget = isLoopback ? 400 : timeoutMs
    try {
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(budget),
      })
      if (res.ok) return url
    } catch {
      /* unreachable on this endpoint — try the next */
    }
  }
  return seedUrl
}

// ── Relay peering config (relay-to-relay federation) ───────────────────────
// Per-machine file (not synced via dotfiles). Each machine has its own peer
// list — asymmetric peering is fine (A↔B, B↔A+C, C↔B only). The relay reads
// this on startup + SIGHUP (Phase 2) to connect to peer relays.

export interface RelayPeer {
  url: string
  name: string
  /** The peer relay's pinned Ed25519 public key (base64). Since the strict
   *  pairing gate, this is MANDATORY — the relay neither dials nor accepts
   *  an unpinned peer. */
  pubkey?: string
  /** The one-time pairing secret from the relay-pair:// URL (base64 TOKEN,
   *  not a key). Presented to the peer in the outbound relay_hello so the
   *  peer auto-adds us; the pin (pubkey) is the durable trust. */
  pair_secret?: string
}

/** A pending pairing entry — `unbien relay pair` mints one and the ISSUING
 *  relay holds it in relay-peers.json `pending`. The secret is a one-time
 *  token: the relay matches it by SHA-256 hash, consumes it, and pins the
 *  PRESENTER's key. name/url are the issuer's own identity as the pairing
 *  URL advertised it. */
export interface PendingRelayPair {
  secret: string
  name: string
  url: string
  at: string
  /** Mint time, epoch millis (expiry vs PENDING_TTL_MS). Legacy entries
   *  without it never expire. */
  at_ms?: number
}

/** A pending pairing invitation is single-use AND short-lived: 24h from
 *  mint. Without this, an unconsumed entry stays a live pairing secret in
 *  relay-peers.json forever (each `relay pair` mints a fresh one). */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000

/** The full relay-peers.json document. The relay ALSO writes this file (the
 *  pairing auto-add), so writers must preserve every field they don't own
 *  (pending, the legacy federation flag, anything else). */
interface RelayPeersDoc {
  peers?: RelayPeer[]
  pending?: PendingRelayPair[]
  [key: string]: unknown
}

const RELAY_PEERS_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "relay-peers.json",
)

function readRelayPeersDoc(path = RELAY_PEERS_PATH): RelayPeersDoc {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RelayPeersDoc
  } catch {
    return {}
  }
}

/** Write the doc ATOMICALLY (temp + rename, 0600) so the relay's fswatch
 *  loop sees one clean event, and PRESERVE every field we don't own. */
function writeRelayPeersDoc(doc: RelayPeersDoc, path = RELAY_PEERS_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

export function loadRelayPeers(path = RELAY_PEERS_PATH): RelayPeer[] {
  return readRelayPeersDoc(path).peers ?? []
}

export function loadPendingRelayPairs(
  path = RELAY_PEERS_PATH,
): PendingRelayPair[] {
  return readRelayPeersDoc(path).pending ?? []
}

/** Hold a freshly-minted pairing secret (the `unbien relay pair` flow).
 *  Preserves peers + every other field in the file. */
export function addPendingRelayPair(
  entry: PendingRelayPair,
  path = RELAY_PEERS_PATH,
): void {
  const doc = readRelayPeersDoc(path)
  // UPSERT by name: re-minting for the same peer replaces the previous
  // invitation (the old secret dies with it — re-issuing IS revocation),
  // and expired entries are pruned while we hold the doc.
  const fresh = (doc.pending ?? []).filter(
    (p) => p.name !== entry.name && isPendingLive(p),
  )
  fresh.push(entry)
  writeRelayPeersDoc({ ...doc, pending: fresh }, path)
}

/** A pending entry is live when it is inside the TTL window. Entries
 *  minted before at_ms exist (CLI < 0.3.31) fall back to their ISO `at`
 *  stamp — legacy entries are aged by the data they already carry, so a
 *  stale pre-TTL invitation cannot linger as a live pairing secret forever. */
export function isPendingLive(p: PendingRelayPair): boolean {
  const mintedAt = p.at_ms ?? Date.parse(p.at)
  if (!Number.isFinite(mintedAt)) return true // no usable stamp ⇒ keep
  return Date.now() - mintedAt < PENDING_TTL_MS
}

/** The relay's CONFIG file — settings (federation gate), in the config root
 *  (dotfile-syncable). The peers list stays in the state root's
 *  relay-peers.json (per-machine topology). Mirrors the relay's
 *  paths::relay_config_path. */
export const RELAY_CONFIG_PATH = join(
  homedir(),
  ".config",
  "un-bien",
  "relay.json",
)

/** The relay federation gate — `federation.enabled` in
 *  ~/.config/un-bien/relay.json (settings). Legacy fallback: the old flag in
 *  the state file. Default false: federation is OPT-IN (the relay refuses
 *  /relay-peer + never starts its peering loops otherwise). */
export function isFederationEnabled(configPath = RELAY_CONFIG_PATH): boolean {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      federation?: { enabled?: boolean }
    }
    if (parsed.federation?.enabled !== undefined) return parsed.federation.enabled === true
  } catch {
    // no config file — fall through to legacy
  }
  try {
    const legacy = JSON.parse(readFileSync(RELAY_PEERS_PATH, "utf8")) as {
      federation?: { enabled?: boolean }
    }
    return legacy.federation?.enabled === true
  } catch {
    return false
  }
}

/** Flip the federation gate — writes ONLY the config file (settings live in
 *  config, state file holds just the peers list). */
export function setFederationEnabled(enabled: boolean, configPath = RELAY_CONFIG_PATH): void {
  let parsed: { federation?: { enabled?: boolean } } = {}
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      federation?: { enabled?: boolean }
    }
  } catch {
    // fresh file
  }
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  // Merge: parsed fields first, then the NEW gate — the flip must win over
  // any existing federation block (a trailing spread would resurrect it).
  writeFileSync(
    configPath,
    JSON.stringify(
      { ...parsed, federation: { ...(parsed.federation ?? {}), enabled } },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}

export function addRelayPeer(
  peer: RelayPeer,
  path = RELAY_PEERS_PATH,
): void {
  const doc = readRelayPeersDoc(path)
  const peers = (doc.peers ?? []).filter((p) => p.name !== peer.name)
  peers.push(peer)
  writeRelayPeersDoc({ ...doc, peers }, path)
}

export function removeRelayPeer(
  name: string,
  path = RELAY_PEERS_PATH,
): boolean {
  const doc = readRelayPeersDoc(path)
  const peers = doc.peers ?? []
  const filtered = peers.filter((p) => p.name !== name)
  if (filtered.length === peers.length) return false
  writeRelayPeersDoc({ ...doc, peers: filtered }, path)
  return true
}

// ── relay-pair:// URLs (federation v2: explicit pairing) ────────────────────

/** The pairing URL payload: the issuing relay's own identity + the
 *  one-time secret. The peer stores {url, name, pubkey} as the PIN and
 *  presents `secret` in its relay_hello so the issuer auto-adds back. */
export interface RelayPairUrl {
  url: string
  name: string
  pubkey: string
  secret?: string
}

export function encodeRelayPairUrl(p: RelayPairUrl): string {
  return `relay-pair://${Buffer.from(JSON.stringify(p)).toString("base64")}`
}

/** Parse a relay-pair:// URL. Returns null on malformed URLs (bad base64,
 *  non-JSON, or missing url/name/pubkey — the pin is mandatory, so a URL
 *  without a pubkey is not a usable pairing URL). */
export function decodeRelayPairUrl(raw: string): RelayPairUrl | null {
  if (!raw.startsWith("relay-pair://")) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(raw.slice("relay-pair://".length), "base64").toString("utf8"),
    ) as Partial<RelayPairUrl>
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.pubkey !== "string"
    ) {
      return null
    }
    const secret =
      typeof parsed.secret === "string" && parsed.secret.length > 0
        ? parsed.secret
        : undefined
    return { url: parsed.url, name: parsed.name, pubkey: parsed.pubkey, secret }
  } catch {
    return null
  }
}

// ── Relay keypair (identity for relay-to-relay peering) ───────────────────

const RELAY_KEYPAIR_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "relay-keypair.json",
)

interface KeypairFile {
  public_key: string // base64
  private_key: string // base64 (32-byte seed)
}

/** Load the relay's Ed25519 keypair from the state dir, or generate + persist
 *  a new one. Format is compatible with the Rust relay's `relay_keypair.rs`. */
export function loadOrCreateRelayKeypair(
  path = RELAY_KEYPAIR_PATH,
): Ed25519Keypair {
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as KeypairFile
    const seed = Buffer.from(file.private_key, "base64")
    if (seed.length === 32) {
      return ed25519KeypairFromSeed(seed)
    }
  } catch {
    // File doesn't exist or is corrupt — generate a new one.
  }
  const kp = generateEd25519Keypair()
  const file: KeypairFile = {
    public_key: Buffer.from(kp.publicKey).toString("base64"),
    private_key: Buffer.from(kp.secretKey).toString("base64"),
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 })
  return kp
}

/** The relay's public key as base64 (its "id" for pairing). */
export function relayPubkeyB64(path = RELAY_KEYPAIR_PATH): string {
  return Buffer.from(loadOrCreateRelayKeypair(path).publicKey).toString(
    "base64",
  )
}
