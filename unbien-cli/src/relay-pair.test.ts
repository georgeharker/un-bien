/**
 * Federation v2 slice 1 — CLI pairing flow tests:
 *  - relay-pair:// URL round-trip carries the secret (one-time token)
 *  - `unbien relay pair` mints a pending entry in relay-peers.json
 *  - `unbien relay peer add relay-pair://…` stores the pin + secret
 *  - the legacy `peer add <url> <name>` form REFUSES (pinned pairing is
 *    mandatory)
 *
 * The subprocess tests run relay.ts under tsx with HOME pointed at a temp
 * dir, so the CLI writes only hermetic state (relay-peers.json, the relay
 * identity keypair, relay.json).
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, test } from "vitest"
import {
  addPendingRelayPair,
  addRelayPeer,
  decodeRelayPairUrl,
  encodeRelayPairUrl,
  isPendingLive,
  loadPendingRelayPairs,
  loadRelayPeers,
  PENDING_TTL_MS,
} from "./store.js"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Run `src/relay.ts` in a subprocess with an isolated HOME. */
function runCli(args: string[], home: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join("src", "relay.ts"), ...args],
    {
      cwd: PKG_ROOT,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    },
  )
}

// ── URL round-trip (pure) ──────────────────────────────────────────────────

describe("relay-pair URL codec", () => {
  it("round-trips url, name, pubkey and the secret", () => {
    const url = encodeRelayPairUrl({
      url: "ws://host-a:3000",
      name: "host-a",
      pubkey: "pk-a",
      secret: "the-secret",
    })
    expect(url.startsWith("relay-pair://")).toBe(true)
    const parsed = decodeRelayPairUrl(url)
    expect(parsed).toEqual({
      url: "ws://host-a:3000",
      name: "host-a",
      pubkey: "pk-a",
      secret: "the-secret",
    })
  })

  it("secret is optional on the wire (manual dual pairing)", () => {
    const parsed = decodeRelayPairUrl(
      encodeRelayPairUrl({ url: "http://x:1", name: "x", pubkey: "pk" }),
    )
    expect(parsed?.secret).toBeUndefined()
  })

  it("rejects garbage and URLs without a pubkey (the pin is mandatory)", () => {
    expect(decodeRelayPairUrl("not a url")).toBeNull()
    expect(decodeRelayPairUrl("relay-pair://!!!not-base64")).toBeNull()
    const noPk = `relay-pair://${Buffer.from(
      JSON.stringify({ url: "http://x:1", name: "x" }),
    ).toString("base64")}`
    expect(decodeRelayPairUrl(noPk)).toBeNull()
  })
})

// ── store: pending + peers share one file ───────────────────────────────────

describe("relay-peers.json pending entries", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "unbien-pending-test-"))
  const peersPath = join(tmpDir, "relay-peers.json")

  it("addPendingRelayPair upserts by name — re-minting revokes the old secret", () => {
    addPendingRelayPair(
      { secret: "tok", name: "self", url: "http://a:3000", at: "t", at_ms: Date.now() },
      peersPath,
    )
    addPendingRelayPair(
      { secret: "tok2", name: "self", url: "http://a:3000", at: "t2", at_ms: Date.now() },
      peersPath,
    )
    // Same name: the new invitation REPLACES the old — re-issuing is
    // revocation (the old secret no longer pairs).
    expect(loadPendingRelayPairs(peersPath).map((p) => p.secret)).toEqual([
      "tok2",
    ])
    // A different name appends: one live invitation per peer name.
    addPendingRelayPair(
      { secret: "tok3", name: "other", url: "http://b:3000", at: "t3", at_ms: Date.now() },
      peersPath,
    )
    expect(loadPendingRelayPairs(peersPath).map((p) => p.secret)).toEqual([
      "tok2",
      "tok3",
    ])
  })

  it("expired invitations are pruned on mint + report not live", () => {
    addPendingRelayPair(
      {
        secret: "tok-dead",
        name: "stale",
        url: "http://s:3000",
        at: "t",
        at_ms: Date.now() - PENDING_TTL_MS - 60_000,
      },
      peersPath,
    )
    const dead = loadPendingRelayPairs(peersPath).find((p) => p.secret === "tok-dead")
    expect(dead).toBeDefined()
    expect(isPendingLive(dead!)).toBe(false)
    // A fresh mint prunes the expired entry from the file.
    addPendingRelayPair(
      { secret: "tok-new", name: "fresh", url: "http://f:3000", at: "t", at_ms: Date.now() },
      peersPath,
    )
    expect(
      loadPendingRelayPairs(peersPath).some((p) => p.secret === "tok-dead"),
    ).toBe(false)
    // Legacy entries without at_ms never expire.
    addPendingRelayPair(
      { secret: "tok-legacy", name: "legacy", url: "http://l:3000", at: "t" },
      peersPath,
    )
    const legacy = loadPendingRelayPairs(peersPath).find(
      (p) => p.secret === "tok-legacy",
    )
    expect(isPendingLive(legacy!)).toBe(true)
  })

  it("addRelayPeer PRESERVES pending entries + other fields (one shared file)", () => {
    addRelayPeer(
      { url: "http://b:3000", name: "hostB", pubkey: "pk-b", pair_secret: "tok2" },
      peersPath,
    )
    const doc = JSON.parse(readFileSync(peersPath, "utf8")) as Record<
      string,
      unknown
    >
    expect(loadRelayPeers(peersPath).map((p) => p.name)).toEqual(["hostB"])
    expect(loadPendingRelayPairs(peersPath).map((p) => p.secret)).toEqual([
      "tok2",
      "tok3",
      "tok-new",
      "tok-legacy",
    ])
    expect(doc["federation"]).toBeUndefined() // untouched fields survive
  })

  it("stores pair_secret alongside the pin", () => {
    const peer = loadRelayPeers(peersPath).find((p) => p.name === "hostB")
    expect(peer?.pubkey).toBe("pk-b")
    expect(peer?.pair_secret).toBe("tok2")
  })

  it("atomic write leaves no temp files behind", () => {
    const leftovers = readdirSync(tmpDir).filter((f) => f.includes(".tmp-"))
    expect(leftovers).toEqual([])
    rmSync(tmpDir, { recursive: true })
  })
})

// ── subprocess e2e: the actual CLI flow ────────────────────────────────────

describe("unbien relay pair / peer add (subprocess)", () => {
  const home = mkdtempSync(join(tmpdir(), "unbien-relay-cli-home-"))
  const peersPath = join(home, ".local", "state", "un-bien", "relay-peers.json")

  test("'relay pair' mints a secret + pending entry", () => {
    const res = runCli(["pair", "http://127.0.0.1:3999", "--name", "host-a"], home)
    expect(res.status).toBe(0)
    const stdoutUrl = res.stdout.trim().split("\n").pop() as string
    expect(stdoutUrl.startsWith("relay-pair://")).toBe(true)

    // The URL carries the secret; the pending entry holds it (single-use).
    const parsed = decodeRelayPairUrl(stdoutUrl)
    expect(parsed).not.toBeNull()
    expect(parsed?.pubkey).toBeTruthy()
    expect(parsed?.secret).toBeTruthy()
    const pending = loadPendingRelayPairs(peersPath)
    expect(pending).toHaveLength(1)
    expect(pending[0].secret).toBe(parsed?.secret)
    expect(pending[0].name).toBe("host-a")
    expect(pending[0].url).toBe("ws://127.0.0.1:3999") // doPair converts http→ws
  })

  test("'peer add relay-pair://…' stores the pin + the secret", () => {
    const pairRes = runCli(["pair", "http://127.0.0.1:4001", "--name", "host-a2"], home)
    const url = pairRes.stdout.trim().split("\n").pop() as string
    const secret = decodeRelayPairUrl(url)?.secret

    const addRes = runCli(["peer", "add", url], home)
    expect(addRes.status).toBe(0)
    const peers = loadRelayPeers(peersPath)
    expect(peers.map((p) => p.name)).toContain("host-a2")
    const peer = peers.find((p) => p.name === "host-a2")
    expect(peer?.pubkey).toBe(decodeRelayPairUrl(url)?.pubkey)
    expect(peer?.pair_secret).toBe(secret)
    // The issuing relay's pending entry is untouched on THIS machine (the
    // PEER's relay consumes it when the hello presents it).
    expect(loadPendingRelayPairs(peersPath).map((p) => p.url)).toContain(
      "ws://127.0.0.1:4001",
    )
  })

  test("legacy 'peer add <url> <name>' REFUSES (pinned pairing is mandatory)", () => {
    const res = runCli(["peer", "add", "http://100.x:3000", "hostB"], home)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain("pairing URL")
    // And it wrote nothing.
    const names = loadRelayPeers(peersPath).map((p) => p.name)
    expect(names).not.toContain("hostB")
  })

  test("'peer list' shows pin status + pending count, never the secret", () => {
    const res = runCli(["peer", "list"], home)
    expect(res.status).toBe(0)
    expect(res.stderr).toContain("pinned")
    expect(res.stderr).toContain("Pending pairing invitations")
    const secrets = loadPendingRelayPairs(peersPath).map((p) => p.secret)
    for (const s of secrets) {
      expect(res.stderr).not.toContain(s)
    }
  })

  it("cleans up", () => {
    rmSync(home, { recursive: true })
  })
})