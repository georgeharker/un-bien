import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, test } from "vitest"
import {
  loadRelayPeers,
  addRelayPeer,
  removeRelayPeer,
  isFederationEnabled,
  setFederationEnabled,
} from "./store.js"

// ── Relay peering config (relay-peers.json) ────────────────────────────────
describe("relay peering config", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "unbien-peer-test-"))
  const peerPath = join(tmpDir, "relay-peers.json")

  test("loadRelayPeers on absent file → empty", () => {
    expect(loadRelayPeers(peerPath)).toEqual([])
  })

  test("addRelayPeer writes + loadRelayPeers reads back", () => {
    addRelayPeer({ url: "http://100.x:3000", name: "hostB" }, peerPath)
    addRelayPeer({ url: "http://100.y:3000", name: "hostC" }, peerPath)
    const peers = loadRelayPeers(peerPath)
    expect(peers).toHaveLength(2)
    expect(peers.map((p) => p.name)).toEqual(["hostB", "hostC"])
  })

  test("addRelayPeer deduplicates by name", () => {
    addRelayPeer({ url: "http://100.z:3000", name: "hostB" }, peerPath)
    const peers = loadRelayPeers(peerPath)
    expect(peers).toHaveLength(2)
    expect(peers.find((p) => p.name === "hostB")?.url).toBe("http://100.z:3000")
  })

  test("removeRelayPeer by name", () => {
    expect(removeRelayPeer("hostB", peerPath)).toBe(true)
    expect(loadRelayPeers(peerPath)).toHaveLength(1)
    expect(loadRelayPeers(peerPath).map((p) => p.name)).toEqual(["hostC"])
  })

  test("removeRelayPeer on absent name → false", () => {
    expect(removeRelayPeer("nonexistent", peerPath)).toBe(false)
  })
})
describe("federation gate", () => {
  it("defaults to disabled (absent file / missing flag)", () => {
    const dir = mkdtempSync("/tmp/unbien-test-")!
    const file = join(dir, "relay-peers.json")
    expect(isFederationEnabled(file)).toBe(false)
    rmSync(dir, { recursive: true })
  })

  it("setFederationEnabled flips + preserves peers", () => {
    const dir = mkdtempSync("/tmp/unbien-test-")!
    const file = join(dir, "relay-peers.json")
    addRelayPeer({ url: "ws://m:3000", name: "m" }, file)
    expect(isFederationEnabled(file)).toBe(false)
    setFederationEnabled(true, file)
    expect(isFederationEnabled(file)).toBe(true)
    setFederationEnabled(false, file)
    expect(isFederationEnabled(file)).toBe(false)
    // peers survived the flips
    expect(loadRelayPeers(file)).toHaveLength(1)
    rmSync(dir, { recursive: true })
  })
})
