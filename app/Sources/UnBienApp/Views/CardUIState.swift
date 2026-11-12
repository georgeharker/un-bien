import SwiftUI

/// Per-tool-card view state (expand + Diff/Content toggle) that must SURVIVE the
/// transcript's row windowing. `ToolCardView`'s own `@State` is destroyed when a
/// row scrolls out of the ±pages margin and recreated on return — so a card the
/// user expanded or flipped to Content silently collapsed on scroll ("edits
/// disappear"). This store lives ABOVE the windowed ForEach (a `@State` on
/// TranscriptView) and is keyed by `toolCallID`, so a dematerialize →
/// rematerialize round-trip keeps the user's choice. Lifetime = the transcript
/// view (resets on relaunch — acceptable).
///
/// It is deliberately NOT an ObservableObject and is passed via a NON-observing
/// `@Environment(\.cardUIState)` value: reactivity stays in each ToolCardView's
/// LOCAL @State (seeded from here in init, written back onChange). An observed
/// `@EnvironmentObject` instead made every visible card a subscriber to one
/// shared object — re-established on every materialization during scroll and
/// fighting `TranscriptRow.equatable()` — which made scrolling jerkier (design
/// 01M1S9ET append). As pure storage it's touched only on materialize (read)
/// and toggle (write).
///
/// @unchecked Sendable: pure reference storage touched ONLY from SwiftUI view
/// bodies (main actor) — ToolCardView reads it in init and writes it onChange,
/// never off-main and never per-render. The assertion satisfies the nonisolated
/// EnvironmentKey.defaultValue without dragging @MainActor onto the env key.
final class CardUIState: @unchecked Sendable {
    private var expandedByID: [String: Bool] = [:]
    private var showContentByID: [String: Bool] = [:]
    private var showsAllByID: Set<String> = []

    /// Expanded state for `id`: the user's override when they left the card
    /// different from its default, otherwise the default (which moves as the
    /// card settles or Settings change).
    func expanded(_ id: String, default fallback: Bool) -> Bool {
        expandedByID[id] ?? fallback
    }

    /// Whether the user has overridden `id`'s default.
    func hasExpandedOverride(_ id: String) -> Bool { expandedByID[id] != nil }

    /// Record the card's open state: an override when it differs from the
    /// default, cleared when it matches (so the card follows its default again).
    func setExpanded(_ id: String, _ value: Bool, default fallback: Bool) {
        expandedByID[id] = value == fallback ? nil : value
    }

    /// Diff⇄Content toggle (false = Diff, the default).
    func showContent(_ id: String) -> Bool { showContentByID[id] ?? false }

    func setShowContent(_ id: String, _ value: Bool) { showContentByID[id] = value }

    /// A Preview card the user asked to see in full ("N more lines").
    func showsAll(_ id: String) -> Bool { showsAllByID.contains(id) }

    func setShowsAll(_ id: String) { showsAllByID.insert(id) }
}

private struct CardUIStateKey: EnvironmentKey {
    static let defaultValue = CardUIState()
}

extension EnvironmentValues {
    /// Non-observing handle to the transcript's per-card UI-state store. A plain
    /// value read (no ObservableObject subscription) — ToolCardView seeds its
    /// local @State from it and writes back, so cards stay independent.
    var cardUIState: CardUIState {
        get { self[CardUIStateKey.self] }
        set { self[CardUIStateKey.self] = newValue }
    }
}
