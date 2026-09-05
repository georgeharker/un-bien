import SwiftUI

/// Per-tool-card view state (expand + Diff/Content toggle) that must SURVIVE the
/// transcript's row windowing. `ToolCardView`'s own `@State` is destroyed when a
/// row scrolls out of the ±pages margin and reset to defaults when it scrolls
/// back — so a card the user expanded or flipped to Content silently collapsed
/// on scroll ("edits disappear"). This store is held ABOVE the windowed ForEach
/// (a `@StateObject` on TranscriptView, injected via environment) and keyed by
/// `toolCallID`, so a dematerialize → rematerialize round-trip keeps the user's
/// choice. Lifetime = the transcript view (resets on relaunch — acceptable).
@MainActor
final class CardUIState: ObservableObject {
    @Published private var expandedByID: [String: Bool] = [:]
    @Published private var showContentByID: [String: Bool] = [:]

    /// Expanded state for `id`, falling back to the card's computed default the
    /// first time it's seen (rich cards start expanded when the pref is on).
    func expanded(_ id: String, default fallback: Bool) -> Bool {
        expandedByID[id] ?? fallback
    }

    func setExpanded(_ id: String, _ value: Bool) { expandedByID[id] = value }

    /// Diff⇄Content toggle (false = Diff, the default).
    func showContent(_ id: String) -> Bool { showContentByID[id] ?? false }

    func setShowContent(_ id: String, _ value: Bool) { showContentByID[id] = value }
}
