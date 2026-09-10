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
    /// without a cap that launches every uncached row at once as high-QoS
    /// detached parses competing with the main thread. 3 keeps the pipeline
    /// full without saturating the cores; skipped rows retry on the next
    /// recompute as slots free (self-throttling), and the view's lazy .task
    /// (userInitiated) remains the backstop for what's actually visible.
    /// The in-flight cap applies to PRODUCING only — the TOUCH pass above it
    /// is unconditional: capping the touch too would strip the leading edge's
    /// eviction protection exactly when the cache is under scroll pressure
    /// (the "dropping keys" failure the HUD eviction counter watches for).
    private static let prewarmMaxInFlight = 3
    func prewarm(scope: String, rows: [(id: String, text: String)], style: MarkdownProseStyle) {
        // PASS 1 — TOUCH everything, always (MRU bump = eviction protection,
        // 01M1Y1GK; O(1) per row, no tasks, no cap).
        var cold: [(key: String, text: String)] = []
        for row in rows where !row.text.isEmpty {
            let key = Self.key(scope: scope, id: row.id, styleHash: style.hashValue)
            if lru.hit(key) != nil { continue }
            cold.append((key: key, text: row.text))
        }
        // PASS 2 — PRODUCE the cold rows up to the in-flight cap, utility QoS.
        // produce's single-flight (`inflight`) is consulted first: if the
        // VIEW's own .task is already parsing this row, prewarm neither spawns
        // nor spends a cap slot — that parse will cache it. `prewarming` then
        // caps only what PREWARM itself originates.
        for row in cold {
            if inflight[row.key] != nil { continue }
            guard prewarming.count < Self.prewarmMaxInFlight else {
                RenderActivity.prewarmDeferred += 1
                return
            }
            guard prewarming.insert(row.key).inserted else { continue }
            RenderActivity.prewarmStarted += 1
            Task {
                _ = await produce(row.key, text: row.text, style: style, priority: .utility)
                prewarming.remove(row.key)
            }
        }
    }

    /// priority: the VIEW's lazy path runs .userInitiated (the user is looking
    /// at that row NOW); PREWARM runs .utility + capped (see prewarm) so a
    /// scroll through cold history can't spawn a burst of high-QoS parses
    /// that competes with the main thread for cores (scroll-jank regression,
    /// 2026-09-10).
    /// SINGLE-FLIGHT (per-key): EVERY caller — the view's lazy .task and all
    /// prewarm triggers — funnels through here. A key already parsing is
    /// JOINED (await the running task), never re-spawned. Kills the in-flight
    /// gap race: lru.insert happens only AFTER the off-main parse, so gating
    /// on "is it cached?" answers NO right up until it is — prewarm + a
    /// materializing view each spawned their own parse of the same text
    /// (duplicate userInitiated bursts while scrolling, 2026-09-10).
    private var inflight: [String: Task<[MarkdownEntity], Never>] = [:]
    func produce(_ key: String, text: String, style: MarkdownProseStyle,
                 priority: TaskPriority = .userInitiated) async -> [MarkdownEntity] {
        if let hit = lru.hit(key) { return hit }   // touch: stamp MRU, O(1)
        if let running = inflight[key] {           // single-flight: JOIN, don't re-spawn
            RenderActivity.produceJoined += 1
            return await running.value
        }
        RenderActivity.produceStarted += 1
        let t0 = DispatchTime.now().uptimeNanoseconds
        let task = Task.detached(priority: priority) {
            // SELF gauge = parse CPU only, timed inside the closure (bg write —
            // RenderActivity's documented best-effort racy-tally contract).
            let c0 = DispatchTime.now().uptimeNanoseconds
            let made = markdownEntities(text, style: style)
            RenderActivity.produceSelfMicros = Int((DispatchTime.now().uptimeNanoseconds - c0) / 1000)
            return made
        }
        inflight[key] = task
        let made = await task.value
        inflight[key] = nil
        // WALL = spawn + queue + parse + hop-back; WAIT = wall − self ≈ pure
        // contention (QoS preemption / pool busy). wait ≫ self while throttled.
        RenderActivity.produceLastMicros = Int((DispatchTime.now().uptimeNanoseconds - t0) / 1000)
        RenderActivity.produceWaitMicros = RenderActivity.produceLastMicros - RenderActivity.produceSelfMicros
        lru.insert(key, made)
        RenderActivity.produceFinished += 1
        RenderActivity.entityCacheCount = lru.count
        RenderActivity.entityCacheEvicted = lru.evictedTotal
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
                       fontName: typography.bodyFontName)
}
