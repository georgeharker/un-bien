import XCTest
@testable import UnBienCore

final class SessionStateTests: XCTestCase {
    // Scroll-memory anchoring (design 01M1B9F6): only replay-stable rows may be
    // persisted as anchors. Streaming assistant bubbles (positional a{n} ids,
    // re-keyed to {identify}-a at settle), reasoning segments (live-only), and
    // notices are transient — anchorID nil. Settled assistant, user, tool rows
    // are stable. Also: a bubble interrupted by a tool card is closed
    // (streaming=false) but KEEPS its positional id — anchorID must stay nil.
    func testAnchorIDExcludesTransientRows() {
        var state = SessionState()
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("user"), "timestamp": .number(1),
                                                    "content": .string("hi")])]))
        state.applyRPC(.object(["type": .string("turn_start")]))
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("text_delta"),
                                                                  "delta": .string("hel")])]))
        // While streaming: positional id, transient — not an anchor.
        XCTAssertEqual(state.items.count, 2)
        // v2: a LIVE-born user row is PENDING (seq synthetic, no entry id yet) —
        // not anchorable until the delta re-keys it to the durable entry id.
        XCTAssertNil(state.items[0].anchorID, "pending live user rows must NOT anchor")
        guard case let .assistant(streaming) = state.items[1] else { return XCTFail("no bubble") }
        XCTAssertTrue(streaming.streaming)
        XCTAssertNil(state.items[1].anchorID, "streaming assistant rows must NOT anchor")

        // Interleaved reasoning CLOSES the text bubble (mid-turn interleaving):
        // streaming=false but the positional id is KEPT — still not an anchor.
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("thinking_delta"),
                                                                  "delta": .string("hm")])]))
        guard case .assistant(let closed) = state.items[1] else { return XCTFail("no bubble") }
        XCTAssertFalse(closed.streaming)
        XCTAssertNil(state.items[1].anchorID,
                     "closed-but-positional bubble must NOT anchor (id is re-keyed only at message_end)")
        guard case .reasoning = state.items[2] else { return XCTFail("no reasoning row") }
        XCTAssertNil(state.items[2].anchorID, "reasoning rows must NOT anchor")

        // A tool card is stable (toolCallID-keyed) and anchors.
        state.applyRPC(.object(["type": .string("tool_execution_start"), "toolCallId": .string("tc1"),
                                "toolName": .string("bash"), "args": .object([:])]))
        XCTAssertNotNil(state.items[3].anchorID, "tool cards anchor")

        // Settle (live message_end with responseId): v2 births the row with the
        // identify FALLBACK id and registers it PENDING (the open bubble was
        // closed by the interleaved reasoning) — still transient, not anchorable.
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("assistant"), "timestamp": .number(2),
                                                    "responseId": .string("resp_1"),
                                                    "content": .array([.object(["type": .string("text"),
                                                                                "text": .string("hello")])])])]))
        XCTAssertEqual(state.items[4].id, "assistant:rresp_1-a")
        XCTAssertNil(state.items[4].anchorID, "pending live settle must NOT anchor")

        // Settle the turn FIRST (Stage 0 mid-turn deferral: a beacon under an
        // active turn parks until agent_settled — the real cadence re-keys by
        // settle, never under the in-flight stream).
        state.applyRPC(.object(["type": .string("agent_settled")]))

        // The message_end-triggered delta lands (applyEntries MATCH LOOP): both
        // pending rows re-key to their durable ENTRY ids — NOW anchorable.
        state.applyEntries([
            .object(["type": .string("message"), "id": .string("eu1"), "parentId": .string(""),
                     "message": .object(["role": .string("user"), "timestamp": .number(1),
                                         "content": .string("hi")])]),
            .object(["type": .string("message"), "id": .string("ea1"), "parentId": .string("eu1"),
                     "message": .object(["role": .string("assistant"), "timestamp": .number(2),
                                         "responseId": .string("resp_1"),
                                         "content": .array([.object(["type": .string("text"),
                                                                     "text": .string("hello")])])])]),
        ], leafId: "ea1")
        XCTAssertEqual(state.items[0].id, "user:eu1")
        XCTAssertEqual(state.items[0].anchorID, "user:eu1", "re-keyed rows anchor on their entry id")
        XCTAssertEqual(state.items[4].id, "assistant:ea1")
        XCTAssertEqual(state.items[4].anchorID, "assistant:ea1")
    }

    // liveArrivals (scroll follow counter) must count only VISIBLE mutations —
    // "the turn is running" is not "something was output". A quiet thinking
    // phase streams thinking_delta frames; when thinking is hidden they must
    // bump NOTHING, else each phantom follow re-pins the bottom sentinel inside
    // the 150 ms unpin debounce and the reader is LOCKED at the bottom for the
    // whole "…" phase (user report 2026-09-17).
    func testLiveArrivalsCountsOnlyVisibleMutations() {
        var state = SessionState()

        // turn_start is liveness, not output.
        state.applyRPC(.object(["type": .string("turn_start")]))
        XCTAssertEqual(state.liveArrivals, 0)

        // Hidden thinking delta: still folds (the pref can flip back) but is NOT
        // counted.
        state.hideReasoning = true
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("thinking_delta"),
                                                                  "delta": .string("hm")])]))
        XCTAssertEqual(state.liveArrivals, 0)
        guard let last = state.items.last, case .reasoning = last else {
            return XCTFail("hidden reasoning row must still fold")
        }

        // Visible thinking delta: counted.
        state.hideReasoning = false
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("thinking_delta"),
                                                                  "delta": .string("hm2")])]))
        XCTAssertEqual(state.liveArrivals, 1)

        // Text delta: counted.
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("text_delta"),
                                                                  "delta": .string("hi")])]))
        XCTAssertEqual(state.liveArrivals, 2)

        // toolcall_* lifecycle event: no row, no count.
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("toolcall_start"),
                                                                  "id": .string("tc9"),
                                                                  "toolName": .string("bash")])]))
        XCTAssertEqual(state.liveArrivals, 2)

        // toolResult message_end: no row (cards fill via tool_execution_*) — no count.
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("toolResult"),
                                                    "toolCallId": .string("tc9"),
                                                    "content": .array([])])]))
        XCTAssertEqual(state.liveArrivals, 2)

        // User row inserted: counted. Replayed (dedup no-op) user message: NOT.
        let user: JSONValue = .object(["type": .string("message_end"),
                                       "message": .object(["role": .string("user"), "timestamp": .number(1),
                                                           "content": .string("hello")])])
        state.applyRPC(user)
        XCTAssertEqual(state.liveArrivals, 3)
        state.applyRPC(user)
        XCTAssertEqual(state.liveArrivals, 3)

        // Tool card: NEW open counted; unknown-id end NOT (replay straggler);
        // known-id end counted; idempotent re-open NOT; partial-less update NOT.
        state.applyRPC(.object(["type": .string("tool_execution_start"), "toolCallId": .string("tc1"),
                                "toolName": .string("bash"), "args": .object([:])]))
        XCTAssertEqual(state.liveArrivals, 4)
        state.applyRPC(.object(["type": .string("tool_execution_end"), "toolCallId": .string("tc-x"),
                                "result": .string("ok")]))
        XCTAssertEqual(state.liveArrivals, 4)
        state.applyRPC(.object(["type": .string("tool_execution_end"), "toolCallId": .string("tc1"),
                                "result": .string("ok")]))
        XCTAssertEqual(state.liveArrivals, 5)
        state.applyRPC(.object(["type": .string("tool_execution_start"), "toolCallId": .string("tc1"),
                                "toolName": .string("bash"), "args": .object([:])]))
        XCTAssertEqual(state.liveArrivals, 5)
        state.applyRPC(.object(["type": .string("tool_execution_update"), "toolCallId": .string("tc1")]))
        XCTAssertEqual(state.liveArrivals, 5)
    }

    // The capture walk (design 01M1B9F6): given the bottom-most visible row's
    // index, anchor to the nearest replay-stable row at-or-above.
    func testStableAnchorAtOrAboveWalksToNearestStableRow() {
        var state = SessionState()
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("user"), "timestamp": .number(1),
                                                    "content": .string("hi")])]))
        state.applyRPC(.object(["type": .string("turn_start")]))
        state.applyRPC(.object(["type": .string("message_update"),
                                "assistantMessageEvent": .object(["type": .string("text_delta"),
                                                                  "delta": .string("run")])]))
        state.applyRPC(.object(["type": .string("tool_execution_start"), "toolCallId": .string("tc1"),
                                "toolName": .string("bash"), "args": .object([:])]))
        XCTAssertEqual(state.items.count, 3, "user, streaming bubble, tool card")
        let items = state.items
        // Bottom-most visible is the transient streaming row → walks UP to the user row.
        XCTAssertEqual(items.stableAnchor(atOrAbove: 1), items[0].anchorID)
        // Bottom-most is the tool card → anchors to itself.
        XCTAssertEqual(items.stableAnchor(atOrAbove: 2), items[2].anchorID)
        // Out of range → nil.
        XCTAssertNil(items.stableAnchor(atOrAbove: -1))
        XCTAssertNil(items.stableAnchor(atOrAbove: 99))
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
        func entry(role: String, text: String, ts: Double, responseId: String? = nil,
                        parent: String = "") -> JSONValue {
            var msg: [String: JSONValue] = [
                "role": .string(role),
                "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
                "timestamp": .number(ts),
            ]
            if let rid = responseId { msg["responseId"] = .string(rid) }
            return .object(["type": .string("message"), "id": .string("entry-\(ts)"),
                            "parentId": .string(parent),
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
        // entries carrying their durable ids. The MATCH LOOP finds the live
        // PENDING rows (identify bridge) and RE-KEYS them to the entry ids:
        // same rows, same content, upgraded ids — never duplicates.
        state.applyEntries([
            entry(role: "user", text: "hi", ts: 100),
            entry(role: "assistant", text: "hello", ts: 200, responseId: "resp_1",
                  parent: "entry-100.0"),
        ], leafId: "entry-200.0")
        XCTAssertEqual(state.items.count, 2, "match-loop re-key must not duplicate rows")
        XCTAssertEqual(state.items.map(\.id), ["user:entry-100.0", "assistant:entry-200.0"],
                       "pending live rows re-key to their durable entry ids")
        XCTAssertEqual(state.items.map(\.anchorID),
                       ["user:entry-100.0", "assistant:entry-200.0"],
                       "re-keyed rows are anchorable (id-scheme v2)")
    }

    // FULL-WALK RESET (ordering fix): live rows folded into a FRESH reducer
    // before a full walk (app relaunch mid-conversation) used to strand the
    // newest exchange at the TOP — the walk appended history AFTER them. The
    // walk's first page now resets, and the rebuild lands in LOG order.
    func testFullWalkResetRebuildsInLogOrder() {
        var state = SessionState()
        // The misplaced scenario: live tail folded first (fresh reducer).
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("user"), "timestamp": .number(300),
                                                    "content": .string("newest")])]))
        XCTAssertEqual(state.items.map(\.id), ["user:u1"], "live birth is a pending seq synthetic")
        // The walk's first page arrives → reset → entries fold in log order.
        state.resetTranscript()
        state.applyEntries([
            .object(["type": .string("message"), "id": .string("e1"), "parentId": .string(""),
                     "message": .object(["role": .string("user"), "timestamp": .number(100),
                                         "content": .string("oldest")])]),
            .object(["type": .string("message"), "id": .string("e2"), "parentId": .string("e1"),
                     "message": .object(["role": .string("user"), "timestamp": .number(300),
                                         "content": .string("newest")])]),
        ], leafId: "e2")
        XCTAssertEqual(state.items.map(\.id), ["user:e1", "user:e2"],
                       "post-reset walk rebuilds in LOG order, newest last")
    }

    // ARRIVAL ORDER ≠ LOG ORDER (ordering tightening, user report 2026-09-17):
    // a fresh entry birth whose live frame was never seen (reconnect gap,
    // delta lag) is OLDER than any pending row — it must INSERT BEFORE the live
    // tail, never append after a newer pending. And a matched re-key keeps its
    // position (the folded region grows contiguously through the tail's head).
    func testLateEntryBirthInsertsBeforeLiveTail() {
        var state = SessionState()
        // A pending live row (settled, entry not yet folded) sits in the tail.
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("user"), "timestamp": .number(500),
                                                    "content": .string("newest live")])]))
        XCTAssertEqual(state.items.map(\.id), ["user:u1"])

        // A delta arrives carrying an OLDER gap entry (its live frame was never
        // seen) PLUS the pending's own entry, in log order — the exact shape a
        // reconnect gap produces. The gap entry must insert BEFORE the pending;
        // the pending's entry must MATCH + re-key it in place (after the gap).
        state.applyEntries([
            .object(["type": .string("message"), "id": .string("e-old"), "parentId": .string(""),
                     "message": .object(["role": .string("user"), "timestamp": .number(100),
                                         "content": .string("older gap")])]),
            .object(["type": .string("message"), "id": .string("e-new"), "parentId": .string("e-old"),
                     "message": .object(["role": .string("user"), "timestamp": .number(500),
                                         "content": .string("newest live")])]),
        ], leafId: "e-new")
        XCTAssertEqual(state.items.map(\.id), ["user:e-old", "user:e-new"],
                       "older gap entry inserts before the pending; the pending re-keys in place after it — log order, not arrival order")
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
            .object(["type": .string("message"), "id": .string("e1"), "parentId": .string(""),
                     "message": .object(["role": .string("user"), "timestamp": .number(1),
                                         "content": .string("list files")])]),
            .object(["type": .string("message"), "id": .string("e2"), "parentId": .string("e1"),
                     "message": asstMsg]),
            .object(["type": .string("message"), "id": .string("e3"), "parentId": .string("e2"),
                     "message": .object(["role": .string("toolResult"), "timestamp": .number(2),
                                         "toolCallId": .string("tc1"), "isError": .bool(false),
                                         "content": .string("a\nb")])]),
        ], leafId: "e3")
        // user bubble, assistant bubble, filled tool card.
        XCTAssertEqual(state.items.count, 3)
        guard case let .tool(card) = state.items[2] else { return XCTFail("no tool card") }
        XCTAssertEqual(card.state, .ok)
        XCTAssertEqual(card.tool, "bash")
    }

    // The ended flag is RETRACTABLE: a pi session can be RESUMED (the fresh
    // extension instance re-joins the same room under the durable session id),
    // so a live `turn_start` (live-ONLY — replays never synthesize it) and an
    // explicit `markResumed()` (room re-advertise / hello) both clear it, while
    // a get_entries backfill of an ENDED session's history must NOT.
    func testEndedRetractsOnResumeSignals() {
        var state = SessionState()
        XCTAssertFalse(state.ended)

        state.applyRPC(.object(["type": .string("session_shutdown")]))
        XCTAssertTrue(state.ended)

        // Backfill of the ended session's history: replay frames only — the
        // session is still dead, we're just refetching the entry log.
        state.applyEntries([
            .object(["type": .string("message"), "id": .string("e1"), "parentId": .string(""),
                     "message": .object(["role": .string("user"), "timestamp": .number(1),
                                         "content": .string("hi")])]),
        ], leafId: "e1")
        XCTAssertTrue(state.ended, "get_entries backfill must not retract ended")

        // A live turn: the session is running again — banner drops.
        state.applyRPC(.object(["type": .string("turn_start")]))
        XCTAssertFalse(state.ended, "a live turn_start retracts ended")

        // It can end again, and the explicit retraction (room re-advertise /
        // hello on resume) clears it once more.
        state.applyRPC(.object(["type": .string("session_shutdown")]))
        XCTAssertTrue(state.ended)
        state.markResumed()
        XCTAssertFalse(state.ended, "markResumed retracts ended")
    }

    // appendNotice (app-side routing of extension_ui WARNING notifies): a
    // notice row lands inline in the transcript — actionable but never modal.
    func testAppendNoticeAddsInlineRow() {
        var state = SessionState()
        state.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("user"), "timestamp": .number(1),
                                                    "content": .string("hi")])]))
        state.appendNotice(code: "ask_warning", message: "Clarification expired on the bridge")
        state.appendNotice(code: "ask_warning", message: "Answer was not accepted")
        XCTAssertEqual(state.items.count, 3, "user bubble + two notice rows")
        let notices = state.items.compactMap { item -> NoticeItem? in
            if case let .notice(n) = item { return n } else { return nil }
        }
        XCTAssertEqual(notices.map(\.code), ["ask_warning", "ask_warning"])
        XCTAssertEqual(notices.map(\.message),
                       ["Clarification expired on the bridge", "Answer was not accepted"])
        XCTAssertEqual(Set(notices.map(\.id)).count, 2, "notice ids must be unique (ForEach)")
    }

    // Custom-role messages flagged display:false (un-bien's own bookkeeping:
    // mesh name assignment, relay state, auto-update) must NOT surface as
    // transcript notices; display-absent custom messages still render.
    func testDisplayFalseCustomMessagesAreSuppressed() {
        var state = SessionState()
        func customFrame(content: String, display: Bool?) -> JSONValue {
            var msg: [String: JSONValue] = ["role": .string("custom"), "content": .string(content)]
            if let display { msg["display"] = .bool(display) }
            return .object(["type": .string("message_end"), "message": .object(msg)])
        }
        // Suppressed: explicitly hidden bookkeeping.
        state.applyRPC(customFrame(content: "Mesh name: tmp.XXXXXX", display: false))
        state.applyRPC(customFrame(content: "Relay connected", display: false))
        // Rendered: display absent (display-intended).
        state.applyRPC(customFrame(content: "Deploy finished", display: nil))
        // Rendered: display explicitly true.
        state.applyRPC(customFrame(content: "Task complete", display: true))
        let notices = state.items.compactMap { item -> NoticeItem? in
            if case let .notice(n) = item { return n } else { return nil }
        }
        XCTAssertEqual(notices.map(\.message), ["Deploy finished", "Task complete"],
                       "display:false custom messages must be suppressed; absent/true render")
    }

    // REGRESSION (the "text arrives as sentence-fragment bubbles" corruption):
    // a get_entries refetch on relay reconnect lands MID-STREAM while an
    // assistant bubble is open. Replayed rows append below it — the walk must
    // NOT close the open bubble (else the next live delta mints a NEW bubble,
    // fragmenting one message into fractions) and must NOT re-key it (a
    // replayed settled message_end must not steal the live bubble's identity).
    func testMidStreamGetEntriesRefetchDoesNotFragmentOpenBubble() {
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
        func entry(role: String, text: String, ts: Double, responseId: String? = nil,
                        parent: String = "") -> JSONValue {
            var msg: [String: JSONValue] = [
                "role": .string(role),
                "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
                "timestamp": .number(ts),
            ]
            if let rid = responseId { msg["responseId"] = .string(rid) }
            return .object(["type": .string("message"), "id": .string("entry-\(ts)"),
                            "parentId": .string(parent),
                            "message": .object(msg)])
        }

        // History: one settled turn.
        state.applyRPC(endFrame(role: "user", text: "first", ts: 100))
        state.applyRPC(simple("turn_start"))
        state.applyRPC(delta("ear"))
        state.applyRPC(endFrame(role: "assistant", text: "earlier", ts: 200, responseId: "resp_1"))
        state.applyRPC(simple("agent_settled"))

        // LIVE: a second turn starts streaming.
        state.applyRPC(endFrame(role: "user", text: "second", ts: 300))
        state.applyRPC(simple("turn_start"))
        state.applyRPC(delta("streaming "))
        state.applyRPC(delta("mid-message"))

        // RECONNECT: a get_entries refetch replays the log (the settled first
        // turn + the user's second message — the in-flight assistant text is
        // NOT in the log yet). All dedup except the second user row, which
        // appends BELOW the open bubble — the open bubble must survive intact.
        state.applyEntries([
            entry(role: "user", text: "first", ts: 100),
            entry(role: "assistant", text: "earlier", ts: 200, responseId: "resp_1",
                  parent: "entry-100.0"),
        ], leafId: "entry-200.0")

        // The stream continues after the reconnect.
        state.applyRPC(delta(", and more"))
        state.applyRPC(delta(" text arrives"))

        // ONE assistant bubble for the second turn, full text, still streaming.
        let assistantBubbles = state.items.filter {
            if case .assistant = $0 { return true } else { return false }
        }
        XCTAssertEqual(assistantBubbles.count, 2,
                       "two turns = two assistant bubbles; the live one must not fragment")
        if case let .assistant(live)? = state.items.last(where: {
            if case .assistant = $0 { return true } else { return false }
        }) {
            XCTAssertEqual(live.text, "streaming mid-message, and more text arrives")
            XCTAssertTrue(live.streaming, "the live bubble stays open across the refetch")
        } else {
            XCTFail("expected an open assistant bubble")
        }
    }
}

// MARK: - Entry-born provider errors ride log position (run 2026-09-17:
// historical out-of-credit errors floated below the live tail on every
// reconnect delta walk)

final class EntryBornErrorNoticeTests: XCTestCase {
    /// A replayed error entry, folded while a LIVE pending tail exists, must
    /// land in the HISTORY region (before the live tail) — not at the end.
    func testEntryBornErrorInsertsBeforeLiveTail() {
        var s = SessionState()
        // History: one settled user row.
        _ = s.applyRPC(.object([
            "type": .string("message_end"),
            "message": .object(["role": .string("user"), "content": .string("hi")]),
            "entryId": .string("e1"),
        ]))
        // LIVE pending tail: a live-born user row (no entryId ⇒ pending).
        _ = s.applyRPC(.object([
            "type": .string("message_end"),
            "message": .object(["role": .string("user"), "content": .string("live question")]),
        ]))
        // A replayed provider-error entry (entryId present ⇒ entry-born).
        _ = s.applyRPC(.object([
            "type": .string("message_end"),
            "message": .object(["role": .string("assistant"),
                                "stopReason": .string("error"),
                                "errorMessage": .string("out of credit")]),
            "entryId": .string("e99"),
        ]))
        // The error notice must sit BEFORE the live pending row, not after it.
        let ids = s.items.map(\.id)
        let liveIdx = ids.firstIndex(of: "user:u1")   // live pending (second user row)
        let errorIdx = s.items.lastIndex { if case .notice = $0 { return true } else { return false } }
        XCTAssertNotNil(liveIdx)
        XCTAssertNotNil(errorIdx)
        if let live = liveIdx, let error = errorIdx {
            XCTAssertLessThan(error, live,
                "entry-born error must insert before the live tail (history region)")
        }
    }

    /// A LIVE error and its later ENTRY replay are the same row (content-identity
    /// id collision dedup) — no duplicate.
    func testLiveErrorAndEntryReplayDedup() {
        var s = SessionState()
        let errorMsg: JSONValue = .object(["role": .string("assistant"),
                                           "stopReason": .string("error"),
                                           "errorMessage": .string("out of credit")])
        _ = s.applyRPC(.object(["type": .string("message_end"), "message": errorMsg]))
        _ = s.applyRPC(.object(["type": .string("message_end"), "message": errorMsg,
                                "entryId": .string("e1")]))
        let noticeCount = s.items.filter { if case .notice = $0 { return true } else { return false } }.count
        XCTAssertEqual(noticeCount, 1, "live error + entry replay = one row")
    }

    /// Two DIFFERENT errors stay two rows.
    func testDistinctErrorsBothBirth() {
        var s = SessionState()
        _ = s.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("assistant"),
                                                    "stopReason": .string("error"),
                                                    "errorMessage": .string("out of credit")]),
                                "entryId": .string("e1")]))
        _ = s.applyRPC(.object(["type": .string("message_end"),
                                "message": .object(["role": .string("assistant"),
                                                    "stopReason": .string("error"),
                                                    "errorMessage": .string("rate limited")]),
                                "entryId": .string("e2")]))
        let noticeCount = s.items.filter { if case .notice = $0 { return true } else { return false } }.count
        XCTAssertEqual(noticeCount, 2)
    }
    /// REGRESSION (run 2026-09-18: "stream ended without finish"): a beacon
    /// arriving MID-TURN must NOT reset the in-flight rows — the re-path
    /// defers to the settle point (agent_settled), which replays including
    /// the finished turn's entries. The replay invariant: nothing disturbs
    /// live-stream continuation state.
    func testMidTurnBeaconDefersRepath() {
        var state = SessionState()
        state.applyEntries([
            .object(["type": .string("message"), "id": .string("a1"), "parentId": .string(""),
                     "message": .object(["role": .string("user"), "timestamp": .number(1),
                                         "content": .string("start")])]),
            .object(["type": .string("message"), "id": .string("b1"), "parentId": .string("a1"),
                     "message": .object(["role": .string("assistant"), "timestamp": .number(2),
                                         "responseId": .string("r1"),
                                         "content": .array([.object(["type": .string("text"),
                                                                     "text": .string("answer")])])])]),
        ], leafId: "b1")
        XCTAssertEqual(state.items.count, 2)

        // A turn streams (turn_start sets the active turn).
        state.applyRPC(.object(["type": .string("turn_start")]))

        // MID-TURN: the branch entry indexes (a page fold — no beacon), then
        // the beacon leaf arrives. The re-path MUST DEFER — no reset under
        // the in-flight turn.
        state.applyEntries([
            .object(["type": .string("message"), "id": .string("c1"), "parentId": .string("b1"),
                     "message": .object(["role": .string("user"), "timestamp": .number(3),
                                         "content": .string("branched")])]),
        ])
        state.applyEntries([], leafId: "c1")
        XCTAssertEqual(state.items.count, 2, "mid-turn beacon must NOT reset the rows")

        // Settle: the deferred re-path applies — the new path renders, and
        // (run 2026-09-18, the branch marker) a trailing notice lands at the
        // branch point: 3 rows + the notice.
        state.applyRPC(.object(["type": .string("agent_settled")]))
        XCTAssertEqual(state.items.count, 4, "settle applies the parked re-path + the branch notice")
        XCTAssertEqual(state.items.map(\.id).dropLast().last, "user:c1")
        guard case let .notice(notice) = state.items.last else {
            return XCTFail("expected the trailing branch notice")
        }
        XCTAssertEqual(notice.code, "branch")
    }
}
