import XCTest
import UnBienCore
@testable import UnBienApp

/// Tool faces stage 2b: the display policy's persistence and its migration
/// from the former "Expand rich tool results" toggle, plus the card's start
/// state.
final class ToolDisplaySettingsTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let name = "un-bien.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testNewInstallGetsTheStandardPolicy() {
        XCTAssertEqual(AppModel.loadToolDisplayPolicy(freshDefaults()), .standard)
    }

    func testLegacyToggleOffMigratesToAllClosed() {
        let defaults = freshDefaults()
        defaults.set(false, forKey: AppModel.legacyExpandRichKey)
        XCTAssertEqual(AppModel.loadToolDisplayPolicy(defaults), .allCollapsed)
    }

    func testLegacyToggleOnMigratesToStandard() {
        let defaults = freshDefaults()
        defaults.set(true, forKey: AppModel.legacyExpandRichKey)
        XCTAssertEqual(AppModel.loadToolDisplayPolicy(defaults), .standard)
    }

    func testSavedPolicyWinsOverTheLegacyToggle() {
        let defaults = freshDefaults()
        defaults.set(false, forKey: AppModel.legacyExpandRichKey)
        var policy = ToolDisplayPolicy.standard
        policy[.mcp] = .expanded
        AppModel.saveToolDisplayPolicy(policy, defaults)
        XCTAssertEqual(AppModel.loadToolDisplayPolicy(defaults), policy)
    }

    /// A card starts open when its category isn't Closed AND it has something
    /// to show; a Closed category stays closed however rich the card is.
    func testCardStartStateFollowsThePolicy() {
        let bash = ToolCard(toolCallID: "b", tool: "bash", args: ["command": .string("ls")],
                            result: .object(["content": .array([])]), state: .ok)
        XCTAssertTrue(ToolCardView.startsExpanded(bash, policy: .standard))
        XCTAssertFalse(ToolCardView.startsExpanded(bash, policy: .allCollapsed))
        let empty = ToolCard(toolCallID: "e", tool: "bash", args: [:], state: .running)
        XCTAssertFalse(ToolCardView.startsExpanded(empty, policy: .standard), "nothing to show yet")
        let mcp = ToolCard(toolCallID: "m", tool: "mcp", args: ["tool": .string("x")],
                           result: .object(["content": .array([])]), state: .ok)
        XCTAssertFalse(ToolCardView.startsExpanded(mcp, policy: .standard))
        var failed = mcp
        failed.state = .failed
        XCTAssertTrue(ToolCardView.startsExpanded(failed, policy: .standard), "failed calls open")
    }
}
