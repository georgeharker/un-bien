import Foundation

/// A bounded, least-recently-USED store stamped by a monotonic use-sequence —
/// the retention policy shared by both render caches (MarkdownEntityStore and
/// AttributedTextCache). Design 01M1Y1GK.
///
/// TOUCH IS O(1): bump the clock, stamp the key — no array reorder. The only
/// O(n) work is the find-min victim search in `evictIfNeeded`, and that runs
/// ONLY on a purge (insert-over-cap or a `cap` decrease), NEVER on a touch or a
/// peek. PEEK (`value`) reads WITHOUT touching — the render-path read must not
/// reorder recency (a SwiftUI body must never touch the LRU).
///
/// NOT thread-safe by itself: callers confine it (MarkdownEntityStore is
/// @MainActor, uses it bare) or guard it (AttributedTextCache holds its
/// OSAllocatedUnfairLock around these O(1) accessors).
struct SeqStampLRU<Key: Hashable, Value> {
    private var store: [Key: Value] = [:]
    private var useSeq: [Key: Int] = [:]
    private var clock = 0

    /// Retention bound. Lowering it purges immediately (didSet).
    var cap: Int { didSet { evictIfNeeded() } }

    init(cap: Int) { self.cap = cap }

    var count: Int { store.count }

    /// PEEK — read without touching recency (the render-path read).
    func value(_ key: Key) -> Value? { store[key] }

    /// Read + stamp MRU (the materialise path: order = scroll direction, so the
    /// leading edge lands MRU and evicts last).
    mutating func hit(_ key: Key) -> Value? {
        guard let v = store[key] else { return nil }
        clock += 1; useSeq[key] = clock
        return v
    }

    mutating func insert(_ key: Key, _ value: Value) {
        store[key] = value
        clock += 1; useSeq[key] = clock
        evictIfNeeded()
    }

    mutating func removeAll(keepingCapacity: Bool = false) {
        store.removeAll(keepingCapacity: keepingCapacity)
        useSeq.removeAll(keepingCapacity: keepingCapacity)
    }

    /// Evict least-recently-USED (min seq) past the cap. O(n) find-min, on PURGE
    /// only — never on a touch or a render read.
    mutating func evictIfNeeded() {
        while store.count > cap, let victim = useSeq.min(by: { $0.value < $1.value })?.key {
            store[victim] = nil
            useSeq[victim] = nil
        }
    }
}
