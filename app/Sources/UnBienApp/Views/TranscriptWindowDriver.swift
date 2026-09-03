import Combine
import Foundation
import os
import UnBienCore

#if DEBUG
/// Window-driver diagnostics (iOS scroll-hang diagnosis, 2026-09-17): recompute
/// wall-times, rejected scroll offsets, and suspect height records. Read with
/// the scroll category:
/// `log stream --level debug --predicate 'subsystem == "un-bien" AND category == "scroll"'`
private let driverLog = Logger(subsystem: "un-bien", category: "scroll")
private func dbgDriverLog(_ message: String) {
    driverLog.info("\(message, privacy: .public)")
}
#else
private func dbgDriverLog(_ message: String) {}
#endif

/// The windowed-transcript engine (design: transcript row-geometry — geometric
/// window, husk rows). Owns the bounds registry (the ARITHMETIC source — SwiftUI
/// has no parent-reads-child-@State channel, so husks report measured heights
/// here) and the near/far window: the top probe reports the content offset per
/// frame, and the driver publishes MEMBERSHIP FLIPS — only boundary-crossing
/// rows — so a scroll step re-evaluates O(boundary) husks, never the ForEach.
///
/// Deliberately NOT @Published/@Observable: heights and window are read
/// imperatively (each husk's @State is the RENDER source; this is the math
/// source). The only reactive surface is `flips` — publishing a whole near-set
/// would re-evaluate every husk per step, the churn this exists to escape.
@MainActor
final class TranscriptWindowDriver {
    /// Nonisolated so a `@State` default-value expression in the nonisolated
    /// `TranscriptView` struct can construct it (Swift 6 isolation; all stored
    /// properties have defaults).
    nonisolated init() {}
    /// Membership changes from the last recompute, as SETS — `on` (attach
    /// content) and `off` (husk). SET semantics, never toggle: if the driver's
    /// window ever desyncs from a husk's actual state (e.g. the viewport
    /// invalidation path resets the near set), a set heals to the driver's
    /// truth instead of INVERTING — the toggle version could mass-off on
    /// invalidation and blank the screen.
    let flips = PassthroughSubject<(on: Set<Int>, off: Set<Int>), Never>()

    /// Pages of attached context above + below the viewport. GEOMETRIC, not
    /// row-count: heights run from 2pt notices to screen-filling dumps, so an
    /// index window would swing between 20 screens and half a screen of render
    /// budget; pages are predictable budget + prefetch margin.
    var pages: Double = 2
    /// Inter-row spacing — MUST match the stack's `VStack(spacing:)`.
    var spacing: Double = 12
    /// Reserved height for never-measured rows. Deliberately SMALL:
    /// underestimating far offsets makes the window OVER-include (attach
    /// content), never strand a placeholder on screen.
    var fallbackHeight: Double = 44
    /// Probe height + stack top padding above row 0 — a uniform-shift constant;
    /// errors are negligible at page scale.
    var contentInset: Double = 17
    /// Scroll movement below which the window cannot have changed membership
    /// (the window is pages wide). Sub-threshold probe frames are free.
    var scrollRecomputeThreshold: Double = 32

    private var bounds = RowBoundsStore()
    private var order: [String] = []
    private var near: Set<Int> = []
    private var scrollY: Double?
    private var viewportHeight: Double?
    private var viewportHeightAtGeneration: Double?
    private var dirty = false
    private var lastComputeScrollY: Double?
    /// IDENTITY-ANCHORED windowing (the rendered state's truth — user,
    /// 2026-09-17: "we should do this from the rendered state"): the binding
    /// readout names the row at the viewport's bottom edge; the near window
    /// centers on that row BY IDENTITY, immune to registry-vs-rendered
    /// height divergence (stale seeds + unmeasured rows starve the raw-offset
    /// geometric mapping — the live-tail blank deadlock, where far rows
    /// never measure so the window never self-corrects). Geometric windowing
    /// remains only as the pre-anchor fallback.
    private enum WindowAnchor: Equatable { case none, tail, row(String) }
    private var anchor: WindowAnchor = .none

    /// Current membership — a husk reads this ONCE at init; updates arrive via
    /// `flips` (row-targeted, so non-boundary husks never re-eval).
    func isNear(_ index: Int) -> Bool { near.contains(index) }

    /// A row's retained height (measured OR seeded/migrated) — the RENDER side
    /// of the "registry IS what the husks render" invariant. Without this,
    /// seeded geometry drove the window arithmetic while husks still claimed
    /// fallback frames — two coordinate systems, and the near window attached
    /// rows far from the viewport (the iOS blank-bubble hang, run 2026-09-17).
    func knownHeight(for id: String) -> Double? { bounds.height(id: id) }

    /// Display-order row ids changed (append/re-key/reorder).
    func update(order: [String]) {
        guard order != self.order else { return }
        // Re-key height migration (id-scheme v2): a same-index id swap recreates
        // the husk — its @State height dies and the registry entry under the OLD
        // id orphans. Carry the measurement across so a FAR re-keyed row keeps
        // its exact frame instead of collapsing to a fallback sliver (the
        // "history went blank" symptom).
        if order.count == self.order.count {
            for (i, newID) in order.enumerated() where newID != self.order[i] {
                if let h = bounds.height(id: self.order[i]) {
                    bounds.record(id: newID, height: h)
                }
            }
        }
        self.order = order
        dirty = true
    }

    /// Content offset from the scroll-view geometry source (fires per frame;
    /// internally gated). Sanity-guarded: a committed-geometry source shouldn't
    /// produce garbage, but a single stray frame used to mass-flip the whole
    /// near set (the oscillation wedge, run 2026-09-17) — physically
    /// impossible offsets are rejected outright.
    func update(scrollY: Double) {
        guard scrollY > -1_000_000, scrollY < 100_000_000 else {
            #if DEBUG
            dbgDriverLog("REJECTED scrollY \(Int(scrollY)) — out of plausible range")
            #endif
            return
        }
        self.scrollY = scrollY
        recomputeIfNeeded()
    }

    func update(viewportHeight: Double) {
        guard viewportHeight != self.viewportHeight else { return }
        // Coarse reflow handling (first cut): a LARGE viewport change (rotation,
        // iPad split, big window resize) treats retained heights as stale — near
        // rows re-measure as live views; far husks fall back until revisited.
        // Small changes (keyboard, toolbar) keep heights.
        if let old = viewportHeightAtGeneration, abs(viewportHeight - old) > 120 {
            bounds.invalidate()
            near = []
        }
        // ANY height change re-spreads the window (anchored windows included:
        // a bigger viewport needs a wider near set).
        dirty = true
        viewportHeightAtGeneration = viewportHeight
        self.viewportHeight = viewportHeight
        recomputeIfNeeded()
    }

    /// A husk measured (or re-measured) its row. No immediate recompute — the
    /// next probe frame picks it up; heights mostly move the far region's
    /// arithmetic, not near membership. DEBUG: outlier heights are logged —
    /// a transient garbage measure (e.g. mid-rotation zero-width layout)
    /// inflates contentHeight PERMANENTLY for the view's lifetime and sends
    /// the sentinel megapoints down (the "can't scroll to the bottom" hang).
    func record(id: String, height: Double) {
        guard height > 0, bounds.height(id: id) != height else { return }
        #if DEBUG
        if height > 20_000 {
            dbgDriverLog("SUSPECT height \(Int(height))pt id=\(id) — garbage measure? contentHeight inflated")
        }
        #endif
        bounds.record(id: id, height: height)
        dirty = true
    }

    /// The binding readout named a ROW — center the near window on it.
    func update(anchorID: String) {
        guard anchor != .row(anchorID) else { return }
        anchor = .row(anchorID)
        dirty = true
        recomputeIfNeeded()
    }

    /// The binding readout named the SENTINEL — anchor on the tail (the
    /// last row by identity; kills the blank-tail deadlock outright).
    func updateTailAnchor() {
        guard anchor != .tail else { return }
        anchor = .tail
        dirty = true
        recomputeIfNeeded()
    }

    /// Binding cleared (pre-restore) — fall back to geometric windowing.
    func clearAnchor() {
        guard anchor != .none else { return }
        anchor = .none
        dirty = true
        recomputeIfNeeded()
    }

    /// Bottom-most VISIBLE row index — the windowed layout's scroll-memory
    /// capture source (replaces lazy materialization tracking).
    func bottomVisibleIndex() -> Int? {
        // The ANCHOR is the rendered-state truth for the bottom-most visible
        // row (that is the binding readout's literal semantic) — prefer it;
        // arithmetic is the pre-anchor fallback.
        if case .row(let id) = anchor, let i = order.firstIndex(of: id) { return i }
        if case .tail = anchor, let last = order.indices.last { return last }
        guard let scrollY, let viewportHeight else { return order.indices.last }
        return bounds.bottomVisibleIndex(order: order, scrollY: scrollY,
                                         viewportHeight: viewportHeight,
                                         spacing: spacing, fallbackHeight: fallbackHeight,
                                         contentInset: contentInset)
    }

    /// Body-time sync (idempotent, gated) — call once per body BEFORE the
    /// ForEach so newly inserted husks read correct initial membership. Order
    /// changes (append, re-key) recompute immediately; scroll/height updates
    /// arrive via the geometry source.
    /// Height-cache capture (persistence tier): every measured height the
    /// registry holds. The VIEW filters this to replay-stable ids before it
    /// reaches the store (pending synthetics would persist as stale junk).
    func heightSnapshot() -> [String: Double] { bounds.allHeights }

    /// Height-cache seeding (persistence restore): bulk-load retained
    /// heights so the restore's binding jump lands on EXACT geometry instead
    /// of the fallback-estimate cascade — the relaunch blank-bubble window
    /// (run 2026-09-17). Measured values overwrite seeds as rows re-measure,
    /// self-healing staleness the fingerprint can't see (rotation).
    func seedHeights(_ heights: [String: Double]) {
        guard !heights.isEmpty else { return }
        bounds.seed(heights)
        dirty = true
    }

    func sync(order: [String]) {
        update(order: order)
        recomputeIfNeeded()
    }

    // MARK: - Private

    private func recomputeIfNeeded() {
        guard let viewportHeight else { return }
        if case .none = anchor {
            // Geometric fallback (PRE-ANCHOR ONLY): needs scrollY + the
            // movement gate — the global offset mapping is legitimate only
            // before any identity anchor exists (local-vs-global rule,
            // run 2026-09-17).
            guard let scrollY else { return }
            if !dirty, let last = lastComputeScrollY,
               abs(scrollY - last) < scrollRecomputeThreshold { return }
        } else if !dirty {
            // ANCHORED: recompute only on membership-relevant changes (dirty:
            // order / height / anchor / viewport updates). Per-frame geometry
            // can't move an identity-anchored window — re-running the global
            // mapping here is exactly the local↔global confusion.
            return
        }
        #if DEBUG
        let t0 = DispatchTime.now().uptimeNanoseconds
        #endif
        dirty = false
        lastComputeScrollY = scrollY
        guard let window = computeWindow(viewportHeight: viewportHeight) else { return }
        let newNear = Set(window)
        let turnedOn = newNear.subtracting(near)
        let turnedOff = near.subtracting(newNear)
        near = newNear
        if !turnedOn.isEmpty || !turnedOff.isEmpty {
            flips.send((on: turnedOn, off: turnedOff))
        }
        #if DEBUG
        let dt = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
        if dt > 3 {
            dbgDriverLog("recompute \(String(format: "%.1f", dt))ms N=\(order.count) near=\(near.count) on=\(turnedOn.count) off=\(turnedOff.count) anchor=\(anchorLabel)")
        }
        #endif
    }

    private var anchorLabel: String {
        switch anchor {
        case .none: return "none"
        case .tail: return "tail"
        case .row(let id): return "row:\(id.suffix(8))"
        }
    }

    /// The near window by ANCHOR (rendered-state truth) with the geometric
    /// mapping as fallback — see WindowAnchor.
    private func computeWindow(viewportHeight: Double) -> Range<Int>? {
        switch anchor {
        case .row(let id):
            if let center = order.firstIndex(of: id) {
                return bounds.windowRangeAroundIndex(order: order, center: center,
                                                     viewportHeight: viewportHeight,
                                                     pages: pages, spacing: spacing,
                                                     fallbackHeight: fallbackHeight)
            }
            // Anchored row vanished (compaction/filter) — KEEP the last
            // window rather than silently falling back to the global mapping;
            // the readout names a valid row on its next change and re-centers.
            return nil
        case .tail:
            guard let last = order.indices.last else { return nil }
            return bounds.windowRangeAroundIndex(order: order, center: last,
                                                 viewportHeight: viewportHeight,
                                                 pages: pages, spacing: spacing,
                                                 fallbackHeight: fallbackHeight)
        case .none:
            return geometricWindow(viewportHeight: viewportHeight)
        }
    }

    private func geometricWindow(viewportHeight: Double) -> Range<Int>? {
        guard let scrollY else { return nil }
        return bounds.windowRange(order: order, scrollY: scrollY,
                                  viewportHeight: viewportHeight, pages: pages,
                                  spacing: spacing, fallbackHeight: fallbackHeight,
                                  contentInset: contentInset)
    }
}
