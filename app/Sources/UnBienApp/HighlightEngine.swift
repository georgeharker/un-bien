import Foundation
import Highlighter
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Shared, bounded cache for syntax-highlighted code.
///
/// HighlighterSwift (smittytone — the maintained successor to the archived
/// raspu/Highlightr; same architecture: highlight.js via JavaScriptCore,
/// synchronous NSAttributedString) runs tens of ms per block, and
/// swift-markdown-ui re-invokes the highlighter every time a row re-enters
/// the near window — so without a cache, scrolling re-highlights every
/// visible block on every appearance (the scroll jank). This caches the result
/// keyed by (code, language, style, font): a theme/font change yields new keys
/// and the stale entries LRU-evict. Highlighter engine instances are reused
/// per (style, font) rather than re-created per render (each init spins up a
/// JS runtime). The cache bound is a configurable option (`cacheLimit`).
///
/// Thread-safe by construction (NSCache is thread-safe; the engine dict is
/// guarded by `lock`), hence `@unchecked Sendable`.
public final class HighlightEngine: @unchecked Sendable {
    public static let shared = HighlightEngine()

    private let cache = NSCache<NSString, NSAttributedString>()
    private var engines: [String: Highlighter] = [:]
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
        let engine: Highlighter?
        if let existing = engines[engineKey] {
            engine = existing
        } else {
            let instance = Highlighter()
            _ = instance?.setTheme(style)
            if let font { instance?.theme.setCodeFont(font) }
            engines[engineKey] = instance
            engine = instance
        }
        guard let engine, let result = engine.highlight(code, as: language) else {
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
        evalQueue.async { [weak self] in
            self?.queueEngines.removeAll()
        }
    }

    // MARK: - Off-main evaluation (perf #5, corrected 2026-09-18)
    //
    // The first attempt (REVERTED — never shipped) ran Task.detached against
    // the MAIN-pool engines: JSContext thread-binding violated (detached
    // tasks run on arbitrary executor threads; contexts created on main),
    // fire-and-forget (no cancellation: offscreen rows kept the queue busy —
    // the scroll-highlight slowness), and main-path lock contention (a big
    // background evaluation would stall sync callers behind the engine
    // lock). Corrected: a DEDICATED SERIAL QUEUE with its OWN engine pool
    // (contexts created AND used only on that queue — never crossing
    // threads), TICKET CANCELLATION checked at drain (the requesting view's
    // .task dies with the view; cancelled tickets drop BEFORE the expensive
    // part — the "mutable queue", user 2026-09-18), the font crossing as
    // identity (PlatformFont is not Sendable), and a cache re-check at both
    // enqueue and drain.

    private let evalQueue = DispatchQueue(label: "un-bien.highlight.eval", qos: .userInitiated)
    private var queueEngines: [String: Highlighter] = [:]   // evalQueue-confined

    /// Cancellation ticket — flipped by the awaiting task's cancellation
    /// handler; the queue drain checks it before evaluating.
    private final class EvalTicket: @unchecked Sendable {
        private let lock = NSLock()
        private var cancelled = false
        var isCancelled: Bool {
            lock.lock(); defer { lock.unlock() }
            return cancelled
        }
        func cancel() {
            lock.lock(); cancelled = true; lock.unlock()
        }
    }

    private static func fontKey(fontName: String?, fontSize: CGFloat) -> String {
        guard let fontName else { return "system" }
        return "\(fontName):\(fontSize)"
    }

    private static func fontFromIdentity(_ fontName: String?, fontSize: CGFloat) -> PlatformFont? {
        guard let fontName else { return nil }
        #if os(macOS)
        return NSFont(name: fontName, size: fontSize)
        #else
        return UIFont(name: fontName, size: fontSize)
        #endif
    }

    /// Cache-ONLY lookup — nil on miss; never evaluates, never blocks. The
    /// render path's synchronous common case (repeat renders hit this).
    public func cached(_ code: String, language: String?, style: String,
                       font: PlatformFont?) -> AttributedString? {
        let fontKey = font.map { "\($0.fontName):\($0.pointSize)" } ?? "system"
        let key = "\(style)\u{1}\(fontKey)\u{1}\(language ?? "")\u{1}\(code)" as NSString
        guard let hit = cache.object(forKey: key) else { return nil }
        return AttributedString(hit)
    }

    /// Off-main highlight: awaits a slot on the serial eval queue. A
    /// cancelled ticket (the requesting view left the hierarchy — row
    /// scrolled offscreen) is DROPPED at drain; onscreen work gets the
    /// queue. Returns nil when cancelled or unhighlightable — the caller's
    /// plain-mono frame stands.
    public func highlightOffMain(_ code: String, language: String?, style: String,
                                 fontName: String?, fontSize: CGFloat) async -> AttributedString? {
        // Cache may have filled (another path warmed it) — never queue what
        // we already have.
        let fk = Self.fontKey(fontName: fontName, fontSize: fontSize)
        let earlyKey = "\(style)\u{1}\(fk)\u{1}\(language ?? "")\u{1}\(code)" as NSString
        if let hit = cache.object(forKey: earlyKey) { return AttributedString(hit) }

        let ticket = EvalTicket()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<AttributedString?, Never>) in
                evalQueue.async { [weak self] in
                    guard let self else { cont.resume(returning: nil); return }
                    if ticket.isCancelled { cont.resume(returning: nil); return }   // mutable queue: drop
                    let result = self.evaluateOnQueue(code, language: language, style: style,
                                                      fontName: fontName, fontSize: fontSize)
                    cont.resume(returning: result)
                }
            }
        } onCancel: {
            ticket.cancel()
        }
    }

    /// evalQueue-confined evaluation: the queue's OWN engine pool (JSContext
    /// never crosses threads); the shared NSCache is the only cross-path
    /// state (thread-safe by construction).
    private func evaluateOnQueue(_ code: String, language: String?, style: String,
                                 fontName: String?, fontSize: CGFloat) -> AttributedString? {
        let fk = Self.fontKey(fontName: fontName, fontSize: fontSize)
        let key = "\(style)\u{1}\(fk)\u{1}\(language ?? "")\u{1}\(code)" as NSString
        if let hit = cache.object(forKey: key) { return AttributedString(hit) }
        let engineKey = "\(style)\u{1}\(fk)"
        let engine: Highlighter
        if let existing = queueEngines[engineKey] {
            engine = existing
        } else {
            guard let instance = Highlighter() else { return nil }
            _ = instance.setTheme(style)
            if let font = Self.fontFromIdentity(fontName, fontSize: fontSize) {
                instance.theme.setCodeFont(font)
            }
            queueEngines[engineKey] = instance
            engine = instance
        }
        guard let result = engine.highlight(code, as: language) else { return nil }
        cache.setObject(result, forKey: key)
        return AttributedString(result)
    }
}

// rebuild-probe
