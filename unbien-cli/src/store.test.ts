import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  loadRelayPeers,
  addRelayPeer,
  removeRelayPeer,
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