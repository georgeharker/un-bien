import { describe, expect, it } from "vitest"
import { canonicalize } from "../mesh/canonical.js"
import { ed25519KeypairFromSeed, ed25519Verify } from "./crypto.js"
import { encodeEd25519PublicKey } from "../mesh/encoding.js"
import {
  buildSignedAllowList,
  type AllowListBlob,
} from "./signed_allow_list.js"

const seed = new Uint8Array(32).fill(7)
const kp = ed25519KeypairFromSeed(seed)
const owners = ["b/S0SergU3KiWhU=", "aQ7LxSCP8KEG4TM="]

describe("buildSignedAllowList", () => {
  it("signs a canonical blob the machine key verifies (verify_strict-compatible)", () => {
    const { blob, sig } = buildSignedAllowList(kp, owners, 5)
    const blobBytes = Buffer.from(blob, "base64")
    const sigBytes = Buffer.from(sig, "base64")
    expect(sigBytes.length).toBe(64)
    // The relay verifies the EXACT received bytes — so verification here must
    // pass against those bytes, not a re-serialization.
    expect(ed25519Verify(kp.publicKey, blobBytes, sigBytes)).toBe(true)
  })

  it("binds machine_pk to the signing key in the relay's peer_id encoding", () => {
    const { blob } = buildSignedAllowList(kp, owners, 5)
    const parsed = JSON.parse(
      Buffer.from(blob, "base64").toString("utf8"),
    ) as AllowListBlob
    expect(parsed.machine_pk).toBe(
      encodeEd25519PublicKey(kp.publicKey, "machine_pk"),
    )
    expect(parsed.owners).toEqual(owners)
    expect(parsed.version).toBe(5)
    expect(typeof parsed.issued_at).toBe("number")
  })

  it("produces canonical JSON bytes (keys sorted, no whitespace)", () => {
    const { blob } = buildSignedAllowList(kp, owners, 5)
    const text = Buffer.from(blob, "base64").toString("utf8")
    const parsed = JSON.parse(text) as AllowListBlob
    expect(text).toBe(canonicalize(parsed))
  })

  it("a mutated blob fails verification against the original signature", () => {
    const { blob, sig } = buildSignedAllowList(kp, owners, 5)
    const tampered = Buffer.from(blob, "base64")
    tampered[tampered.length - 2] ^= 0xff
    expect(
      ed25519Verify(kp.publicKey, tampered, Buffer.from(sig, "base64")),
    ).toBe(false)
  })
})
