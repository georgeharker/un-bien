import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import qrTerminal from "qrcode-terminal";

const QR_TMP = "/tmp/remote-pi-qr.txt";

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
  relayUrl: string,
  sessionName: string,
): string {
  const epkB64 = Buffer.from(longtermEdPk).toString("base64url");
  const params = new URLSearchParams({
    t: token,
    epk: epkB64,
    r: relayUrl,
    n: sessionName.slice(0, 80),
  });
  return `remotepi://pair?${params.toString()}`;
}

export function displayQR(uri: string): void {
  qrTerminal.generate(uri, { small: true }, (qrcode) => {
    const content = `\n📱 Scan to pair:\n\n${qrcode}\n${uri}\n`;

    // Write to tmp file and open a dedicated Terminal window so the QR
    // is never clipped by the Pi TUI panel.
    try {
      writeFileSync(QR_TMP, content, "utf8");
      execSync(
        `osascript -e 'tell application "Terminal" to do script "printf \\"\\\\033[2J\\\\033[H\\"; cat ${QR_TMP}; echo"'`,
        { stdio: "ignore" },
      );
    } catch {
      // Fallback: write to stderr (may be clipped in Pi TUI)
      process.stderr.write(content);
    }

    // Always print the URI to stderr so it's accessible in the Pi panel
    process.stderr.write(`\n📱 QR: ${uri}\n`);
  });
}

/**
 * Starts a rotating QR session: generates a new QR every 60s, printing it
 * to stdout. Returns a `stop()` function that cancels the rotation and clears
 * the active token.
 */
export function startQRRotation(
  longtermEdPk: Uint8Array,
  relayUrl: string,
  sessionName: string,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const rotate = () => {
    if (stopped) return;
    const { token, expiresAt } = qrSession.issueToken();
    const uri = buildQRUri(token, longtermEdPk, relayUrl, sessionName);
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
