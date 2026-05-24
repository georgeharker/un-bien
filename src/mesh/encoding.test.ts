import { describe, expect, test } from "vitest";
import { decodeB64Any, bytesEqual } from "./encoding.js";

describe("decodeB64Any", () => {
  test("standard base64 with padding round-trips", () => {
    const original = new Uint8Array([0x07, 0x3d, 0x36, 0xb8, 0xb8, 0xb0, 0xae]);
    const encoded = Buffer.from(original).toString("base64"); // "Bz02uLiwrg=="
    const decoded = decodeB64Any(encoded);
    expect(decoded).toEqual(original);
  });

  test("standard and URL-safe of the same bytes produce identical Uint8Arrays", () => {
    // This is the exact incident pattern from plan/24 W3:
    // app emits url-safe, pi-ext emits standard, comparing bytes must match.
    const std = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    const urlSafe = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE";
    expect(decodeB64Any(std)).toEqual(decodeB64Any(urlSafe));
  });

  test("standard without padding still decodes", () => {
    const padded = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    const unpadded = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE";
    expect(decodeB64Any(padded)).toEqual(decodeB64Any(unpadded));
  });

  test("URL-safe with padding (mixed variant) decodes the same", () => {
    const std = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    const urlSafeWithPad = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE=";
    expect(decodeB64Any(std)).toEqual(decodeB64Any(urlSafeWithPad));
  });

  test("32-byte Ed25519 pubkey shape preserved across encodings", () => {
    // Fabricate a 32-byte key, encode both ways, ensure decode lands at 32 B.
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = (i * 7 + 3) & 0xff;
    const std = Buffer.from(raw).toString("base64");
    const url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeB64Any(std)).toEqual(raw);
    expect(decodeB64Any(url)).toEqual(raw);
    expect(decodeB64Any(std).length).toBe(32);
  });

  test("empty string decodes to empty bytes", () => {
    expect(decodeB64Any("")).toEqual(new Uint8Array(0));
  });
});

describe("bytesEqual", () => {
  test("identical arrays → true", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(bytesEqual(a, b)).toBe(true);
  });

  test("empty arrays → true", () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  test("different lengths → false", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(bytesEqual(a, b)).toBe(false);
  });

  test("different byte at one position → false", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 9, 4]);
    expect(bytesEqual(a, b)).toBe(false);
  });

  test("different byte at last position → false (no early-out skipping the tail)", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(bytesEqual(a, b)).toBe(false);
  });
});
