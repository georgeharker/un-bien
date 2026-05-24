import { ed25519Verify } from "../pairing/crypto.js";
import type { MeshEnvelope, MeshHeader, MeshMember } from "./types.js";

/**
 * Verifies the Ed25519 signature on a mesh envelope and decodes the blob
 * into a typed `MeshHeader`.
 *
 * The verification key is extracted *from the blob* (`owner_pk` field) —
 * the caller MUST then check that `sha256(header.ownerPk)` matches the
 * URL hash they queried with. Otherwise a malicious relay could serve a
 * valid-but-different-owner blob at our hash slot.
 *
 * Throws on:
 *   - JSON parse failure
 *   - Missing or wrong-type required fields
 *   - `owner_pk` not 32 bytes
 *   - Signature mismatch
 */
export async function verifyEnvelope(env: MeshEnvelope): Promise<MeshHeader> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(env.blob));
  } catch (e) {
    throw new Error(`mesh: blob is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("mesh: blob is not a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  if (typeof o["owner_pk"] !== "string") {
    throw new Error("mesh: owner_pk missing or not a string");
  }
  if (typeof o["version"] !== "number" || !Number.isInteger(o["version"])) {
    throw new Error("mesh: version missing or not an integer");
  }
  if (typeof o["issued_at"] !== "number" || !Number.isInteger(o["issued_at"])) {
    throw new Error("mesh: issued_at missing or not an integer");
  }
  if (!Array.isArray(o["members"])) {
    throw new Error("mesh: members missing or not an array");
  }

  const ownerPk = Uint8Array.from(Buffer.from(o["owner_pk"] as string, "base64"));
  if (ownerPk.length !== 32) {
    throw new Error(`mesh: owner_pk wrong length (${ownerPk.length}, expected 32)`);
  }

  if (!ed25519Verify(ownerPk, env.blob, env.sig)) {
    throw new Error("mesh: signature verification failed");
  }

  const members: MeshMember[] = (o["members"] as unknown[]).map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`mesh: members[${i}] is not an object`);
    }
    const m = raw as Record<string, unknown>;
    if (typeof m["remote_epk"] !== "string") {
      throw new Error(`mesh: members[${i}].remote_epk invalid`);
    }
    if (typeof m["relay_url"] !== "string") {
      throw new Error(`mesh: members[${i}].relay_url invalid`);
    }
    if (typeof m["paired_at"] !== "string") {
      throw new Error(`mesh: members[${i}].paired_at invalid`);
    }
    const nickname = m["nickname"];
    return {
      remoteEpk: m["remote_epk"] as string,
      relayUrl: m["relay_url"] as string,
      pairedAt: m["paired_at"] as string,
      ...(typeof nickname === "string" ? { nickname } : {}),
    };
  });

  return {
    version: o["version"] as number,
    issuedAt: o["issued_at"] as number,
    ownerPk,
    members,
  };
}
