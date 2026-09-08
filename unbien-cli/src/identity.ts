import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  ed25519KeypairFromSeed,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from "@geohar/un-bien/client"

/**
 * This client's own owner identity. It is a SEPARATE owner device from the
 * phone — it pairs on its own token and is revoked on its own, so losing the
 * laptop never implies re-pairing the phone.
 */
const IDENTITY_PATH = join(
  homedir(),
  ".local",
  "state",
  "un-bien",
  "proxy-identity.json",
)

export function loadOrCreateIdentity(path = IDENTITY_PATH): Ed25519Keypair {
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { seed?: string }
    if (stored.seed) {
      return ed25519KeypairFromSeed(Buffer.from(stored.seed, "base64"))
    }
  } catch {
    // No identity yet (or an unreadable one) — mint a fresh one below.
  }

  const keypair = generateEd25519Keypair()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(
    path,
    JSON.stringify({
      seed: Buffer.from(keypair.secretKey.slice(0, 32)).toString("base64"),
      publicKey: Buffer.from(keypair.publicKey).toString("base64"),
    }),
    { mode: 0o600 },
  )
  chmodSync(path, 0o600)
  return keypair
}
