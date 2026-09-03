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

    @State private var isNear: Bool
    @State private var measuredHeight: Double?

    init(item: TranscriptItem, index: Int, driver: TranscriptWindowDriver,
         themeID: ThemeID, theme: AppTheme, typography: Typography,
         expandRich: Bool, hideInputRich: Bool) {
        self.item = item
        self.index = index
        self.driver = driver
        self.themeID = themeID
        self.theme = theme
        self.typography = typography
        self.expandRich = expandRich
        self.hideInputRich = hideInputRich
        _isNear = State(initialValue: driver.isNear(index))
    }

    var body: some View {
        Group {
            if isNear {
                TranscriptRow(item: item, themeID: themeID, theme: theme,
                              typography: typography, expandRich: expandRich,
                              hideInputRich: hideInputRich)
                    .equatable()
                    .background(heightProbe)
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
