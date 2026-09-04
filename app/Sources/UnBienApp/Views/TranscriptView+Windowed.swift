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
        let ids = items.map(\.id)
        // Fork points (>1 child) for the branch-glyph annotation — computed
        // ONCE per body, not per row.
        let branchPoints = model.transcripts[session.id]?.branchPointIds ?? []
        // Body-time sync (idempotent, gated): inserted/re-keyed husks read
        // correct initial membership BEFORE the ForEach builds them.
        let _ = windowDriver.sync(order: ids)
        return VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.element.id) { pair in
                HuskRow(item: pair.element, index: pair.offset, driver: windowDriver,
                        themeID: model.themeID, theme: theme, typography: typography,
                        expandRich: model.expandRichToolResults,
                        hideInputRich: model.hideInputWhenRich,
                        onFork: model.isDemo(session) ? nil : { entryID in
                            Task { await model.forkFromEntry(session, entryID: entryID) }
                        },
                        onBranch: model.isDemo(session) ? nil : { entryID, prefill in
                            Task { await model.branchFromEntry(session, entryID: entryID,
                                                               prefill: prefill) }
                        },
                        branchPointIds: branchPoints)
            }
            bottomSentinel
        }
        .padding()
        // Cap line length on wide windows; centered. No-op on phones.
        .frame(maxWidth: 1100, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
        // Register rows + sentinel as scroll targets so the scrollPosition
        // binding can address them by id (design: scroll-position pin;
        // prototype-verified).
        .scrollTargetLayout()
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

    /// The bottom sentinel cell: the busy "…" box while a turn runs, an
    /// invisible 2pt cell when idle. Its id is the scrollPosition binding's
    /// bottom target (arm / follow / re-trigger all bind HERE, and the
    /// two-way readout reports it when the user settles at the bottom). No
    /// probe, no sensor duty — the scroll-view geometry source owns the
    /// window's position input (main file).
    var bottomSentinel: some View {
        Group {
            if model.activeTurnID(for: session) != nil, !model.hasEnded(session) {
                BusyIndicatorBox(theme: theme)
            } else {
                Color.clear.frame(height: 2)
            }
        }
        .id(Self.bottomSentinelID)
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
