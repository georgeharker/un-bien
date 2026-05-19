import { describe, expect, test, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { generateEd25519Keypair } from "../pairing/crypto.js";

// ── WS mock (class-based, vitest-hoisted) ─────────────────────────────────────
// Must use a proper class so `new WebSocket(...)` works inside RelayClient.

// Shared reference: set by the MockWS constructor so tests can access it.
const wsRef: { current: MockWS | null } = { current: null };

class MockWS extends EventEmitter {
  static OPEN = 1;
  readyState = MockWS.OPEN;
  readonly sent: string[] = [];

  constructor(_url: string) {
    super();
    wsRef.current = this;
    // Defer 'open' so RelayClient has time to attach its handlers first.
    setTimeout(() => this.emit("open"), 0);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit("close"); }
  terminate(): void { this.emit("close"); }
}

vi.mock("ws", () => ({ default: MockWS }));

// Import AFTER the mock so RelayClient picks up the mocked ws module.
const { RelayClient } = await import("./relay_client.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentWs(): MockWS {
  if (!wsRef.current) throw new Error("no MockWS instance created yet");
  return wsRef.current;
}

function simulateChallenge(ws: MockWS, nonceByte = 0xab): void {
  const nonce = Buffer.alloc(32, nonceByte);
  ws.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") })),
  );
}

async function connectWithAuth(client: InstanceType<typeof RelayClient>, nonceByte = 0xab): Promise<void> {
  const p = client.connect();
  await vi.waitFor(() => expect(currentWs().sent.length).toBeGreaterThan(0));
  simulateChallenge(currentWs(), nonceByte);
  await p;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RelayClient", () => {
  let keypair: ReturnType<typeof generateEd25519Keypair>;

  beforeEach(() => {
    keypair = generateEd25519Keypair();
    wsRef.current = null;
  });

  test("connect: sends hello with correct Ed25519 pubkey", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client);

    const ws = currentWs();
    const hello = JSON.parse(ws.sent[0]) as { type: string; pubkey: string };
    expect(hello.type).toBe("hello");
    expect(hello.pubkey).toBe(Buffer.from(keypair.publicKey).toString("base64"));

    client.close();
  });

  test("connect: sends auth with 64-byte Ed25519 signature", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client);

    const ws = currentWs();
    const auth = JSON.parse(ws.sent[1]) as { type: string; sig: string };
    expect(auth.type).toBe("auth");
    expect(Buffer.from(auth.sig, "base64")).toHaveLength(64);

    client.close();
  });

  test("connect: auth messages (hello + auth) are exactly 2 sends", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client);

    // hello + auth = 2 sends during auth phase only
    expect(currentWs().sent).toHaveLength(2);
    client.close();
  });

  test("connect: challenge message NOT forwarded as public 'message' event", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    const received: string[] = [];
    client.on("message", (line) => received.push(line));

    await connectWithAuth(client);

    // Challenge should NOT appear in public events
    expect(received.some((l) => l.includes("challenge"))).toBe(false);
    client.close();
  });

  test("connect: post-auth outer envelopes are forwarded as 'message' events", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    const received: string[] = [];
    client.on("message", (line) => received.push(line));

    await connectWithAuth(client);

    const outer = JSON.stringify({ peer: "app_peer_1", ct: "AAAA" });
    currentWs().emit("message", Buffer.from(outer));

    expect(received).toContain(outer);
    client.close();
  });

  test("send: writes raw line to the WebSocket", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client);

    const ws = currentWs();
    const before = ws.sent.length;
    const outer = JSON.stringify({ peer: "x", ct: "BQID" });
    client.send(outer);
    expect(ws.sent[before]).toBe(outer);

    client.close();
  });
});
