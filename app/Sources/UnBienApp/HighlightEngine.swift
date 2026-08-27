import Foundation
import Highlightr

/// Shared, bounded cache for syntax-highlighted code.
///
/// Highlightr runs highlight.js via JavaScriptCore (tens of ms per block), and
/// swift-markdown-ui re-invokes the highlighter every time a row re-enters the
/// `LazyVStack` viewport — so without a cache, scrolling re-highlights every
/// visible block on every appearance (the scroll jank). This caches the result
/// keyed by (code, language, style, font): a theme/font change yields new keys
/// and the stale entries LRU-evict. Highlightr engine instances are reused per
/// (style, font) rather than re-created per render (each init spins up a JS
/// runtime). The cache bound is a configurable option (`cacheLimit`).
///
/// Thread-safe by construction (NSCache is thread-safe; the engine dict is
/// guarded by `lock`), hence `@unchecked Sendable`.
public final class HighlightEngine: @unchecked Sendable {
    public static let shared = HighlightEngine()

    private let cache = NSCache<NSString, NSAttributedString>()
    private var engines: [String: Highlightr] = [:]
    private let lock = NSLock()

    /// Max cached highlighted blocks. Configurable (Settings); default 400.
    /// Trades memory for scroll smoothness on long sessions.
    public var cacheLimit: Int {
        get { cache.countLimit }
        set { cache.countLimit = max(0, newValue) }
    }

    private init() { cache.countLimit = 400 }

    /// Highlighted `code`, from cache when available. `\u{1}`-joined key can't
    /// collide across fields (code can't contain it).
    public func highlighted(_ code: String, language: String?, style: String,
                            font: PlatformFont?) -> AttributedString? {
        let fontKey = font.map { "\($0.fontName):\($0.pointSize)" } ?? "system"
        let key = "\(style)\u{1}\(fontKey)\u{1}\(language ?? "")\u{1}\(code)" as NSString
        if let hit = cache.object(forKey: key) { return AttributedString(hit) }

        lock.lock()
        defer { lock.unlock() }
        if let hit = cache.object(forKey: key) { return AttributedString(hit) }  // double-check under lock

        let engineKey = "\(style)\u{1}\(fontKey)"
        let engine: Highlightr?
        if let existing = engines[engineKey] {
            engine = existing
        } else {
            let instance = Highlightr()
            instance?.setTheme(to: style)
            if let font { instance?.theme.setCodeFont(font) }
            engines[engineKey] = instance
            engine = instance
        }
        guard let engine, let result = engine.highlight(code, as: language, fastRender: true) else {
            return nil
        }
        cache.setObject(result, forKey: key)
        return AttributedString(result)
    }

    /// Drop all cached highlights (e.g. on a hard theme reset).
    public func clear() {
        cache.removeAllObjects()
        lock.lock()
        engines.removeAll()
        lock.unlock()
    }
}
