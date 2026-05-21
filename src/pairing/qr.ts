import { randomBytes } from "node:crypto";
import qrTerminal from "qrcode-terminal";

const TOKEN_TTL_MS = 60_000;

interface ActiveToken {
  token: string;
  expiresAt: number;
  consumed: boolean;
}

/** Encapsulates the single active QR token. One instance per Pi process. */
export class QRSession {
  private active: ActiveToken | null = null;

  /** Generates a fresh 16-byte random token encoded as base64url. */
  generateToken(): string {
    return randomBytes(16).toString("base64url");
  }

  /**
   * Issues a new active token, invalidating any previous one.
   * Returns the token and its expiry timestamp.
   */
  issueToken(): { token: string; expiresAt: number } {
    const token = this.generateToken();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.active = { token, expiresAt, consumed: false };
    return { token, expiresAt };
  }

  /** Validates and atomically consumes a token. */
  consumeToken(
    token: string,
  ): "ok" | "expired" | "consumed" | "unknown" {
    if (!this.active || this.active.token !== token) return "unknown";
    if (this.active.consumed) return "consumed";
    if (Date.now() > this.active.expiresAt) return "expired";
    this.active.consumed = true;
    return "ok";
  }

  clear(): void {
    this.active = null;
  }
}

export const qrSession = new QRSession();

// ── URI + display ─────────────────────────────────────────────────────────────

export function buildQRUri(
  token: string,
  longtermEdPk: Uint8Array, // Ed25519 — only peer ID after E2E rollback
  sessionName: string,
): string {
  // `r` (relay URL) removed in plano 14 — relay now comes from app config /
  // pi-ext env|config|default chain. Keeps QR ~30-50 chars shorter.
  const epkB64 = Buffer.from(longtermEdPk).toString("base64url");
  const params = new URLSearchParams({
    t: token,
    epk: epkB64,
    n: sessionName.slice(0, 80),
  });
  return `remotepi://pair?${params.toString()}`;
}

/**
 * Renders the QR + URI in the Pi TUI's output pane via stderr. `ctx.ui.notify`
 * collapses multi-line content into a single toast, so for ASCII art we need
 * the raw stderr capture that the Pi TUI exposes as scrollable log. Post
 * plano 14 the QR carries only `t/epk/n`, fits comfortably in the panel
 * without needing a separate Terminal window.
 */
export function displayQR(uri: string): void {
  qrTerminal.generate(uri, { small: true }, (qrcode) => {
    process.stderr.write(`\n📱 Scan to pair:\n\n${qrcode}\n${uri}\n`);
  });
}

/**
 * Starts a rotating QR session: generates a new QR every 60s, printing it
 * to stdout. Returns a `stop()` function that cancels the rotation and clears
 * the active token.
 */
export function startQRRotation(
  longtermEdPk: Uint8Array,
  sessionName: string,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const rotate = () => {
    if (stopped) return;
    const { token, expiresAt } = qrSession.issueToken();
    const uri = buildQRUri(token, longtermEdPk, sessionName);
    displayQR(uri);
    console.log(
      `⏱  Renews at ${new Date(expiresAt).toLocaleTimeString()} — waiting for scan…`,
    );
    timer = setTimeout(rotate, TOKEN_TTL_MS);
  };

  rotate();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    qrSession.clear();
  };
}
