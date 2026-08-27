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

    private func load(_ name: String) throws -> [EnvelopeMessage] {
        let data = try Data(contentsOf: fixtureURL(name))
        let decoder = JSONDecoder()
        return try String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
    }

    /// Step 4: the app-end reader connects — decode the combined {rpc|evt}
    /// envelope stream from a real subagent run and fold it into interpreted state.
    func testSubagentRunConnects() throws {
        let messages = try load("subagent-run.envelope.jsonl")
        XCTAssertEqual(messages.count, 447)

        var reducer = EnvelopeReducer()
        reducer.apply(messages)
        let state = reducer.state

        // {evt} plane → one subagent, final status completed, enriched by merge.
        XCTAssertEqual(state.subagents.count, 1)
        let sub = try XCTUnwrap(state.subagents.first)
        XCTAssertEqual(sub.status, "completed")
        XCTAssertEqual(sub.type, "general-purpose")
        XCTAssertEqual(sub.description, "How to print date in blue in zsh")
        XCTAssertNotNil(sub.result)

        // rpc plane → the subagent shows as an "Agent" tool card in the transcript.
        XCTAssertTrue(state.transcript.contains { $0.kind == .tool && $0.toolName == "Agent" })

        // rpc get_state → session snapshot captured.
        let session = try XCTUnwrap(state.session)
        XCTAssertEqual(session.provider, "claude-bridge")
        XCTAssertNotNil(session.model)

        // extension_ui setStatus text is ANSI-stripped (no ESC left behind).
        for value in state.status.values {
            XCTAssertFalse(value.contains("\u{1B}"), "status text should be ANSI-stripped")
        }
    }

    func testCleanMessageTurnTranscript() throws {
        // The clean fixture is raw rpc (no {evt}); wrap each frame as {rpc}.
        let data = try Data(contentsOf: fixtureURL("message-turn-clean.jsonl"))
        let decoder = JSONDecoder()
        let messages: [EnvelopeMessage] = try String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .map { EnvelopeMessage(rpc: try decoder.decode(JSONValue.self, from: Data($0.utf8))) }

        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        // user prompt + assistant "hello world" both land in the transcript.
        let assistant = reducer.state.transcript.filter { $0.kind == .assistant }
        XCTAssertTrue(assistant.contains { $0.text.contains("hello world") })
        XCTAssertTrue(reducer.state.transcript.contains { $0.kind == .user })
    }
}
