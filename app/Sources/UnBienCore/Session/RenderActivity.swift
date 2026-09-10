import Foundation

/// Approximate activity counters for the on-device debug HUD — lets you SEE
/// whether the transcript is quiescent or quietly rebuilding/reproducing /
/// paging in the background. `nonisolated(unsafe)` plain Ints: best-effort debug
/// tallies, so a racy increment that miscounts by one is fine and costs zero
/// synchronization on the hot paths. In-flight = started - finished/retired.
public enum RenderActivity {
    /// Off-main entity parses kicked off (MarkdownEntityStore.produce).
    public nonisolated(unsafe) static var produceStarted = 0
    /// produce calls that JOINED an already-running parse for the same key
    /// (single-flight dedup) — nonzero while scrolling means the dedup is
    /// SAVING a duplicate parse. Design 01M24A9NR.
    public nonisolated(unsafe) static var produceJoined = 0
    /// Split gauges for the LAST produce: SELF = parse CPU (timed INSIDE the
    /// detached closure, bg-written — best-effort per this enum's contract);
    /// WAIT = wall − self (spawn + queue + hop-back). WAIT ≫ SELF = contention
    /// (pool busy / QoS preemption), not a slow parse. produceLastMicros stays
    /// the WALL total.
    public nonisolated(unsafe) static var produceSelfMicros = 0
    public nonisolated(unsafe) static var produceWaitMicros = 0
    /// PREWARM-triggered parses actually launched (post cap), and ones DEFERRED
    /// by the in-flight cap (scroll-contention guard) — deferred climbing while
    /// scrolling is the self-throttle working; deferred climbing at REST would
    /// mean the cap starves the leading pass. Design 01M24A9NR.
    public nonisolated(unsafe) static var prewarmStarted = 0
    public nonisolated(unsafe) static var prewarmDeferred = 0
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
    /// Last reset's path sizes + leading common-prefix length. With
    /// lastResetReason these distinguish TRUNCATION (new < old — an
    /// authoritative refetch shorter than the local render / a dropped temp
    /// bubble) from a MIDDLE-FILL reshape (common prefix stops MID-path, not at
    /// 0 or min(old,new)). Gauges (direct-read, not raw()). Design 01M1X582.
    public nonisolated(unsafe) static var lastResetOldCount = 0
    public nonisolated(unsafe) static var lastResetNewCount = 0
    public nonisolated(unsafe) static var lastResetCommonPrefix = 0
    /// Which branch the last derivePath took: defer-turn / defer-trunc / nochange
    /// / extend(N) / reset(reason) / render(N). Names the cold-launch withhold.
    public nonisolated(unsafe) static var lastDerivePath = ""
    /// Row-height MEASURES that arrived (heightProbe fired; synchronous, not bg).
    public nonisolated(unsafe) static var boundsMeasured = 0
    /// Row-height measures that actually STORED a changed value (measured minus
    /// set = no-op re-measures = wasteful churn).
    public nonisolated(unsafe) static var boundsSet = 0
    /// get_entries responses for a SUPERSEDED walk chain (!isCurrentWalk) —
    /// reconnect-storm stragglers / redelivery (the surplus).
    public nonisolated(unsafe) static var getEntriesStraggler = 0
    /// GAUGES (not monotonic; not in raw()) — last computeWindow duration (µs)
    /// and the resulting near-set size (window recompute cost + membership).
    public nonisolated(unsafe) static var lastWindowMicros = 0
    public nonisolated(unsafe) static var nearCount = 0
    /// Materialize: last MarkdownEntityStore.produce duration (µs) — gauge.
    public nonisolated(unsafe) static var produceLastMicros = 0
    /// Entity cache occupancy + cumulative evictions (gauges). Evictions climbing
    /// = a >cap session under pressure — the regime the leading-window protection
    /// (never evict what we're scrolling toward, 01M1Y1GK) exists for.
    public nonisolated(unsafe) static var entityCacheCount = 0
    public nonisolated(unsafe) static var entityCacheEvicted = 0
    /// Last scroll direction the driver derived from the view's anchor (+1 toward
    /// newest, -1 toward oldest, 0 idle) — the leading edge it protects.
    public nonisolated(unsafe) static var scrollDir = 0
    /// Walk lifecycle (plan 01M1YYYVT diagnosis): starts, terminals (completed),
    /// stalls (watchdog retries), + the last walk's kind (full | delta:<leaf>).
    /// starts climbing while terminals lags = walks not completing.
    public nonisolated(unsafe) static var walkStarts = 0
    public nonisolated(unsafe) static var walkTerminals = 0
    public nonisolated(unsafe) static var walkStalls = 0
    public nonisolated(unsafe) static var lastWalkInfo = ""
    /// Swift callback-surface probes (monotonic, in raw() — HUD delta per 0.5s
    /// reveals fan-out). ALL incremented in EVENT handlers / store logic, NEVER
    /// a view body (a body side-effect broke rendering, 2026-09-07): husk
    /// flip-subscription deliveries (onReceive fan-out, ~N/crossing),
    /// scrollAnchor CROSSINGS (the transcriptStack body-rebuild TRIGGER — one
    /// per crossing, each fanning to N husk builds), scroll-geometry callbacks
    /// (per frame), height-probe callbacks (per near-row height change).
    public nonisolated(unsafe) static var huskFlipCallbacks = 0
    public nonisolated(unsafe) static var scrollAnchorCrossings = 0
    public nonisolated(unsafe) static var scrollGeomCallbacks = 0
    public nonisolated(unsafe) static var heightProbeCallbacks = 0

    /// Raw counters in a fixed order; the HUD diffs successive reads to colour
    /// tokens that moved. Order: produceStarted, produceFinished, window,
    /// reset, extend, getEntriesStarted, getEntriesRetired.
    public static func raw() -> [Int] {
        [produceStarted, produceFinished, windowRecomputed, transcriptReset,
         pathExtended, getEntriesStarted, getEntriesRetired, getEntriesCached,
         boundsInvalidated, boundsMeasured, boundsSet, getEntriesStraggler,
         huskFlipCallbacks, scrollAnchorCrossings, scrollGeomCallbacks, heightProbeCallbacks]
    }
}
