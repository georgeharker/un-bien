import XCTest
@testable import UnBienCore

/// Stage 2 of the tool-result rendering plan (design 01M77YDWSZFD6WCYVFT3Z73SWJ):
/// every stage-0 fixture resolves to the face, category, text, notices and
/// extras its `expect` block states — from the replayed card AND the live one,
/// which must agree.
final class ToolFaceTests: XCTestCase {
    /// The pi catalog and the durable one (captured from pi-durable's tools by
    /// unbien-durable/src/tool_fixtures.test.ts): both must resolve the same way.
    private func catalog() throws -> [JSONValue] {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/tool-results")
        return try ["catalog.json", "durable-catalog.json"].flatMap { name in
            try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: dir.appendingPathComponent(name)))["fixtures"]?
                .arrayValue ?? []
        }
    }

    private func card(_ state: SessionState, _ id: String) -> ToolCard? {
        for case .tool(let c) in state.items where c.toolCallID == id { return c }
        return nil
    }

    private func liveCard(_ f: JSONValue) -> ToolCard? {
        var state = SessionState()
        for frame in f["live"]?.arrayValue ?? [] { state.applyRPC(frame) }
        return card(state, f["toolCallId"]?.stringValue ?? "")
    }

    private func replayCard(_ f: JSONValue) -> ToolCard? {
        var state = SessionState()
        let stored = f["stored"]?.arrayValue ?? []
        state.applyEntries(stored, leafId: stored.last?["id"]?.stringValue, authoritative: true)
        return card(state, f["toolCallId"]?.stringValue ?? "")
    }

    private func kind(_ face: ToolFace) -> String {
        switch face {
        case .pending: return "pending"
        case .terminal: return "terminal"
        case .file: return "file"
        case .diff: return "diff"
        case .confirmation: return "confirmation"
        case .lines: return "lines"
        case .script: return "script"
        case .error: return "error"
        case .text: return "text"
        }
    }

    private func bodyText(_ face: ToolFace) -> String? {
        switch face {
        case .terminal(let text, _, _), .file(let text, _, _), .lines(let text, _),
             .text(let text), .error(let text), .confirmation(let text): return text
        case .script(_, let output): return output
        case .pending, .diff: return nil
        }
    }

    private func notices(_ face: ToolFace) -> [String]? {
        switch face {
        case .terminal(_, let n, _), .file(_, _, let n), .lines(_, let n): return n
        default: return nil
        }
    }

    func testEveryFixtureResolvesToItsSpecifiedFace() throws {
        for f in try catalog() {
            let id = f["id"]?.stringValue ?? "?"
            let expect = f["expect"] ?? .object([:])
            if expect["replayAvailable"]?.boolValue == false {
                // The record holds no result: replay waits, live still shows it.
                XCTAssertEqual(replayCard(f).map { ToolFaceResolver.resolve($0).face }, .pending, id)
                XCTAssertEqual(liveCard(f).map { kind(ToolFaceResolver.resolve($0).face) },
                               expect["face"]?.stringValue, id)
                continue
            }
            guard let replay = replayCard(f), let live = liveCard(f) else { XCTFail("\(id): no card"); continue }
            let view = ToolFaceResolver.resolve(replay)
            XCTAssertEqual(view, ToolFaceResolver.resolve(live), "\(id): live and replay resolve alike")
            XCTAssertEqual(kind(view.face), expect["face"]?.stringValue, "\(id): face")
            XCTAssertEqual(view.category.rawValue, expect["category"]?.stringValue, "\(id): category")
            if let text = expect["text"]?.stringValue {
                XCTAssertEqual(bodyText(view.face), text, "\(id): text")
            }
            if let expected = expect["notices"]?.arrayValue {
                XCTAssertEqual(notices(view.face), expected.compactMap(\.stringValue), "\(id): notices")
            }
            if let lang = expect["lang"]?.stringValue, case .file(_, let got, _) = view.face {
                XCTAssertEqual(got, lang, "\(id): lang")
            }
            if let calls = expect["calls"]?.intValue, case .script(let got, _) = view.face {
                XCTAssertEqual(got.count, calls, "\(id): calls")
            }
            if let source = expect["diffFrom"]?.stringValue, case .diff(let hunks, _) = view.face {
                XCTAssertEqual(hunks != nil, source == "details.patch", "\(id): diff source")
            }
            if let line = expect["confirmation"]?.stringValue {
                switch view.face {
                case .diff(_, let got): XCTAssertEqual(got, line, "\(id): confirmation")
                case .confirmation(let got): XCTAssertEqual(got, line, "\(id): confirmation")
                default: XCTFail("\(id): expected a confirmation")
                }
            }
            if let expected = expect["diagnostics"]?.arrayValue {
                XCTAssertEqual(view.diagnostics, expected.compactMap(\.stringValue), "\(id): diagnostics")
            } else {
                XCTAssertEqual(view.diagnostics, [], "\(id): no diagnostics")
            }
            if expect["diffInOutput"]?.boolValue == true {
                guard case .terminal(_, _, let diff) = view.face else { XCTFail(id); continue }
                XCTAssertEqual(diff?["kind"]?.stringValue, "diff", "\(id): diff in output")
            }
            if let images = expect["images"]?.intValue {
                XCTAssertEqual(replay.images.count, images, "\(id): images")
            }
        }
    }

    /// The edit diff from the record is pi's unified patch, with real line
    /// numbers from its @@ header.
    func testEditDiffComesFromThePatchWithLineNumbers() throws {
        let f = try XCTUnwrap(catalog().first { $0["id"]?.stringValue == "edit.ok" })
        let view = try ToolFaceResolver.resolve(XCTUnwrap(replayCard(f)))
        guard case .diff(let hunks?, _) = view.face else { return XCTFail("no hunks") }
        let lines = hunks.first?["lines"]?.arrayValue ?? []
        let added = lines.first { $0["kind"]?.stringValue == "add" }
        XCTAssertEqual(added?["newLine"]?.intValue, 7)
        XCTAssertEqual(added?["text"]?.stringValue, "source \"$HOME/.env.sh\"")
    }

    /// A running call streams its partial text: shell as terminal output,
    /// anything else as plain text; nothing until text arrives.
    func testRunningCardsStreamTheirPartialText() {
        var bash = ToolCard(toolCallID: "a", tool: "bash", args: [:])
        bash.result = SessionState.canonicalToolResult(.string("partial"))
        XCTAssertEqual(ToolFaceResolver.resolve(bash).face, .terminal(text: "partial", notices: [], diff: nil))
        var agent = ToolCard(toolCallID: "b", tool: "subagent", args: [:])
        agent.result = SessionState.canonicalToolResult(.string("3 tool uses…"))
        XCTAssertEqual(ToolFaceResolver.resolve(agent).face, .text("3 tool uses…"))
        let empty = ToolCard(toolCallID: "c", tool: "read", args: [:])
        XCTAssertEqual(ToolFaceResolver.resolve(empty).face, .pending)
    }

    /// File text that happens to end in brackets is not mistaken for a notice.
    func testReadKeepsBracketedFileText() {
        var card = ToolCard(toolCallID: "c", tool: "read", args: ["path": .string("a.txt")], state: .ok)
        card.result = SessionState.canonicalToolResult(.string("items:\n\n[one, two]"))
        XCTAssertEqual(ToolFaceResolver.resolve(card).face, .file(text: "items:\n\n[one, two]", lang: nil, notices: []))
    }

    /// The reference log: every settled built-in call resolves to its own face
    /// (never the text fallback), so the specs match what pi really stores.
    func testRealLogBuiltInsResolveToTheirFaces() throws {
        let path = "/Users/geohar/.local/share/pi/2026-10-14T15-47-40-528Z_"
            + "01a13b19-0f6f-72ef-aa88-5c17e5962b87.jsonl"
        guard FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("real session log not present on this machine")
        }
        var entries: [JSONValue] = []
        for line in try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n") {
            if let v = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)),
               v["id"]?.stringValue != nil { entries.append(v) }
        }
        var state = SessionState()
        state.applyEntries(entries, leafId: entries.last?["id"]?.stringValue, authoritative: true)
        let builtIns: Set<String> = ["bash", "read", "edit", "write", "codemode"]
        var checked = 0
        for case .tool(let c) in state.items where builtIns.contains(c.tool) && c.state == .ok {
            checked += 1
            let face = ToolFaceResolver.resolve(c).face
            if case .text = face { XCTFail("\(c.tool) \(c.toolCallID) fell back to text") }
            if case .pending = face { XCTFail("\(c.tool) \(c.toolCallID) settled but pending") }
        }
        XCTAssertGreaterThan(checked, 1000)
    }
}
