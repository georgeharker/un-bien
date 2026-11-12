import XCTest
@testable import UnBienApp
@testable import UnBienCore

/// The 1.6.0 review findings on the card: agent prompts behind their own
/// setting, error diagnostics on calls that succeeded, wrapped notices, the
/// header duration, and the policy fingerprint.
final class ToolCardReviewTests: XCTestCase {
    private func agent(_ args: [String: JSONValue]) -> ToolCard {
        ToolCard(toolCallID: "a1", tool: "subagent", args: args,
                 result: .object(["content": .array([.object([
                     "type": .string("text"), "text": .string("**Done.**")])])]),
                 state: .ok)
    }

    // MARK: - Agent prompts

    func testAnAgentShowsItsPromptAboveItsReport() {
        let card = agent(["description": .string("review"), "prompt": .string("Review the diff.\n\nBe strict.")])
        XCTAssertEqual(ToolCardView.promptParts(for: card, show: true),
                       [.label("prompt"), .markdown("Review the diff.\n\nBe strict.", face: "prompt")])
        XCTAssertEqual(ToolCardView.resultMarkdown(for: card).map(\.id), ["a1\u{1}@prompt-all", "a1\u{1}@md-all"])
    }

    func testPromptsAreTheirOwnSetting() {
        let card = agent(["prompt": .string("Do it.")])
        XCTAssertEqual(ToolCardView.promptParts(for: card, show: false), [])
        XCTAssertEqual(ToolCardView.resultMarkdown(for: card, showAgentPrompts: false).map(\.id), ["a1\u{1}@md-all"])
        // Hide input on rich results still hides the raw arguments; the
        // prompt is not raw input.
        XCTAssertFalse(ToolCardView.showsInputSection(for: card, hideInputRich: true))
        XCTAssertEqual(ToolCardView.promptParts(for: card, show: true).count, 2)
        // A steer's message is its prompt; other tools have none.
        let steer = ToolCard(toolCallID: "s", tool: "steer_subagent", args: ["message": .string("Stop.")])
        XCTAssertEqual(ToolCardView.agentPrompt(for: steer, show: true), "Stop.")
        let bash = ToolCard(toolCallID: "b", tool: "bash", args: ["prompt": .string("x")])
        XCTAssertNil(ToolCardView.agentPrompt(for: bash, show: true))
    }

    func testThePromptIsEstimated() {
        let card = agent(["prompt": .string("Review the diff.")])
        let shown = RowHeightEstimator.toolCardFacts(for: card, expanded: true, hideInputRich: true,
                                                     showAgentPrompts: true)
        let hidden = RowHeightEstimator.toolCardFacts(for: card, expanded: true, hideInputRich: true,
                                                      showAgentPrompts: false)
        XCTAssertEqual(shown.markdownTexts, ["Review the diff.", "**Done.**"])
        XCTAssertEqual(hidden.markdownTexts, ["**Done.**"])
        XCTAssertEqual(shown.labeledSections, hidden.labeledSections + 1)
        XCTAssertEqual(shown.bodySections, hidden.bodySections + 1)
    }

    func testTheFingerprintCoversPrompts() {
        var off = ToolDisplayPolicy.standard
        off.showAgentPrompts = false
        XCTAssertNotEqual(off.fingerprint, ToolDisplayPolicy.standard.fingerprint)
    }

    // MARK: - Diagnostics and notices

    func testAnErrorDiagnosticOnASucceededCallDrawsAsAnError() {
        let card = ToolCard(toolCallID: "d", tool: "bash", args: [:],
                            result: .object(["content": .array([
                                .object(["type": .string("text"), "text": .string("ok")]),
                                .object(["type": .string("text"),
                                         "text": .string("<harness>\n[error] step blocked by policy\n[warn] slow\n</harness>")]),
                            ])]), state: .ok)
        XCTAssertEqual(ToolCardView.resultParts(for: card),
                       [.label("output"), .mono("ok"), .errorNotice("step blocked by policy"), .notice("slow")])
    }

    func testALongNoticeIsEstimatedWrapped() {
        let path = "Full output: /var/folders/tm/zljspgz50td_0yjp1h3swdcw0000gn/T/pi-durable-spill-0123456789abcdef/output.log"
        XCTAssertGreaterThan(RowHeightEstimator.noticeExtraHeight(path, width: 200), 0)
        XCTAssertEqual(RowHeightEstimator.noticeExtraHeight("Truncated", width: 200), 0)
    }

    // MARK: - Main-thread cost

    /// The transcript rebuild builds every tool card's height facts and warm
    /// list on the main thread. It must read the card's stored result view,
    /// not resolve it again: 1.6.0 (26) resolved each card about nine times
    /// per rebuild, 25ms for a 100KB shell result. Guarded relative to one
    /// resolve, so machine speed cancels out.
    @MainActor func testTheRebuildPathDoesNotReResolveCards() {
        let theme = ThemeID.oneDark.theme
        let typography = Typography()
        let out = (1...2000).map { "PASS test_case_\($0) (0.0\($0 % 10)s) some output text here" }
            .joined(separator: "\n") + "\n@@ -1 +1 @@\n-a\n+b"
        let card = ToolCard(toolCallID: "big", tool: "bash", args: ["command": .string("swift test")],
                            result: .object(["content": .array([.object([
                                "type": .string("text"), "text": .string(out)])])]),
                            state: .ok)
        func time(_ body: () -> Void) -> Double {
            let start = Date()
            for _ in 0..<10 { body() }
            return Date().timeIntervalSince(start)
        }
        let resolve = time { _ = ToolFaceResolver.resolve(card) }
        let rebuild = time {
            for preview in [false, true] {
                _ = RowHeightEstimator.toolCardFacts(for: card, expanded: true, hideInputRich: true, preview: preview)
                _ = ToolCardView.diffProducer(for: card, theme: theme, themeID: .oneDark)
                _ = ToolCardView.resultProducers(for: card, theme: theme, typography: typography,
                                                 themeID: .oneDark, preview: preview)
                _ = ToolCardView.resultMarkdown(for: card, preview: preview)
                _ = ToolCardView.sectionLabels(for: card, hideInputRich: true)
            }
        }
        print(String(format: "HPERF resolve %.2fms rebuild(open+preview) %.2fms", resolve * 100, rebuild * 100))
        XCTAssertLessThan(rebuild, resolve * 2, "the rebuild path re-resolves the card")
    }

    // MARK: - Duration

    func testDurationText() {
        XCTAssertEqual(ToolCardView.durationText(840), "840ms")
        XCTAssertEqual(ToolCardView.durationText(12_345), "12.3s")
        XCTAssertEqual(ToolCardView.durationText(125_000), "2m 05s")
        XCTAssertNil(ToolCardView.durationText(nil))
    }
}
