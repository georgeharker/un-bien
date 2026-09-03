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

    private func notices(_ state: SessionState) -> [NoticeItem] {
        state.items.compactMap { if case let .notice(n) = $0 { return n } else { return nil } }
    }

    /// Command acks ride the envelope now: `action_error` surfaces a transcript
    /// notice ("<action> failed: <error>"), `action_ok` is silent, and an
    /// enveloped `error` (e.g. malformed models.json) surfaces a notice too.
    func testEnvelopedAcksSurfaceNotices() throws {
        let lines = [
            #"{"rpc":{"type":"action_ok","in_reply_to":"r1","action":"session_new"}}"#,
            #"{"rpc":{"type":"action_error","in_reply_to":"r2","action":"model_set","error":"no auth configured"}}"#,
            #"{"rpc":{"type":"error","in_reply_to":"r3","code":"internal_error","message":"models.json malformed"}}"#,
        ]
        let decoder = JSONDecoder()
        let messages = try lines.map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        let noticeRows = notices(reducer.session)
        // action_ok is silent; only action_error + error produce notices.
        XCTAssertEqual(noticeRows.count, 2)
        XCTAssertEqual(noticeRows[0].code, "action_error")
        XCTAssertEqual(noticeRows[0].message, "model_set failed: no auth configured")
        XCTAssertEqual(noticeRows[1].code, "internal_error")
        XCTAssertEqual(noticeRows[1].message, "models.json malformed")
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

    /// Images ride the rpc plane: assistant `message_end` content image blocks
    /// attach to the bubble; `tool_execution_end` result images attach to the card.
    func testImagesFromRPC() throws {
        let lines = [
            #"{"rpc":{"type":"turn_start"}}"#,
            #"{"rpc":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"here"}}}"#,
            #"{"rpc":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"here"},{"type":"image","data":"AAAA","mimeType":"image/png"}]}}}"#,
            #"{"rpc":{"type":"tool_execution_start","toolCallId":"tc1","toolName":"screenshot","args":{}}}"#,
            #"{"rpc":{"type":"tool_execution_end","toolCallId":"tc1","isError":false,"result":{"content":[{"type":"image","data":"BBBB","mimeType":"image/jpeg"}]}}}"#,
            #"{"rpc":{"type":"agent_settled"}}"#,
        ]
        let decoder = JSONDecoder()
        let messages = try lines.map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        // assistant bubble carries the inline image (attached on message_end).
        let assistantImages = reducer.session.items.compactMap { item -> [WireImage]? in
            if case let .assistant(bubble) = item { return bubble.images } else { return nil }
        }.flatMap { $0 }
        XCTAssertEqual(assistantImages, [WireImage(data: "AAAA", mime: "image/png")])

        // tool card carries the result image.
        let card = try XCTUnwrap(toolCards(reducer.session).first)
        XCTAssertEqual(card.tool, "screenshot")
        XCTAssertEqual(card.state, .ok)
        XCTAssertEqual(card.images, [WireImage(data: "BBBB", mime: "image/jpeg")])
    }

    /// OUTPUT enrichment is app-side (design 01M177AF): the reducer classifies
    /// the raw `tool_execution_end` result into `card.output` — no wire aux.
    /// An edit result that IS a unified diff becomes a `diff` block; the raw
    /// rpc.result stays untouched on the card.
    func testEditResultClassifiedToDiffBlock() throws {
        let lines = [
            #"{"rpc":{"type":"tool_execution_start","toolCallId":"tc9","toolName":"edit","args":{}}}"#,
            #"{"rpc":{"type":"tool_execution_end","toolCallId":"tc9","toolName":"edit","isError":false,"result":"@@ -1 +1 @@\n-a\n+b"}}"#,
        ]
        let decoder = JSONDecoder()
        let messages = try lines.map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        let card = try XCTUnwrap(toolCards(reducer.session).first)
        XCTAssertEqual(card.tool, "edit")
        XCTAssertEqual(card.output?["v"]?.intValue, 1)
        let blocks = try XCTUnwrap(card.output?["blocks"]?.arrayValue)
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks[0]["kind"]?.stringValue, "diff")
        XCTAssertEqual(card.result?.stringValue, "@@ -1 +1 @@\n-a\n+b")   // raw untouched
    }

    /// A read result is classified into a `code` block, with `lang` inferred
    /// from the tool's `args.path` extension. Raw rpc.result stays untouched.
    func testReadResultClassifiedToCodeBlock() throws {
        let lines = [
            #"{"rpc":{"type":"tool_execution_start","toolCallId":"tc7","toolName":"read","args":{"path":"/a/Foo.swift"}}}"#,
            #"{"rpc":{"type":"tool_execution_end","toolCallId":"tc7","toolName":"read","isError":false,"result":"let x = 1"}}"#,
        ]
        let decoder = JSONDecoder()
        let messages = try lines.map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        let card = try XCTUnwrap(toolCards(reducer.session).first)
        let blocks = try XCTUnwrap(card.output?["blocks"]?.arrayValue)
        XCTAssertEqual(blocks[0]["kind"]?.stringValue, "code")
        XCTAssertEqual(blocks[0]["text"]?.stringValue, "let x = 1")
        XCTAssertEqual(blocks[0]["lang"]?.stringValue, "swift")
        XCTAssertEqual(card.result?.stringValue, "let x = 1")
    }

    /// The whole point of moving classification app-side: a `get_entries` REPLAY
    /// (no wire aux at all) still enriches tool output. The reducer synthesizes
    /// tool_execution_end from the toolResult entry → fillToolCard → classify.
    func testGetEntriesReplayEnrichesOutput() throws {
        // Stage 0: entries carry id+parentId (pi's real shape); a completing
        // page is a TRUSTED beacon only when the leaf is not the final entry —
        // so the fixture ends with an off-path model_change after the leaf.
        let assistant = #"{"type":"message","id":"e1","parentId":"","message":{"role":"assistant","content":[{"type":"toolCall","id":"tcR","name":"edit","arguments":{}}]}}"#
        let toolResult = #"{"type":"message","id":"e2","parentId":"e1","message":{"role":"toolResult","toolCallId":"tcR","content":"@@ -1 +1 @@\n-x\n+y","isError":false}}"#
        let trailing = #"{"type":"model_change","id":"e3","parentId":"e2"}"#
        let line = #"{"rpc":{"type":"response","command":"get_entries","data":{"entries":["# + assistant + "," + toolResult + "," + trailing + #"],"leafId":"e2"}}}"#
        let msg = try JSONDecoder().decode(EnvelopeMessage.self, from: Data(line.utf8))
        var reducer = EnvelopeReducer()
        reducer.apply(msg)

        let card = try XCTUnwrap(toolCards(reducer.session).first)
        XCTAssertEqual(card.tool, "edit")
        let blocks = try XCTUnwrap(card.output?["blocks"]?.arrayValue)
        XCTAssertEqual(blocks[0]["kind"]?.stringValue, "diff")
        XCTAssertEqual(reducer.leafId, "e2")
    }

    /// appendNotice forwards to the session (app-side routing of extension_ui
    /// WARNING notifies folds through the reducer so the row persists like any
    /// other notice — AppModel+Inbound calls this, never SessionState directly).
    func testAppendNoticeForwardsToSession() {
        var reducer = EnvelopeReducer()
        reducer.appendNotice(code: "ask_warning", message: "Answer was not accepted")
        let notices = reducer.session.items.compactMap { item -> NoticeItem? in
            if case let .notice(n) = item { return n } else { return nil }
        }
        XCTAssertEqual(notices.count, 1)
        XCTAssertEqual(notices[0].code, "ask_warning")
        XCTAssertEqual(notices[0].message, "Answer was not accepted")
    }
    /// LIVE aux sidecar (run 2026-09-18, "never see the sidecar even live"):
    /// a tool_execution_start envelope carrying `aux.hunks` must land the
    /// pre-rendered Edit diff on the card — the whole app fold chain
    /// (decode → apply(env) → applyRpc(aux:) → card.hunks) in one test.
    func testLiveAuxHunksAttachToToolCard() throws {
        let lines = [
            #"{"rpc":{"type":"tool_execution_start","toolCallId":"tcA","toolName":"edit","# +
                #" "args":{"path":"a.swift","edits":[{"oldText":"x","newText":"y"}]}},"# +
                #" "aux":{"hunks":[{"lines":[{"kind":"remove","oldLine":1,"text":"x"},"# +
                #" {"kind":"add","newLine":1,"text":"y"}]}]}}"#,
        ]
        let decoder = JSONDecoder()
        let messages = try lines.map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
        var reducer = EnvelopeReducer()
        reducer.apply(messages)

        let card = try XCTUnwrap(toolCards(reducer.session).first)
        XCTAssertEqual(card.hunks?.count, 1, "live aux.hunks must attach to the card")
        let hunkLines = try XCTUnwrap(card.hunks?.first?["lines"]?.arrayValue)
        XCTAssertEqual(hunkLines.count, 2)
        XCTAssertEqual(hunkLines[0]["kind"]?.stringValue, "remove")
        XCTAssertEqual(hunkLines[1]["kind"]?.stringValue, "add")
    }
    /// REGRESSION (run 2026-09-18 — "never see the sidecar even live"): the
    /// message_end refetch folds the assistant's entry seconds after the live
    /// frame, rebirthing its tool calls fromEntry. The idempotent re-open used
    /// to REPLACE the card — stripping the live-attached aux.hunks (and result
    /// / output). The rebirth must preserve them.
    func testEntryRebirthPreservesLiveHunks() throws {
        let lines = [
            #"{"rpc":{"type":"tool_execution_start","toolCallId":"tcR","toolName":"edit","# +
                #" "args":{"path":"a.swift","edits":[{"oldText":"x","newText":"y"}]}},"# +
                #" "aux":{"hunks":[{"lines":[{"kind":"remove","oldLine":1,"text":"x"},"# +
                #" {"kind":"add","newLine":1,"text":"y"}]}]}}"#,
            #"{"rpc":{"type":"tool_execution_end","toolCallId":"tcR","toolName":"edit","isError":false,"result":"ok"}}"#,
        ]
        // The entry fold: the assistant message carrying the same toolCall
        // block (as get_entries / the message_end refetch delivers it).
        let entry = #"{"type":"message","id":"e1","message":{"role":"assistant","# +
            #" "content":[{"type":"toolCall","id":"tcR","name":"edit","# +
            #" "arguments":{"path":"a.swift","edits":[{"oldText":"x","newText":"y"}]}}]}}"#
        let decoder = JSONDecoder()
        var messages = try lines.map { try decoder.decode(EnvelopeMessage.self, from: Data($0.utf8)) }
        let entries = [try decoder.decode(JSONValue.self, from: Data(entry.utf8))]

        var reducer = EnvelopeReducer()
        reducer.apply(messages)
        let liveCard = try XCTUnwrap(toolCards(reducer.session).first)
        XCTAssertEqual(liveCard.hunks?.count, 1, "live aux.hunks attached")

        var replay = reducer
        replay.applyEntries(entries, leafId: "e1")
        let rebornCard = try XCTUnwrap(toolCards(replay.session).first)
        XCTAssertEqual(rebornCard.hunks?.count, 1, "entry rebirth must NOT strip live hunks")
        XCTAssertEqual(rebornCard.hunks?.first?["lines"]?.arrayValue?.count, 2)
        XCTAssertEqual(rebornCard.result?.stringValue, "ok", "result survives the rebirth")
    }
    // MARK: - Stage 0 — branch-aware fold (design 01M1FTV2)

    /// pi entries: {type:"message", id, parentId, message:{role, content}}.
    /// Tree fixture: a1 ← b1, then a BRANCH: c1 (original continuation —
    /// abandoned) and d1 (the fork — the ACTIVE path). The log interleaves
    /// both in append order; the fold must render the active path only.
    private static func msgEntry(_ id: String, parent: String, role: String, text: String) -> JSONValue {
        .object([
            "type": .string("message"),
            "id": .string(id),
            "parentId": .string(parent),
            "timestamp": .number(1),
            "message": .object(["role": .string(role),
                                "content": .array([.object(["type": .string("text"), "text": .string(text)])])]),
        ])
    }

    private static func branchyLog() -> [JSONValue] {
        [
            msgEntry("a1", parent: "", role: "user", text: "start"),
            msgEntry("b1", parent: "a1", role: "assistant", text: "answer"),
            msgEntry("c1", parent: "b1", role: "user", text: "original continuation (abandoned)"),
            msgEntry("c2", parent: "c1", role: "assistant", text: "abandoned answer"),
            msgEntry("d1", parent: "b1", role: "user", text: "forked continuation (active)"),
            msgEntry("d2", parent: "d1", role: "assistant", text: "active answer"),
        ]
    }

    func testBranchyBackfillFoldsActivePathOnly() throws {
        var reducer = EnvelopeReducer()
        reducer.applyEntries(Self.branchyLog(), leafId: "d2")
        let texts = reducer.session.items.compactMap { item -> String? in
            if case let .user(b) = item { return b.text }
            if case let .assistant(b) = item { return b.text }
            return nil
        }
        XCTAssertEqual(texts, ["start", "answer", "forked continuation (active)", "active answer"],
                       "the abandoned branch must NOT render")
    }

    func testPreDerivationPagesRenderNothing() throws {
        // The pull-then-backwalk contract: a page whose leafId equals its
        // final entry's id (partial-page cursor OR the completing corner
        // where the active leaf IS the last entry) is NOT a beacon — indexed,
        // retained, NOTHING rendered. The empty walk terminal is the
        // unambiguous beacon, and it resolves exactly that corner.
        var reducer = EnvelopeReducer()
        let decoder = JSONDecoder()
        let page = #"{"rpc":{"type":"response","command":"get_entries","success":true,"id":"r1","# +
            #" "data":{"entries":[{"type":"message","id":"a1","parentId":"","# +
            #" "message":{"role":"user","content":[{"type":"text","text":"start"}]}},"# +
            #" {"type":"message","id":"d1","parentId":"a1","# +
            #" "message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}],"# +
            #" "leafId":"d1"}}}"#
        reducer.apply(try decoder.decode(EnvelopeMessage.self, from: Data(page.utf8)))
        XCTAssertTrue(reducer.session.items.isEmpty,
                      "leafId == final entry id: not a beacon — nothing renders yet")

        let terminal = #"{"rpc":{"type":"response","command":"get_entries","success":true,"id":"r2","# +
            #" "data":{"entries":[],"leafId":"d1"}}}"#
        reducer.apply(try decoder.decode(EnvelopeMessage.self, from: Data(terminal.utf8)))
        XCTAssertEqual(reducer.session.items.count, 2,
                       "the empty terminal beacons — the held entries render")
    }

    func testLeafMoveBeaconReDerives() throws {
        var reducer = EnvelopeReducer()
        reducer.applyEntries(Self.branchyLog(), leafId: "d2")
        XCTAssertEqual(reducer.session.items.count, 4)

        // The user edit-resubmits in the TUI: the leaf moves to the OTHER
        // branch. The next refetch beacon (entries empty, leaf = c2) fires.
        reducer.applyEntries([], leafId: "c2")
        let texts = reducer.session.items.compactMap { item -> String? in
            if case let .user(b) = item { return b.text }
            if case let .assistant(b) = item { return b.text }
            return nil
        }
        XCTAssertEqual(texts, ["start", "answer", "original continuation (abandoned)", "abandoned answer"],
                       "the moved path renders; the old branch's rows go")
    }

    func testCompletingRefetchPageIsABeacon() throws {
        // A message_end refetch after a leaf move: NON-empty (the new branch's
        // entries), completing — leafId != the page's last entry id only when
        // the active leaf isn't the log's final entry. Build: existing path to
        // d2, then a new branch appended AFTER d2 whose tip the user jumped to.
        var reducer = EnvelopeReducer()
        reducer.applyEntries(Self.branchyLog(), leafId: "d2")

        let newBranch = [
            Self.msgEntry("e1", parent: "b1", role: "user", text: "third try"),
            Self.msgEntry("e2", parent: "e1", role: "assistant", text: "third answer"),
        ]
        // Log order: ...d2, e1, e2 — the active leaf (e2) IS the final entry,
        // so leafId == last entry id → NOT trusted by the wire rule. The next
        // EMPTY terminal beacons it (one turn late — the documented corner).
        var fold = EnvelopeReducer()
        fold.applyEntries(Self.branchyLog() + newBranch, leafId: nil)
        XCTAssertTrue(fold.session.items.isEmpty, "no beacon yet — nothing renders")

        fold.applyEntries([], leafId: "e2")
        XCTAssertEqual(fold.session.items.count, 4, "a1, b1, e1, e2 — the third path")
    }
}
