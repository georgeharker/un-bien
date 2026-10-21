import { describe, expect, test } from "vitest"
import {
  formatPeerInventory,
  formatPeerInventoryDetailed,
  type RosterInfo,
} from "./peer_inventory.js"

function info(
  address: string,
  cwd = "",
  name = address.split("@").pop() ?? address,
): RosterInfo {
  return { cwd, name, address }
}

describe("formatPeerInventoryDetailed", () => {
  test("groups local peers by cwd, legacy no-cwd peers last", () => {
    const text = formatPeerInventoryDetailed([
      info("/radar@metrics-core", "/radar"),
      info("old-agent"),
      info("/alpha@auth", "/alpha"),
      info("/radar@metrics-docs", "/radar"),
      info("/alpha@planner", "/alpha"),
    ])
    const lines = text.split("\n")
    // One header per cwd: alphabetical, "cwd not reported" last — addresses
    // verbatim under each.
    expect(lines.filter((l) => l.startsWith("  local —"))).toEqual([
      "  local — /alpha",
      "  local — /radar",
      "  local — cwd not reported",
    ])
    expect(text).toContain("    /radar@metrics-core")
    expect(text).toContain("    /radar@metrics-docs")
    expect(text).toContain("    old-agent")
  })

  test("remote pc peers group under their label, then cwd", () => {
    const text = formatPeerInventoryDetailed([
      info("/local@watchdog", "/local"),
      info("casa:/home/jo/api@api", "/home/jo/api"),
      info("casa:/home/jo/web@web", "/home/jo/web"),
    ])
    const lines = text.split("\n")
    expect(lines.filter((l) => l.startsWith("  "))).toEqual([
      "  local — /local",
      "    /local@watchdog",
      "  remote:casa — /home/jo/api",
      "    casa:/home/jo/api@api",
      "  remote:casa — /home/jo/web",
      "    casa:/home/jo/web@web",
    ])
  })

  test("self is excluded by address; empty roster is (no peers)", () => {
    const text = formatPeerInventoryDetailed([info("/r@me", "/r")], {
      selfAddress: "/r@me",
    })
    expect(text).toBe("(no peers)")

    const rest = formatPeerInventoryDetailed(
      [
        info("/r@me", "/r"),
        info("/r@other", "/r"),
      ],
      { selfAddress: "/r@me" },
    )
    expect(rest).toContain("/r@other")
    expect(rest).not.toContain("@me")
  })

  test("addresses with percent-encoded colons never split on %3A", () => {
    // PC labels percent-encode colons (%3A): the label separator is only the
    // FIRST literal colon — a %3A inside a local cwd@name address can still
    // appear as the first ":" of "casa%3Ahost" style labels, so split only on
    // real separators and treat percent-encoded ones as part of the label.
    const text = formatPeerInventoryDetailed([
      info("casa%3Ahost:/home/pc@worker", "/home/pc"),
    ])
    expect(text).toContain("  remote:casa%3Ahost — /home/pc")
    expect(text).toContain("    casa%3Ahost:/home/pc@worker")
  })
})

describe("formatPeerInventory (legacy flat shape)", () => {
  test("preserves the local/remote split output", () => {
    const text = formatPeerInventory(["sess-1", "casa:sess-2"], "sess-1")
    expect(text).toBe("  local:\n    (none)\n\n  remote:casa\n    sess-2")
  })
})