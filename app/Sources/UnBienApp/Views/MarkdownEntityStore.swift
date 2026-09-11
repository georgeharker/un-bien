import SwiftUI
import MarkdownUI
import UnBienCore

/// Off-main producer + cache for `[MarkdownEntity]`, keyed per settled message.
/// Parsing + prose styling run on a background task; the result is memoized so
/// a husk re-materialization is a synchronous cache hit (no re-parse).
@MainActor
final class MarkdownEntityStore {
    static let shared = MarkdownEntityStore()

    /// LRU shared with AttributedTextCache (SeqStampLRU). FULLY LOCK-FREE here:
    /// @MainActor confines every store access to the main thread, and the render
    /// is on the main thread too, so render and store CAN'T RACE. Only the pure
    /// markdownEntities parse is off-main (Task.detached) and it touches NO store
    /// state — the cache read/write brackets the await back on the main actor.
    private var lru = SeqStampLRU<String, [MarkdownEntity]>(cap: 400)
    /// Max cached MESSAGES (per-bubble entity lists). Configurable (Settings);
    /// default 400 — the per-BUBBLE tier alongside AttributedTextCache.cacheLimit
    /// (per-BLOCK). Lowering it trims immediately (SeqStampLRU.cap didSet).
    var cap: Int {
        get { lru.cap }
        set { lru.cap = newValue }
    }

    /// Cache key = row identity + a hash of the whole style (leaf of the
    /// scoped builder below).
    static func key(rowID: String, styleHash: Int) -> String { "\(rowID)\u{1}\(styleHash)" }

    /// THE scoped-key builder — every consumer (the view, the AppModel fold
    /// trigger, the driver's leading pass) derives its key HERE so keys can
    /// never drift into mismatched cache slots (the old touchLeading keyed by
    /// the bare row id while the view keyed scoped — a silent no-op). scope =
    /// session.id; id = the BUBBLE id (not the role-prefixed row id) —
    /// matches MarkdownEntitiesView.
    static func key(scope: String, id: String, styleHash: Int) -> String {
        key(rowID: scope.isEmpty ? id : "\(scope)\u{1}\(id)", styleHash: styleHash)
    }

    func cached(_ key: String) -> [MarkdownEntity]? { lru.value(key) }   // peek: no touch

    /// PREWARM (produce-ahead) — the ONE shared primitive every trigger calls
    /// (design 01M24A9NR). Touch-on-hit: the MRU bump IS the eviction
    /// protection the leading pass always wanted (01M1Y1GK). Produce-on-miss:
    /// the off-main parse starts immediately so a settle / re-key /
    /// scroll-into first paint is a cache HIT — no styledMarkdown fallback
    /// flash. Fire-and-forget per row; repeat calls are ~free (lru-hit dedup
    /// + in-flight guard). CALLERS MUST PASS ONLY TEXT-FINAL rows — never a
    /// still-streaming bubble: its key is stable across streaming, so a
    /// partial parse would POISON the slot with stale entities the settled
    /// view then hits forever (.task(id:) never refires at settle).
    private var prewarming: Set<String> = []
    /// SCROLL CONTENTION GUARD (jank regression, 2026-09-10): a fast scroll
    /// through cold history fires the leading pass over its whole window —
    /// without a cap that launches every uncached row at once. 3 bounds
    /// concurrent prewarm parses (their priority is the SAME as the view's —
    /// a lower QoS would invert through the single-flight join); skipped
    /// rows retry on the next recompute as slots free, and the view's lazy
    /// .task remains the backstop for what's actually visible. TUNABLE from
    /// Advanced settings (0 = prewarm produce-off, touch-only — a useful A/B
    /// position while dialing in the sweet spot). The cap applies to
    /// PRODUCING only — the TOUCH pass is unconditional (capping it would
    /// strip the leading edge's eviction protection under scroll pressure).
    /// SAFETY: nonisolated(unsafe) mutable static — written only from the
    /// Settings UI and read only on the main actor (the store is @MainActor).
    nonisolated(unsafe) static var prewarmMaxInFlight = 3
    /// rows: (bubble id, text, images). width > 0 enables the height-estimate
    /// side channel (analytic tier, RowHeightEstimator): the detached pass
    /// computes an estimate (warming ImageCache as a side effect) and hands it
    /// back tagged with the row id via onEstimate — the caller seeds its bounds
    /// registry so first materialization barely mutates content. width 0 = opt
    /// out (the fold trigger has no width; its rows are visible/immediate).
    func prewarm(scope: String, rows: [(id: String, text: String, images: [WireImage])],
                 style: MarkdownProseStyle, width: Double = 0,
                 onEstimate: ((String, Double) -> Void)? = nil,
                 warmCode: ((String, String?) -> Void)? = nil) {
        // PASS 1 — TOUCH everything, always (MRU bump = eviction protection,
        // 01M1Y1GK; O(1) per row, no tasks, no cap). The touched count feeds the
        // HUD `t` gauge — a fully-warm scroll moves no OTHER prewarm token.
        // NOTE: rows with images but EMPTY text still warm (image decode) —
        // they just never enter the entity LRU.
        var cold: [(key: String, id: String, text: String, images: [WireImage])] = []
        var touched = 0
        for row in rows where !row.text.isEmpty || !row.images.isEmpty {
            let key = Self.key(scope: scope, id: row.id, styleHash: style.hashValue)
            if !row.text.isEmpty, lru.hit(key) != nil {
                touched += 1
                // Cached entities don't need a produce — but the image warm +
                // estimate side channel still applies (cheap, and deliberately
                // NOT capped: a row that misses its seed shifts the view).
                if width > 0, let onEstimate {
                    estimateOnly(row: row, key: key, style: style, width: width, onEstimate: onEstimate)
                }
                continue
            }
            cold.append((key: key, id: row.id, text: row.text, images: row.images))
        }
        if touched > 0 { RenderActivity.prewarmTouched = touched }
        // PASS 2 — PRODUCE the cold rows up to the in-flight cap (same priority
        // as the view — a lower QoS would invert through the single-flight join).
        // produce's single-flight (`inflight`) is consulted first: if the
        // VIEW's own .task is already parsing this row, prewarm neither spawns
        // nor spends a cap slot — that parse will cache it. `prewarming` then
        // caps only what PREWARM itself originates.
        for (i, row) in cold.enumerated() {
            if inflight[row.key] != nil { continue }
            guard prewarming.count < Self.prewarmMaxInFlight else {
                // ALL remaining cold rows (incl. this one) were deferred by the
                // cap — count them all, not just the first (an honest ⏸).
                RenderActivity.prewarmDeferred += cold.count - i
                return
            }
            guard prewarming.insert(row.key).inserted else { continue }
            RenderActivity.prewarmStarted += 1
            let rowID = row.id
            Task {
                let entities = await produce(row.key, text: row.text, style: style, width: width,
                                              onEstimate: { onEstimate?(rowID, $0) })
                // CODE-SEGMENT WARM (A-tier, scroll-jank trigger 2026-09-10):
                // content-addressed HighlightProducer keys mean warming here
                // HITS the exact slot AsyncAttributedText reads at attach —
                // no plain-text flash, no swap re-layout, no eval-queue wait.
                if let warmCode {
                    for entity in entities {
                        if case let .code(language, text) = entity {
                            warmCode(text, language)
                        }
                    }
                }
                prewarming.remove(row.key)
            }
        }
    }

    /// Estimate-only dedup — a SEPARATE set from `prewarming`, not the budget.
    /// Bounding and de-duplicating are different jobs: this pass is cheap (no
    /// parse) and load-bearing (a row without a bounds seed shifts the view),
    /// so it must run for every warm row on every recompute. Sharing the parse
    /// budget's set made pass 1 spend pass 2's slots, so a mostly-warm window
    /// deferred every cold row — starving the very seeds this delivers, while
    /// the ⏸ gauge reported healthy backpressure.
    private var estimating: Set<String> = []

    /// Warm images + estimate for a row whose ENTITIES are already cached
    /// (pass-1 hit): decode images into ImageCache off-main and hand back the
    /// estimate without re-parsing. Image-only rows land here too.
    private func estimateOnly(row: (id: String, text: String, images: [WireImage]),
                              key: String, style: MarkdownProseStyle, width: Double,
                              onEstimate: @escaping (String, Double) -> Void) {
        guard estimating.insert(key).inserted else { return }   // dedup, NOT the cap
        let rowID = row.id
        Task {
            let entities = cached(key) ?? []
            let est = await Task.detached(priority: .userInitiated) {
                RowHeightEstimator.estimate(entities, images: row.images,
                                            style: style, width: width)
            }.value
            estimating.remove(key)
            if est > 0 { onEstimate(rowID, est) }
        }
    }

    /// Prewarm-originated parses currently in flight (cap-accounting set
    /// size). Read-only; for tests + HUD diagnostics.
    var prewarmInFlight: Int { prewarming.count }

    /// SINGLE-PRIORITY by construction (no `priority` param): a single-flight
    /// JOIN must never downgrade the caller — the view's render path awaiting
    /// a utility-QoS prewarm parse WAS the top Instruments wait (2026-09-10:
    /// MarkdownEntitiesView:73, 390ms+). DEMAND IS DELIBERATELY UNCAPPED: the
    /// budget governs SPECULATION only — if a row is materializing we need it
    /// now, and metering it would just make visible rows wait. Only prewarm's
    /// own pass 2 meters against `prewarming`; the single-flight join below is
    /// the only thing that bounds a demand caller. Parses are short (~300µs).
    /// SINGLE-FLIGHT (per-key): EVERY caller — the view's lazy .task and all
    /// prewarm triggers — funnels through here. A key already parsing is
    /// JOINED (await the running task), never re-spawned. Kills the in-flight
    /// gap race: lru.insert happens only AFTER the off-main parse, so gating
    /// on "is it cached?" answers NO right up until it is — prewarm + a
    /// materializing view each spawned their own parse of the same text
    /// (duplicate userInitiated bursts while scrolling, 2026-09-10).
    private var inflight: [String: Task<([MarkdownEntity], Double), Never>] = [:]
    func produce(_ key: String, text: String, style: MarkdownProseStyle,
                 width: Double = 0, onEstimate: ((Double) -> Void)? = nil) async -> [MarkdownEntity] {
        if let hit = lru.hit(key) { return hit }   // touch: stamp MRU, O(1)
        if let running = inflight[key] {           // single-flight: JOIN, don't re-spawn
            RenderActivity.produceJoined += 1
            return await running.value.0
        }
        RenderActivity.produceStarted += 1
        let t0 = DispatchTime.now().uptimeNanoseconds
        let task = Task.detached(priority: .userInitiated) {
            let c0 = DispatchTime.now().uptimeNanoseconds
            let made = markdownEntities(text, style: style)
            RenderActivity.produceSelfMicros = Int((DispatchTime.now().uptimeNanoseconds - c0) / 1000)
            // Height-estimate side channel (analytic tier): same detached pass
            // (image warming included) when the caller supplied a width.
            let estimate = width > 0
                ? RowHeightEstimator.estimate(made, images: [], style: style, width: width)
                : 0
            return (made, estimate)
        }
        inflight[key] = task
        let (made, estimate) = await task.value
        inflight[key] = nil
        // WALL = spawn + queue + parse + hop-back; WAIT = wall − self ≈ pure
        // contention (QoS preemption / pool busy). wait ≫ self while throttled.
        RenderActivity.produceLastMicros = Int((DispatchTime.now().uptimeNanoseconds - t0) / 1000)
        RenderActivity.produceWaitMicros = RenderActivity.produceLastMicros - RenderActivity.produceSelfMicros
        lru.insert(key, made)
        RenderActivity.produceFinished += 1
        RenderActivity.entityCacheCount = lru.count
        RenderActivity.entityCacheEvicted = lru.evictedTotal
        if estimate > 0 { onEstimate?(estimate) }
        return made
    }
}

/// One reused prose style per (theme, typography). All bubbles share the same
/// style (it depends only on theme + typography, never on the bubble), so
/// build it once and hand out the memoized value; it rebuilds only when the
/// theme or fonts change. Single-entry: every visible bubble uses the same
/// theme/typography at any given moment.
@MainActor
enum MarkdownStyleCache {
    private static var last: (key: String, style: MarkdownProseStyle)?

    static func style(theme: AppTheme, typography: Typography) -> MarkdownProseStyle {
        let key = "\(theme.codeHighlightStyle)\u{1}\(Int(typography.bodySize))"
            + "\u{1}\(typography.bodyFontName ?? "")\u{1}\(typography.monoFontName ?? "")"
        if let last, last.key == key { return last.style }
        let style = markdownProseStyle(theme: theme, typography: typography)
        last = (key, style)
        return style
    }
}

func markdownProseStyle(theme: AppTheme, typography: Typography) -> MarkdownProseStyle {
    MarkdownProseStyle(baseSize: typography.bodySize, textColor: theme.text,
                       linkColor: theme.accent,
                       codeColor: theme.text, codeBackground: theme.surface,
                       codeFontName: typography.monoFontName,
                       quoteColor: theme.secondaryText,
                       fontName: typography.bodyFontName,
                       // The renderer sizes BLOCK code from codeSize (not
                       // bodySize) — the analytic tier must match (wrap-aware
                       // code counting + mono line height both key off it).
                       codeSize: typography.codeSize)
}
