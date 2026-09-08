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
