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

    // A session_sync re-open replays the SAME pi messages as faithful
    // `message_end` frames. Because the bubble id is derived from each message's
    // own fields (identify), the replay resolves to the SAME id the live stream
    // produced, so `appendedIDs` dedups and NOTHING is duplicated. Guards
    // design 01M15FMQ (live == replay ids). Exercises both identify paths:
    // responseId anchor (turn 1) and the role+ts+model+content hash (turn 2).
    func testSessionSyncReplayDedupsAgainstLiveStream() {
        var state = SessionState()

        func end(role: String, text: String, ts: Double, responseId: String? = nil) -> JSONValue {
            var msg: [String: JSONValue] = [
                "role": .string(role),
                "content": role == "user"
                    ? .string(text)
                    : .array([.object(["type": .string("text"), "text": .string(text)])]),
                "timestamp": .number(ts),
            ]
            if let rid = responseId { msg["responseId"] = .string(rid) }
            return .object(["type": .string("message_end"), "message": .object(msg)])
        }
        func delta(_ s: String) -> JSONValue {
            .object(["type": .string("message_update"),
                     "assistantMessageEvent": .object(["type": .string("text_delta"),
                                                       "delta": .string(s)])])
        }
        let simple: (String) -> JSONValue = { .object(["type": .string($0)]) }

        // LIVE: two streamed turns (assistant text arrives as deltas, settles at
        // message_end). Turn 1 carries a provider responseId; turn 2 does not.
        state.applyRPC(end(role: "user", text: "hi", ts: 100))
        state.applyRPC(simple("turn_start"))
        state.applyRPC(delta("hel"))
        state.applyRPC(delta("lo"))
        state.applyRPC(end(role: "assistant", text: "hello", ts: 200, responseId: "resp_1"))
        state.applyRPC(simple("agent_settled"))
        state.applyRPC(end(role: "user", text: "bye", ts: 300))
        state.applyRPC(simple("turn_start"))
        state.applyRPC(delta("cya"))
        state.applyRPC(end(role: "assistant", text: "cya", ts: 400))
        state.applyRPC(simple("agent_settled"))

        let liveIDs = state.items.map(\.id)
        XCTAssertEqual(liveIDs.count, 4, "expected 2 user + 2 assistant bubbles")
        XCTAssertEqual(Set(liveIDs).count, 4, "live bubble ids must be unique")

        // RE-OPEN: session_sync replays the same four messages as message_end
        // frames (what _historyReplayFromMessages emits). No deltas this time.
        state.applyRPC(end(role: "user", text: "hi", ts: 100))
        state.applyRPC(end(role: "assistant", text: "hello", ts: 200, responseId: "resp_1"))
        state.applyRPC(end(role: "user", text: "bye", ts: 300))
        state.applyRPC(end(role: "assistant", text: "cya", ts: 400))

        XCTAssertEqual(state.items.map(\.id), liveIDs,
                       "session_sync replay must dedup to the identical transcript, not duplicate it")
    }

    // The transcript now reconstructs from the native get_entries rpc via
    // SessionState.applyEntries (raw pi entries), NOT a fork replay. Because the
    // per-bubble id is identify(msg)-derived, reducing the entries for messages
    // already seen live DEDUPS — the reopen/refetch is idempotent (design
    // 01M15FMQ). Also covers tool-card reconstruction from toolCall/toolResult.
    func testGetEntriesReconstructionDedupsAgainstLiveStream() {
        var state = SessionState()

        func endFrame(role: String, text: String, ts: Double, responseId: String? = nil) -> JSONValue {
            var msg: [String: JSONValue] = [
                "role": .string(role),
                "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
                "timestamp": .number(ts),
            ]
            if let rid = responseId { msg["responseId"] = .string(rid) }
            return .object(["type": .string("message_end"), "message": .object(msg)])
        }
        func delta(_ s: String) -> JSONValue {
            .object(["type": .string("message_update"),
                     "assistantMessageEvent": .object(["type": .string("text_delta"), "delta": .string(s)])])
        }
        let simple: (String) -> JSONValue = { .object(["type": .string($0)]) }
        // A raw pi ENTRY (type:"message") wrapping an AgentMessage — what
        // get_entries returns; the entry.id is intentionally NOT the bubble id.
        func entry(role: String, text: String, ts: Double, responseId: String? = nil) -> JSONValue {
            var msg: [String: JSONValue] = [
                "role": .string(role),
                "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
                "timestamp": .number(ts),
            ]
            if let rid = responseId { msg["responseId"] = .string(rid) }
            return .object(["type": .string("message"), "id": .string("entry-\(ts)"),
                            "message": .object(msg)])
        }

        // LIVE: a streamed user + assistant turn.
        state.applyRPC(endFrame(role: "user", text: "hi", ts: 100))
        state.applyRPC(simple("turn_start"))
        state.applyRPC(delta("hel"))
        state.applyRPC(delta("lo"))
        state.applyRPC(endFrame(role: "assistant", text: "hello", ts: 200, responseId: "resp_1"))
        state.applyRPC(simple("agent_settled"))
        let liveIDs = state.items.map(\.id)
        XCTAssertEqual(liveIDs.count, 2)

        // REOPEN: reconstruct from get_entries — the SAME two messages as raw
        // entries. identify(msg) matches the live ids -> appendedIDs dedups.
        state.applyEntries([
            entry(role: "user", text: "hi", ts: 100),
            entry(role: "assistant", text: "hello", ts: 200, responseId: "resp_1"),
        ])
        XCTAssertEqual(state.items.map(\.id), liveIDs,
                       "get_entries reconstruction must dedup to the identical transcript")
    }

    // A fresh get_entries reconstruction (no prior live stream) builds the
    // transcript AND the tool card from toolCall content + a toolResult entry.
    func testGetEntriesReconstructsToolCard() {
        var state = SessionState()
        let asstMsg: JSONValue = .object([
            "role": .string("assistant"),
            "timestamp": .number(10),
            "content": .array([
                .object(["type": .string("text"), "text": .string("running")]),
                .object(["type": .string("toolCall"), "id": .string("tc1"),
                         "name": .string("bash"), "arguments": .object(["command": .string("ls")])]),
            ]),
        ])
        state.applyEntries([
            .object(["type": .string("message"), "id": .string("e1"),
                     "message": .object(["role": .string("user"), "timestamp": .number(1),
                                         "content": .string("list files")])]),
            .object(["type": .string("message"), "id": .string("e2"), "message": asstMsg]),
            .object(["type": .string("message"), "id": .string("e3"),
                     "message": .object(["role": .string("toolResult"), "timestamp": .number(2),
                                         "toolCallId": .string("tc1"), "isError": .bool(false),
                                         "content": .string("a\nb")])]),
        ])
        // user bubble, assistant bubble, filled tool card.
        XCTAssertEqual(state.items.count, 3)
        guard case let .tool(card) = state.items[2] else { return XCTFail("no tool card") }
        XCTAssertEqual(card.state, .ok)
        XCTAssertEqual(card.tool, "bash")
    }
}
