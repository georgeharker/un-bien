import { describe, expect, test } from "vitest";
import { generateEd25519Keypair, ed25519Sign } from "../pairing/crypto.js";
import { canonicalBytes } from "./canonical.js";
import { verifyEnvelope } from "./verify.js";
import type { MeshEnvelope } from "./types.js";

/** Builds a signed envelope from a logical header object (camelCase) for
 *  test use. Mirrors what the app/relay sender side will do. */
function makeSignedEnvelope(
  logical: {
    version: number;
    issued_at: number;
    owner_pk: string;
    members: Array<{
      remote_epk: string;
      relay_url: string;
      paired_at: string;
      nickname?: string;
    }>;
  },
  sk: Uint8Array,
): MeshEnvelope {
  const blob = canonicalBytes(logical);
  const sig = ed25519Sign(sk, blob);
  return { blob, sig };
}

describe("verifyEnvelope", () => {
  test("accepts a valid signed envelope and parses fields", async () => {
    const kp = generateEd25519Keypair();
    const ownerPkB64 = Buffer.from(kp.publicKey).toString("base64");
    const env = makeSignedEnvelope(
      {
        version: 7,
        issued_at: 1700000000000,
        owner_pk: ownerPkB64,
        members: [
          { remote_epk: "PI1", relay_url: "wss://r", paired_at: "2026-05-22T10:00:00Z" },
          { remote_epk: "PI2", relay_url: "wss://r", paired_at: "2026-05-23T10:00:00Z", nickname: "Mac" },
        ],
      },
      kp.secretKey,
    );

    const header = await verifyEnvelope(env);
    expect(header.version).toBe(7);
    expect(header.issuedAt).toBe(1700000000000);
    expect(Buffer.from(header.ownerPk).toString("base64")).toBe(ownerPkB64);
    expect(header.members).toHaveLength(2);
    expect(header.members[0]).toEqual({
      remoteEpk: "PI1",
      relayUrl: "wss://r",
      pairedAt: "2026-05-22T10:00:00Z",
    });
    expect(header.members[1]).toEqual({
      remoteEpk: "PI2",
      relayUrl: "wss://r",
      pairedAt: "2026-05-23T10:00:00Z",
      nickname: "Mac",
    });
  });

  test("rejects invalid signature (sig flipped)", async () => {
    const kp = generateEd25519Keypair();
    const env = makeSignedEnvelope(
      {
        version: 1,
        issued_at: 1,
        owner_pk: Buffer.from(kp.publicKey).toString("base64"),
        members: [],
      },
      kp.secretKey,
    );
    // Flip one byte of the signature.
    env.sig[0] = env.sig[0] ^ 0xff;
    await expect(verifyEnvelope(env)).rejects.toThrow(/signature verification failed/);
  });

  test("rejects corrupted blob (signed bytes mutated after sign)", async () => {
    const kp = generateEd25519Keypair();
    const env = makeSignedEnvelope(
      {
        version: 1,
        issued_at: 1,
        owner_pk: Buffer.from(kp.publicKey).toString("base64"),
        members: [],
      },
      kp.secretKey,
    );
    // Flip a byte in the blob → signature no longer matches.
    env.blob[10] = env.blob[10] ^ 0xff;
    // Either signature failure (most common) or JSON parse failure if we
    // happened to corrupt structural bytes — both are acceptable rejections.
    await expect(verifyEnvelope(env)).rejects.toThrow();
  });

  test("rejects envelope signed by a different keypair", async () => {
    const kpReal = generateEd25519Keypair();
    const kpAttacker = generateEd25519Keypair();
    // Header claims owner is the real key, but sig is from attacker.
    const env = makeSignedEnvelope(
      {
        version: 1,
        issued_at: 1,
        owner_pk: Buffer.from(kpReal.publicKey).toString("base64"),
        members: [],
      },
      kpAttacker.secretKey,
    );
    await expect(verifyEnvelope(env)).rejects.toThrow(/signature verification failed/);
  });

  test("rejects malformed JSON blob", async () => {
    const env: MeshEnvelope = {
      blob: new TextEncoder().encode("not json"),
      sig: new Uint8Array(64),
    };
    await expect(verifyEnvelope(env)).rejects.toThrow(/not valid JSON/);
  });

  test("rejects missing required fields", async () => {
    const env: MeshEnvelope = {
      blob: new TextEncoder().encode('{"version":1}'),
      sig: new Uint8Array(64),
    };
    await expect(verifyEnvelope(env)).rejects.toThrow();
  });

  test("rejects owner_pk with wrong byte length", async () => {
    const shortKey = Buffer.from(new Uint8Array(8)).toString("base64"); // only 8 bytes
    const env: MeshEnvelope = {
      blob: canonicalBytes({
        version: 1,
        issued_at: 1,
        owner_pk: shortKey,
        members: [],
      }),
      sig: new Uint8Array(64),
    };
    await expect(verifyEnvelope(env)).rejects.toThrow(/wrong length/);
  });
});
