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
    // v1 tuning literals (calibrated against the device eΔ gauge, 2026-09-10:
    // first cut averaged 27pt SHORT — a systematic row-chrome underestimate):
    static let lineBodyFactor: Double = 1.35      // body line-height × baseSize
    static let lineMonoFactor: Double = 1.30      // code line-height × baseSize
    static let codeChrome: Double = 48            // code block padding (12×2) + margins (8×2) + bubble chrome
    static let paraGap: Double = 12               // between markdown blocks
    static let rowChrome: Double = 30             // row/bubble padding + margins (44 overshot: b −19 → trim)
    static let headingExtra: Double = 10          // heading margins above wrapped prose
    static let imageCap: Double = 480             // WireImageView's maxWidth/maxHeight
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
            if i > 0 || total > 0 { total += 8 }
            total += imageHeight(img, width: width)
        }
        return total + rowChrome
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
            return estimate(children, images: [], style: style, width: max(0, width - 20)) + 12
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
