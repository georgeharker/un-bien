/**
 * Contract-fixture roundtrip for the pair_* wire shapes.
 *
 * Colocated with session/relay_lifecycle.ts — the pair_request / pair_ok /
 * pair_error handshake implementation (`_handlePairRequest`) lives there.
 * These tests parse the app-side test fixtures (JSONL) into the protocol
 * shapes so the extension's replies can't drift from what the app tests
 * exercise.
 */
import { describe, expect, test } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

describe("contract fixtures: pair_*", () => {
  const fixtureDir = fileURLToPath(
    new URL("../../../app/Tests/UnBienCoreTests/Fixtures", import.meta.url),
  )

  test("pair_request.jsonl parses into ClientMessage shape", () => {
    const lines = readFileSync(`${fixtureDir}/pair_request.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const obj = JSON.parse(line) as {
        type: string
        id: string
        token: string
        device_name: string
      }
      expect(obj.type).toBe("pair_request")
      expect(typeof obj.id).toBe("string")
      expect(typeof obj.token).toBe("string")
      expect(typeof obj.device_name).toBe("string")
    }
  })

  test("pair_ok.jsonl parses into ServerMessage shape", () => {
    const lines = readFileSync(`${fixtureDir}/pair_ok.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const obj = JSON.parse(line) as {
        type: string
        in_reply_to: string
        session_name: string
      }
      expect(obj.type).toBe("pair_ok")
      expect(typeof obj.in_reply_to).toBe("string")
      expect(typeof obj.session_name).toBe("string")
    }
  })

  test("pair_error.jsonl parses with valid code", () => {
    const lines = readFileSync(`${fixtureDir}/pair_error.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const validCodes = new Set([
      "token_expired",
      "token_consumed",
      "token_unknown",
      "internal_error",
    ])
    for (const line of lines) {
      const obj = JSON.parse(line) as {
        type: string
        in_reply_to: string
        code: string
        message: string
      }
      expect(obj.type).toBe("pair_error")
      expect(validCodes.has(obj.code)).toBe(true)
    }
  })

  test("all 20 fixture files present", () => {
    const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".jsonl"))
    expect(files).toHaveLength(20)
  })
})
