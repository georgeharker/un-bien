import XCTest
@testable import UnBienCore

final class SessionStateTests: XCTestCase {
    func testLoadHistoryRebuildsTranscriptInOrder() {
        var state = SessionState()
        let events: [SessionHistoryEvent] = [
            .userInput(timestamp: 1, id: "u1", text: "list files", images: nil),
            .toolRequest(timestamp: 2, toolCallID: "tc1", tool: "bash", args: ["command": .string("ls")]),
            .toolResult(timestamp: 3, toolCallID: "tc1", result: .string("a\nb"), error: nil, images: nil),
            .agentMessage(timestamp: 4, inReplyTo: "u1", text: "two files", usage: nil, images: nil),
        ]
        state.loadHistory(events, sessionStartedAt: 1_716_234_500_000)
        XCTAssertEqual(state.sessionStartedAt, 1_716_234_500_000)
        XCTAssertEqual(state.items.count, 3) // user, tool (filled), assistant
        guard case let .tool(card) = state.items[1] else { return XCTFail("no tool") }
        XCTAssertEqual(card.state, .ok)
    }
}
