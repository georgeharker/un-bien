import Foundation
import os
import SwiftUI
import UnBienCore
import Highlighter
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - Producer abstraction
//
// The cache owns STORAGE + the off-main WINDOWED PULL; a producer owns ONLY
// production of the NSAttributedString. Plug in a highlighter, a diff colorer,
// or any future block type as an instance — they all share one bounded NSCache
// and one serial eval queue with ticket cancellation. `produce()` runs ON that
// queue (off-main), so a producer must be Sendable.

/// One theme-specialized attributed-text producer, keyed for the shared cache.
public protocol AttributedTextProducer: Sendable {
    /// Stable cache key. Two producers with the same key MUST yield the same
    /// string — theme, font and content all fold into it.
    var cacheKey: String { get }
    /// Plain fallback shown for the one frame before the windowed pull warms
    /// the cache (in practice rarely seen: the near-window produces ahead of
    /// the viewport, so the cache is warm before the row is on screen).
    var plainText: String { get }
    /// Build the attributed string — called at most once per key (cache miss),
    /// ON the cache's eval queue.
    func produce() -> NSAttributedString?
}

/// highlight.js, via the cache's queue-confined engine pool (JSContext never
/// crosses threads). Carries font IDENTITY (name/size) so it stays Sendable.
public struct HighlightProducer: AttributedTextProducer {
    let code: String
    let language: String?
    let style: String
    let fontName: String?
    let fontSize: CGFloat
    // When set, cache by IDENTITY (id-spaced, e.g. "<toolCallID>\u{1}@source")
    // rather than by content. Still folds in style+font (render context that
    // changes the output); the code text no longer bloats the key. nil = the
    // content-addressed default (dedups identical standalone code blocks).
    let identity: String?

    public init(code: String, language: String?, style: String, font: PlatformFont?,
                identity: String? = nil) {
        self.code = code
        self.language = language
        self.style = style
        self.fontName = font?.fontName
        self.fontSize = font?.pointSize ?? 0
        self.identity = identity
    }

    public var cacheKey: String {
        if let identity {
            let fk = fontName.map { "\($0):\(fontSize)" } ?? "system"
            return "code\u{1}\(style)\u{1}\(fk)\u{1}\(identity)"
        }
        return AttributedTextCache.codeKey(style: style, fontName: fontName, fontSize: fontSize,
                                           language: language, code: code)
    }
    public var plainText: String { code }
    public func produce() -> NSAttributedString? {
        AttributedTextCache.shared.highlightNSAttr(code, language: language, style: style,
                                                   fontName: fontName, fontSize: fontSize)
    }
}

/// Diff colorer — pure production, no shared engine. A card's diff is
/// immutable, so the key is just `<themeID>:<toolCallID>`; hunks + colors ride
/// the queue hop (JSONValue and SwiftUI.Color are Sendable) and resolve to
/// PlatformColor inside `produce()`.
public struct DiffProducer: AttributedTextProducer {
    let toolCallID: String
    let themeID: String
    let hunks: [JSONValue]
    let add: Color
    let remove: Color
    let context: Color
    let budget: Int

    public init(toolCallID: String, themeID: String, hunks: [JSONValue],
                add: Color, remove: Color, context: Color, budget: Int = 800) {
        self.toolCallID = toolCallID
        self.themeID = themeID
        self.hunks = hunks
        self.add = add
        self.remove = remove
        self.context = context
        self.budget = budget
    }

    public var cacheKey: String { "\(themeID)\u{1}\(toolCallID)\u{1}@diff" }
    public var plainText: String { "" }

    public func produce() -> NSAttributedString? {
        let out = NSMutableAttributedString()
        let addC = PlatformColor(add), remC = PlatformColor(remove), ctxC = PlatformColor(context)
        var count = 0
        walk: for hunk in hunks {
            for line in hunk["lines"]?.arrayValue ?? [] {
                if count >= budget {
                    out.append(NSAttributedString(string: "  \u{22EF} (diff truncated)\n",
                                                  attributes: [.foregroundColor: ctxC]))
                    break walk
                }
                let kind = line["kind"]?.stringValue ?? ""
                let color = kind == "remove" ? remC : kind == "add" ? addC : ctxC
                out.append(NSAttributedString(
                    string: Self.prefix(kind) + (line["text"]?.stringValue ?? "") + "\n",
                    attributes: [.foregroundColor: color]))
                count += 1
            }
        }
        return out
    }

    static func prefix(_ kind: String) -> String {
        switch kind {
        case "remove": return "-"
        case "add": return "+"
        case "ellipsis": return " \u{22EF}"
        default: return " "
        }
    }
}

/// Shared, bounded cache for themed attributed text (syntax-highlighted code,
/// colored diffs, …) with an off-main windowed pull.
///
/// HighlighterSwift (smittytone; highlight.js via JavaScriptCore, synchronous
/// NSAttributedString) runs tens of ms per block, and swift-markdown-ui
/// re-invokes it every time a row re-enters the near window — so without a
/// cache, scrolling re-highlights every visible block (the scroll jank). This
/// caches the produced NSAttributedString keyed by each producer's `cacheKey`;
/// a theme/font change yields new keys and stale entries LRU-evict. Engine
/// instances are pooled per (style, font) rather than re-created per render
/// (each init spins up a JS runtime). The cache bound is configurable
/// (`cacheLimit`, Settings).
///
/// Thread-safe by construction (NSCache is thread-safe; the main engine dict is
/// guarded by `lock`, the queue engine dict is `evalQueue`-confined), hence
/// `@unchecked Sendable`.
public final class AttributedTextCache: @unchecked Sendable {
    public static let shared = AttributedTextCache()

    // Manual access-touched LRU (design 01M1Y1GK). Replaces NSCache, whose
    // eviction is opaque and whose reads give no recency touch, so retention
    // couldn't follow what the reader is VIEWING.
    //
    // WHY THE RENDER CAN GO NEAR-LOCKLESS: unlike the entity store (which is
    // @MainActor, so render and store are the same thread and it needs NO lock),
    // this cache is genuinely CROSS-THREAD — read on the MAIN thread
    // (highlighted() during MarkdownUI render, cached() in AsyncAttributedText
    // .body) and written on the evalQueue (async produce). A lock is required
    // for correctness. NEARLY ALL holds are O(1) dict ops — peek/get, set, or a
    // seq-stamp touch (no reorder); the async produce runs its engine OFF this
    // lock (evalQueue, SEPARATE queueEngines pool), and O(n) find-min eviction is
    // on INSERT, not on a render read. os_unfair_lock (OSAllocatedUnfairLock)
    // because those holds are nanosecond-short. THE ONE EXCEPTION is the sync
    // highlighted() main path, which DELIBERATELY holds the lock across
    // engine.highlight to serialise the non-thread-safe JSContext engine (why:
    // see there).
    //
    // LRU: SeqStampLRU (shared with MarkdownEntityStore) — touch O(1), find-min
    // victim search on PURGE only. This cache guards it with `lock` (genuinely
    // cross-thread); the entity store uses the same type bare (@MainActor).
    private var lru = SeqStampLRU<String, NSAttributedString>(cap: 400)
    private var engines: [String: Highlighter] = [:]      // main-path pool (highlighted)
    private let lock = OSAllocatedUnfairLock()
    private let pressureSource = DispatchSource.makeMemoryPressureSource(
        eventMask: [.warning, .critical], queue: .global(qos: .utility))

    /// Max cached blocks. Configurable (Settings); default 400. Trades memory
    /// for scroll smoothness on long sessions.
    public var cacheLimit: Int {
        get { lock.lock(); defer { lock.unlock() }; return lru.cap }
        set {
            lock.lock(); defer { lock.unlock() }
            lru.cap = max(0, newValue)   // cap didSet purges
        }
    }

    private init() {
        pressureSource.setEventHandler { [weak self] in self?.purgeUnderPressure() }
        pressureSource.resume()
    }

    // MARK: - LRU store (all access lock-guarded)

    /// Read WITHOUT touching recency — the render-path read (sync body / sync
    /// highlight), so rendering never reorders the LRU.
    private func peek(_ key: String) -> NSAttributedString? {
        lock.lock(); defer { lock.unlock() }
        return lru.value(key)
    }
    /// Read + TOUCH to MRU — the async .task MATERIALISE path (event, not a view
    /// body). Materialisation order = scroll direction, so the leading edge
    /// lands MRU and evicts last (design 01M1Y1GK).
    private func touchHit(_ key: String) -> NSAttributedString? {
        lock.lock(); defer { lock.unlock() }
        return lru.hit(key)
    }
    private func insert(_ key: String, _ value: NSAttributedString) {
        lock.lock(); defer { lock.unlock() }
        lru.insert(key, value)
    }
    /// Caller MUST hold `lock` (the sync highlight path double-checks/inserts
    /// under its own lock). O(1): peek or a seq stamp, never an array reorder.
    private func getLocked(_ key: String, touch: Bool) -> NSAttributedString? {
        touch ? lru.hit(key) : lru.value(key)
    }
    private func setLocked(_ key: String, _ value: NSAttributedString) {
        lru.insert(key, value)
    }
    /// Purge cached strings under memory pressure (keeps the JS engine pools) —
    /// the safety net NSCache gave automatically (design 01M1Y1GK).
    private func purgeUnderPressure() {
        lock.lock(); defer { lock.unlock() }
        lru.removeAll(keepingCapacity: false)
    }

    /// `\u{1}`-joined key can't collide across fields (content can't contain it).
    public static func codeKey(style: String, fontName: String?, fontSize: CGFloat,
                               language: String?, code: String) -> String {
        let fk = fontName.map { "\($0):\(fontSize)" } ?? "system"
        return "code\u{1}\(style)\u{1}\(fk)\u{1}\(language ?? "")\u{1}\(code)"
    }

    // MARK: - Generic windowed pull (every producer shares this)

    /// Cache-ONLY sync lookup — nil on miss, never evaluates, never blocks. The
    /// repeat-render hot path (a warm near-window row hits this synchronously).
    public func cached(_ producer: any AttributedTextProducer) -> AttributedString? {
        peek(producer.cacheKey).map(AttributedString.init)
    }

    /// Off-main produce-once: awaits a slot on the serial eval queue; a
    /// cancelled ticket (the requesting view left the near window) is DROPPED
    /// at drain, so onscreen work gets the queue. Windowed callers warm this
    /// AHEAD of display — no visible frame delay. Returns nil when cancelled or
    /// unproducible; the caller's plain fallback stands.
    public func attributed(_ producer: any AttributedTextProducer) async -> AttributedString? {
        let key = producer.cacheKey
        if let hit = touchHit(key) { return AttributedString(hit) }
        let ticket = EvalTicket()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<AttributedString?, Never>) in
                evalQueue.async { [weak self] in
                    guard let self else { cont.resume(returning: nil); return }
                    if ticket.isCancelled { cont.resume(returning: nil); return }   // mutable queue: drop
                    if let hit = self.touchHit(key) {
                        cont.resume(returning: AttributedString(hit)); return
                    }
                    guard let made = producer.produce() else { cont.resume(returning: nil); return }
                    self.insert(key, made)
                    cont.resume(returning: AttributedString(made))
                }
            }
        } onCancel: {
            ticket.cancel()
        }
    }

    // MARK: - Sync main-path highlight (MarkdownUI's synchronous protocol)

    /// Highlighted `code`, from cache when available. Synchronous because
    /// swift-markdown-ui's `CodeSyntaxHighlighter` protocol can't await; shares
    /// the same NSCache as the async path (cache-covered after first render).
    public func highlighted(_ code: String, language: String?, style: String,
                            font: PlatformFont?) -> AttributedString? {
        let key = Self.codeKey(style: style, fontName: font?.fontName,
                               fontSize: font?.pointSize ?? 0, language: language, code: code)
        if let hit = peek(key) { return AttributedString(hit) }

        // The lock IS held across engine.highlight here — deliberately, and unlike
        // everywhere else the lock is O(1)-only. Highlighter is JSContext-backed
        // and NOT thread-safe, so this serialises ENGINE USE. We do NOT narrow it
        // by assuming highlighted() is main-serial: that's an assumption about
        // MarkdownUI's CodeSyntaxHighlighter threading, and a concurrent/off-main
        // call would corrupt the shared JSContext mid-highlight (the highlight
        // data going away under us). The cost is only the evalQueue's O(1) store
        // ops waiting for the highlight's duration, and only on the STREAMING
        // render path (the main thread is busy with the highlight anyway); the
        // scroll-critical async path uses the SEPARATE queueEngines pool off this
        // lock, so scroll is unaffected.
        lock.lock()
        defer { lock.unlock() }
        if let hit = getLocked(key, touch: false) { return AttributedString(hit) }  // double-check under lock
        let engineKey = "\(style)\u{1}\(font.map { "\($0.fontName):\($0.pointSize)" } ?? "system")"
        let engine: Highlighter
        if let existing = engines[engineKey] {
            engine = existing
        } else {
            guard let instance = Highlighter() else { return nil }
            _ = instance.setTheme(style)
            if let font { instance.theme.setCodeFont(font) }
            engines[engineKey] = instance
            engine = instance
        }
        guard let result = engine.highlight(code, as: language) else { return nil }
        setLocked(key, result)
        return AttributedString(result)
    }

    /// Drop all cached results (e.g. on a hard theme reset).
    public func clear() {
        lock.lock()
        lru.removeAll()
        engines.removeAll()
        lock.unlock()
        evalQueue.async { [weak self] in
            self?.queueEngines.removeAll()
        }
    }

    // MARK: - Off-main evaluation (perf #5, corrected 2026-09-18)
    //
    // A DEDICATED SERIAL QUEUE with its OWN engine pool (JSContexts created AND
    // used only on that queue — never crossing threads), TICKET CANCELLATION
    // checked at drain (the requesting view's `.task` dies with the view;
    // cancelled tickets drop BEFORE the expensive part — the "mutable queue"),
    // and a cache re-check at drain. `HighlightProducer.produce()` delegates
    // here via `highlightNSAttr`, so the JS engines stay pooled + confined.

    private let evalQueue = DispatchQueue(label: "un-bien.attrtext.eval", qos: .userInitiated)
    private var queueEngines: [String: Highlighter] = [:]   // evalQueue-confined

    /// evalQueue-confined highlight production. MUST be called only from a
    /// producer running on `evalQueue` (i.e. inside `attributed`).
    func highlightNSAttr(_ code: String, language: String?, style: String,
                         fontName: String?, fontSize: CGFloat) -> NSAttributedString? {
        let fk = fontName.map { "\($0):\(fontSize)" } ?? "system"
        let engineKey = "\(style)\u{1}\(fk)"
        let engine: Highlighter
        if let existing = queueEngines[engineKey] {
            engine = existing
        } else {
            guard let instance = Highlighter() else { return nil }
            _ = instance.setTheme(style)
            if let fontName, let font = Self.platformFont(fontName, fontSize) {
                instance.theme.setCodeFont(font)
            }
            queueEngines[engineKey] = instance
            engine = instance
        }
        return engine.highlight(code, as: language)
    }

    private static func platformFont(_ name: String, _ size: CGFloat) -> PlatformFont? {
        #if os(macOS)
        return NSFont(name: name, size: size)
        #else
        return UIFont(name: name, size: size)
        #endif
    }

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
}
