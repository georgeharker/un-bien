import XCTest
@testable import UnBienCore

/// THE definitive regression pin: the real session log through the real
/// pipeline, in the exact sequence the phone performed (captured live from
/// the device log, 2026-10-26 16:28): cache-hit fold of all entries + derive
/// from the cached leaf, delta page fold, empty-terminal derive from the
/// machine tail. Born from the missing-post-tool-prose mystery: the root
/// cause was identify() trusting provider responseIds (426 of 744 shared
/// across different messages in this very log) — every message sharing a
/// rid became "the same message" to the match loop, its birth eaten by a
/// re-key onto an earlier row, invisible forever through healthy walks.
/// Skips on machines without the log; the synthetic suites in
/// ReproPostToolTests carry the semantics everywhere.
final class RealLogReproTests: XCTestCase {
    func testRealLogCacheHitDeltaTerminalRendersProse() throws {
        let path = "/Users/geohar/.local/share/pi/2026-10-14T15-47-40-528Z_"
            + "01a13b19-0f6f-72ef-aa88-5c17e5962b87.jsonl"
        guard FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("real session log not present on this machine")
        }
        let lines = try String(contentsOfFile: path, encoding: .utf8)
            .split(separator: "\n")
        let decoder = JSONDecoder()
        var entries: [JSONValue] = []
        for line in lines {
            if let data = String(line).data(using: .utf8),
               let value = try? decoder.decode(JSONValue.self, from: data) {
                entries.append(value)
            }
        }
        XCTAssertGreaterThan(entries.count, 3000, "the real log loaded")

        // The phone-captured cursor + tail from the live device log.
        func idx(_ id: String) -> Int? { entries.firstIndex { $0["id"]?.stringValue == id } }
        guard let cursorIdx = idx("5b791d84"),
              let tailIdx = entries.lastIndex(where: { ($0["id"]?.stringValue ?? "").count == 8 }) else {
            throw XCTSkip("cursor/leaf ids not found in the log")
        }
        let tail = entries[tailIdx]["id"]!.stringValue!
        let delta = Array(entries[(cursorIdx + 1)...tailIdx])

        var state = SessionState()
        // Phase 1 (phone 16:28:00): cache hit — all cached entries folded,
        // derive from the cached leaf.
        state.applyEntries(Array(entries[...cursorIdx]), leafId: "5b791d84")
        // Phase 2: the delta walk's page (non-empty → index-only).
        state.applyEntries(delta, leafId: nil)
        // Phase 3: the empty terminal page carries the machine tail → derive.
        state.applyEntries([], leafId: tail)

        // The previously-eaten trailing prose must render. (An earlier marker
        // checked the codemode return-JSON's string — that lives in the
        // toolResult plane, not assistant text — and another checked a
        // message compacted away: pi's summary replaced the literal entry,
        // so its absence is correct and unfindable by design. This marker is
        // the actual prose text, clear of its markdown bold.)
        let assistantTexts = state.items.compactMap { item -> String? in
            if case let .assistant(b) = item { return b.text }
            return nil
        }
        XCTAssertTrue(assistantTexts.contains { $0.contains("exact segment that vanished before") },
                      "the trailing prose must render through the real sequence")
    }
}