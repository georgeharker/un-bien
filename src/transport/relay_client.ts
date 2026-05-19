import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { ed25519Sign } from "../pairing/crypto.js";
import type { Ed25519Keypair } from "../pairing/crypto.js";

const AUTH_TIMEOUT_MS = 5_000;

/** Relay control messages (sent/received during auth). */
interface HelloMsg { type: "hello"; pubkey: string }
interface ChallengeMsg { type: "challenge"; nonce: string }
interface AuthMsg { type: "auth"; sig: string }

export interface RelayClientEvents {
  /** A single JSONL line delivered by the relay (outer envelope). */
  message: [line: string];
  close: [];
  error: [err: Error];
}

/**
 * Thin WebSocket client for the Remote Pi relay.
 *
 * Lifecycle:
 *   const relay = new RelayClient(url, ed25519Keypair)
 *   await relay.connect()          // opens WS + runs Ed25519 challenge-response
 *   relay.on("message", line => …) // outer envelopes: { peer, ct }
 *   relay.send(jsonLine)           // write to relay
 *   relay.close()
 *
 * Auth sequence (pairing.md §Challenge-response):
 *   → { type:"hello",     pubkey: "<Ed25519 pubkey base64>" }
 *   ← { type:"challenge", nonce:  "<32 bytes base64>" }
 *   → { type:"auth",      sig:    "<Ed25519 sig base64>" }
 */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly keypair: Ed25519Keypair,
  ) {
    super();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Connects and completes Ed25519 auth.  Resolves when relay is ready. */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on("error", (err) => reject(err));

      ws.on("open", async () => {
        try {
          await this._authenticate(ws);

          // Auth done — wire persistent message handler
          ws.on("message", (raw) => {
            const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
            for (const line of text.split("\n")) {
              const trimmed = line.trim();
              if (trimmed) this.emit("message", trimmed);
            }
          });

          ws.on("close", () => this.emit("close"));
          resolve();
        } catch (err) {
          ws.terminate();
          reject(err);
        }
      });
    });
  }

  /** Sends a raw line to the relay (caller is responsible for framing). */
  send(line: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay: not connected");
    }
    this.ws.send(line);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  private async _authenticate(ws: WebSocket): Promise<void> {
    const pubkeyB64 = Buffer.from(this.keypair.publicKey).toString("base64");
    const hello: HelloMsg = { type: "hello", pubkey: pubkeyB64 };
    this._rawSend(ws, JSON.stringify(hello));

    const challengeRaw = await this._nextMsg(ws);
    const challenge = JSON.parse(challengeRaw) as ChallengeMsg;
    if (challenge.type !== "challenge" || !challenge.nonce) {
      throw new Error(`relay auth_failed: expected challenge, got ${challengeRaw}`);
    }

    const nonce = Buffer.from(challenge.nonce, "base64");
    const sig = ed25519Sign(this.keypair.secretKey, nonce);
    const auth: AuthMsg = {
      type: "auth",
      sig: Buffer.from(sig).toString("base64"),
    };
    this._rawSend(ws, JSON.stringify(auth));

    // Relay does not send an explicit "ok" — it simply starts routing.
    // Proceed immediately after sending auth.
  }

  /** Waits for the next single WS message with a timeout. */
  private _nextMsg(ws: WebSocket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay auth timeout")),
        AUTH_TIMEOUT_MS,
      );
      ws.once("message", (raw) => {
        clearTimeout(timer);
        resolve(Buffer.isBuffer(raw) ? raw.toString() : String(raw));
      });
    });
  }

  private _rawSend(ws: WebSocket, data: string): void {
    ws.send(data);
  }
}
