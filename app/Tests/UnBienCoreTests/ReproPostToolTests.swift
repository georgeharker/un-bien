import XCTest
@testable import UnBienCore

final class ReproPostToolTests: XCTestCase {
    private func toolCallBlock(_ id: String, code: String) -> JSONValue {
        .object(["type": .string("toolCall"), "id": .string(id),
                 "name": .string("codemode"), "arguments": .object(["code": .string(code)])])
    }

    private func entries(cParentOfLast: String) -> [JSONValue] {
        // Tree: eu → ea(A, toolCall tc1) → tr1 → eb(B, toolCall tc2) → tr2 → ec(C, text)
        // where C's parentId is `cParentOfLast` (probe both chain shapes).
        [
            .object(["type": .string("message"), "id": .string("eu"), "parentId": .string(""),
                     "message": .object(["role": .string("user"), "timestamp": .number(1),
                                         "content": .string("run the test")])]),
            .object(["type": .string("message"), "id": .string("ea"), "parentId": .string("eu"),
                     "message": .object(["role": .string("assistant"), "timestamp": .number(2),
                                         "responseId": .string("r1"),
                                         "content": .array([toolCallBlock("tc1", code: "return 1")])])]),
            .object(["type": .string("message"), "id": .string("tr1"), "parentId": .string("ea"),
                     "message": .object(["role": .string("toolResult"), "timestamp": .number(3),
                                         "toolCallId": .string("tc1"),
                                         "content": .string("Script failed")])]),
            .object(["type": .string("message"), "id": .string("eb"), "parentId": .string("tr1"),
                     "message": .object(["role": .string("assistant"), "timestamp": .number(4),
                                         "responseId": .string("r2"),
                                         "content": .array([toolCallBlock("tc2", code: "return 2")])])]),
            .object(["type": .string("message"), "id": .string("tr2"), "parentId": .string("eb"),
                     "message": .object(["role": .string("toolResult"), "timestamp": .number(5),
                                         "toolCallId": .string("tc2"),
                                         "content": .string("{\"template\":true}")])]),
            .object(["type": .string("message"), "id": .string("ec"), "parentId": .string(cParentOfLast),
                     "message": .object(["role": .string("assistant"), "timestamp": .number(6),
                                         "responseId": .string("r3"),
                                         "content": .array([.object(["type": .string("text"),
                                                                      "text": .string("There it is — the post-tool prose.")])])])]),
        ]
    }

    private func assertPostToolText(_ items: [TranscriptItem], _ label: String) {
        let texts = items.compactMap { item -> String? in
            if case let .assistant(b) = item { return b.text }
            return nil
        }
        XCTAssertTrue(texts.contains("There it is — the post-tool prose."),
                      "\(label): post-tool assistant text missing; assistant texts = \(texts)")
    }

    func testBackfillChainThroughToolResults() {
        var state = SessionState()
        state.applyEntries(entries(cParentOfLast: "tr2"), leafId: "ec")
        assertPostToolText(state.items, "C.parent=tr2")
        // 4 rows: user + the two tool cards + the prose. The toolCall-only
        // assistant messages birth NO empty bubble (the text-empty guard) —
        // the cards ARE their identity. Pinned deliberately.
        XCTAssertEqual(state.items.count, 4, "user + card(tc1) + card(tc2) + C")
    }

    func testBackfillChainSkippingToolResults() {
        var state = SessionState()
        state.applyEntries(entries(cParentOfLast: "eb"), leafId: "ec")
        assertPostToolText(state.items, "C.parent=eb")
    }
}

extension ReproPostToolTests {
    func testLiveSequencePostToolText() {
        var state = SessionState()
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("user"), "timestamp": .number(1),
                                                    "content": .string("run the test")])]))
        state.applyRPC(.object(["type": .string("turn_start")]))
        // Message A: toolCall-only (the failed codemode call).
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("assistant"), "timestamp": .number(2),
                                                    "responseId": .string("r1"),
                                                    "content": .array([.object(["type": .string("toolCall"),
                                                                                "id": .string("tc1"),
                                                                                "name": .string("codemode"),
                                                                                "arguments": .object(["code": .string("return 1")])])])])]))
        state.applyRPC(.object(["type": .string("tool_execution_start"), "toolCallId": .string("tc1"),
                                "toolName": .string("codemode"), "args": .object(["code": .string("return 1")])]))
        state.applyRPC(.object(["type": .string("tool_execution_end"), "toolCallId": .string("tc1"),
                                "result": .string("Script failed"), "isError": .bool(true)]))
        // Message B: toolCall-only (the retry).
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("assistant"), "timestamp": .number(3),
                                                    "responseId": .string("r2"),
                                                    "content": .array([.object(["type": .string("toolCall"),
                                                                                "id": .string("tc2"),
                                                                                "name": .string("codemode"),
                                                                                "arguments": .object(["code": .string("return 2")])])])])]))
        state.applyRPC(.object(["type": .string("tool_execution_start"), "toolCallId": .string("tc2"),
                                "toolName": .string("codemode"), "args": .object(["code": .string("return 2")])]))
        state.applyRPC(.object(["type": .string("tool_execution_end"), "toolCallId": .string("tc2"),
                                "result": .string("{\"ok\":true}"), "isError": .bool(false)]))
        // Message C: the post-tool prose, streamed as deltas then settled.
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("text_delta"),
                                                                  "delta": .string("There it is — the post-tool prose.")])]))
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("assistant"), "timestamp": .number(4),
                                                    "responseId": .string("r3"),
                                                    "content": .array([.object(["type": .string("text"),
                                                                                "text": .string("There it is — the post-tool prose.")])])])]))
        state.applyRPC(.object(["type": .string("agent_settled")]))
        assertPostToolText(state.items, "live sequence")
    }
}

extension ReproPostToolTests {
    /// The codemode topology: the script's NESTED tool calls log as entries
    /// parented on the toolResult (children of tr2) — SIBLINGS of the
    /// post-tool prose ec. If the active leaf lands on the nested branch
    /// (not the prose), does the derived path still render ec?
    func testNestedSiblingLeafExcludesProse() {
        // DOCUMENTED MODEL LIMITATION (the /tree semantics): the leaf beacon
        // drives the derived path, so a leaf on a nested/sibling branch renders
        // THAT branch and excludes siblings — the post-tool prose on the
        // sibling chain. The relaunch e2e test pins the common case (leaf on
        // the conversation tail); this pins the branch behavior AS DESIGNED.
        var state = SessionState()
        var tree = entries(cParentOfLast: "tr2")
        tree += [
            .object(["type": .string("message"), "id": .string("na1"), "parentId": .string("tr2"),
                     "message": .object(["role": .string("assistant"), "timestamp": .number(7),
                                         "responseId": .string("nr1"),
                                         "content": .array([.object(["type": .string("toolCall"),
                                                                     "id": .string("ntc1"),
                                                                     "name": .string("read"),
                                                                     "arguments": .object(["path": .string("x")])])])])]),
        ]
        state.applyEntries(tree, leafId: "na1")   // leaf on the nested branch
        XCTAssertFalse(state.items.contains { item in
            if case let .assistant(b) = item { return b.text.contains("post-tool") } else { return false }
        }, "a branch leaf renders the branch path, excluding siblings (the /tree model)")
        // The same tree with the leaf on the prose renders it.
        var stateB = SessionState()
        stateB.applyEntries(tree, leafId: "ec")
        assertPostToolText(stateB.items, "leaf on the prose")
    }
}

extension ReproPostToolTests {
    /// The breaker-derive MONOTONICITY guard (the build-17 regression): a
    /// derive to a leaf BEHIND the current render rewinds the visible
    /// transcript (messages vanish until a restart re-derives from the cache
    /// leaf). isLeafAtOrAhead is the gate: only nil/equal/descendant leaves
    /// (strictly-forward or first paint) may derive.
    func testMonotonicDeriveGuard() {
        var state = SessionState()
        // Nothing rendered yet: any leaf is allowed (first paint).
        XCTAssertTrue(state.isLeafAtOrAhead(ofRender: "ec"), "nil render accepts any leaf")
        state.applyEntries(entries(cParentOfLast: "tr2"), leafId: "ec")
        // Same leaf: allowed (re-derive of the same path is a no-change).
        XCTAssertTrue(state.isLeafAtOrAhead(ofRender: "ec"))
        // BEHIND (an ancestor of the rendered leaf): REFUSED — deriving
        // rewinds the visible path (the build-17 regression case).
        XCTAssertFalse(state.isLeafAtOrAhead(ofRender: "tr2"),
                       "a behind-leaf must be refused (the rewind case)")
        // Unrelated/sibling chain: refused.
        XCTAssertFalse(state.isLeafAtOrAhead(ofRender: "eu"),
                       "an off-chain leaf must be refused")
    }
}

extension ReproPostToolTests {
    /// Mesh agent messages ride custom-role ENTRIES (display:true). The live
    /// message_end path always birthed them, but birthEntry's role switch
    /// fell role:"custom" to `default: break` — after any relaunch, mesh
    /// messages were absent entirely (live-only rows). The replay path now
    /// births them through the same applyRPC funnel, and the notice id is a
    /// DETERMINISTIC content hash so a live birth and its replay dedup via
    /// the appendedIDs guard.
    func testCustomNoticeBirthsOnEntryReplay() {
        // THE REAL SHAPE (from the actual session log): mesh custom messages
        // ride TYPE custom_message with TOP-LEVEL content + display — no
        // message object. An earlier version of this test used a fabricated
        // type:"message"+role:"custom" shape pi never writes and passed
        // against fiction; the live-rendered ping then vanished on relaunch
        // because the real type fell to birthEntry's outer default:break.
        var state = SessionState()
        let ping = JSONValue.object([
            "type": .string("custom_message"),
            "customType": .string("un-bien:mesh-message"),
            "content": .string("**mesh ping** from a peer agent — toucan test token"),
            "display": .bool(true),
            "id": .string("cm1"), "parentId": .string(""),
            "timestamp": .string("2026-10-28T03:00:00Z"),
        ])
        state.applyEntries([ping], leafId: "cm1")
        guard case let .notice(notice)? = state.items.first else {
            return XCTFail("custom_message must birth a notice on entry replay (top-level content/display)")
        }
        XCTAssertEqual(notice.code, "custom")
        XCTAssertTrue(notice.message.contains("mesh ping"),
                      "the notice carries the top-level content (markdown intact)")
        // display:false bookkeeping (name-assigned, relay-state) stays filtered.
        let hidden = JSONValue.object([
            "type": .string("custom_message"),
            "customType": .string("un-bien:name-assigned"),
            "content": .string("Mesh name: tmp.XXXX"),
            "display": .bool(false),
            "id": .string("cm2"), "parentId": .string("cm1"),
            "timestamp": .string("2026-10-28T03:00:01Z"),
        ])
        state.applyEntries([hidden], leafId: "cm2")
        XCTAssertFalse(state.items.contains { item in
            if case let .notice(n) = item { return n.message.contains("mesh name") } else { return false }
        }, "display:false custom_message entries stay filtered")
        // Replay the SAME entry (idempotent: deterministic content-hash id).
        state.applyEntries([ping], leafId: "cm1")
        let count = state.items.filter { if case .notice = $0 { return true } else { return false } }.count
        XCTAssertEqual(count, 1, "same-id replay must not duplicate the notice")
    }
}
