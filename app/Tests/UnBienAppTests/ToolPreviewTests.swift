import XCTest
@testable import UnBienApp
@testable import UnBienCore

/// Tool faces stage 5: header subtitles (a read's path:range, pi's format)
/// and Preview cards (pi's collapsed line counts, shared by the card, the
/// estimator and prewarm through resultParts).
final class ToolPreviewTests: XCTestCase {
    private func settled(_ tool: String, args: [String: JSONValue] = [:], text: String) -> ToolCard {
        ToolCard(toolCallID: "p1", tool: tool, args: args,
                 result: .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])])]),
                 state: .ok)
    }

    private func numbered(_ n: Int) -> String {
        (1...n).map { "line \($0)" }.joined(separator: "\n")
    }

    // MARK: - Header subtitle

    func testReadSubtitleIsPathAndRangeAsPiWritesIt() {
        func subtitle(_ args: [String: JSONValue]) -> String? {
            ToolCardView.headerSubtitle(for: ToolCard(toolCallID: "r", tool: "read", args: args))?.text
        }
        XCTAssertEqual(subtitle(["path": .string("a/b.swift")]), "a/b.swift")
        XCTAssertEqual(subtitle(["path": .string("a/b.swift"), "offset": .number(10), "limit": .number(40)]),
                       "a/b.swift:10-49")
        XCTAssertEqual(subtitle(["path": .string("a/b.swift"), "offset": .number(10)]), "a/b.swift:10")
        XCTAssertEqual(subtitle(["path": .string("a/b.swift"), "limit": .number(5)]), "a/b.swift:1-5")
        // Strict schemas send null for omitted fields.
        XCTAssertEqual(subtitle(["path": .string("a"), "offset": .null, "limit": .null]), "a")
        XCTAssertEqual(subtitle(["file_path": .string("x.py")]), "x.py")
        XCTAssertNil(subtitle([:]))
    }

    func testPathSubtitlesForEditWriteLsAndMCPUnchanged() {
        for tool in ["edit", "write", "ls"] {
            let sub = ToolCardView.headerSubtitle(for: ToolCard(toolCallID: "e", tool: tool,
                                                                 args: ["path": .string("src/x.ts")]))
            XCTAssertEqual(sub?.text, "src/x.ts", tool)
            XCTAssertEqual(sub?.isPath, true, tool)
        }
        let mcp = ToolCardView.headerSubtitle(for: ToolCard(toolCallID: "m", tool: "mcp",
                                                             args: ["tool": .string("github_search")]))
        XCTAssertEqual(mcp?.text, "github_search")
        XCTAssertEqual(mcp?.isPath, false)
        XCTAssertNil(ToolCardView.headerSubtitle(for: ToolCard(toolCallID: "b", tool: "bash",
                                                                args: ["path": .string("x")])))
    }

    func testWebAndAgentSubtitles() {
        func sub(_ tool: String, _ args: [String: JSONValue]) -> String? {
            ToolCardView.headerSubtitle(for: ToolCard(toolCallID: "w", tool: tool, args: args))?.text
        }
        XCTAssertEqual(sub("web_fetch", ["url": .string("https://x.dev/a")]), "https://x.dev/a")
        XCTAssertEqual(sub("web_search", ["query": .string("swift ui")]), "\"swift ui\"")
        XCTAssertEqual(sub("subagent", ["description": .string("review"), "prompt": .string("…")]), "review")
        XCTAssertNil(sub("web_fetch", [:]))
    }

    func testWebAndAgentResultsAreMarkdown() {
        let card = ToolCard(toolCallID: "a", tool: "subagent", args: [:],
                            result: .object(["content": .array([.object([
                                "type": .string("text"), "text": .string("**Verdict: ready.**")])])]),
                            state: .ok)
        XCTAssertEqual(ToolCardView.resultParts(for: card),
                       [.label("output"), .markdown("**Verdict: ready.**", face: "md")])
        XCTAssertEqual(ToolCardView.resultMarkdown(for: card).map(\.id), ["a\u{1}@md-all"])
        var running = card
        running.state = .running
        XCTAssertEqual(ToolCardView.resultParts(for: running), [.label("output"), .mono("**Verdict: ready.**")],
                       "running output stays plain text")
    }

    // MARK: - ToolPreview

    func testPreviewLineCountsArePis() {
        XCTAssertEqual(ToolPreview.forTool("bash"), ToolPreview(lines: 5, fromEnd: true))
        XCTAssertEqual(ToolPreview.forTool("codemode"), ToolPreview(lines: 5, fromEnd: true))
        XCTAssertEqual(ToolPreview.forTool("read"), ToolPreview(lines: 10, fromEnd: false))
        XCTAssertEqual(ToolPreview.forTool("grep"), ToolPreview(lines: 15, fromEnd: false))
        XCTAssertEqual(ToolPreview.forTool("find"), ToolPreview(lines: 20, fromEnd: false))
        XCTAssertEqual(ToolPreview.forTool("ls"), ToolPreview(lines: 20, fromEnd: false))
        XCTAssertEqual(ToolPreview.forTool("web_fetch"), ToolPreview(lines: 10, fromEnd: false))
    }

    func testCutKeepsHeadOrTailAndCountsHidden() {
        let head = ToolPreview(lines: 3, fromEnd: false).cut(numbered(10))
        XCTAssertEqual(head.text, "line 1\nline 2\nline 3")
        XCTAssertEqual(head.hidden, 7)
        let tail = ToolPreview(lines: 3, fromEnd: true).cut(numbered(10) + "\n\n")
        XCTAssertEqual(tail.text, "line 8\nline 9\nline 10", "trailing empty lines don't count")
        XCTAssertEqual(tail.hidden, 7)
        let short = ToolPreview(lines: 3, fromEnd: true).cut("a\nb\n")
        XCTAssertEqual(short.text, "a\nb\n", "short text is shown whole, untouched")
        XCTAssertEqual(short.hidden, 0)
    }

    // MARK: - Preview parts

    func testBashPreviewShowsTheLastFiveLinesThenMore() {
        let parts = ToolCardView.resultParts(for: settled("bash", args: ["command": .string("seq 12")],
                                                          text: numbered(12)), preview: true)
        XCTAssertEqual(parts, [.label("output"), .mono((8...12).map { "line \($0)" }.joined(separator: "\n")),
                               .more(7)])
    }

    func testReadPreviewShowsTheFirstTenInItsOwnCacheSlot() {
        let parts = ToolCardView.resultParts(for: settled("read", args: ["path": .string("a.swift")],
                                                          text: numbered(30)), preview: true)
        guard case .code(let text, let lang, let face)? = parts.first else { return XCTFail("\(parts)") }
        XCTAssertEqual(text, numbered(10))
        XCTAssertEqual(lang, "swift")
        XCTAssertEqual(face, "preview", "the full file's slot is \"output\"")
        XCTAssertEqual(parts.dropFirst().first, .more(20))
    }

    func testShortResultsAndErrorsShowWhole() {
        let short = settled("grep", args: ["pattern": .string("x")], text: numbered(4))
        XCTAssertEqual(ToolCardView.resultParts(for: short, preview: true), ToolCardView.resultParts(for: short))
        var failed = settled("read", args: ["path": .string("a")], text: numbered(40))
        failed.state = .failed
        XCTAssertEqual(ToolCardView.resultParts(for: failed, preview: true), ToolCardView.resultParts(for: failed))
    }

    func testStartsPreviewingFollowsThePolicyUntilShowAll() {
        let read = settled("read", args: ["path": .string("a")], text: numbered(30))
        let store = CardUIState()
        XCTAssertTrue(ToolCardView.startsPreviewing(read, policy: .standard, store: store))
        XCTAssertFalse(ToolCardView.startsPreviewing(settled("bash", text: "x"), policy: .standard, store: store),
                       "shell opens in full by default")
        XCTAssertFalse(ToolCardView.startsPreviewing(read, policy: .allCollapsed, store: store))
        store.setShowsAll(read.toolCallID)
        XCTAssertFalse(ToolCardView.startsPreviewing(read, policy: .standard, store: store),
                       "\"N more lines\" sticks across rematerialization")
    }

    func testPreviewEstimateCountsTheShortenedBody() {
        let read = settled("read", args: ["path": .string("a.swift")], text: numbered(300))
        let full = RowHeightEstimator.toolCardFacts(for: read, expanded: true, hideInputRich: true)
        let preview = RowHeightEstimator.toolCardFacts(for: read, expanded: true, hideInputRich: true, preview: true)
        // The input section is the same in both; the result goes from 300
        // lines to ten and the more row.
        XCTAssertEqual(full.monoLineTokens.count - preview.monoLineTokens.count, 300 - 11)
    }
}
