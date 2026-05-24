import type { MeshEnvelope } from "./types.js";

/**
 * HTTP client for the relay's `/mesh/<owner_pk_hash>` endpoints.
 *
 * Uses Node 20+ global `fetch` — no extra dependency. The constructor
 * expects the **canonical http(s):// form** of the relay URL — the same
 * value returned by `resolveRelayUrl()`. No scheme conversion is done
 * here; ws(s):// URLs would be passed through to `fetch` and fail.
 *
 * Spec: plan/24-mesh-membership.md "API HTTP" section.
 */
export class MeshClient {
  private readonly baseUrl: string;

  constructor(relayUrl: string) {
    // Only strip trailing slashes for clean URL concatenation; scheme is
    // assumed canonical (http(s)://) and is not rewritten.
    this.baseUrl = relayUrl.replace(/\/+$/, "");
  }

  /**
   * `GET /mesh/<hash>?since=<version>`.
   *
   * `hash` is `sha256(owner_pk)` encoded as **lowercase hex** — the format
   * the relay stores and the app publishes. Mismatched encodings yield a
   * silent 404 forever.
   *
   * Status mapping:
   *   - 200 → returns a `MeshEnvelope` with base64-decoded `blob` and `sig`.
   *   - 304 / 404 → returns `null` (caller treats as "no update" or "owner
   *     never published").
   *   - Anything else → throws (caller logs + continues).
   *
   * Malformed 200 responses (missing fields, non-string blob/sig) also throw.
   */
  async get(hash: string, since?: number): Promise<MeshEnvelope | null> {
    const qs = since !== undefined ? `?since=${encodeURIComponent(since)}` : "";
    const url = `${this.baseUrl}/mesh/${encodeURIComponent(hash)}${qs}`;
    const res = await fetch(url, { method: "GET" });
    if (res.status === 200) {
      const payload = (await res.json()) as unknown;
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as { blob?: unknown }).blob !== "string" ||
        typeof (payload as { sig?: unknown }).sig !== "string"
      ) {
        throw new Error(`mesh: malformed 200 response from ${url}`);
      }
      const p = payload as { blob: string; sig: string };
      return {
        blob: Uint8Array.from(Buffer.from(p.blob, "base64")),
        sig: Uint8Array.from(Buffer.from(p.sig, "base64")),
      };
    }
    if (res.status === 304 || res.status === 404) return null;
    throw new Error(`mesh: unexpected status ${res.status} from ${url}`);
  }
}
