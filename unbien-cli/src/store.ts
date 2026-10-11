import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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
