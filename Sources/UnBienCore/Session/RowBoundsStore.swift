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
    /// Bumped whenever a layout-affecting input changes; a new generation means
    /// the retained heights are stale and were dropped.
    public private(set) var generation: Int = 0
    private var heights: [String: Double] = [:]

    public init() {}

    public var count: Int { heights.count }

    /// Record (or update) a measured row height. Retained until `invalidate`/`clear`.
    public mutating func record(id: String, height: Double) {
        heights[id] = height
    }

    public func height(id: String) -> Double? { heights[id] }

    public func contains(id: String) -> Bool { heights[id] != nil }

    /// Offset-from-top of `id` = summed heights of the blocks before it in
    /// `order`. Returns nil if `id` isn't in `order`, or if any preceding block's
    /// height hasn't been measured yet (offset is only exact once they're known).
    /// O(n) — back with a prefix-sum/Fenwick tree only if consumed at scroll rate.
    public func offset(before id: String, order: [String]) -> Double? {
        guard let end = order.firstIndex(of: id) else { return nil }
        var total = 0.0
        for other in order[..<end] {
            guard let height = heights[other] else { return nil }
            total += height
        }
        return total
    }

    /// Total height of `order` (nil if any block is unmeasured).
    public func totalHeight(order: [String]) -> Double? {
        var total = 0.0
        for id in order {
            guard let height = heights[id] else { return nil }
            total += height
        }
        return total
    }

    /// A layout-affecting change (width / font / textScale / theme) — bump the
    /// generation and drop all retained heights so they re-measure.
    public mutating func invalidate() {
        generation += 1
        heights.removeAll(keepingCapacity: true)
    }

    /// Conversation closed / left the view — drop everything.
    public mutating func clear() {
        heights.removeAll()
    }
}
