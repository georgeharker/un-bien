import SwiftUI
import UnBienCore

/// One windowed-layout row (design: transcript row-geometry): the HUSK —
/// identity + measured-height state + claimed frame, permanent in the
/// hierarchy — with its content subtree attached only while near. Cycling out
/// FREEZES to the last measured height; the streaming tail is near by
/// definition (the only growing region — and the only PENDING id region,
/// id-scheme v2: a re-key recreates the husk and its probe re-measures).
///
/// Split from TranscriptView.swift at the 1000-line cap. Internal (not
/// private) so TranscriptView's windowed stack can construct it.
struct HuskRow: View {
    let item: TranscriptItem
    let index: Int
    let driver: TranscriptWindowDriver
    let themeID: ThemeID
    let theme: AppTheme
    let typography: Typography
    let expandRich: Bool
    let hideInputRich: Bool
    /// Fork/Branch actions (pre-release 2026-09-18): closures keep HuskRow
    /// value-structured (no model dependency — Equatable economy preserved);
    /// the construction site owns session/model scope. entryID is the pi
    /// entry id of the durable row; `prefill` is the row's own text for the
    /// Branch composer prefill (user messages).
    var onFork: ((String) -> Void)?
    var onBranch: ((String, String?) -> Void)?
    /// Fork-point entry ids (>1 child) — the construction site passes the
    /// session's set; the row annotates its own durable id.
    let branchPointIds: Set<String>

    @State private var isNear: Bool
    @State private var measuredHeight: Double?

    init(item: TranscriptItem, index: Int, driver: TranscriptWindowDriver,
         themeID: ThemeID, theme: AppTheme, typography: Typography,
         expandRich: Bool, hideInputRich: Bool,
         onFork: ((String) -> Void)? = nil,
         onBranch: ((String, String?) -> Void)? = nil,
         branchPointIds: Set<String> = []) {
        self.item = item
        self.index = index
        self.driver = driver
        self.themeID = themeID
        self.theme = theme
        self.typography = typography
        self.expandRich = expandRich
        self.hideInputRich = hideInputRich
        self.onFork = onFork
        self.onBranch = onBranch
        self.branchPointIds = branchPointIds
        _isNear = State(initialValue: driver.isNear(index))
    }

    /// The row's pi entry id when the row is DURABLE (entry-keyed, anchorable)
    /// — pendings (synthetic ids) offer no fork/branch (their entries haven't
    /// landed). Also the row's plain text for Copy / the Branch prefill.
    private var durableEntryID: String? {
        // anchorID != nil IS the durable gate (id-scheme v2: pendings are
        // anchorless; re-keyed rows carry their pi entry id). The early
        // length heuristic was WRONG — pi entry ids are 8 chars (run
        // 2026-09-18: "I see copy, no fork / branch" — every real id
        // rejected). Just strip the row-kind prefix.
        guard item.anchorID != nil else { return nil }
        let id = item.id
        for prefix in ["user:", "assistant:"] where id.hasPrefix(prefix) {
            return String(id.dropFirst(prefix.count))
        }
        return nil
    }

    /// The /tree selection rule (run 2026-09-18): branching from a USER
    /// message places its text in the editor (the resubmit shape); from an
    /// assistant message the editor stays EMPTY (the continue shape).
    private var branchPrefill: String? {
        if case .user = item { return rowText }
        return nil
    }

    private var rowText: String? {
        switch item {
        case let .user(bubble): return bubble.text
        case let .assistant(bubble): return bubble.text
        default: return nil
        }
    }

    /// Long-press a message row (user 2026-09-18): Copy / Fork From Here /
    /// Branch From Here. Fork + Branch need a DURABLE row (its pi entry);
    /// pendings offer Copy only. Tool/reasoning rows have no menu.
    @ViewBuilder private var rowMenu: some View {
        if let text = rowText {
            Button {
                #if os(macOS)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                #else
                UIPasteboard.general.string = text
                #endif
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            if let entryID = durableEntryID {
                Button {
                    onFork?(entryID)
                } label: {
                    Label("Fork From Here", systemImage: "arrow.triangle.branch")
                }
                Button {
                    onBranch?(entryID, branchPrefill)
                } label: {
                    Label("Branch From Here", systemImage: "arrow.triangle.turn.up.right.circle")
                }
            }
        }
    }

    var body: some View {
        Group {
            if isNear {
                TranscriptRow(item: item, themeID: themeID, theme: theme,
                              typography: typography, expandRich: expandRich,
                              hideInputRich: hideInputRich,
                              isBranchPoint: durableEntryID.map { branchPointIds.contains($0) } ?? false)
                    .equatable()
                    .background(heightProbe)
                    .contextMenu { rowMenu }
            } else {
                // Far husk: an explicit frame IS the bounds — not self-sized,
                // no content, no measurement. Height comes from the husk's
                // own measurement, else the REGISTRY (seeded / re-key-migrated
                // — keeps rendered layout consistent with the driver's window
                // arithmetic, see knownHeight), else the fallback. GHOST-
                // TINTED so an anomalous placeholder-on-screen reads as
                // LOADING, not blank — normal operation never shows these
                // (flips happen beyond the viewport's ±pages margin).
                // Never-measured rows fall back (SMALL constant: the window
                // then over-includes, never under).
                Color.clear
                    .frame(height: measuredHeight
                            ?? driver.knownHeight(for: item.id)
                            ?? driver.fallbackHeight)
                    .background(theme.surface.opacity(0.35),
                                in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .onReceive(driver.flips) { flip in
            // SET semantics (never toggle): heals to the driver's truth on any
            // desync instead of inverting (the toggle version could mass-off
            // on viewport invalidation and blank the screen).
            if flip.on.contains(index) { isNear = true }
            else if flip.off.contains(index) { isNear = false }
        }
    }

    /// Measure-on-layout (the existing probe pattern — no availability risk):
    /// writes the husk's own @State (render source) AND the driver's registry
    /// (arithmetic source — SwiftUI has no parent-reads-child-state channel).
    /// Fires on attach AND on every growth step, so the streaming row stays
    /// live and the window math follows it.
    private var heightProbe: some View {
        GeometryReader { geo in
            Color.clear
                .onAppear { record(geo.size.height) }
                .onChange(of: geo.size.height) { _, h in record(h) }
        }
    }

    private func record(_ height: Double) {
        measuredHeight = height
        driver.record(id: item.id, height: height)
    }
}
