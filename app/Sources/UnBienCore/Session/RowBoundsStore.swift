import Foundation

/// Retained registry of measured transcript-row heights — the "we know the
/// bounds of every render block" store (DESIGN: transcript render performance).
///
/// Distinct from the rendered-content caches (highlight/image): bounds are tiny
/// (one number per block), so this is NOT LRU-bounded and does NOT churn. It
/// retains every measured height for the whole conversation and flushes only on
/// conversation close / leaving the view (`clear`) or a layout-affecting change
/// (`invalidate` — width / font / textScale / theme metrics bump the generation
/// and drop all heights to force re-measure). A content artifact being evicted
/// never loses a block's height.
///
/// Coverage is lazy-but-permanent: `LazyVStack` only builds visible rows, so
/// each block's height is registered the first time it is seen and then kept —
/// so once a block has scrolled past, its bounds are known for later offset /
/// layout math without rebuilding it.
public struct RowBoundsStore: Sendable, Equatable {
    /// Where a retained height came from. Measured and restored heights are
    /// exact (a restored one was measured in an earlier run); an estimate
    /// stands in for a row that hasn't rendered yet and is replaced by its
    /// measurement, or by a better estimate, but never replaces an exact one.
    public enum Source: Sendable, Equatable {
        case measured
        case restored
        case estimated
    }

    public struct Entry: Sendable, Equatable {
        public let height: Double
        public let source: Source
    }

    /// Bumped whenever a layout-affecting input changes; a new generation means
    /// the retained heights are stale and were dropped.
    public private(set) var generation: Int = 0
    private var entries: [String: Entry] = [:]

    public init() {}

    public var count: Int { entries.count }

    /// Record (or update) a measured row height. Retained until `invalidate`/`clear`.
    public mutating func record(id: String, height: Double) {
        entries[id] = Entry(height: height, source: .measured)
    }

    /// Record an estimate for a row that has no exact height (none yet, or
    /// only an earlier estimate). Returns whether it was kept.
    @discardableResult
    public mutating func estimate(id: String, height: Double) -> Bool {
        guard needsEstimate(id: id) else { return false }
        entries[id] = Entry(height: height, source: .estimated)
        return true
    }

    /// Whether an estimate for `id` would be kept: no height, or only an
    /// estimate. Callers skip building one otherwise.
    public func needsEstimate(id: String) -> Bool {
        entries[id].map { $0.source == .estimated } ?? true
    }

    public func height(id: String) -> Double? { entries[id]?.height }

    public func entry(id: String) -> Entry? { entries[id] }

    public func contains(id: String) -> Bool { entries[id] != nil }

    /// Every retained height, estimates included (layout math).
    public var allHeights: [String: Double] { entries.mapValues(\.height) }

    /// The exact heights (measured or restored), the persistence-tier capture
    /// source (see TranscriptWindowDriver.seedHeights for the restore side).
    /// Estimates are never persisted: a restored height is treated as exact.
    public var exactHeights: [String: Double] {
        entries.compactMapValues { $0.source == .estimated ? nil : $0.height }
    }

    /// Bulk-seed retained heights (persistence restore). Measured values
    /// overwrite seeds as rows re-measure, so any staleness (e.g. a rotation
    /// the fingerprint can't see) self-heals on scroll-through.
    public mutating func seed(_ heights: [String: Double]) {
        for (id, height) in heights where height > 0 {
            entries[id] = Entry(height: height, source: .restored)
        }
    }

    /// Carry `from`'s entry, with its source, to `to` (a row re-keyed in place).
    public mutating func carry(from: String, to: String) {
        if let entry = entries[from] { entries[to] = entry }
    }

    /// Offset-from-top of `id` = summed heights of the blocks before it in
    /// `order`. Returns nil if `id` isn't in `order`, or if any preceding block's
    /// height hasn't been measured yet (offset is only exact once they're known).
    /// O(n) — back with a prefix-sum/Fenwick tree only if consumed at scroll rate.
    public func offset(before id: String, order: [String]) -> Double? {
        guard let end = order.firstIndex(of: id) else { return nil }
        var total = 0.0
        for other in order[..<end] {
            guard let height = entries[other]?.height else { return nil }
            total += height
        }
        return total
    }

    /// Total height of `order` (nil if any block is unmeasured).
    public func totalHeight(order: [String]) -> Double? {
        var total = 0.0
        for id in order {
            guard let height = entries[id]?.height else { return nil }
            total += height
        }
        return total
    }

    /// A layout-affecting change (width / font / textScale / theme) — bump the
    /// generation and drop all retained heights so they re-measure.
    public mutating func invalidate() {
        generation += 1
        entries.removeAll(keepingCapacity: true)
    }

    /// Conversation closed / left the view — drop everything.
    public mutating func clear() {
        entries.removeAll()
    }

    // MARK: - Geometric window (windowed transcript layout)

    /// The near window CENTERED ON A ROW INDEX — IDENTITY-ANCHORED windowing
    /// (the rendered state's truth): expand outward from `center` until the
    /// page budget is spent above and below. Immune to registry-vs-rendered
    /// height divergence ABOVE the viewport — the old raw-offset mapping
    /// accumulated every stale-seed/unmeasured row's error into the window
    /// position and could strand the live tail outside its own window (the
    /// blank-at-bottom hang, run 2026-09-17); centering on the anchor row
    /// only involves LOCAL heights, and unmeasured locals just over-include
    /// — the safe direction. The center row is ALWAYS included (it is on
    /// screen by definition).
    public func windowRangeAroundIndex(order: [String], center: Int,
                                       viewportHeight: Double, pages: Double,
                                       spacing: Double, fallbackHeight: Double) -> Range<Int> {
        guard !order.isEmpty, viewportHeight > 0 else { return 0..<0 }
        let c = min(max(center, 0), order.count - 1)
        // INTERSECTION semantics (run 2026-09-18: the whole-row-fits test
        // dropped TALL rows while their bottoms were still on screen — a
        // row taller than the page budget flipped far the moment the anchor
        // passed below it, the position-dependent "bubble dropping out").
        // A row is in the window if ANY part of it lies within the band:
        // include rows whose TOP is inside the budget; a straddling row
        // (top inside, body beyond) is INCLUDED — bounded over-inclusion,
        // the safe direction — and the walk stops once the budget is spent.
        // Downward (toward the tail); the center row is included unconditionally.
        var last = c
        var budget = (1 + pages) * viewportHeight
        var i = c
        while i < order.count {
            if i > c, budget <= 0 { break }
            budget -= (entries[order[i]]?.height ?? fallbackHeight) + spacing
            last = i
            i += 1
        }
        // Upward (toward the head).
        var first = c
        var upBudget = pages * viewportHeight
        i = c - 1
        while i >= 0 {
            if upBudget <= 0 { break }
            upBudget -= (entries[order[i]]?.height ?? fallbackHeight) + spacing
            first = i
            i -= 1
        }
        return first..<last + 1
    }
    /// `[scrollY − pages·viewport, scrollY + (1+pages)·viewport]` — "near":
    /// content attached; everything else renders as a fixed-frame husk.
    /// `scrollY` = content offset (0 = content top at viewport top); row tops
    /// accumulate measured heights (unmeasured count as `fallbackHeight`) plus
    /// the fixed `spacing`, from `contentInset` (the probe+padding constant
    /// above row 0 — errors shift the window uniformly, negligible at page
    /// scale). A SMALL fallback underestimates far offsets, so the window
    /// OVER-includes — erring toward attached content, never an on-screen
    /// placeholder. Single O(n) pass; the driver calls it per window update
    /// (gated), not per frame.
    public func windowRange(order: [String], scrollY: Double, viewportHeight: Double,
                            pages: Double, spacing: Double, fallbackHeight: Double,
                            contentInset: Double = 17) -> Range<Int> {
        guard !order.isEmpty, viewportHeight > 0 else { return 0..<0 }
        let windowMin = scrollY - pages * viewportHeight
        let windowMax = scrollY + (1 + pages) * viewportHeight
        var top = contentInset
        var first: Int?
        var last = -1
        for (i, id) in order.enumerated() {
            let h = entries[id]?.height ?? fallbackHeight
            if first == nil, top + h > windowMin { first = i }
            if top < windowMax { last = i }
            top += h + spacing
        }
        guard let start = first, last >= start else { return 0..<0 }
        return start..<min(last + 1, order.count)
    }

    /// The bottom-most VISIBLE row (top above the viewport's bottom edge) — the
    /// windowed layout's scroll-memory capture source (replaces lazy-stack
    /// materialization tracking). Approximate in unmeasured regions; scroll
    /// memory tolerates that (restore walks to the nearest stable anchor).
    public func bottomVisibleIndex(order: [String], scrollY: Double, viewportHeight: Double,
                                   spacing: Double, fallbackHeight: Double,
                                   contentInset: Double = 17) -> Int? {
        guard !order.isEmpty, viewportHeight > 0 else { return nil }
        var top = contentInset
        var last: Int?
        for (i, id) in order.enumerated() {
            guard top < scrollY + viewportHeight else { break }
            last = i
            top += (entries[id]?.height ?? fallbackHeight) + spacing
        }
        return last
    }
}
