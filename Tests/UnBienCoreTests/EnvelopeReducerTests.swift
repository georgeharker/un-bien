import XCTest
@testable import UnBienCore

final class EnvelopeReducerTests: XCTestCase {
    /// Fixtures live at un-bien/Tests/Fixtures/rpc-stream/, two levels up from
    /// this source file (Tests/UnBienCoreTests/).
    private func fixtureURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // UnBienCoreTests/
            .deletingLastPathComponent()      // Tests/
            .appendingPathComponent("Fixtures/rpc-stream/\(name)")
    }

    private func loadEnvelope(_ name: String) throws -> [EnvelopeMessage] {
        let data = try Data(contentsOf: fixtureURL(name))
        let decoder = JSONDecoder()
        return try String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
    }

    /// Wrap a raw rpc-frame fixture (no {evt}) as {rpc} envelope messages.
    private func loadRawRPC(_ name: String) throws -> [EnvelopeMessage] {
        let data = try Data(contentsOf: fixtureURL(name))
        let decoder = JSONDecoder()
        return try String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .map { EnvelopeMessage(rpc: try decoder.decode(JSONValue.self, from: Data($0.utf8))) }
    }

    private func toolCards(_ state: SessionState) -> [ToolCard] {
        state.items.compactMap { if case let .tool(card) = $0 { return card } else { return nil } }
    }

    /// The full app-end read: fold the combined {rpc|evt} envelope from a real
    /// subagent run and check both planes land in the interpreted state.
    func testSubagentRunConnects() throws {
        let messages = try loadEnvelope("subagent-run.envelope.jsonl")
        XCTAssertEqual(messages.count, 447)

        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        // {evt} plane → one subagent, final status completed, enriched by merge.
        XCTAssertEqual(reducer.subagents.count, 1)
        let sub = try XCTUnwrap(reducer.subagents.first)
        XCTAssertEqual(sub.status, "completed")
        XCTAssertEqual(sub.type, "general-purpose")
        XCTAssertEqual(sub.description, "How to print date in blue in zsh")
        XCTAssertNotNil(sub.result)

        // rpc plane → the subagent shows as an "Agent" tool card, completed ok.
        XCTAssertTrue(toolCards(reducer.session).contains { $0.tool == "Agent" && $0.state == .ok })

        // rpc get_state → session snapshot; extension_ui status ANSI-stripped.
        XCTAssertEqual(reducer.snapshot?.provider, "claude-bridge")
        for value in reducer.status.values {
            XCTAssertFalse(value.contains("\u{1B}"), "status text should be ANSI-stripped")
        }

        // turn settled → no active turn left hanging.
        XCTAssertNil(reducer.session.activeTurnID)
    }

    /// Streaming text reduction: deltas build the assistant bubble; message_end
    /// finalizes without clobbering.
    func testCleanMessageTurnTranscript() throws {
        let messages = try loadRawRPC("message-turn-clean.jsonl")
        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        let items = reducer.session.items
        XCTAssertTrue(items.contains { if case .user = $0 { return true } else { return false } })

        let assistantText = items.compactMap { item -> String? in
            if case let .assistant(bubble) = item { return bubble.text } else { return nil }
        }.joined()
        XCTAssertTrue(assistantText.contains("hello world"),
                      "assistant bubble should carry the streamed text")

        // No bubble left streaming after settle.
        for item in items {
            if case let .assistant(bubble) = item { XCTAssertFalse(bubble.streaming) }
        }
    }
}
