import { createHash } from "node:crypto"
import {
  canonicalizeEd25519PublicKey,
  decodeEd25519PublicKey,
  publicKeyFingerprint,
} from "../mesh/encoding.js"
import { listPeers, type PeerRecord } from "./storage.js"

/**
 * Owner-trust lookups shared by the extension (index.ts) and the regime-2 launcher
 * daemon. The trust model: the RELAY authenticates a peer's Ed25519 key
 * ownership (challenge-response), so an inbound `peer` id IS the owner's
 * cryptographic identity; authorization is then "is this key in peers.json?".
 * Revocation is expressed by REMOVING the record, so a peers.json match is
 * itself the not-revoked check — there is no separate revoked flag to honor.
 */

export interface InspectedPeerRecord {
  readonly record: PeerRecord
  readonly rawHandle: string
  readonly runtimeKey: string | null
}

/** Metadata-only fingerprint of an UNTRUSTED/unparseable owner handle — used in
 *  diagnostics so a malformed record never puts key bytes in a log line. */
function _rawOwnerFingerprint(rawValue: unknown): string {
  let fingerprintInput: string
  if (typeof rawValue === "string") {
    fingerprintInput = rawValue
  } else {
    try {
      const serialized = JSON.stringify(rawValue)
      const type = rawValue === null ? "null" : typeof rawValue
      fingerprintInput = `${type}:${serialized ?? ""}`
    } catch {
      fingerprintInput = `${typeof rawValue}:unserializable`
    }
  }
  return createHash("sha256")
    .update(fingerprintInput, "utf8")
    .digest("hex")
    .slice(0, 8)
}

export function _runtimeOwnerFingerprint(runtimeKey: string): string {
  try {
    return publicKeyFingerprint(
      decodeEd25519PublicKey(runtimeKey, "Owner runtime key"),
    )
  } catch {
    // Relay authentication guarantees canonical keys in production. This
    // fallback keeps diagnostics metadata-only at defensive/test boundaries.
    return _rawOwnerFingerprint(runtimeKey)
  }
}

export function _inspectPeerRecord(
  record: unknown,
): InspectedPeerRecord | null {
  if (!record || typeof record !== "object") {
    const fingerprint = _rawOwnerFingerprint(record)
    console.warn(`[un-bien] event=invalid_owner_record owner_fp=${fingerprint}`)
    return null
  }

  const candidate = record as Partial<Record<keyof PeerRecord, unknown>>
  const rawHandle = candidate.remote_epk
  if (typeof rawHandle !== "string") {
    const fingerprint = _rawOwnerFingerprint(rawHandle)
    console.warn(`[un-bien] event=invalid_owner_record owner_fp=${fingerprint}`)
    return null
  }

  const safeRecord: PeerRecord = {
    name: typeof candidate.name === "string" ? candidate.name : "Unknown Owner",
    remote_epk: rawHandle,
    paired_at:
      typeof candidate.paired_at === "string" ? candidate.paired_at : "",
  }
  try {
    const runtimeKey = canonicalizeEd25519PublicKey(
      rawHandle,
      "stored Owner public key",
    )
    return { record: safeRecord, rawHandle, runtimeKey }
  } catch {
    const fingerprint = _rawOwnerFingerprint(rawHandle)
    console.warn(`[un-bien] event=invalid_owner_record owner_fp=${fingerprint}`)
    return { record: safeRecord, rawHandle, runtimeKey: null }
  }
}

/** Resolve a relay-verified inbound `peer` id to its paired PeerRecord, or null
 *  if it isn't a known owner (never paired, or revoked → removed from
 *  peers.json). This IS the owner-authorization gate. */
export async function _findKnownPeer(
  appPeerIdStd: string,
): Promise<PeerRecord | null> {
  let runtimeKey: string
  try {
    runtimeKey = canonicalizeEd25519PublicKey(appPeerIdStd, "Relay Owner key")
  } catch {
    return null
  }
  for (const record of await listPeers()) {
    const inspected = _inspectPeerRecord(record)
    if (inspected?.runtimeKey === runtimeKey) return inspected.record
  }
  return null
}
