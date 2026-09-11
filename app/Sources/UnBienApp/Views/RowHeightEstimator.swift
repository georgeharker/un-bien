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
    /// Level-tiered heading chrome (harness: flat 13 overshot #/## standalone
    /// but the long-reply's ### sections needed it — deep headings carry more).
    static func headingExtra(level: Int) -> Double { level <= 2 ? 4 : 14 }
    static var listItemGap: Double { 3 }   // harness-calibrated (loose≈8 tight≈2; rendered lands low)
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
    /// A tool row's estimate facts + its PREWARM closure (fires the exact
    /// DiffProducer/HighlightProducer the materialized card constructs —
    /// single-source via ToolCardView statics). Driver calls warm() for
    /// LEADING rows only; nil warm = materialization warms as before.
    struct ToolWarmSpec {
        let facts: ToolCardFacts
        /// MAIN-ACTOR by declaration, not by convention: the warm spawns its own
        /// producer tasks and must never ride into the off-main estimator
        /// flight. Typing it here is what keeps the Sendable half (`facts`)
        /// separable from this half at the concurrency boundary — fusing them
        /// in one tuple dragged the facts into main-actor isolation too.
        let warm: (@MainActor () -> Void)?
    }

    struct ToolCardFacts: Sendable {
        var expanded: Bool
        var hasSwitcher: Bool        // hunks AND content both present
        var labeledSections: Int     // "CONTENT"/"input"/"output"/"error" rows
        /// EVERY mono line the expanded body renders — content, args, output
        /// blocks, diff hunks — as the character count of each whitespace-
        /// separated token, unwrapped.
        ///
        /// Token shape, not line length, decides height: Text breaks on word
        /// boundaries, so one long identifier forces a break a character count
        /// says is unnecessary. A raw line COUNT is wrong for the same reason,
        /// only worse — it assumes no wrapping at all, which understates a
        /// source file at phone width several-fold. `estimateToolCard` owns the
        /// style, so it owns the wrap.
        var monoLineTokens: [[Int]]
        var imageCount: Int
        var imageAspects: [Double]   // w/h per image (warmed decode; 0 = unknown)
        init(expanded: Bool, hasSwitcher: Bool = false, labeledSections: Int = 0,
             monoLineTokens: [[Int]] = [], imageCount: Int = 0,
             imageAspects: [Double] = []) {
            self.expanded = expanded; self.hasSwitcher = hasSwitcher
            self.labeledSections = labeledSections
            self.monoLineTokens = monoLineTokens
            self.imageCount = imageCount; self.imageAspects = imageAspects
        }
    }

    /// TRUE monospace advance — the MEASURED width of "0". Deriving it from the
    /// line height cannot work: line height is ~1.25 × pointSize while the mono
    /// advance is ~0.60 × pointSize, so any factor of one mis-scales the other
    /// and diffs wrap wrong. Same measurement the fork's markdownEstimateMetrics
    /// uses for code wrapping.
    static func monoAdvance(size: Double, name: String?) -> Double {
        let font: PlatformFont
        if let name, let named = PlatformFont(name: name, size: size) {
            font = named
        } else {
            #if os(macOS)
            font = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
            #else
            font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
            #endif
        }
        return max(0.5, ("0" as NSString).size(withAttributes: [.font: font]).width)
    }

    /// Character counts of a line's whitespace-separated tokens, for the
    /// word-boundary wrap below.
    static func lineTokens(_ line: String) -> [Int] {
        line.split(separator: " ", omittingEmptySubsequences: false).map(\.count)
    }

    /// Rendered line count for one logical line at `perLine` columns, wrapping
    /// on word boundaries the way Text does. A token wider than the line is
    /// hard-broken, matching Text's behaviour for an over-long identifier.
    static func wrappedLineCount(tokens: [Int], perLine: Int) -> Int {
        guard perLine > 0, !tokens.isEmpty else { return 1 }
        var lines = 1
        var col = 0
        for token in tokens {
            if token > perLine {
                if col > 0 { lines += 1 }
                let overflow = (token - 1) / perLine
                lines += overflow
                col = token - overflow * perLine
                continue
            }
            let separator = col == 0 ? 0 : 1
            if col + separator + token > perLine {
                lines += 1
                col = token
            } else {
                col += separator + token
            }
        }
        return lines
    }

    static func estimateToolCard(_ facts: ToolCardFacts, style: MarkdownProseStyle,
                                 width: Double) -> Double {
        let monoLine = lineHeight(size: style.codeSize ?? style.baseSize, name: style.codeFontName, mono: true)
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
        // WRAP THE DIFF HERE, with the real style: diff lines render mono at
        // the code size (inherited from the card body's .font) inside the
        // card's own padding, so the content width is the row width less that
        // padding — the same subtraction the code path makes.
        let diffWidth = max(1, width - Double(TranscriptMetrics.toolCardPadding) * 2)
        let advance = monoAdvance(size: style.codeSize ?? style.baseSize, name: style.codeFontName)
        let perLine = max(1, Int(diffWidth / advance))
        let monoLines = facts.monoLineTokens.reduce(0) {
            $0 + wrappedLineCount(tokens: $1, perLine: perLine)
        }
        h += Double(monoLines) * monoLine
        // Args sections render in body font; mono lines dominate — the blend is
        // approximated by mono (cards are overwhelmingly mono).
        h += Double(max(sections - 1, 0)) * TranscriptMetrics.toolCardSectionSpacing
        return h + imageTerms(facts, width: width)
    }

    /// Build facts from a card the SAME way the view resolver does (shared by
    /// production + the regression harness so they can't diverge).
    /// `expanded` must be seeded EXACTLY as ToolCardView does:
    /// store.expanded(id, default: expandRich && isRich).
    /// WIDTH-INDEPENDENT by construction: facts describe the CARD; geometry is
    /// applied by estimateToolCard, which owns the style. Accepting a width
    /// here would invite wrap math that has no font to measure with.
    static func toolCardFacts(for card: ToolCard, expanded: Bool,
                              hideInputRich: Bool) -> ToolCardFacts {
        let contentKeys = ["content", "contents", "text", "new_string", "new_str", "newText"]
        let hasContent = contentKeys.contains {
            (card.args[$0]?.stringValue ?? "").isEmpty == false
        }
        // DERIVED hunks count too — the card renders `inputHunks` (live OR
        // derived), so reading card.hunks directly made replay cards estimate
        // no switcher and no diff lines for a diff they visibly render.
        let renderedHunks = ToolCardView.hunks(for: card) ?? []
        let hasHunks = !renderedHunks.isEmpty
        var facts = ToolCardFacts(
            expanded: expanded,
            hasSwitcher: hasHunks && hasContent,
            labeledSections: ToolCardView.sectionLabels(for: card, hideInputRich: hideInputRich),
            imageCount: card.images.count)
        let body: String
        if hasContent {
            body = contentKeys.compactMap { card.args[$0]?.stringValue }.first ?? ""
        } else if ToolCardView.showsInputSection(for: card, hideInputRich: hideInputRich) {
            // The "input" section renders the pretty-printed ARGS — previously
            // uncounted, so a card with args but no result estimated zero lines
            // for a section it visibly draws.
            body = JSONValue.object(card.args).prettyString
        } else if let result = card.result {
            body = card.state == .running
                ? String(result.prettyString.prefix(4_000))
                : result.prettyString
        } else {
            body = ""
        }
        // Body text renders through BudgetedContent, which draws only the
        // first `toolBudget` characters plus a SHOW ALL button. Estimating the
        // untruncated string reserves height for content the card never draws.
        func tokenLines(_ text: String) -> [[Int]] {
            text.split(separator: "\n", omittingEmptySubsequences: false)
                .map { lineTokens(String($0)) }
        }
        var bodyTokens: [[Int]] = []
        if !body.isEmpty {
            bodyTokens = tokenLines(String(body.prefix(toolBudget)))
            if body.count > toolBudget { bodyTokens.append([0]) }   // SHOW ALL row
        }
        // The producer prepends a "+"/"-"/" " gutter, which joins the first token.
        func hunkTokens(_ hunks: [JSONValue]) -> [[Int]] {
            hunks.flatMap { hunk in
                (hunk["lines"]?.arrayValue ?? []).map { line -> [Int] in
                    var tokens = lineTokens(line["text"]?.stringValue ?? "")
                    if tokens.isEmpty { tokens = [0] }
                    tokens[0] += 1
                    return tokens
                }
            }
        }
        var diffTokens = hunkTokens(renderedHunks)
        // OUTPUT BLOCKS mirror outputBlocksView's switch case for case: a
        // `diff` block carries EITHER `hunks` (live) or `text` (historical),
        // and only the `hunks` shape draws. Reading one field for every kind
        // cannot express that. The switcher branch draws the toggle plus one
        // face and never reaches output blocks.
        if !facts.hasSwitcher {
            for block in ToolCardView.outputBlocks(for: card) {
                switch block["kind"]?.stringValue {
                case "diff":
                    // Live blocks carry structured hunks; historical ones carry
                    // the rendered diff text. Both draw, and both wrap the same
                    // way, so both feed the word-wrap path.
                    if let hunks = block["hunks"]?.arrayValue, !hunks.isEmpty {
                        diffTokens += hunkTokens(hunks)
                    } else if let text = block["text"]?.stringValue, !text.isEmpty {
                        bodyTokens += tokenLines(String(text.prefix(toolBudget)))
                    }
                case "code":
                    guard let text = block["text"]?.stringValue, !text.isEmpty else { continue }
                    bodyTokens += tokenLines(String(text.prefix(toolBudget)))
                default:
                    continue
                }
            }
            // The "\u{2026} output truncated" footer occupies a line.
            if card.output?["truncated"]?.boolValue == true { bodyTokens.append([0]) }
        }
        // A SWITCHER draws exactly one face, and Diff is the default — adding
        // the hidden content's lines reserves height nothing occupies.
        facts.monoLineTokens = facts.hasSwitcher ? diffTokens : bodyTokens + diffTokens
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
    /// Row-shape geometry for the text tier. Rows differ in more than their
    /// caption: a user bubble's text sits inside a padded surface, so it both
    /// adds chrome and NARROWS the wrap width. Estimating every row with the
    /// assistant's shape biases every user row short by the difference.
    struct RowTextSpec: Sendable {
        let chrome: Double
        /// Horizontal inset the text is laid out within (both sides summed).
        let inset: Double
        static let assistant = RowTextSpec(
            chrome: TranscriptMetrics.assistantRowChrome, inset: 0)
        static let user = RowTextSpec(
            chrome: TranscriptMetrics.userRowChrome,
            inset: Double(TranscriptMetrics.userBubblePadding) * 2)
    }

    /// A row the leading pass warms: the BUBBLE id to key the entity cache by,
    /// its content, and the row shape the estimate must use.
    struct WarmRow: Sendable {
        let id: String
        let text: String
        let images: [WireImage]
        let spec: RowTextSpec
        init(id: String, text: String, images: [WireImage], spec: RowTextSpec) {
            self.id = id; self.text = text; self.images = images; self.spec = spec
        }
    }

    static func estimateText(_ text: String, images: [WireImage],
                             style: MarkdownProseStyle, width: Double,
                             spec: RowTextSpec = .assistant) -> Double {
        guard width > 0 else { return 0 }
        let width = max(1, width - spec.inset)
        let m = markdownEstimateMetrics(text, style: style, width: width)
        let monoLine = Self.lineHeight(size: style.codeSize ?? style.baseSize,
                                     name: style.codeFontName, mono: true)
        let bodyLine = Self.lineHeight(size: style.baseSize, name: style.fontName)
        var blocks = m.proseBlocks + m.codeBlocks + m.headings
        if m.tableRows > 0 { blocks += 1 }
        if m.listItems > 0 { blocks += 1 }
        if m.quoteLines > 0 { blocks += 1 }
        // PROSE-PROSE spacing renders ~14pt (harness-calibrated: 8 gap + 6
        // extra) — coalesced paragraphs carry internal spacing ABOVE the
        // entity gap.
        let proseExtra = Double(max(m.proseBlocks - 1, 0)) * 6
        // Composed step-by-step (a single chained expression trips the
        // type-checker): text metrics, then per-kind chrome, then gaps.
        var total: Double = m.textHeight
        total += Double(m.codeLines) * monoLine
        total += Double(m.codeBlocks) * codeChrome
        total += Double(m.tableLines) * bodyLine   // WRAPPED row-lines (wide tables)
        total += Double(m.tableRows) * 8            // grid row spacing
        total += Double(m.listItems) * listItemGap
        total += Double(m.headings) * headingExtra(level: 3)
        total += Double(max(blocks - 1, 0)) * paraGap
        total += proseExtra
        for (i, img) in images.enumerated() {
            if i > 0 || total > 0 { total += imageSpacing }
            total += imageHeight(img, width: width)
        }
        return total + spec.chrome
    }

    /// Real line height from font metrics (ascent+descent+leading) for the
    /// style's font at size — replaces ×-factor guesses where it matters.
    /// (macOS NSFont has no lineHeight: ascent+descent+leading.)
    static func lineHeight(size: Double, name: String?, mono: Bool = false) -> Double {
        #if os(macOS)
        let font: NSFont
        if let name, let named = NSFont(name: name, size: size) {
            font = named
        } else {
            font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
                        : NSFont.systemFont(ofSize: size)
        }
        return font.ascender + font.descender.magnitude + font.leading
        #else
        let font: UIFont
        if let name, let named = UIFont(name: name, size: size) {
            font = named
        } else {
            font = mono ? UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
                        : UIFont.systemFont(ofSize: size)
        }
        return font.lineHeight
        #endif
    }

    /// One entity's height contribution.
    private static func entity(_ e: MarkdownEntity, style: MarkdownProseStyle, width: Double) -> Double {
        switch e {
        case .prose(let attr):
            return textHeight(String(attr.characters), size: style.baseSize,
                              fontName: style.fontName, width: width)
        case .heading(let level, let text):
            return textHeight(String(text.characters), size: style.baseSize * 1.3,
                              fontName: style.fontName, width: width) + headingExtra(level: level)
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
