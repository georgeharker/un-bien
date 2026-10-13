import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
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

// ── Relay peering config (relay-to-relay federation) ───────────────────────
// Per-machine file (not synced via dotfiles). Each machine has its own peer
// list — asymmetric peering is fine (A↔B, B↔A+C, C↔B only). The relay reads
// this on startup + SIGHUP (Phase 2) to connect to peer relays.

export interface RelayPeer {
  url: string
  name: string
  /** The peer relay's pinned Ed25519 public key (base64). If present, the
   *  relay verifies the peer's identity on connect. */
  pubkey?: string
}

const RELAY_PEERS_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "relay-peers.json",
)

export function loadRelayPeers(path = RELAY_PEERS_PATH): RelayPeer[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      peers?: RelayPeer[]
    }
    return parsed.peers ?? []
  } catch {
    return []
  }
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
  const peers = loadRelayPeers(path).filter((p) => p.name !== peer.name)
  peers.push(peer)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ peers }, null, 2), { mode: 0o600 })
}

export function removeRelayPeer(
  name: string,
  path = RELAY_PEERS_PATH,
): boolean {
  const peers = loadRelayPeers(path)
  const filtered = peers.filter((p) => p.name !== name)
  if (filtered.length === peers.length) return false
  writeFileSync(path, JSON.stringify({ peers: filtered }, null, 2), {
    mode: 0o600,
  })
  return true
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
