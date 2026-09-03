import Foundation
import os
import UnBienCore

private let log = Logger(subsystem: "un-bien", category: "relay")

// Scroll + height memory (designs 01M1B9F6 + transcript row-geometry) split
// out of AppModel.swift (its 1000-line cap): remember/restore of the
// last-viewed STABLE row, the retained-heights persistence tier, debounced
// UserDefaults persistence, and per-session pruning. The stored properties
// (`lastViewedScroll`, `heightCache`, the capture-handler registry + their
// didSet hooks) stay on AppModel; this extension only drives them.

extension AppModel {
    // Called from AppModel's `lastViewedScroll` didSet (cross-file) — internal.
    func scheduleScrollPersist() {
        scrollPersistTask?.cancel()
        scrollPersistTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.persistScrollAndHeights()
        }
    }

    // MARK: - Scroll restore

    /// Remembered bottom-most visible STABLE row id for a session, or nil.
    public func rememberedScroll(session: LiveSession) -> String? {
        lastViewedScroll[session.id]
    }

    /// Record the bottom-most visible STABLE row id (view-exit lifecycle
    /// capture; never per-scroll-flip — user, 2026-09-17).
    public func rememberScroll(id: String, session: LiveSession) {
        // Demo sessions never persist scroll memory (their ids are stable
        // across launches — a demo anchor would shadow nothing and pollute
        // the store).
        guard !isDemo(session) else { return }
        guard lastViewedScroll[session.id] != id else { return }
        log.notice("scroll memory → anchor \(String(id.suffix(8)), privacy: .public) key=\(String(session.id.suffix(8)), privacy: .public)")
        lastViewedScroll[session.id] = id
    }

    /// Heights retained for `session` under the CURRENT layout fingerprint —
    /// nil when absent or stale (font/theme/scale changed ⇒ never seed).
    public func seedHeights(for session: LiveSession) -> [String: Double]? {
        guard !isDemo(session),
              let entry = heightCache[session.id],
              entry.fingerprint == layoutFingerprint() else { return nil }
        return entry.heights
    }

    /// Record a session's retained heights (view-exit lifecycle capture).
    public func rememberHeights(_ heights: [String: Double], session: LiveSession) {
        guard !isDemo(session), !heights.isEmpty else { return }
        heightCache[session.id] = HeightCacheEntry(fingerprint: layoutFingerprint(),
                                                   heights: heights, at: Date())
    }

    /// The layout-affecting fingerprint for the height cache: text scale +
    /// font choices + theme. Deliberately NOT width — rotation staleness
    /// self-heals as seeded rows re-measure on scroll-through.
    func layoutFingerprint() -> String {
        let body = bodyFontName ?? "-"
        let mono = monoFontName ?? "-"
        return "\(themeID.rawValue)|\(body)|\(mono)|\(String(format: "%.2f", textScale))"
    }

    /// IMMEDIATE persistence (no debounce) — call when the app leaves the
    /// foreground (iOS backgrounding) or is about to terminate (macOS quit):
    /// the debounced write loses the final state when the user quits inside
    /// the 500ms window, and process termination never runs the pending Task
    /// (macOS quit doesn't reliably pass through scenePhase either).
    @MainActor
    public func flushScrollMemory() {
        scrollPersistTask?.cancel()
        // LIFECYCLE capture: ask every open view for its CURRENT position and
        // heights — capture happens HERE (and at view exit), never per-flip.
        for (key, capture) in scrollCaptureHandlers {
            let payload = capture()
            if let anchor = payload.anchor { lastViewedScroll[key] = anchor }
            if !payload.heights.isEmpty {
                heightCache[key] = HeightCacheEntry(fingerprint: layoutFingerprint(),
                                                    heights: payload.heights, at: Date())
            }
        }
        trimHeightCache()
        log.notice("scroll memory flush → persisting now (\(self.lastViewedScroll.count, privacy: .public) sessions, \(self.heightCache.count, privacy: .public) height-cached)")
        persistScrollAndHeights()
    }

    /// Persist both stores in one write (they flush together by design —
    /// same lifecycle moments, same pruning).
    private func persistScrollAndHeights() {
        if let data = try? JSONEncoder().encode(lastViewedScroll) {
            UserDefaults.standard.set(data, forKey: Self.lastViewedScrollKey)
        }
        if let data = try? JSONEncoder().encode(heightCache) {
            UserDefaults.standard.set(data, forKey: Self.heightCacheKey)
        }
        log.notice("scroll memory persisted (\(self.lastViewedScroll.count, privacy: .public) sessions, \(self.heightCache.count, privacy: .public) height-cached)")
    }

    /// Load the height cache at init (call once, from AppModel.init).
    func loadHeightCache() {
        guard let data = UserDefaults.standard.data(forKey: Self.heightCacheKey),
              let saved = try? JSONDecoder().decode([String: HeightCacheEntry].self, from: data) else { return }
        heightCache = saved
        log.notice("height cache loaded (\(saved.count, privacy: .public) sessions)")
    }

    /// Cap the height cache at the newest `maxHeightCacheSessions` sessions —
    /// heights are small but unbounded growth across a long-lived install
    /// is still junk (dropped/ended sessions prune entirely in forgetSession).
    private static let maxHeightCacheSessions = 20
    private func trimHeightCache() {
        guard heightCache.count > Self.maxHeightCacheSessions else { return }
        let newest = heightCache.values.map(\.at).max() ?? Date.distantPast
        let cutoff = heightCache.sorted { $0.value.at < $1.value.at }
            .prefix(heightCache.count - Self.maxHeightCacheSessions)
            .map(\.key)
        for key in cutoff { heightCache[key] = nil }
        log.notice("height cache trimmed \(newest, privacy: .public) → \(self.heightCache.count, privacy: .public) sessions")
    }

    /// Drop a dropped/ended session's remembered scroll + heights (persists
    /// immediately) — otherwise they accumulate as rooms end.
    func forgetSession(key: String) {
        lastViewedScroll[key] = nil
        heightCache[key] = nil
        // Flush immediately — the didSet only schedules a debounced write.
        scrollPersistTask?.cancel()
        persistScrollAndHeights()
    }
}


// touch
