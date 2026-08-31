import Foundation
import UnBienCore

// Scroll memory (design 01M1B9F6) split out of AppModel.swift (its 1000-line
// cap): remember/restore of the last-viewed STABLE row, debounced UserDefaults
// persistence, and per-session pruning. The `lastViewedScroll` store + its
// didSet (which schedules the debounced persist) stay on AppModel; this
// extension only drives them.

extension AppModel {
    // Called from AppModel's `lastViewedScroll` didSet (cross-file) — internal.
    func scheduleScrollPersist() {
        scrollPersistTask?.cancel()
        scrollPersistTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.persistLastViewedScroll()
        }
    }

    // MARK: - Scroll restore

    /// Remembered bottom-most visible STABLE row id for a session, or nil.
    public func rememberedScroll(session: LiveSession) -> String? {
        lastViewedScroll[session.id]
    }

    /// Record the bottom-most visible STABLE row id as the user scrolls
    /// (design 01M1B9F6).
    public func rememberScroll(id: String, session: LiveSession) {
        // Demo sessions never persist scroll memory (their ids are stable
        // across launches — a demo anchor would shadow nothing and pollute
        // the store).
        guard !isDemo(session) else { return }
        guard lastViewedScroll[session.id] != id else { return }
        lastViewedScroll[session.id] = id
    }

    private func persistLastViewedScroll() {
        guard let data = try? JSONEncoder().encode(lastViewedScroll) else { return }
        UserDefaults.standard.set(data, forKey: Self.lastViewedScrollKey)
    }

    /// Drop a dropped/ended session's remembered scroll (didSet re-persists, so
    /// the on-disk copy prunes too) — otherwise it accumulates as rooms end.
    func forgetSession(key: String) {
        lastViewedScroll[key] = nil
        // Flush immediately — the didSet only schedules a debounced write.
        scrollPersistTask?.cancel()
        persistLastViewedScroll()
    }
}
