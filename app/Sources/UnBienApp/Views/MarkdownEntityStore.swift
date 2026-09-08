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

    /// Cache key = row identity + a hash of the whole style. Shared with the
    /// driver so its leading-window protection reconstructs the same key.
    static func key(rowID: String, styleHash: Int) -> String { "\(rowID)\u{1}\(styleHash)" }

    func cached(_ key: String) -> [MarkdownEntity]? { lru.value(key) }   // peek: no touch

    /// Protect the leading window edge from eviction (01M1Y1GK): bump each
    /// still-cached row to MRU so find-min never discards what we're scrolling
    /// TOWARD. No-op for rows not (yet) produced. O(rowIDs), all O(1) hits.
    func touchLeading(_ rowIDs: [String], styleHash: Int) {
        for id in rowIDs { _ = lru.hit(Self.key(rowID: id, styleHash: styleHash)) }
    }

    func produce(_ key: String, text: String, style: MarkdownProseStyle) async -> [MarkdownEntity] {
        if let hit = lru.hit(key) { return hit }   // touch: stamp MRU, O(1)
        RenderActivity.produceStarted += 1
        let t0 = DispatchTime.now().uptimeNanoseconds
        let made = await Task.detached(priority: .userInitiated) {
            markdownEntities(text, style: style)
        }.value
        RenderActivity.produceLastMicros = Int((DispatchTime.now().uptimeNanoseconds - t0) / 1000)
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
