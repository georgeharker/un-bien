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
            // Content width for the analytic height tier — the driver's
            // prewarmWidth is fed by the viewport probe.
            estimateWidth: windowDriver.prewarmWidth,
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
                    windowDriver.prewarmWidth = min(geo.size.width, 1100) - 32
                }
                .onChange(of: geo.size.height) { _, h in
                    viewportHeight = h
                    windowDriver.update(viewportHeight: h)
                }
                .onChange(of: geo.size.width) { _, w in
                    // Width feed for the analytic height tier (rotation/split).
                    windowDriver.prewarmWidth = min(w, 1100) - 32
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
    // Content width for the analytic height tier's estimate channel (0 = off).
    let estimateWidth: Double
    // Session scope for the driver's leading-pass PREWARM keys (design
    // 01M24A9NR) — the same session scoping MarkdownEntitiesView keys under.
    @Environment(\.sessionScope) private var sessionScope
    @Environment(\.cardUIState) private var cardUI
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
        let style = MarkdownStyleCache.style(theme: theme, typography: typography)
        // Leading-window prewarm resolver (design 01M24A9NR): row id → the
        // (bubble id, text, images) warm pair. TEXT-FINAL rows only — a
        // still-streaming bubble must NEVER be warmed (its key is stable
        // across streaming; a partial parse would poison the cache slot).
        // Images ride the pair for the analytic height tier + ImageCache warm.
        // O(n) per rebuild, same order as the order map beside it.
        let warmPairs = Dictionary(
            items.compactMap { item -> (String, (id: String, text: String, images: [WireImage]))? in
                switch item {
                case .assistant(let b) where !b.streaming && (!b.text.isEmpty || !b.images.isEmpty):
                    return (item.id, (id: b.id, text: b.text, images: b.images))
                case .user(let u) where !u.text.isEmpty || !u.images.isEmpty:
                    return (item.id, (id: u.id, text: u.text, images: u.images))
                default: return nil
                }
            }, uniquingKeysWith: { first, _ in first })
        // TOOL-CARD facts resolver (the last uncovered row kind): expansion
        // seeds EXACTLY as ToolCardView does (store override ?? expandRich &&
        // isRich — cards OPEN by default per the pref), so the estimate matches
        // the disclosure state the materialized card actually renders in.
        let toolFacts = Dictionary(
            items.compactMap { item -> (String, RowHeightEstimator.ToolCardFacts)? in
                guard case let .tool(card) = item else { return nil }
                let contentKeys = ["content", "contents", "text", "new_string", "new_str", "newText"]
                let hasContent = contentKeys.contains {
                    (card.args[$0]?.stringValue ?? "").isEmpty == false
                }
                let hasHunks = !(card.hunks ?? []).isEmpty
                var facts = RowHeightEstimator.ToolCardFacts(
                    expanded: cardUI.expanded(card.toolCallID,
                                              default: expandRich && ToolCardView.isRich(card)),
                    hasSwitcher: hasHunks && hasContent,
                    labeledSections: (card.args.isEmpty || hasHunks || hasContent ? 0 : 1)
                        + (card.result != nil && !hasContent ? 1 : 0)
                        + (card.error != nil ? 1 : 0),
                    textLines: 0,
                    imageCount: card.images.count)
                // Mono text lines: the content text if present, else the result
                // string (prefix-bounded while RUNNING — the full-string line
                // count was O(output) per rebuild on main).
                let body: String
                if hasContent {
                    body = contentKeys.compactMap { card.args[$0]?.stringValue }.first ?? ""
                } else if let result = card.result {
                    body = card.state == .running
                        ? String(result.prettyString.prefix(4_000))
                        : result.prettyString
                } else {
                    body = ""
                }
                facts.textLines = body.isEmpty ? 0 : body.split(separator: "\n",
                                                                 omittingEmptySubsequences: false).count
                return (item.id, facts)
            }, uniquingKeysWith: { first, _ in first })
        let _ = driver.sync(order: items.map(\.id), scope: sessionScope, style: style,
                            warmPairFor: { warmPairs[$0] ?? nil },
                            toolFactsFor: { toolFacts[$0] ?? nil },
                            width: estimateWidth)
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
