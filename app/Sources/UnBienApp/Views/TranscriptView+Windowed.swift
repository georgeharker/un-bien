import SwiftUI
import UnBienCore

// The transcript stack members of TranscriptView (designs: transcript
// row-geometry + scroll-position pin), split from TranscriptView.swift at the
// 1000-line cap. Members here are THE stack (non-lazy, husk rows), its
// probes, the sentinel cell, and the windowed scroll-memory capture. Shared
// TranscriptView state they touch is internal (not private) in the main file.

extension TranscriptView {
    /// THE transcript stack: a NON-LAZY VStack — every row placed, exact
    /// frames by construction. Rows are HUSKS (identity + @State
    /// measuredHeight + claimed frame, permanent in the hierarchy) whose
    /// content subtree attaches only inside the GEOMETRIC page-window
    /// (driver-owned arithmetic); cycling out freezes to the last measured
    /// height. The "…" sentinel keeps its cell; the PIN is the
    /// scrollPosition binding's business (main file) — this stack just marks
    /// itself the scroll-target layout so the binding can address its
    /// children (rows + sentinel) by id.
    var transcriptStack: some View {
        TranscriptStackView(
            items: items,
            contentGeneration: model.transcripts[session.id]?.contentGeneration ?? 0,
            branchPoints: model.transcripts[session.id]?.branchPointIds ?? [],
            driver: windowDriver,
            themeID: model.themeID, theme: theme, typography: typography,
            expandRich: model.expandRichToolResults,
            hideInputRich: model.hideInputWhenRich,
            isDemo: model.isDemo(session),
            sentinelBusy: model.activeTurnID(for: session) != nil && !model.hasEnded(session),
            onFork: { entryID in Task { await model.forkFromEntry(session, entryID: entryID) } },
            onBranch: { entryID, prefill in
                Task { await model.branchFromEntry(session, entryID: entryID, prefill: prefill) }
            }
        )
        .equatable()
    }

    /// Viewport height for the window math + the resize reclaim.
    var viewportProbe: some View {
        GeometryReader { geo in
            Color.clear
                .onAppear {
                    viewportHeight = geo.size.height
                    windowDriver.update(viewportHeight: geo.size.height)
                }
                .onChange(of: geo.size.height) { _, h in
                    viewportHeight = h
                    windowDriver.update(viewportHeight: h)
                }
        }
    }

    /// The CURRENT bottom-most visible stable anchor (driver arithmetic over
    /// retained bounds) — LIFECYCLE capture's compute (view exit / background
    /// / terminate; never per-scroll-flip, user 2026-09-17). Approximate in
    /// unmeasured regions; restore walks to the nearest stable anchor, which
    /// tolerates it.
    func currentStableAnchor() -> String? {
        guard didRestoreScroll,
              let idx = windowDriver.bottomVisibleIndex(),
              idx < items.count else { return nil }
        return items.stableAnchor(atOrAbove: idx)
    }

    /// The driver's measured heights, FILTERED to replay-stable rows —
    /// pending synthetic ids would persist as stale junk after their re-key
    /// (the height-cache persistence tier's capture compute).
    func stableHeights() -> [String: Double] {
        let stableIDs = Set(items.compactMap(\.anchorID))
        return windowDriver.heightSnapshot().filter { stableIDs.contains($0.key) }
    }

}

/// The transcript stack extracted as an EQUATABLE view so a scrollAnchor-only
/// re-eval of TranscriptView.body diff-skips it (no ForEach, no N HuskRow
/// reconstruction). == gates on the content generation + display inputs;
/// scrollAnchor is NOT an input, and the fork/branch closures are excluded
/// (recreated only on a real rebuild — they capture the stable model/session).
struct TranscriptStackView: View, Equatable {
    let items: [TranscriptItem]
    let contentGeneration: Int
    let branchPoints: Set<String>
    let driver: TranscriptWindowDriver
    let themeID: ThemeID
    let theme: AppTheme
    let typography: Typography
    let expandRich: Bool
    let hideInputRich: Bool
    let isDemo: Bool
    let sentinelBusy: Bool
    let onFork: (String) -> Void
    let onBranch: (String, String?) -> Void

    nonisolated static func == (l: TranscriptStackView, r: TranscriptStackView) -> Bool {
        l.contentGeneration == r.contentGeneration
            && l.themeID == r.themeID
            && l.typography == r.typography
            && l.expandRich == r.expandRich
            && l.hideInputRich == r.hideInputRich
            && l.isDemo == r.isDemo
            && l.sentinelBusy == r.sentinelBusy
            && l.branchPoints == r.branchPoints
    }

    var body: some View {
        // Sync runs on a REAL rebuild only (a skipped scroll never reaches here,
        // and order is unchanged on a scroll anyway → update(order:) no-ops).
        // Inserted/re-keyed husks get correct membership BEFORE the ForEach.
        let _ = driver.sync(order: items.map(\.id),
                            styleHash: MarkdownStyleCache.style(theme: theme, typography: typography).hashValue)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.element.id) { pair in
                HuskRow(item: pair.element, index: pair.offset, driver: driver,
                        themeID: themeID, theme: theme, typography: typography,
                        expandRich: expandRich, hideInputRich: hideInputRich,
                        onFork: isDemo ? nil : onFork,
                        onBranch: isDemo ? nil : onBranch,
                        branchPointIds: branchPoints)
            }
            bottomSentinel
        }
        .padding()
        .frame(maxWidth: 1100, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
        .scrollTargetLayout()
    }

    private var bottomSentinel: some View {
        Group {
            if sentinelBusy { BusyIndicatorBox(theme: theme) }
            else { Color.clear.frame(height: 2) }
        }
        .id(TranscriptView.bottomSentinelID)
    }
}
