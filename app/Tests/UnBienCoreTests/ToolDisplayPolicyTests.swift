import XCTest
@testable import UnBienCore

/// Tool faces stage 2b: the per-category display defaults (design
/// 01M77YDWSZFD6WCYVFT3Z73SWJ).
final class ToolDisplayPolicyTests: XCTestCase {
    private func card(_ tool: String, state: ToolCard.State = .ok) -> ToolCard {
        ToolCard(toolCallID: "t", tool: tool, args: [:], state: state)
    }

    func testStandardDefaultsOpenShellAndDiffsPreviewReadsCloseTheRest() {
        let p = ToolDisplayPolicy.standard
        XCTAssertEqual(p.disclosure(for: card("bash")), .expanded)
        XCTAssertEqual(p.disclosure(for: card("edit")), .expanded)
        XCTAssertEqual(p.disclosure(for: card("write")), .expanded)
        XCTAssertEqual(p.disclosure(for: card("codemode")), .expanded)
        XCTAssertEqual(p.disclosure(for: card("read")), .preview)
        XCTAssertEqual(p.disclosure(for: card("grep")), .preview)
        XCTAssertEqual(p.disclosure(for: card("mcp")), .collapsed)
        XCTAssertEqual(p.disclosure(for: card("subagent")), .collapsed)
        XCTAssertEqual(p.disclosure(for: card("web_fetch")), .collapsed)
        XCTAssertEqual(p.disclosure(for: card("agent_send")), .collapsed)
        XCTAssertTrue(p.expandFailed)
    }

    func testFailedCallsOpenUnlessTurnedOff() {
        var p = ToolDisplayPolicy.standard
        XCTAssertEqual(p.disclosure(for: card("mcp", state: .failed)), .expanded)
        p.expandFailed = false
        XCTAssertEqual(p.disclosure(for: card("mcp", state: .failed)), .collapsed)
    }

    func testAllCollapsedClosesEveryCategoryButKeepsFailedOpen() {
        let p = ToolDisplayPolicy.allCollapsed
        for category in ToolCategory.allCases { XCTAssertEqual(p[category], .collapsed, "\(category)") }
        XCTAssertEqual(p.disclosure(for: card("bash", state: .failed)), .expanded)
    }

    func testSettingACategoryAndRoundTrip() throws {
        var p = ToolDisplayPolicy.standard
        p[.mcp] = .expanded
        let decoded = try JSONDecoder().decode(ToolDisplayPolicy.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(decoded, p)
        XCTAssertEqual(decoded[.mcp], .expanded)
    }

    /// Settings saved before a category existed: that category takes the
    /// standard default instead of failing to load.
    func testMissingCategoryTakesTheStandardDefault() throws {
        let stored = #"{"defaults":{"shell":"collapsed"},"expandFailed":false}"#
        let p = try JSONDecoder().decode(ToolDisplayPolicy.self, from: Data(stored.utf8))
        XCTAssertEqual(p[.shell], .collapsed)
        XCTAssertEqual(p[.edits], ToolDisplayPolicy.standard[.edits])
        XCTAssertFalse(p.expandFailed)
    }

    /// The fingerprint keys the height cache: any change to a setting changes it.
    func testFingerprintChangesWithEverySetting() {
        let base = ToolDisplayPolicy.standard
        var seen: Set<String> = [base.fingerprint]
        for category in ToolCategory.allCases {
            for value in ToolDisclosure.allCases where value != base[category] {
                var p = base
                p[category] = value
                XCTAssertTrue(seen.insert(p.fingerprint).inserted, "\(category)=\(value)")
            }
        }
        var failedOff = base
        failedOff.expandFailed = false
        XCTAssertNotEqual(failedOff.fingerprint, base.fingerprint)
        XCTAssertEqual(ToolDisplayPolicy.standard.fingerprint, base.fingerprint, "stable")
    }
}
