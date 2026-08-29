import { createHash, randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";

// Configure @noble/ed25519 v3 to use Node.js built-in SHA-512
(ed.hashes as Record<string, unknown>)["sha512"] = (...msgs: Uint8Array[]) => {
  const h = createHash("sha512");
  for (const m of msgs) h.update(m);
  return Uint8Array.from(h.digest());
};

export interface Ed25519Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generates an Ed25519 keypair for relay challenge-response auth. */
export function generateEd25519Keypair(): Ed25519Keypair {
  const secretKey = randomBytes(32);
  const publicKey = ed.getPublicKey(secretKey);
  return { secretKey, publicKey: Buffer.from(publicKey) };
}

/** Derives an Ed25519 keypair from its 32-byte seed (the secret key material),
 *  so a seed supplied via the UNBIEN_IDENTITY_SEED override round-trips to the
 *  same public key the relay routes on. */
export function ed25519KeypairFromSeed(seed: Uint8Array): Ed25519Keypair {
  if (seed.length !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes (got ${seed.length}).`);
  }
  const publicKey = ed.getPublicKey(seed);
  return { secretKey: Buffer.from(seed), publicKey: Buffer.from(publicKey) };
}

export function ed25519Sign(sk: Uint8Array, msg: Uint8Array): Uint8Array {
  return Buffer.from(ed.sign(msg, sk));
}

export function ed25519Verify(
  pk: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array,
): boolean {
  return ed.verify(sig, msg, pk);
}
