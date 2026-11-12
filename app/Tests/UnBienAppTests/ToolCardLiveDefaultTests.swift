import XCTest
import SwiftUI
@testable import UnBienApp
@testable import UnBienCore

/// A card follows its display default when the default moves (the call
/// settles, or Settings change), unless the user overrode it: the card and
/// the estimator then agree on its open state.
@MainActor
final class ToolCardLiveDefaultTests: XCTestCase {
    private let theme = ThemeID.oneDark.theme
    private let typography = Typography()

    private func view(_ card: ToolCard, policy: ToolDisplayPolicy, store: CardUIState) -> some View {
        ToolCardView(card: card, theme: theme, typography: typography, displayPolicy: policy,
                     hideInputRich: true, store: store, themeID: .oneDark)
            .frame(width: 370, alignment: .leading)
    }

    #if os(macOS)
    private func host<V: View>(_ root: V) -> NSHostingView<V> {
        let host = NSHostingView(rootView: root)
        host.layoutSubtreeIfNeeded()
        return host
    }

    private func height<V: View>(_ host: NSHostingView<V>) -> Double {
        host.layoutSubtreeIfNeeded()
        // Let onChange handlers run and re-layout.
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }

    private let running = ToolCard(toolCallID: "r1", tool: "read", args: ["path": .string("a.swift")])
    private var settled: ToolCard {
        var card = running
        card.result = .object(["content": .array([.object([
            "type": .string("text"),
            "text": .string((1...30).map { "let v\($0) = \($0)" }.joined(separator: "\n"))])])])
        card.state = .ok
        return card
    }

    func testARunningReadOpensToItsPreviewWhenItSettles() {
        let store = CardUIState()
        let host = host(view(running, policy: .standard, store: store))
        let closed = height(host)
        XCTAssertEqual(closed, TranscriptMetrics.toolCardCollapsedChrome, accuracy: 2, "running read: nothing to show yet")
        host.rootView = view(settled, policy: .standard, store: store)
        let open = height(host)
        XCTAssertGreaterThan(open, closed + 100, "settled read opens to its preview")
        // The estimator's start state for the same card and store.
        XCTAssertTrue(store.expanded(settled.toolCallID,
                                     default: ToolCardView.startsExpanded(settled, policy: .standard)))
        XCTAssertFalse(store.hasExpandedOverride(settled.toolCallID), "following the default is not an override")
    }

    func testAUserOverrideSticksWhenTheDefaultMoves() {
        let store = CardUIState()
        // The user closed this read after it settled open.
        store.setExpanded(settled.toolCallID, false, default: true)
        let host = host(view(settled, policy: .standard, store: store))
        let closed = height(host)
        host.rootView = view(settled, policy: .allCollapsed, store: store)
        XCTAssertEqual(height(host), closed, accuracy: 1)
        var allOpen = ToolDisplayPolicy.standard
        allOpen[.reads] = .expanded
        host.rootView = view(settled, policy: allOpen, store: store)
        XCTAssertEqual(height(host), closed, accuracy: 1, "an override survives a Settings change")
    }

    func testASettingsChangeMovesCardsWithoutAnOverride() {
        let store = CardUIState()
        let host = host(view(settled, policy: .standard, store: store))
        let preview = height(host)
        host.rootView = view(settled, policy: .allCollapsed, store: store)
        XCTAssertEqual(height(host), TranscriptMetrics.toolCardCollapsedChrome, accuracy: 2)
        var allOpen = ToolDisplayPolicy.standard
        allOpen[.reads] = .expanded
        host.rootView = view(settled, policy: allOpen, store: store)
        XCTAssertGreaterThan(height(host), preview + 100, "open shows the whole file, not the preview")
    }
    #endif
}
