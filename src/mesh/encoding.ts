/**
 * Base64 + byte-array helpers shared by the mesh module.
 *
 * **Why this exists**: the mesh protocol crosses three languages (Dart in
 * the app, Rust in the relay, TypeScript here). Each language's default
 * base64 encoder picks a different variant — `dart:convert.base64Encode`
 * emits **standard** (`+`, `/`, `=`-padded), while the app's pairing layer
 * historically emitted **URL-safe** (`-`, `_`, no padding) in some places.
 * String comparison on those two encodings fails even when the underlying
 * 32 bytes are identical, producing silent self-revocations (see
 * `plan/24` Wave 3 incident report).
 *
 * The fix is to never compare base64 strings — decode both sides to bytes
 * and compare bytes. `decodeB64Any` accepts either variant.
 */

/**
 * Decodes a base64 string in either standard or URL-safe form, with or
 * without padding. Returns the raw bytes.
 *
 *   decodeB64Any("Bz02…JM=")     // standard, padded
 *   decodeB64Any("Bz02…JM")      // standard, no pad
 *   decodeB64Any("Bz02…J_M")     // url-safe
 *
 * All three produce identical `Uint8Array`s when the underlying bytes
 * match.
 */
export function decodeB64Any(s: string): Uint8Array {
  // URL-safe → standard alphabet
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  // Re-pad to multiple of 4 (Node accepts unpadded, but being explicit
  // avoids subtle differences across Buffer versions)
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/**
 * Constant-time-ish byte equality. Used for comparing public keys that
 * may have arrived in different base64 encodings (see `decodeB64Any`).
 * Returns false immediately on length mismatch.
 *
 * Not strictly constant-time — Ed25519 pubkeys aren't secrets, so the
 * short-circuit on length and the byte-by-byte compare are acceptable.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
