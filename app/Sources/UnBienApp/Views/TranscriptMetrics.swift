import Foundation

/// THE single source of the transcript's layout chrome — every vertical
/// constant the render tree applies that a height estimate must account for.
/// Views reference these SYMBOLS (not copies), and RowHeightEstimator reads
/// the same symbols — a padding change in a view is automatically the
/// estimator's new constant; drift is structurally impossible (design:
/// analytic height tier, "same constant, not just same value").
///
/// Audited 2026-09-10 against EntityStack / TranscriptRowViews / ToolCardView.
/// A few entries are ESTIMATE-ONLY (natural heights SwiftUI computes, like the
/// assistant header's caption line) — documented as such; they have no view
/// literal to share and are calibrated, not read.
enum TranscriptMetrics {
    // EntityStack (inter-entity / per-block-kind):
    /// Spacing between entities in the settled bubble's stack.
    static let entitySpacing: CGFloat = 8
    /// Code block inner padding (all sides).
    static let codeBlockPadding: CGFloat = 12
    /// Code block vertical chrome (padding × 2).
    static let codeBlockChrome: CGFloat = codeBlockPadding * 2
    /// Heading top padding (level ≤ 2; deeper levels use half).
    static let headingTopPadding: CGFloat = 8
    /// List item spacing when the source list is tight / loose.
    static let listItemGapTight: CGFloat = 2
    static let listItemGapLoose: CGFloat = 8
    /// Blockquote inner padding (all sides).
    static let quotePadding: CGFloat = 8
    /// Blockquote vertical chrome (padding × 2).
    static let quoteChrome: CGFloat = quotePadding * 2
    /// Table row height addend over the body line (Grid verticalSpacing 6 ×2-ish).
    static let tableRowExtra: CGFloat = 8

    // Assistant / user rows (TranscriptRowViews):
    /// ESTIMATE-ONLY: the "Pi" header caption line's natural height (~17pt).
    static let assistantHeaderHeight: Double = 17
    /// Spacing between the assistant header row and the entity stack.
    static let assistantHeaderSpacing: CGFloat = 4
    /// ESTIMATE-ONLY: total assistant row chrome (header + spacing + slack).
    static let assistantRowChrome: Double = 24

    // Images (WireImageView):
    /// Render cap (maxWidth/maxHeight) for inline images.
    static let imageCap: CGFloat = 480
    /// Spacing between stacked images / after entities.
    static let imageSpacing: CGFloat = 8

    // Tool cards (ToolCardView):
    /// Outer card padding (all sides).
    static let toolCardPadding: CGFloat = 10
    /// Section spacing INSIDE the expanded content (VStack spacing 6).
    static let toolCardSectionSpacing: CGFloat = 6
    /// ESTIMATE-ONLY: header label row (icon + tool name, callout) ≈ 20.
    static let toolCardHeaderHeight: Double = 20
    /// ESTIMATE-ONLY: the DiffContentToggle switcher row ≈ 30 (natural height,
    /// present when hunks AND content both exist).
    static let toolCardSwitcherHeight: Double = 30
    /// ESTIMATE-ONLY: a section label row ("CONTENT"/"input"/… 9pt + spacing 2) ≈ 16.
    static let toolCardSectionLabelHeight: Double = 16
    /// COLLAPSED card total (padding ×2 + header) — a collapsed card's height
    /// is content-INDEPENDENT (DisclosureGroup hides the body; images remain).
    static let toolCardCollapsedChrome: Double = 44
    /// Expanded non-content base (padding ×2 + header + top pad 4).
    static let toolCardExpandedBase: Double = 48
}
