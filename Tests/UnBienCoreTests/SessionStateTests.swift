import XCTest
@testable import UnBienCore

final class SessionStateTests: XCTestCase {
    func testStreamingChunksCoalesceThenSettle() {
        var state = SessionState()
        state.apply(.userMessage(id: "u1", text: "hi", images: nil, streamingBehavior: nil))
        state.apply(.agentChunk(inReplyTo: "u1", delta: "Hel"))
        state.apply(.agentChunk(inReplyTo: "u1", delta: "lo"))

        guard case let .assistant(mid) = state.items[1] else { return XCTFail("no assistant") }
        XCTAssertEqual(mid.text, "Hello")
        XCTAssertTrue(mid.streaming)

        state.apply(.agentDone(inReplyTo: "u1", usage: Usage(inputTokens: 10, outputTokens: 5)))
        guard case let .assistant(done) = state.items[1] else { return XCTFail("no assistant") }
        XCTAssertFalse(done.streaming)
        XCTAssertEqual(done.usage, Usage(inputTokens: 10, outputTokens: 5))
        XCTAssertEqual(state.items.count, 2)
    }

    func testAgentMessageImagesAttachToBubble() {
        var state = SessionState()
        state.apply(.agentChunk(inReplyTo: "u1", delta: "Here is a plot:"))
        let img = WireImage(data: "AAAA", mime: "image/png")
        state.apply(.agentMessage(inReplyTo: "u1", text: "Here is a plot:", usage: nil, images: [img]))
        guard case let .assistant(bubble) = state.items[0] else { return XCTFail("no assistant") }
        XCTAssertEqual(bubble.images, [img])
        XCTAssertFalse(bubble.streaming)
    }

    func testActiveTurnIDTracksStreamingLifecycle() {
        var state = SessionState()
        XCTAssertNil(state.activeTurnID)
        state.apply(.agentReasoning(inReplyTo: "u1", delta: "hmm"))
        XCTAssertEqual(state.activeTurnID, "u1")
        state.apply(.agentChunk(inReplyTo: "u1", delta: "Hi"))
        XCTAssertEqual(state.activeTurnID, "u1", "still streaming")
        state.apply(.agentDone(inReplyTo: "u1", usage: nil))
        XCTAssertNil(state.activeTurnID, "done clears the active turn")
    }

    func testCancelledClosesActiveTurn() {
        var state = SessionState()
        state.apply(.agentChunk(inReplyTo: "u1", delta: "Work"))
        XCTAssertEqual(state.activeTurnID, "u1")
        XCTAssertTrue(state.apply(.cancelled(inReplyTo: "u1", targetID: "u1")))
        XCTAssertNil(state.activeTurnID)
        guard case let .assistant(bubble) = state.items[0] else { return XCTFail("no assistant") }
        XCTAssertFalse(bubble.streaming, "cancel settles the open bubble")
    }

    func testReasoningPrecedesTextAsCollapsibleBlock() {
        var state = SessionState()
        state.apply(.agentReasoning(inReplyTo: "u1", delta: "Let me "))
        state.apply(.agentReasoning(inReplyTo: "u1", delta: "think."))
        state.apply(.agentChunk(inReplyTo: "u1", delta: "Answer."))
        state.apply(.agentDone(inReplyTo: "u1", usage: nil))

        XCTAssertEqual(state.items.count, 2)
        guard case let .reasoning(block) = state.items[0] else { return XCTFail("no reasoning") }
        XCTAssertEqual(block.text, "Let me think.")
        XCTAssertFalse(block.streaming, "text arrival closes the reasoning block")
        guard case let .assistant(bubble) = state.items[1] else { return XCTFail("no assistant") }
        XCTAssertEqual(bubble.text, "Answer.")
    }

    func testMidTurnToolCallInterleavesTextAboveAndBelow() {
        var state = SessionState()
        state.apply(.userMessage(id: "u1", text: "go", images: nil, streamingBehavior: nil))
        state.apply(.agentChunk(inReplyTo: "u1", delta: "Let me check. "))
        state.apply(.toolRequest(toolCallID: "tc1", tool: "bash", args: [:]))
        state.apply(.toolResult(toolCallID: "tc1", result: .string("ok"), error: nil))
        state.apply(.agentChunk(inReplyTo: "u1", delta: "Found it."))
        state.apply(.agentDone(inReplyTo: "u1", usage: nil))

        // Expect: user, assistant("Let me check."), tool, assistant("Found it.")
        XCTAssertEqual(state.items.count, 4)
        guard case let .assistant(first) = state.items[1] else { return XCTFail("no first bubble") }
        XCTAssertEqual(first.text, "Let me check. ")
        XCTAssertFalse(first.streaming, "tool call closes the earlier segment")
        guard case .tool = state.items[2] else { return XCTFail("tool card not in the middle") }
        guard case let .assistant(second) = state.items[3] else { return XCTFail("no second bubble") }
        XCTAssertEqual(second.text, "Found it.")
        XCTAssertFalse(second.streaming)

        // Both segments share a turn (inReplyTo) but MUST have distinct row ids,
        // or LazyVStack drops rows on scroll (duplicate SwiftUI identity).
        XCTAssertEqual(first.inReplyTo, second.inReplyTo)
        XCTAssertNotEqual(state.items[1].id, state.items[3].id)
        let ids = state.items.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "all transcript row ids are unique")
    }

    func testToolRequestThenResultFillsSameCard() {
        var state = SessionState()
        state.apply(.toolRequest(toolCallID: "tc1", tool: "bash", args: ["command": .string("ls")]))
        XCTAssertEqual(state.items.count, 1)
        guard case let .tool(running) = state.items[0] else { return XCTFail("no tool") }
        XCTAssertEqual(running.state, .running)

        state.apply(.toolResult(toolCallID: "tc1", result: .string("done"), error: nil))
        XCTAssertEqual(state.items.count, 1, "result fills the existing card, not a new row")
        guard case let .tool(filled) = state.items[0] else { return XCTFail("no tool") }
        XCTAssertEqual(filled.state, .ok)
        XCTAssertEqual(filled.result, .string("done"))
    }

    func testToolErrorMarksFailed() {
        var state = SessionState()
        state.apply(.toolRequest(toolCallID: "tc1", tool: "bash", args: [:]))
        state.apply(.toolResult(toolCallID: "tc1", result: nil, error: "boom"))
        guard case let .tool(card) = state.items[0] else { return XCTFail("no tool") }
        XCTAssertEqual(card.state, .failed)
        XCTAssertEqual(card.error, "boom")
    }

    func testAgentMessageWithoutPriorChunksSettlesDirectly() {
        var state = SessionState()
        state.apply(.agentMessage(inReplyTo: "u1", text: "answer", usage: nil, images: nil))
        guard case let .assistant(bubble) = state.items[0] else { return XCTFail("no assistant") }
        XCTAssertFalse(bubble.streaming)
        XCTAssertEqual(bubble.text, "answer")
    }

    func testLoadHistoryRebuildsTranscriptInOrder() {
        var state = SessionState()
        let events: [SessionHistoryEvent] = [
            .userInput(timestamp: 1, id: "u1", text: "list files", images: nil),
            .toolRequest(timestamp: 2, toolCallID: "tc1", tool: "bash", args: ["command": .string("ls")]),
            .toolResult(timestamp: 3, toolCallID: "tc1", result: .string("a\nb"), error: nil),
            .agentMessage(timestamp: 4, inReplyTo: "u1", text: "two files", usage: nil, images: nil),
        ]
        state.loadHistory(events, sessionStartedAt: 1_716_234_500_000)
        XCTAssertEqual(state.sessionStartedAt, 1_716_234_500_000)
        XCTAssertEqual(state.items.count, 3) // user, tool (filled), assistant
        guard case let .tool(card) = state.items[1] else { return XCTFail("no tool") }
        XCTAssertEqual(card.state, .ok)
    }

    func testStatusMessagesHaveNoTranscriptEffect() {
        var state = SessionState()
        XCTAssertFalse(state.apply(.pong(inReplyTo: "x")))
        XCTAssertFalse(state.apply(.steerConsumed(id: "y")))
        XCTAssertTrue(state.items.isEmpty)
    }
}
