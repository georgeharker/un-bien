import { canonicalBytes } from "../mesh/canonical.js"
import { encodeEd25519PublicKey } from "../mesh/encoding.js"
import { ed25519Sign, type Ed25519Keypair } from "./crypto.js"

// Authority parity (design 01M23MKVG, principle 01M2393FR): the MACHINE signs
// "these owners may reach me" so the relay verifies + stores it but cannot forge
// it — at parity with owner-signed mesh_versions. The phone is never the
// authority for access to a machine; only the machine's own signed statement is.
//
// The signed bytes are canonical JSON (mesh/canonical.ts, JCS-like). The relay
// verifies the EXACT bytes received and never re-canonicalizes, so this module
// is the single producer of that byte layout on the extension side.

/** Decoded allow-list blob. `machine_pk` is STANDARD-padded base64 of the
 *  machine's Ed25519 public key — identical to the relay's challenge-verified
 *  peer_id encoding, so the relay can bind blob ↔ connection directly. */
export interface AllowListBlob {
  machine_pk: string
  owners: string[]
  version: number
  issued_at: number
}

/** Wire envelope mirroring MeshEnvelopeWire: base64(STANDARD) blob + 64-byte sig. */
export interface SignedAllowListEnvelope {
  blob: string
  sig: string
}

/** Build and machine-sign the allow-list envelope. `owners` are the already
 *  canonicalized owner epks (pairingAllowList output); `version` is the
 *  persisted monotonic counter. Returns the base64 wire fields the relay
 *  verifies with verify_strict over the exact blob bytes. */
export function buildSignedAllowList(
  kp: Ed25519Keypair,
  owners: string[],
  version: number,
): SignedAllowListEnvelope {
  const blobObject: AllowListBlob = {
    machine_pk: encodeEd25519PublicKey(kp.publicKey, "machine_pk"),
    owners,
    version,
    issued_at: Date.now(),
  }
  const blobBytes = canonicalBytes(blobObject)
  const sig = ed25519Sign(kp.secretKey, blobBytes)
  return {
    blob: Buffer.from(blobBytes).toString("base64"),
    sig: Buffer.from(sig).toString("base64"),
  }
}
