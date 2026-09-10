import Combine
import Foundation
import MarkdownUI
import os
import UnBienCore

#if DEBUG
/// Window-driver diagnostics (iOS scroll-hang diagnosis, 2026-09-17): recompute
/// wall-times, rejected scroll offsets, and suspect height records. Read with
/// the scroll category:
/// `log stream --level debug --predicate 'subsystem == "un-bien" AND category == "scroll"'`
private let driverLog = Logger(subsystem: "un-bien", category: "scroll")
private func dbgDriverLog(_ message: String) {
    guard dbgTraceScroll else { return }   // gated: Instruments trace volume
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
/// source). The only reactive surface is per-row flip inboxes — each husk owns
/// one and receives ONLY its own membership changes, so a scroll step wakes
/// O(boundary) husks, never all N (broadcasting a whole near-set would
/// re-evaluate every husk per step, the churn this exists to escape).
@MainActor
final class TranscriptWindowDriver {
    /// Nonisolated so a `@State` default-value expression in the nonisolated
    /// `TranscriptView` struct can construct it (Swift 6 isolation; all stored
    /// properties have defaults).
    nonisolated init() {}
    /// Per-row flip delivery: each husk owns a PassthroughSubject (its @State
    /// inbox) and REGISTERS it here by id (from onAppear — never a body side
    /// effect). On a crossing the driver delivers true/false ONLY to the ~2
    /// rows that actually changed, instead of broadcasting to all N husks (the
    /// O(N) fan-out — ~1400 wakeups/crossing measured, 2026-09-07). Delivery is
    /// an explicit membership VALUE (not a toggle), so a desync heals to the
    /// driver's truth instead of inverting.
    private var flipInboxes: [String: PassthroughSubject<Bool, Never>] = [:]

    /// A husk registers its own inbox by id; the driver hands it the CURRENT
    /// membership so an init-vs-register gap (a flip sent before this husk
    /// registered) can't leave it stale. The heal MUST read the driver's OWN
    /// authoritative index for the id (orderIndex[id]) — NEVER an index the husk
    /// passes: content can change between a husk's construction and its onAppear,
    /// so a husk-supplied index may be stale and healing against it shows the
    /// WRONG row's membership (the missing / mis-shown-content bug).
    func registerFlipInbox(_ inbox: PassthroughSubject<Bool, Never>, for id: String) {
        flipInboxes[id] = inbox
        inbox.send(near.contains(id))
    }
    func unregisterFlipInbox(for id: String) { flipInboxes[id] = nil }

    /// Pages of attached context above + below the viewport. GEOMETRIC, not
    /// row-count: heights run from 2pt notices to screen-filling dumps, so an
    /// index window would swing between 20 screens and half a screen of render
    /// budget; pages are predictable budget + prefetch margin.
    /// Attach pages — the near window's normal spread around the anchor.
    var attachPages: Double = 2
    /// Detach pages — HYSTERESIS (proven in the L3 harness, P2): a row that
    /// is ALREADY NEAR is retained while within this wider band, even when a
    /// recompute (measurement cascades landing real heights after the seed
    /// invalidation — run 2026-09-18 "big bubble flaking") pushes it outside
    /// the attach band. New rows attach only within `attachPages`. True
    /// hysteresis = attach ∪ (near ∩ keep), NOT a plain union (a plain union
    /// is just a wider window — it flaps at its own edge).
    var detachPages: Double = 3
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
    /// id -> display index for O(1) anchor lookup; rebuilt in update(order:).
    private var orderIndex: [String: Int] = [:]
    /// Window membership, id-keyed: ids survive any reorder/prepend/insert, so
    /// there is no index-remap to get wrong (01M1WZEND2).
    private var near: Set<String> = []
    /// Scroll direction from the VIEW's rendered-state truth (the anchor index
    /// delta, freshest signal): +1 toward newest/bottom, -1 toward oldest, 0
    /// idle. scrollY delta is only the geometric-fallback source. Readable by
    /// the content. Drives which window edge cache eviction protects.
    private(set) var scrollDirection = 0
    private var previousAnchorIndex: Int?
    private var previousScrollY: Double?
    /// PREWARM inputs (design 01M24A9NR): the leading pass calls the shared
    /// MarkdownEntityStore.prewarm — the scoped key needs the session scope
    /// and the produce needs the style + row TEXT, none of which this
    /// ids-only driver derives. All fed from TranscriptStackView via sync.
    var sessionScope = ""
    var prewarmStyle: MarkdownProseStyle?
    /// Given a ROW id (this driver's vocabulary, role-prefixed), resolve the
    /// entity-warm pair (bubble id + text + images), or nil for rows that must
    /// never be warmed (still-streaming bubbles — cache-poison rule; non-bubble
    /// rows). Keeps the driver ids-only.
    var warmPairFor: ((String) -> (id: String, text: String, images: [WireImage])?)?
    /// TOOL-ROW facts resolver (the last estimate-covered row kind): row id →
    /// ToolCardFacts (expansion seeded EXACTLY as ToolCardView does — cards
    /// OPEN by default per the pref). View-fed; the driver stays facts-agnostic.
    var toolFactsFor: ((String) -> RowHeightEstimator.ToolCardFacts?)?
    /// Content width for the height-estimate side channel (analytic tier) —
    /// fed from the transcript viewport probe alongside viewportHeight.
    var prewarmWidth: Double = 0
    /// TRUE while a USER scroll gesture (drag / momentum) is in flight — set
    /// from TranscriptView's phase handler. Feeds the height-delta-during-scroll
    /// diagnosis (id-anchor reassertion vs deceleration physics).
    var scrollGestureActive = false
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

    /// Current membership by id — a husk reads this ONCE at init; updates arrive
    /// via `flips` (row-targeted, so non-boundary husks never re-eval).
    func isNear(_ id: String) -> Bool { near.contains(id) }

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
        orderIndex.removeAll(keepingCapacity: true)
        for (i, id) in order.enumerated() { orderIndex[id] = i }
        // NO near remap: near is id-keyed, and ids survive a reorder / backfill
        // prepend / middle-insert unchanged. This deletes the "anything
        // index-keyed surviving a reorder must remap by id" bug class outright
        // (01M1WZEND2) — both this session's flip bugs lived in that remap.
        // Prune flip inboxes for ids no longer present (re-keyed / removed /
        // reset rows) — DETERMINISTIC cleanup independent of onDisappear (which
        // SwiftUI fires unreliably). Bounds the dict to live rows; a fresh husk
        // re-registers on appear. ALL order changes route here (sync -> update).
        if !flipInboxes.isEmpty {
            let live = Set(order)
            flipInboxes = flipInboxes.filter { live.contains($0.key) }
        }
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
        // Geometric-fallback direction: only when NO identity anchor exists (the
        // anchor is the truth otherwise). scrollY is the distrusted global offset.
        if case .none = anchor, let prev = previousScrollY {
            if scrollY > prev + 0.5 { scrollDirection = 1 }
            else if scrollY < prev - 0.5 { scrollDirection = -1 }
        }
        previousScrollY = scrollY
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
            RenderActivity.boundsInvalidated += 1
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
        RenderActivity.boundsMeasured += 1
        guard height > 0 else { return }
        let oldHeight = bounds.height(id: id)
        // Gesture-mutation gauge: BOTH first-ever measures (no reserved height
        // — the layout jumps by the full height) and seed→real corrections
        // count; no-op re-measures don't. (STRUCTURAL FIX 2026-09-10: the
        // hd-gauge edit made first measures RETURN EARLY — before
        // bounds.record — so unseeded rows never recorded and re-measured on
        // every probe forever: the 4-5× measure-count inflation + distorted
        // accuracy gauges. All record-worthy paths now reach bounds.record.)
        if scrollGestureActive, oldHeight != height {
            RenderActivity.heightDeltasWhileScrolling += 1
            RenderActivity.heightDeltaPointsWhileScrolling += Int(oldHeight.map { abs(height - $0) } ?? height)
        }
        guard oldHeight != height else { return }   // no-op re-measure
        // Estimator accuracy (analytic tier): the real measure landed on an
        // estimate-seeded row — accumulate |Δ| (eΔ) and the signed bias (b).
        // Both updated from the SAME (height, estimate) pair — |b| ≤ eΔ always.
        if let estimated = estimateSeeded.removeValue(forKey: id) {
            RenderActivity.heightEstimatesMeasured += 1
            let delta = height - estimated
            RenderActivity.heightEstimateErrSum += Int(abs(delta))
            RenderActivity.heightEstimateBiasSum += Int(delta)
        }
        #if DEBUG
        if height > 20_000 {
            dbgDriverLog("SUSPECT height \(Int(height))pt id=\(id) — garbage measure? contentHeight inflated")
        }
        #endif
        bounds.record(id: id, height: height)
        RenderActivity.boundsSet += 1
        // NO dirty = true (design 01M1X1R2): a height MEASUREMENT must not
        // trigger a membership recompute. recomputeIfNeeded re-derives the near
        // set via the height-budget windowRangeAroundIndex walk, so letting a
        // measure dirty it EVICTS visible rows when a member grows (a big bubble
        // settling 32->10000 shrank the extent -> downstream rows vanished).
        // The new height feeds the NEXT anchor/viewport/order recompute instead.
    }

    /// The binding readout named a ROW — center the near window on it.
    func update(anchorID: String) {
        guard anchor != .row(anchorID) else { return }
        anchor = .row(anchorID)
        // Direction from the rendered-state truth (bottom-visible row moving) —
        // the freshest, most authoritative scroll signal (identity, not raw offset).
        if let new = orderIndex[anchorID] {
            if let old = previousAnchorIndex { scrollDirection = new > old ? 1 : (new < old ? -1 : scrollDirection) }
            previousAnchorIndex = new
        }
        dirty = true
        recomputeIfNeeded()
    }

    /// The binding readout named the SENTINEL — anchor on the tail (the
    /// last row by identity; kills the blank-tail deadlock outright).
    func updateTailAnchor() {
        guard anchor != .tail else { return }
        anchor = .tail
        scrollDirection = 1   // tail = moving toward the newest
        previousAnchorIndex = order.indices.last
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
        if case .row(let id) = anchor, let i = orderIndex[id] { return i }
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

    func sync(order: [String], scope: String = "",
              style: MarkdownProseStyle? = nil,
              warmPairFor: ((String) -> (id: String, text: String, images: [WireImage])?)? = nil,
              toolFactsFor: ((String) -> RowHeightEstimator.ToolCardFacts?)? = nil,
              width: Double = 0) {
        if !scope.isEmpty { sessionScope = scope }
        if let style { prewarmStyle = style }
        if let warmPairFor { self.warmPairFor = warmPairFor }
        if let toolFactsFor { self.toolFactsFor = toolFactsFor }
        if width > 0 { prewarmWidth = width }
        update(order: order)
        recomputeIfNeeded()
    }

    /// Live-apply a window size (Settings sweep — design 01M127NC4 cheap
    /// diagnostic): `pages` is the DETACH (retention) band; the attach band
    /// tracks one page narrower to preserve the hysteresis gap. Floors at the
    /// shipped 2/3 so the minimum is "what we have".
    func applyWindowPages(_ pages: Double) {
        detachPages = max(3, pages)
        attachPages = max(2, detachPages - 1)
        dirty = true
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
        let t0 = DispatchTime.now().uptimeNanoseconds   // always-on: HUD compare gauge
        dirty = false
        lastComputeScrollY = scrollY
        RenderActivity.windowRecomputed += 1
        guard let newNear = computeWindow(viewportHeight: viewportHeight) else { return }
        let turnedOn = newNear.subtracting(near)
        let turnedOff = near.subtracting(newNear)
        near = newNear
        RenderActivity.lastWindowMicros = Int((DispatchTime.now().uptimeNanoseconds - t0) / 1000)
        RenderActivity.nearCount = newNear.count
        // Deliver ONLY to the rows that changed, addressed BY ID — not a
        // broadcast to all N husks.
        for id in turnedOn { flipInboxes[id]?.send(true) }
        for id in turnedOff { flipInboxes[id]?.send(false) }
        protectLeadingWindow()
        #if DEBUG
        let dt = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
        if dt > 3 {
            dbgDriverLog("recompute \(String(format: "%.1f", dt))ms N=\(order.count) near=\(near.count) on=\(turnedOn.count) off=\(turnedOff.count) anchor=\(anchorLabel)")
        }
        #endif
    }

    /// Keep the direction-of-travel window edge warm (01M1Y1GK, extended by
    /// the prewarm design 01M24A9NR): PRODUCE the leading rows ahead of
    /// materialization — a materialized husk then renders from a cache HIT
    /// (no fallback flash) — and the lru-hit inside prewarm is the MRU bump,
    /// so eviction still discards only what we've LEFT BEHIND, never what
    /// we're scrolling TOWARD. Idle (dir 0) warms the whole visible window.
    private func protectLeadingWindow() {
        guard !near.isEmpty else { return }
        RenderActivity.scrollDir = scrollDirection
        let leading: [String]
        if scrollDirection != 0, let center = centerIndex() {
            leading = near.filter {
                guard let i = orderIndex[$0] else { return false }
                return scrollDirection > 0 ? i >= center : i <= center
            }
        } else {
            leading = Array(near)
        }
        // The driver stays ids-only: the view-fed resolver translates its
        // ROW ids to warm pairs and returns nil for never-warm rows. The
        // bubble→row map routes the estimate side channel back (analytic
        // height tier: seed the bounds registry BEFORE first materialization
        // so the seed→real correction lands far beneath the reassertion
        // threshold — the hd/p-diagnosed glide killer).
        guard let style = prewarmStyle, !sessionScope.isEmpty,
              let resolver = warmPairFor else { return }
        var rows: [(id: String, text: String, images: [WireImage])] = []
        var rowByBubble: [String: String] = [:]
        rows.reserveCapacity(leading.count)
        for id in leading {
            if let pair = resolver(id), !pair.text.isEmpty || !pair.images.isEmpty {
                rows.append(pair)
                rowByBubble[pair.id] = id
            }
        }
        guard !rows.isEmpty else { return }
        // TEXT-TIER ESTIMATES (the uncapped fast cut): compose over the fork's
        // markdownEstimateMetrics for EVERY leading row — no parse dependency,
        // microseconds each, one sequential detached task (concurrency 1, no
        // burst). Seeds land as computed; the capped entity-parse estimate
        // below only fills rows this pass somehow missed.
        if prewarmWidth > 0 {
            estimateTextTier(rows: rows, rowByBubble: rowByBubble, style: style,
                             leading: leading)
        }
        MarkdownEntityStore.shared.prewarm(
            scope: sessionScope, rows: rows, style: style, width: prewarmWidth,
            onEstimate: { bubble, estimate in
                guard let rowID = rowByBubble[bubble] else { return }
                self.seedEstimate(rowID: rowID, estimate: estimate)
            })
    }

    /// Coalescing text-tier estimator flight (2026-09-10 fix: the first cut
    /// DROPPED re-entries while a flight ran — a fast fling outran it and rows
    /// attached unseeded, hd 433/p 158k regression). Re-entries now REPLACE the
    /// pending window; the moment a flight ends, the latest one runs — the
    /// tier always chases the NEWEST scroll position, never a stale one, and
    /// never drops work. Rows are ordered DIRECTION-FIRST (attach-imminent
    /// before trailing) so a flight cut short by the next recompute still
    /// seeded the rows that matter most.
    private var textTierInFlight = false
    /// One pending text-tier flight (coalesced): rows to estimate + the
    /// bubble→row map + tool-card facts + the style.
    private struct PendingTier {
        let rows: [(id: String, text: String, images: [WireImage])]
        let rowByBubble: [String: String]
        let style: MarkdownProseStyle
        let toolRows: [(id: String, facts: RowHeightEstimator.ToolCardFacts)]
    }
    private var pendingTextTier: PendingTier?
    private func estimateTextTier(rows: [(id: String, text: String, images: [WireImage])],
                                  rowByBubble: [String: String],
                                  style: MarkdownProseStyle,
                                  leading: [String]) {
        // TOOL ROWS ride the same flight (the last uncovered kind): facts from
        // the view-fed resolver, composed by estimateToolCard.
        let toolRows: [(id: String, facts: RowHeightEstimator.ToolCardFacts)] = leading.compactMap {
            guard let factsFor = toolFactsFor, let facts = factsFor($0) else { return nil }
            return (id: $0, facts: facts)
        }
        // Direction-first ordering: the edge we're scrolling TOWARD estimates
        // first (those rows attach next; trailing rows have pages of margin).
        let ordered: [(id: String, text: String, images: [WireImage])]
        if scrollDirection != 0 {
            let dir = scrollDirection
            ordered = rows.sorted { a, b in
                let ia = orderIndex[rowByBubble[a.id] ?? a.id] ?? 0
                let ib = orderIndex[rowByBubble[b.id] ?? b.id] ?? 0
                return dir > 0 ? ia > ib : ia < ib
            }
        } else {
            ordered = rows
        }
        pendingTextTier = PendingTier(rows: ordered, rowByBubble: rowByBubble,
                                      style: style, toolRows: toolRows)
        guard !textTierInFlight else { return }   // running flight picks this up on completion
        runPendingTextTier()
    }

    private func runPendingTextTier() {
        guard let pending = pendingTextTier else { return }
        pendingTextTier = nil
        textTierInFlight = true
        let width = prewarmWidth
        let rows = pending.rows
        let rowByBubble = pending.rowByBubble
        let style = pending.style
        let toolRows = pending.toolRows
        Task {
            await Task.detached(priority: .userInitiated) {
                for row in rows {
                    let est = RowHeightEstimator.estimateText(row.text, images: row.images,
                                                              style: style, width: width)
                    if est > 0, let rowID = rowByBubble[row.id] {
                        await MainActor.run { self.seedEstimate(rowID: rowID, estimate: est) }
                    }
                }
                for tool in toolRows {
                    let est = RowHeightEstimator.estimateToolCard(tool.facts, style: style,
                                                                 width: width)
                    if est > 0 {
                        await MainActor.run { self.seedEstimate(rowID: tool.id, estimate: est) }
                    }
                }
            }.value
            textTierInFlight = false
            // A recompute replaced the window while we flew — chase it NOW,
            // never drop it (the old drop-on-busy was the fast-fling regression).
            if pendingTextTier != nil { runPendingTextTier() }
        }
    }

    /// Seed the bounds registry with an ANALYTIC estimate (prefill at
    /// entity-produce time). Only when nothing better exists: a measured
    /// height or a persisted seed ALWAYS wins, and the estimate never
    /// persists — it exists to shrink the first-measure mutation (device
    /// truth: 274pt avg → target ≪ 50pt). Accuracy is gauged when the real
    /// measure lands (`eΔ` on the HUD) — the estimator stays honest.
    private var estimateSeeded: [String: Double] = [:]
    func seedEstimate(rowID: String, estimate: Double) {
        guard estimate > 0 else { return }
        // An estimate may be CORRECTED by a later, better estimate (e.g. a card
        // settling rich → the facts flip collapsed→expanded; a re-flight with
        // fresher facts) — estimateSeeded membership proves the existing bounds
        // entry is OURS, not a measure or a persisted seed. Measured truth and
        // persisted seeds always win and are never overwritten.
        let ours = estimateSeeded[rowID] != nil
        guard bounds.height(id: rowID) == nil || ours else { return }
        bounds.record(id: rowID, height: estimate)
        estimateSeeded[rowID] = estimate
        RenderActivity.heightEstimatesSeeded += 1
    }

    /// The window's center row index by the current anchor (rendered-state truth).
    private func centerIndex() -> Int? {
        switch anchor {
        case .row(let id): return orderIndex[id]
        case .tail: return order.indices.last
        case .none: return bottomVisibleIndex()
        }
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
    private func computeWindow(viewportHeight: Double) -> Set<String>? {
        let center: Int
        switch anchor {
        case .row(let id):
            guard let c = orderIndex[id] else {
                // Anchored row vanished (compaction/filter) — KEEP the last
                // window rather than silently falling back to the global mapping.
                return nil
            }
            center = c
        case .tail:
            guard let last = order.indices.last else { return nil }
            center = last
        case .none:
            guard let range = geometricWindow(viewportHeight: viewportHeight) else { return nil }
            return Set(range.map { order[$0] })
        }
        // windowRangeAroundIndex is index-based (the height-budget walk needs
        // positions); convert its result to IDS for the id-keyed near set.
        let attach = bounds.windowRangeAroundIndex(order: order, center: center,
                                                    viewportHeight: viewportHeight,
                                                    pages: attachPages, spacing: spacing,
                                                    fallbackHeight: fallbackHeight)
        let keep = bounds.windowRangeAroundIndex(order: order, center: center,
                                                 viewportHeight: viewportHeight,
                                                 pages: detachPages, spacing: spacing,
                                                 fallbackHeight: fallbackHeight)
        let attachIDs = Set(attach.map { order[$0] })
        let keepIDs = Set(keep.map { order[$0] })
        // TRUE HYSTERESIS: attach band ∪ (already-near ∩ keep band).
        return attachIDs.union(near.intersection(keepIDs))
    }

    private func geometricWindow(viewportHeight: Double) -> Range<Int>? {
        guard let scrollY else { return nil }
        return bounds.windowRange(order: order, scrollY: scrollY,
                                  viewportHeight: viewportHeight, pages: attachPages,
                                  spacing: spacing, fallbackHeight: fallbackHeight,
                                  contentInset: contentInset)
    }
}
