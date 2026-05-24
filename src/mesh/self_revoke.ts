import { createHash } from "node:crypto";
import type { MeshClient } from "./client.js";
import { verifyEnvelope } from "./verify.js";
import { bytesEqual, decodeB64Any } from "./encoding.js";

/**
 * Background poller that watches each Owner's `mesh_versions` envelope on
 * the relay and self-revokes this Pi from any Owner that no longer lists
 * it as a member.
 *
 * Behavior per sweep (one entry per unique Owner in peers.json):
 *   1. Compute `hash = sha256(ownerPk)` (lowercase hex) — the URL slug.
 *      MUST match the format the relay stores and the app publishes;
 *      mismatch results in silent 404 forever.
 *   2. GET /mesh/<hash>?since=<lastSeenVersion>
 *   3. `null` (304/404) → skip silently (no update, or owner never published)
 *   4. Verify Ed25519 signature against the embedded `owner_pk`
 *   5. Defense-in-depth: confirm the blob's `owner_pk` matches what we
 *      expected (otherwise a malicious relay could swap blobs across slots)
 *   6. Anti-rollback: drop versions < our last-seen for this Owner
 *   7. Membership check: decode every `members[].remote_epk` to bytes and
 *      compare against this Pi's pubkey bytes. Critical: comparing the
 *      base64 strings directly would falsely revoke when the app emits
 *      url-safe (`-`/`_`, no padding) and the Pi emits standard
 *      (`+`/`/`, padded) — same 32 bytes, different strings. See
 *      `encoding.ts` for the helpers and `plan/24` Wave 3 fix history.
 *   8. If not a member → `storage.removePeer(ownerEpk)` and fire
 *      `onRevoke(ownerEpk)` so the caller can tear down any live WS
 *      sessions for that Owner.
 *
 * Backward-compat: an Owner who never published a mesh blob returns 404
 * forever, which we treat as "no update". Old clients keep working
 * untouched until they upgrade.
 *
 * Spec: plan/24-mesh-membership.md Wave 3.
 */

/** Minimum storage surface the poller needs. Concrete impl lives in
 *  `src/pairing/storage.ts` — injecting it via constructor keeps the class
 *  testable without filesystem mocking. */
export interface SelfRevokeStorage {
  listOwnerPubkeys(): Promise<string[]>;
  removePeer(remoteEpk: string): Promise<boolean>;
}

export interface SelfRevokeOptions {
  client: MeshClient;
  storage: SelfRevokeStorage;
  /** This Pi's long-term Ed25519 pubkey, raw 32 bytes. */
  myPubkey: Uint8Array;
  /** Polling cadence. Default 60s — matches the app side (plan/24 Q1). */
  intervalMs?: number;
  /** Fired after `storage.removePeer` succeeds, so callers can tear down
   *  any active WS channel for the revoked owner. Receives the base64
   *  (standard) of the Owner pubkey that revoked us. */
  onRevoke?: (ownerEpk: string) => void | Promise<void>;
  /** Logging surface — defaults to `console.*`. Tests inject a fake. */
  log?: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

const DEFAULT_INTERVAL_MS = 60_000;

export class SelfRevoke {
  private readonly client: MeshClient;
  private readonly storage: SelfRevokeStorage;
  /** Raw Ed25519 pubkey bytes (32 B). Membership checks decode each
   *  `members[].remote_epk` and compare byte-wise — avoids the base64
   *  encoding-variant trap (standard vs url-safe). */
  private readonly myPubkey: Uint8Array;
  private readonly intervalMs: number;
  private readonly onRevoke?: SelfRevokeOptions["onRevoke"];
  private readonly log: NonNullable<SelfRevokeOptions["log"]>;
  /** Anti-rollback floor: never accept a version <= lastSeen per Owner. */
  private readonly lastSeenVersion = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SelfRevokeOptions) {
    this.client = opts.client;
    this.storage = opts.storage;
    this.myPubkey = opts.myPubkey;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onRevoke = opts.onRevoke;
    this.log = opts.log ?? {
      info: (msg) => console.info(msg),
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
    };
  }

  /** Starts the periodic sweep. Idempotent — a second call is a no-op.
   *  Fires one sweep immediately so we don't wait `intervalMs` for the
   *  first check. */
  start(): void {
    if (this.timer !== null) return;
    void this.checkOnce();
    this.timer = setInterval(() => { void this.checkOnce(); }, this.intervalMs);
  }

  /** Stops the periodic sweep. In-flight `checkOnce()` calls complete
   *  normally — only the timer is cleared. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep across all known Owners. Per-Owner errors are logged but
   *  do not stop iteration — we want to keep checking other Owners even
   *  if one relay times out or one envelope is malformed. */
  async checkOnce(): Promise<void> {
    const owners = await this.storage.listOwnerPubkeys();
    for (const ownerEpk of owners) {
      try {
        await this._checkOwner(ownerEpk);
      } catch (err) {
        this.log.error(
          `[mesh] self-revoke check failed for ${ownerEpk.slice(0, 8)}…: ${String(err)}`,
        );
      }
    }
  }

  private async _checkOwner(ownerEpk: string): Promise<void> {
    const ownerPk = Uint8Array.from(Buffer.from(ownerEpk, "base64"));
    // Lowercase hex per the cross-language contract (relay + app). Node's
    // `digest('hex')` already produces lowercase by default.
    const hash = createHash("sha256").update(ownerPk).digest("hex");
    const since = this.lastSeenVersion.get(ownerEpk);

    const env = await this.client.get(hash, since);
    if (!env) return;  // 304 or 404 — nothing to do

    const header = await verifyEnvelope(env);

    // Defense-in-depth: a malicious relay could return a valid-but-different
    // owner's envelope at our slot. The relay should reject this on upload
    // (per plan/24), but we double-check here.
    const headerOwnerB64 = Buffer.from(header.ownerPk).toString("base64");
    if (headerOwnerB64 !== ownerEpk) {
      this.log.warn(
        `[mesh] owner_pk mismatch for slot ${ownerEpk.slice(0, 8)}…: blob says ${headerOwnerB64.slice(0, 8)}… — ignoring`,
      );
      return;
    }

    const lastSeen = this.lastSeenVersion.get(ownerEpk) ?? 0;
    if (header.version < lastSeen) {
      this.log.warn(
        `[mesh] anti-rollback: dropped v${header.version} < lastSeen v${lastSeen} for ${ownerEpk.slice(0, 8)}…`,
      );
      return;
    }
    this.lastSeenVersion.set(ownerEpk, header.version);

    // Decode every member's pubkey to bytes and compare against our own.
    // The app may emit base64 url-safe (`-`/`_`, no padding) while the Pi
    // emits standard (`+`/`/`, padded) — same bytes, different strings.
    // String equality on those would falsely revoke us. See `encoding.ts`.
    const stillMember = header.members.some((m) =>
      bytesEqual(decodeB64Any(m.remoteEpk), this.myPubkey),
    );
    if (stillMember) return;

    // Log the EXACT version observed (from the relay's blob) plus the
    // `since` cursor we sent — disambiguates poll-time state from any
    // SQLite snapshot the operator might take later.
    this.log.info(
      `[mesh] self-revoked from owner ${ownerEpk.slice(0, 8)}… ` +
      `(received v${header.version}, since=${since ?? "<none>"}, ` +
      `members=${header.members.length})`,
    );
    await this.storage.removePeer(ownerEpk);
    if (this.onRevoke) await this.onRevoke(ownerEpk);
  }
}
