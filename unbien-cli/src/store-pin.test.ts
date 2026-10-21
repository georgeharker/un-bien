import { describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// Redirect the proxy state dir to an isolated tmp home BEFORE importing the
// store: its module-level paths derive from homedir() at import time. Only
// homedir is overridden (the tmp home is computed without the os module).
const tmpHome = mkdtempSync(join("/tmp", "unbien-store-"))
vi.mock("node:os", () => ({ homedir: () => tmpHome }))

const {
  nextProxyAllowVersion,
  recordRelayIdentity,
  rankEndpoints,
  pickRelayEndpoint,
  relayPinFor,
  loadRelayIdentities,
} = await import("./store.js")

describe("nextProxyAllowVersion (P5)", () => {
  test("strictly monotonic across same-second pushes (persisted floor)", () => {
    const v1 = nextProxyAllowVersion()
    const v2 = nextProxyAllowVersion()
    expect(v2).toBeGreaterThan(v1) // a same-ms push bumps the persisted floor

    // And the floor survives: a fresh reader (another CLI process simulation)
    // can't mint at-or-below what was already pushed.
    const floor = Number.parseInt(
      readFileSync(join(tmpHome, ".local/state/un-bien/proxy-allow-version"), "utf8"),
      10,
    )
    expect(v2).toBe(floor)
    // Freshness: the mint bottoms out at the clock, ±slop for the statements
    // between mint and assert (the strict ordering above is the real check).
    expect(v1).toBeGreaterThanOrEqual(Date.now() - 60_000)
  })
})

describe("relay identity registry (P6/P7 TOFU)", () => {
  test("records the identity, merges endpoints, keeps the first name", () => {
    recordRelayIdentity({
      relayPubkey: "PK-A==",
      relayName: "my-relay",
      endpoint: "http://relay-a:3000",
    })
    expect(relayPinFor("http://relay-a:3000")).toBe("PK-A==")

    // Advertised endpoints merge (P6); name untouched.
    recordRelayIdentity({
      relayPubkey: "PK-A==",
      relayName: "should-not-win",
      endpoint: "http://relay-a:3000",
      endpoints: ["http://100.94.31.99:3000"],
    })
    const ident = loadRelayIdentities().find((i) => i.pubkey === "PK-A==")
    expect(ident?.name).toBe("my-relay")
    expect(ident?.endpoints).toContain("http://100.94.31.99:3000")
    expect(ident?.endpoints).toContain("http://relay-a:3000")
  })

  test("migration folds legacy per-URL pins into identities", () => {
    // The P7 interim pin (in proxy-relays.json via rememberRelay) migrates:
    // a legacy entry's pubkey+url become an identity endpoint, idempotently.
    const relaysPath = join(tmpHome, ".local/state/un-bien/proxy-relays.json")
    mkdirSync(dirname(relaysPath), { recursive: true, mode: 0o700 })
    writeFileSync(
      relaysPath,
      JSON.stringify({
        relays: [
          {
            url: "http://legacy-relay:3000",
            name: "legacy",
            addedAt: "2026-10-01T00:00:00.000Z",
            pubkey: "PK-LEGACY==",
          },
        ],
      }),
    )
    const ident = loadRelayIdentities().find((i) => i.pubkey === "PK-LEGACY==")
    expect(ident?.name).toBe("legacy")
    expect(ident?.endpoints).toContain("http://legacy-relay:3000")
    // Enforcement routes through identities:
    expect(relayPinFor("http://legacy-relay:3000")).toBe("PK-LEGACY==")
  })
})

describe("endpoint ranking + selector (P6 option C)", () => {
  test("rankEndpoints: loopback → dotless → private → tailnet → public", () => {
    const ranked = rankEndpoints([
      "http://example.com:3000",
      "http://crashtest.tail8a69.ts.net:3000",
      "http://10.1.2.3:3000",
      "http://192.168.0.5:3000",
      "http://bigbox:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
    ])
    expect(ranked.slice(0, 2).sort()).toEqual([
      "http://127.0.0.1:3000",
      "http://localhost:3000",
    ])
    expect(ranked[2]).toBe("http://bigbox:3000")
    expect(ranked.slice(3, 5).sort()).toEqual([
      "http://10.1.2.3:3000",
      "http://192.168.0.5:3000",
    ])
    expect(ranked[5]).toBe("http://crashtest.tail8a69.ts.net:3000")
    expect(ranked[6]).toBe("http://example.com:3000")
    // Dedupe + garbage-tolerant:
    expect(rankEndpoints(["x", "x"])).toEqual(["x"])
  })

  test("pickRelayEndpoint prefers the loopback endpoint that answers", async () => {
    recordRelayIdentity({
      relayPubkey: "PK-SEL==",
      relayName: "sel-relay",
      endpoint: "http://crashtest.tail8a69.ts.net:3000",
      endpoints: ["http://127.0.0.1:3996"],
    })
    // Stub fetch: only the loopback candidate replies 200.
    const fetched: string[] = []
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL) => {
        const url = String(input).replace("/health", "")
        fetched.push(url)
        return url === "http://127.0.0.1:3996"
          ? { ok: true }
          : { ok: false }
      }) as unknown,
    )
    const chosen = await pickRelayEndpoint(
      "http://crashtest.tail8a69.ts.net:3000",
    )
    vi.unstubAllGlobals()
    expect(chosen).toBe("http://127.0.0.1:3996")
    expect(fetched.length).toBeGreaterThanOrEqual(1)
  })

  test("pickRelayEndpoint falls back to the seed when nothing answers", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => ({ ok: false })) as unknown,
    )
    const chosen = await pickRelayEndpoint("http://seed-relay:3000", 1)
    vi.unstubAllGlobals()
    expect(chosen).toBe("http://seed-relay:3000")
  })
})