import Foundation

/// Approximate activity counters for the on-device debug HUD — lets you SEE
/// whether the transcript is quiescent or quietly rebuilding/reproducing /
/// paging in the background. `nonisolated(unsafe)` plain Ints: best-effort debug
/// tallies, so a racy increment that miscounts by one is fine and costs zero
/// synchronization on the hot paths. In-flight = started - finished/retired.
public enum RenderActivity {
    /// Off-main entity parses kicked off (MarkdownEntityStore.produce).
    public nonisolated(unsafe) static var produceStarted = 0
    /// Off-main entity parses that completed + cached.
    public nonisolated(unsafe) static var produceFinished = 0
    /// Window membership recomputes that actually ran (past the early-outs).
    public nonisolated(unsafe) static var windowRecomputed = 0
    /// Full transcript teardowns (derivePath divergence / branch).
    public nonisolated(unsafe) static var transcriptReset = 0
    /// Incremental rootward path extensions (backfill prepend, no reset).
    public nonisolated(unsafe) static var pathExtended = 0
    /// get_entries requests sent (backfill paging + delta refetch).
    public nonisolated(unsafe) static var getEntriesStarted = 0
    /// get_entries WIRE responses folded (sent & resolved).
    public nonisolated(unsafe) static var getEntriesRetired = 0
    /// Entry folds served from the LOCAL entry cache (no wire round-trip).
    public nonisolated(unsafe) static var getEntriesCached = 0
    /// RowBoundsStore generation bumps (layout invalidations that drop all
    /// retained heights, forcing a full re-measure).
    public nonisolated(unsafe) static var boundsInvalidated = 0
    /// Why the last transcript reset fired: busy (non-quiet) / ext (extension
    /// but non-quiet) / shape (same-line but not a clean extension) / diverge
    /// (branch). Shown on the HUD reset row to explain a reset in the act.
    public nonisolated(unsafe) static var lastResetReason = ""
    /// Row-height MEASURES that arrived (heightProbe fired; synchronous, not bg).
    public nonisolated(unsafe) static var boundsMeasured = 0
    /// Row-height measures that actually STORED a changed value (measured minus
    /// set = no-op re-measures = wasteful churn).
    public nonisolated(unsafe) static var boundsSet = 0
    /// get_entries responses for a SUPERSEDED walk chain (!isCurrentWalk, not a
    /// delta refetch) — reconnect-storm stragglers / redelivery (the surplus).
    public nonisolated(unsafe) static var getEntriesStraggler = 0
    /// get_entries responses that are per-turn message_end DELTA REFETCHES
    /// (also !isCurrentWalk, but expected — one per turn end).
    public nonisolated(unsafe) static var getEntriesRefetch = 0

    /// Raw counters in a fixed order; the HUD diffs successive reads to colour
    /// tokens that moved. Order: produceStarted, produceFinished, window,
    /// reset, extend, getEntriesStarted, getEntriesRetired.
    public static func raw() -> [Int] {
        [produceStarted, produceFinished, windowRecomputed, transcriptReset,
         pathExtended, getEntriesStarted, getEntriesRetired, getEntriesCached,
         boundsInvalidated, boundsMeasured, boundsSet, getEntriesStraggler,
         getEntriesRefetch]
    }
}
