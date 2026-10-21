import { describe, expect, test } from "vitest"
import { compareSemver, relayNeedsUpdate } from "./relayService.js"

describe("relayNeedsUpdate (semver-aware — never downgrades)", () => {
  test("the case that bit: stable installed, dev target BEHIND it", () => {
    // The dev ladder legitimately sits behind the stable cut that consumed
    // it — `!==` read this as an update and downgraded the relay.
    expect(relayNeedsUpdate("0.8.4", "0.8.2-dev.20261015")).toBe(false)
  })

  test("pre-release installs still upgrade to stable", () => {
    expect(relayNeedsUpdate("0.8.2-dev.20261015", "0.8.4")).toBe(true)
  })

  test("pre-release upgrades to its own release", () => {
    // Equal cores: the plain release outranks the pre-release.
    expect(relayNeedsUpdate("0.8.2-dev.20261015", "0.8.2")).toBe(true)
  })

  test("identical versions never reinstall", () => {
    expect(relayNeedsUpdate("0.8.4", "0.8.4")).toBe(false)
    expect(relayNeedsUpdate("0.8.2-dev.20261015", "0.8.2-dev.20261015")).toBe(
      false,
    )
  })

  test("ordinary stable upgrades", () => {
    expect(relayNeedsUpdate("0.8.3", "0.8.4")).toBe(true)
    expect(relayNeedsUpdate("0.7.40", "0.8.0")).toBe(true)
  })

  test("unversionable binary is left alone", () => {
    expect(relayNeedsUpdate(null, "0.8.4")).toBe(false)
  })
})

describe("compareSemver (semver §11)", () => {
  test("core comparison is numeric, not lexical", () => {
    expect(compareSemver("0.10.0", "0.9.9")).toBe(1)
    expect(compareSemver("0.8.10", "0.8.9")).toBe(1)
  })

  test("pre-release sorts below its release", () => {
    expect(compareSemver("0.8.4-dev.1", "0.8.4")).toBe(-1)
    expect(compareSemver("0.8.4", "0.8.4-dev.1")).toBe(1)
  })

  test("pre-release identifiers compare numerically", () => {
    expect(compareSemver("0.8.2-dev.20261015", "0.8.2-dev.20261016")).toBe(-1)
    expect(compareSemver("0.8.2-dev.2", "0.8.2-dev.10")).toBe(-1)
  })

  test("equal versions compare zero", () => {
    expect(compareSemver("0.8.4", "0.8.4")).toBe(0)
    expect(compareSemver("0.8.2-dev.20261015", "0.8.2-dev.20261015")).toBe(0)
  })

  test("unparseable input falls back to string compare", () => {
    expect(compareSemver("banana", "apple")).toBe(1)
    expect(compareSemver("banana", "banana")).toBe(0)
  })
})