/**
 * Integration tests: extension default export + pair_request flow + reconnect.
 *
 * Post plano 06: no Noise XX. Pairing is `pair_request → pair_ok|pair_error`
 * over an opaque outer envelope whose `ct` is base64(JSON.stringify(inner)).
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

// ── Mock RelayClient ──────────────────────────────────────────────────────────

const relayRef: { current: MockRelay | null } = { current: null };

class MockRelay extends EventEmitter {
  static OPEN = 1;
  readyState = MockRelay.OPEN;
  connect = vi.fn().mockResolvedValue(undefined);
  send    = vi.fn();
  close   = vi.fn();
  constructor() { super(); relayRef.current = this; }
}

vi.mock("./transport/relay_client.js", () => ({ RelayClient: MockRelay }));

// ── Mock storage ──────────────────────────────────────────────────────────────

type StoredPeer = { name: string; remote_epk: string; paired_at: string };
const _knownPeers: StoredPeer[] = [];
const _addedPeers: StoredPeer[] = [];

vi.mock("./pairing/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./pairing/storage.js")>();
  return {
    ...orig,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    }),
    listPeers: vi.fn().mockImplementation(async () => [..._knownPeers]),
    addPeer: vi.fn().mockImplementation(async (p: StoredPeer) => {
      _addedPeers.push(p);
      _knownPeers.push(p);
    }),
  };
});

// ── Mock qrSession.consumeToken control ───────────────────────────────────────

let _tokenStatus: "ok" | "expired" | "consumed" | "unknown" = "ok";
const _consumeCalls: string[] = [];

vi.mock("./pairing/qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./pairing/qr.js")>();
  return {
    ...orig,
    displayQR: vi.fn(),  // suppress side effects (terminal spawn) in tests
    qrSession: {
      issueToken: vi.fn().mockReturnValue({
        token: "test-token",
        expiresAt: Date.now() + 60_000,
      }),
      consumeToken: vi.fn().mockImplementation((token: string) => {
        _consumeCalls.push(token);
        return _tokenStatus;
      }),
      clear: vi.fn(),
      generateToken: vi.fn().mockReturnValue("test-token"),
    },
  };
});

// Import AFTER mocks
const {
  default: extension,
  _getState,
  _onPeerDisconnect,
} = await import("./index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockPi(): { pi: ExtensionAPI; registeredCommands: string[] } {
  const registeredCommands: string[] = [];
  const pi = {
    on: () => undefined,
    registerCommand(name: string, _opts: unknown) { registeredCommands.push(name); },
    registerTool: () => undefined, registerShortcut: () => undefined,
    registerFlag: () => undefined, getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined, sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI;
  return { pi, registeredCommands };
}

function makeMockCtx(cwd = "/home/user/projects/remote_pi") {
  return { ui: { notify: vi.fn() }, cwd, abort: vi.fn() };
}

type CmdHandler = (args: string, ctx: ReturnType<typeof makeMockCtx>) => Promise<void>;

function captureHandler(commandName: string): CmdHandler {
  let captured: CmdHandler | undefined;
  const pi = {
    on: () => undefined,
    registerCommand(name: string, opts: { handler: CmdHandler }) {
      if (name === commandName) captured = opts.handler;
    },
    registerTool: () => undefined, registerShortcut: () => undefined,
    registerFlag: () => undefined, getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined, sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI;
  (extension as ExtensionFactory)(pi);
  if (!captured) throw new Error(`command "${commandName}" not registered`);
  return captured;
}

function makeInnerLine(peer: string, inner: object): string {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
  return JSON.stringify({ peer, ct });
}

function decodeSentCt(raw: string): { peer: string; inner: { type: string; [k: string]: unknown } } {
  const outer = JSON.parse(raw) as { peer: string; ct: string };
  const inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as {
    type: string;
    [k: string]: unknown;
  };
  return { peer: outer.peer, inner };
}

// ── Registration tests ────────────────────────────────────────────────────────

describe("extension default export", () => {
  test("is an ExtensionFactory function", () => {
    expect(typeof extension).toBe("function");
  });

  test("registers all 6 commands", () => {
    const { pi, registeredCommands } = makeMockPi();
    (extension as ExtensionFactory)(pi);
    expect(registeredCommands).toContain("remote-pi");
    expect(registeredCommands).toContain("remote-pi start");
    expect(registeredCommands).toContain("remote-pi pair");
    expect(registeredCommands).toContain("remote-pi stop");
    expect(registeredCommands).toContain("remote-pi list");
    expect(registeredCommands).toContain("remote-pi revoke");
  });

  test("registers exactly 6 commands", () => {
    const { pi, registeredCommands } = makeMockPi();
    (extension as ExtensionFactory)(pi);
    expect(registeredCommands).toHaveLength(6);
  });
});

// ── State machine + pair_request flow ─────────────────────────────────────────

describe("state machine + pair_request flow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _knownPeers.length = 0;
    _addedPeers.length = 0;
    _consumeCalls.length = 0;
    _tokenStatus = "ok";
    relayRef.current = null;
    // Restore default consumeToken behavior — earlier tests can override it.
    const qr = await import("./pairing/qr.js");
    (qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (token: string) => {
        _consumeCalls.push(token);
        return _tokenStatus;
      },
    );
    // Force idle via stop
    const stop = captureHandler("remote-pi stop");
    await stop("", makeMockCtx());
  });

  test("start: idle → started", async () => {
    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());
    expect(_getState()).toBe("started");
  });

  test("pair without start → warning, state stays idle", async () => {
    expect(_getState()).toBe("idle");
    const pair = captureHandler("remote-pi pair");
    const ctx = makeMockCtx();
    await pair("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("start first"), "warning");
    expect(_getState()).toBe("idle");
  });

  test("valid pair_request → pair_ok + state paired + peer persisted", async () => {
    _tokenStatus = "ok";
    const APP_PEER_ID = "valid-app-peer-base64";

    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());
    expect(_getState()).toBe("started");

    relayRef.current!.emit("message", makeInnerLine(APP_PEER_ID, {
      type: "pair_request",
      id: "req-1",
      token: "test-token",
      device_name: "iPhone do Jacob",
    }));

    await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });

    // pair_ok must have been sent back to the app peer
    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string);
    const pairOks = sent.map(decodeSentCt).filter((d) => d.inner.type === "pair_ok");
    expect(pairOks).toHaveLength(1);
    expect(pairOks[0]!.peer).toBe(APP_PEER_ID);
    expect(pairOks[0]!.inner).toMatchObject({
      type: "pair_ok",
      in_reply_to: "req-1",
    });

    // Peer must have been persisted
    expect(_addedPeers).toHaveLength(1);
    expect(_addedPeers[0]).toMatchObject({
      name: "iPhone do Jacob",
      remote_epk: APP_PEER_ID,
    });
  });

  test("expired token → pair_error{token_expired} + state stays started", async () => {
    _tokenStatus = "expired";
    const APP_PEER_ID = "stale-token-peer";

    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());

    relayRef.current!.emit("message", makeInnerLine(APP_PEER_ID, {
      type: "pair_request",
      id: "req-x",
      token: "test-token",
      device_name: "iPhone",
    }));

    await new Promise((r) => setTimeout(r, 50));

    expect(_getState()).toBe("started");
    expect(_addedPeers).toHaveLength(0);

    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string);
    const errs = sent.map(decodeSentCt).filter((d) => d.inner.type === "pair_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.inner).toMatchObject({
      type: "pair_error",
      in_reply_to: "req-x",
      code: "token_expired",
    });
  });

  test("consumed token → pair_error{token_consumed} on second pair_request", async () => {
    // First call returns ok (consumes); second returns consumed.
    let calls = 0;
    _tokenStatus = "ok";
    // override consumeToken to return ok once, then consumed
    const qr = await import("./pairing/qr.js");
    (qr.qrSession.consumeToken as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        calls += 1;
        return calls === 1 ? "ok" : "consumed";
      },
    );

    const APP_PEER_A = "peer-a";
    const APP_PEER_B = "peer-b";

    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());

    // First pair_request from peer A → ok
    relayRef.current!.emit("message", makeInnerLine(APP_PEER_A, {
      type: "pair_request", id: "req-a", token: "test-token", device_name: "Phone A",
    }));
    await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });

    // Disconnect so we're back in started state for the second attempt
    _onPeerDisconnect();
    expect(_getState()).toBe("started");

    // Second pair_request from peer B with same token → consumed
    relayRef.current!.emit("message", makeInnerLine(APP_PEER_B, {
      type: "pair_request", id: "req-b", token: "test-token", device_name: "Phone B",
    }));
    await new Promise((r) => setTimeout(r, 50));

    expect(_getState()).toBe("started");  // didn't transition
    const sent = relayRef.current!.send.mock.calls.map((c) => c[0] as string);
    const errs = sent.map(decodeSentCt).filter((d) =>
      d.inner.type === "pair_error" && d.inner["in_reply_to"] === "req-b",
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]!.inner).toMatchObject({ code: "token_consumed" });
  });

  test("paired peer ignores subsequent pair_request (idempotent)", async () => {
    _tokenStatus = "ok";
    const APP_PEER_ID = "already-paired";

    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());

    // First pair_request → paired
    relayRef.current!.emit("message", makeInnerLine(APP_PEER_ID, {
      type: "pair_request", id: "req-1", token: "test-token", device_name: "Phone",
    }));
    await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });

    const sendsBefore = relayRef.current!.send.mock.calls.length;

    // Second pair_request from same peer while paired → routed through
    // PlainPeerChannel.onMessage → routeClientMessage which ignores it.
    relayRef.current!.emit("message", makeInnerLine(APP_PEER_ID, {
      type: "pair_request", id: "req-2", token: "test-token", device_name: "Phone",
    }));
    await new Promise((r) => setTimeout(r, 50));

    expect(_getState()).toBe("paired");
    // No additional outbound messages from this second pair_request
    expect(relayRef.current!.send.mock.calls.length).toBe(sendsBefore);
  });

  test("known peer reconnect: any non-pair message from peers.json → paired", async () => {
    const APP_PEER_ID = "known-app-peer";
    _knownPeers.push({
      name: "Known App",
      remote_epk: APP_PEER_ID,
      paired_at: new Date().toISOString(),
    });

    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());
    expect(_getState()).toBe("started");

    relayRef.current!.emit("message", makeInnerLine(APP_PEER_ID, {
      type: "ping", id: "ping-reconnect",
    }));

    await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });
  });

  test("unknown peer non-pair message → ignored, state stays started", async () => {
    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());

    relayRef.current!.emit("message", makeInnerLine("unknown-peer", {
      type: "ping", id: "ping-x",
    }));
    await new Promise((r) => setTimeout(r, 50));

    expect(_getState()).toBe("started");
    expect(_addedPeers).toHaveLength(0);
  });

  test("_onPeerDisconnect: paired → started, listener re-installed", async () => {
    _tokenStatus = "ok";
    const APP_PEER_ID = "disco-peer";

    const start = captureHandler("remote-pi start");
    await start("", makeMockCtx());

    relayRef.current!.emit("message", makeInnerLine(APP_PEER_ID, {
      type: "pair_request", id: "req-1", token: "test-token", device_name: "Phone",
    }));
    await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });

    _onPeerDisconnect();
    expect(_getState()).toBe("started");

    // Reconnect via a ping (known peer now) → paired again
    relayRef.current!.emit("message", makeInnerLine(APP_PEER_ID, {
      type: "ping", id: "ping-reconnect",
    }));
    await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });
  });
});

// ── Fixture roundtrip ─────────────────────────────────────────────────────────

describe("contract fixtures: pair_*", () => {
  const fixtureDir = fileURLToPath(
    new URL("../../.orchestration/contracts/fixtures", import.meta.url),
  );

  test("pair_request.jsonl parses into ClientMessage shape", () => {
    const lines = readFileSync(`${fixtureDir}/pair_request.jsonl`, "utf8")
      .split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const obj = JSON.parse(line) as { type: string; id: string; token: string; device_name: string };
      expect(obj.type).toBe("pair_request");
      expect(typeof obj.id).toBe("string");
      expect(typeof obj.token).toBe("string");
      expect(typeof obj.device_name).toBe("string");
    }
  });

  test("pair_ok.jsonl parses into ServerMessage shape", () => {
    const lines = readFileSync(`${fixtureDir}/pair_ok.jsonl`, "utf8")
      .split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const obj = JSON.parse(line) as { type: string; in_reply_to: string; session_name: string };
      expect(obj.type).toBe("pair_ok");
      expect(typeof obj.in_reply_to).toBe("string");
      expect(typeof obj.session_name).toBe("string");
    }
  });

  test("pair_error.jsonl parses with valid code", () => {
    const lines = readFileSync(`${fixtureDir}/pair_error.jsonl`, "utf8")
      .split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const validCodes = new Set(["token_expired", "token_consumed", "token_unknown", "internal_error"]);
    for (const line of lines) {
      const obj = JSON.parse(line) as { type: string; in_reply_to: string; code: string; message: string };
      expect(obj.type).toBe("pair_error");
      expect(validCodes.has(obj.code)).toBe(true);
    }
  });

  test("all 13 fixture files present", () => {
    const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(13);
  });
});
