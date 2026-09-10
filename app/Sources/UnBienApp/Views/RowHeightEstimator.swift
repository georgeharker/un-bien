import Foundation
import MarkdownUI
import UnBienCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// ANALYTIC height tier — estimates a settled row's rendered height from its
/// parsed entities + images so the bounds registry carries a CLOSE reserve
/// before first materialization (device-verified motivation, 2026-09-10:
/// first-ever measures mutated content mid-momentum — hd 484 / 132,567pt in
/// one fling — and SwiftUI's id-anchor reassertion fights the deceleration
/// physics: the fast-scroll glide killer).
///
/// Ported from the EstimatorHarness SMART variant, upgraded to ENTITY-aware
/// (prewarm already classified the blocks — strictly better than fence
/// re-parsing) and IMAGE-aware (renders are scaledToFit within 480×480).
///
/// HONESTY CONTRACT ("so long as we know it's an estimate"): estimates are
/// SEEDS — a real measurement always overwrites one, estimates never persist
/// (heightSnapshot persists the registry, but re-entry re-measures), and the
/// HUD `es`/`eΔ` gauges expose seeded count + average |measure − estimate| so
/// estimator drift is visible, never silent. Constants are v1 literals —
/// calibrate against eΔ.
enum RowHeightEstimator {
    // Chrome comes from TranscriptMetrics — the SAME symbols the views apply
    // (drift structurally impossible). Only line-height factors and the
    // tight/loose list midpoint remain here (estimate-only interpolations).
    static let lineBodyFactor: Double = 1.35      // body line-height × baseSize
    static let lineMonoFactor: Double = 1.30      // code line-height × baseSize
    static var paraGap: Double { TranscriptMetrics.entitySpacing }
    static var rowChrome: Double { TranscriptMetrics.assistantRowChrome }
    static var headingExtra: Double { TranscriptMetrics.headingTopPadding }
    static var listItemGap: Double {
        (TranscriptMetrics.listItemGapTight + TranscriptMetrics.listItemGapLoose) / 2
    }
    static var quoteChrome: Double { TranscriptMetrics.quoteChrome }
    static var codeChrome: Double { TranscriptMetrics.codeBlockChrome }
    static var imageCap: Double { TranscriptMetrics.imageCap }
    static var imageSpacing: Double { TranscriptMetrics.imageSpacing }
    static let unknownImageHeight: Double = 480   // undecodable/unknown dims: reserve the cap

    /// ESTIMATE the rendered height of a settled row. width = CONTENT width
    /// available to the row body (the driver feeds the transcript content
    /// width; per-entity paddings are subtracted here). 0 width = caller opts
    /// out (no estimate). Images are warmed into ImageCache as a side effect
    /// (thread-safe NSCache) — the decode yields dimensions for free.
    static func estimate(_ entities: [MarkdownEntity], images: [WireImage],
                         style: MarkdownProseStyle, width: Double) -> Double {
        guard width > 0 else { return 0 }
        var total: Double = 0
        for (i, e) in entities.enumerated() {
            if i > 0 { total += paraGap }
            total += entity(e, style: style, width: width)
        }
        for (i, img) in images.enumerated() {
            if i > 0 || total > 0 { total += imageSpacing }
            total += imageHeight(img, width: width)
        }
        return total + rowChrome
    }

    /// TOOL-CARD estimate — a FURNITURE COMPOSITION, not lines+constant: the
    /// card is a DisclosureGroup (collapsed = header-only ≈ 44, content-blind),
    /// and its expanded body carries per-section furniture (diff switcher,
    /// labels, spacings) + text lines + images. Facts come from the view-side
    /// resolver, which owns the card data AND the persisted expansion state.
    struct ToolCardFacts {
        var expanded: Bool
        var hasSwitcher: Bool        // hunks AND content both present
        var labeledSections: Int     // "CONTENT"/"input"/"output"/"error" rows
        var textLines: Int           // mono text lines (content/args/output/error)
        var imageCount: Int
        var imageAspects: [Double]   // w/h per image (warmed decode; 0 = unknown)
        init(expanded: Bool, hasSwitcher: Bool = false, labeledSections: Int = 0,
             textLines: Int = 0, imageCount: Int = 0, imageAspects: [Double] = []) {
            self.expanded = expanded; self.hasSwitcher = hasSwitcher
            self.labeledSections = labeledSections; self.textLines = textLines
            self.imageCount = imageCount; self.imageAspects = imageAspects
        }
    }

    static func estimateToolCard(_ facts: ToolCardFacts, style: MarkdownProseStyle,
                                 width: Double) -> Double {
        let monoLine = lineHeight(size: style.codeSize ?? style.baseSize, name: style.codeFontName)
        let bodyLine = lineHeight(size: style.baseSize, name: style.fontName)
        var h = TranscriptMetrics.toolCardCollapsedChrome   // padding + header (+ images below)
        guard facts.expanded else { return h + imageTerms(facts, width: width) }
        h = TranscriptMetrics.toolCardExpandedBase
        var sections = 1
        if facts.hasSwitcher {
            h += DiffContentToggle.estimatedHeight   // estimate OWNED by the component
            sections += 1
        }
        h += Double(facts.labeledSections) * TranscriptMetrics.toolCardSectionLabelHeight
        h += Double(facts.textLines) * monoLine
        // Args sections render in body font; mono lines dominate — the blend is
        // approximated by mono (cards are overwhelmingly mono).
        h += Double(max(sections - 1, 0)) * TranscriptMetrics.toolCardSectionSpacing
        return h + imageTerms(facts, width: width)
    }

    /// Build facts from a card the SAME way the view resolver does (shared by
    /// production + the regression harness so they can't diverge).
    /// `expanded` must be seeded EXACTLY as ToolCardView does:
    /// store.expanded(id, default: expandRich && isRich).
    static func toolCardFacts(for card: ToolCard, expanded: Bool) -> ToolCardFacts {
        let contentKeys = ["content", "contents", "text", "new_string", "new_str", "newText"]
        let hasContent = contentKeys.contains {
            (card.args[$0]?.stringValue ?? "").isEmpty == false
        }
        let hasHunks = !(card.hunks ?? []).isEmpty
        var facts = ToolCardFacts(
            expanded: expanded,
            hasSwitcher: hasHunks && hasContent,
            labeledSections: (card.args.isEmpty || hasHunks || hasContent ? 0 : 1)
                + (card.result != nil && !hasContent ? 1 : 0)
                + (card.error != nil ? 1 : 0),
            textLines: 0,
            imageCount: card.images.count)
        let body: String
        if hasContent {
            body = contentKeys.compactMap { card.args[$0]?.stringValue }.first ?? ""
        } else if let result = card.result {
            body = card.state == .running
                ? String(result.prettyString.prefix(4_000))
                : result.prettyString
        } else {
            body = ""
        }
        facts.textLines = body.isEmpty ? 0 : body.split(separator: "\n",
                                                         omittingEmptySubsequences: false).count
        // DIFF HUNK LINES are content too (harness-caught gap: a hunks-only
        // card estimated 0 lines but renders them — Δ+92 on the first run).
        facts.textLines += (card.hunks ?? []).reduce(0) {
            $0 + ($1["lines"]?.arrayValue?.count ?? 0)
        }
        return facts
    }

    private static func imageTerms(_ facts: ToolCardFacts, width: Double) -> Double {
        guard facts.imageCount > 0 else { return 0 }
        var total = 0.0
        for i in 0..<facts.imageCount {
            if i > 0 { total += TranscriptMetrics.imageSpacing }
            let fitWidth = min(width, TranscriptMetrics.imageCap)
            let aspect = i < facts.imageAspects.count ? facts.imageAspects[i] : 0
            total += aspect > 0 ? min(Double(TranscriptMetrics.imageCap), fitWidth / aspect)
                                : Double(TranscriptMetrics.imageCap)
        }
        return total
    }

    /// TEXT-TIER estimate (the uncapped fast cut): composes chrome over the
    /// fork's `markdownEstimateMetrics` breakdown — no entity parse, no LRU
    /// dependency, microseconds per row. Mono/table line heights come from
    /// REAL font metrics (the fork owns the fonts; we own the chrome).
    static func estimateText(_ text: String, images: [WireImage],
                             style: MarkdownProseStyle, width: Double) -> Double {
        guard width > 0 else { return 0 }
        let m = markdownEstimateMetrics(text, style: style, width: width)
        let monoLine = Self.lineHeight(size: style.baseSize, name: style.codeFontName)
        let bodyLine = Self.lineHeight(size: style.baseSize, name: style.fontName)
        var blocks = m.proseBlocks + m.codeBlocks + m.headings
        if m.tableRows > 0 { blocks += 1 }
        if m.listItems > 0 { blocks += 1 }
        if m.quoteLines > 0 { blocks += 1 }
        // Composed step-by-step (a single chained expression trips the
        // type-checker): text metrics, then per-kind chrome, then gaps.
        var total: Double = m.textHeight
        total += Double(m.codeLines) * monoLine
        total += Double(m.codeBlocks) * codeChrome
        total += Double(m.tableRows) * (bodyLine + 8)
        total += Double(m.listItems) * listItemGap
        total += Double(max(blocks - 1, 0)) * paraGap
        for (i, img) in images.enumerated() {
            if i > 0 || total > 0 { total += imageSpacing }
            total += imageHeight(img, width: width)
        }
        return total + rowChrome
    }

    /// Real line height from font metrics (ascent+descent+leading) for the
    /// style's font at size — replaces ×-factor guesses where it matters.
    /// (macOS NSFont has no lineHeight: ascent+descent+leading.)
    static func lineHeight(size: Double, name: String?) -> Double {
        #if os(macOS)
        let font: NSFont = name.flatMap { NSFont(name: $0, size: size) }
            ?? NSFont.systemFont(ofSize: size)
        return font.ascender + font.descender.magnitude + font.leading
        #else
        let font: UIFont = name.flatMap { UIFont(name: $0, size: size) }
            ?? UIFont.systemFont(ofSize: size)
        return font.lineHeight
        #endif
    }

    /// One entity's height contribution.
    private static func entity(_ e: MarkdownEntity, style: MarkdownProseStyle, width: Double) -> Double {
        switch e {
        case .prose(let attr):
            return textHeight(String(attr.characters), size: style.baseSize,
                              fontName: style.fontName, width: width)
        case .heading(_, let text):
            return textHeight(String(text.characters), size: style.baseSize * 1.3,
                              fontName: style.fontName, width: width) + headingExtra
        case .code(_, let text):
            let lines = max(1, text.split(separator: "\n", omittingEmptySubsequences: false).count)
            return Double(lines) * style.baseSize * lineMonoFactor + codeChrome
        case .table(let t):
            return Double(max(1, t.rows.count)) * style.baseSize * lineBodyFactor + 24
        case .list(let l):
            var h: Double = 0
            for (i, item) in l.items.enumerated() {
                if i > 0 { h += 4 }
                h += estimate(item.content, images: [], style: style, width: max(0, width - 24))
                    + style.baseSize * 0.3
            }
            return h
        case .blockquote(let children):
            // NO quote chrome (harness-verified: bar + indent only); the
            // indent is the width reduction.
            return estimate(children, images: [], style: style, width: max(0, width - 20))
        case .details(let summary, _):
            // Fixed-height callout (never collapsible by design): summary + bounded.
            return textHeight(String(summary.characters), size: style.baseSize,
                              fontName: style.fontName, width: width) + 24
        case .thematicBreak:
            return 24
        case .raw(let plain):
            return textHeight(plain, size: style.baseSize, fontName: style.fontName, width: width)
        }
    }

    /// One image's rendered height: scaledToFit within (min(width, 480), 480)
    /// — height = min(480, fitWidth × h/w). Dimensions come from the warmed
    /// decode (free); SVG carries no platform decode, so its aspect comes from
    /// the viewBox (the same regex WireImageView uses). Unknown → the cap.
    static func imageHeight(_ wire: WireImage, width: Double) -> Double {
        let fitWidth = min(width, imageCap)
        let aspect: Double?     // w / h
        if wire.mime.contains("svg") {
            aspect = svgAspect(wire.data)
        } else if let image = ImageCache.shared.image(for: wire) {
            let size = image.size
            aspect = size.height > 0 ? (size.width / size.height) : nil
        } else {
            aspect = nil
        }
        guard let aspect, aspect > 0 else { return unknownImageHeight }
        return min(imageCap, fitWidth / aspect)
    }

    /// viewBox aspect from raw SVG text (fallback 4:3) — mirrors
    /// SVGImageView.aspect so estimate and render agree.
    static func svgAspect(_ svg: String) -> Double? {
        guard let regex = try? NSRegularExpression(
            pattern: #"viewBox\s*=\s*["']?\s*[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)"#),
            let match = regex.firstMatch(in: svg, range: NSRange(svg.startIndex..., in: svg)),
            let widthRange = Range(match.range(at: 1), in: svg),
            let heightRange = Range(match.range(at: 2), in: svg),
            let width = Double(svg[widthRange]), let height = Double(svg[heightRange]),
            width > 0, height > 0 else { return 4.0 / 3.0 }
        return width / height
    }

    /// Wrapped-text height via boundingRect (harness methodology; safe off-main).
    static func textHeight(_ s: String, size: Double, fontName: String?, width: Double) -> Double {
        guard !s.isEmpty, width > 0 else { return 0 }
        let font: PlatformFont
        if let fontName, let named = PlatformFont(name: fontName, size: size) {
            font = named
        } else {
            font = PlatformFont.systemFont(ofSize: size)
        }
        let attr = NSAttributedString(string: s, attributes: [.font: font])
        let rect = attr.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                     options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        return rect.height.rounded()
    }
}
