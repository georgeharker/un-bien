import SwiftUI
import MarkdownUI
import UnBienCore

private func tableColumnAlignment(_ alignments: [MarkdownTableModel.Alignment], _ index: Int) -> HorizontalAlignment {
    guard index < alignments.count else { return .leading }
    switch alignments[index] {
    case .center: return .center
    case .right: return .trailing
    case .left, .none: return .leading
    }
}

/// Recursive entity renderer — the pluggable materialization. Prose is one
/// cached `Text`; code rides the shared bg-warm highlight path; table/list/
/// blockquote are app-themed views whose text was styled off-main.
struct EntityStack: View {
    let entities: [MarkdownEntity]
    let theme: AppTheme
    let typography: Typography

    var body: some View {
        VStack(alignment: .leading, spacing: TranscriptMetrics.entitySpacing) {
            ForEach(Array(entities.enumerated()), id: \.offset) { _, entity in
                entityView(entity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Splits a prose run at its paragraph breaks into pieces at most about
    /// `maxHeight` points tall. Height is bounded without layout, so the split
    /// doesn't move with the width: every hard line counts as
    /// ceil(length / chars-per-line) lines at the narrowest phone width
    /// (`minWidth`) and the body size, at the estimator's line height. A piece
    /// is cut at the first paragraph break past the cap; one paragraph taller
    /// than the cap stays whole.
    /// "A\n\nB" becomes "A" and "\nB": the second piece's leading newline is
    /// the blank line between them, so the pieces stacked with no spacing
    /// show the same lines as the whole.
    nonisolated static func proseChunks(_ prose: AttributedString, bodySize: Double,
                            maxHeight: Double = 1000, minWidth: Double = 320) -> [AttributedString] {
        let lineHeight = bodySize * RowHeightEstimator.lineBodyFactor
        // ~0.5 em per character: a generous count of characters per line, so
        // the line total (and height) errs high.
        let charsPerLine = max(1, Int(minWidth / (bodySize * 0.5)))
        let maxLines = max(1, Int(maxHeight / lineHeight))
        let chars = prose.characters
        var chunks: [AttributedString] = []
        var start = chars.startIndex
        var lines = 0          // completed hard lines' wrapped line count
        var lineLength = 0     // characters on the current hard line
        var cursor = chars.startIndex
        while cursor < chars.endIndex {
            let next = chars.index(after: cursor)
            if chars[cursor] == "\n" {
                lines += max(1, (lineLength + charsPerLine - 1) / charsPerLine)
                lineLength = 0
                if lines >= maxLines, next < chars.endIndex, chars[next] == "\n" {
                    chunks.append(AttributedString(prose[start..<cursor]))
                    start = next
                    lines = 0
                }
            } else {
                lineLength += 1
            }
            cursor = next
        }
        chunks.append(AttributedString(prose[start..<chars.endIndex]))
        return chunks
    }

    @ViewBuilder
    private func entityView(_ entity: MarkdownEntity) -> some View {
        switch entity {
        case .prose(let attributed):
            // A prose run is every consecutive paragraph joined by "\n\n";
            // as ONE Text a long message is a single view thousands of points
            // tall, which iOS can leave undrawn until much of it is on screen
            // (the bubble's background draws, its text doesn't). Paragraph-
            // sized Texts stacked with no spacing render the same lines.
            VStack(alignment: .leading, spacing: 0) {
                let chunks = Self.proseChunks(attributed, bodySize: typography.bodySize)
                ForEach(Array(chunks.enumerated()), id: \.offset) { _, chunk in
                    Text(chunk).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

        case .heading(let level, let text):
            Text(text).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, level <= 2 ? TranscriptMetrics.headingTopPadding
                         : TranscriptMetrics.headingTopPadding / 2)

        case .code(let language, let source):
            // Wrap long lines instead of a horizontal ScrollView. A ScrollView
            // nested in the transcript's outer vertical ScrollView is heavy to
            // MINT per code block per band-entry (scroll infra + gesture wiring)
            // and is a known scrollable-in-scrollable smell (design 01M127NC4).
            AsyncAttributedText(producer: HighlightProducer(
                code: source, language: language, style: theme.codeHighlightStyle,
                font: typography.monoPlatformFont()))
                .font(typography.monoFont())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(TranscriptMetrics.codeBlockPadding)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))

        case .table(let model):
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                ForEach(Array(model.rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { colIndex, cell in
                            Text(cell)
                                .foregroundStyle(theme.text)
                                .fontWeight(rowIndex == 0 ? .semibold : .regular)
                                .gridColumnAlignment(tableColumnAlignment(model.alignments, colIndex))
                        }
                    }
                }
            }
            .padding(TranscriptMetrics.quotePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))

        case .list(let model):
            VStack(alignment: .leading, spacing: model.isTight ? TranscriptMetrics.listItemGapTight
                                              : TranscriptMetrics.listItemGapLoose) {
                ForEach(Array(model.items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.marker).foregroundStyle(theme.secondaryText)
                            .font(.body.monospacedDigit())
                        EntityStack(entities: item.content, theme: theme, typography: typography)
                    }
                }
            }

        case .blockquote(let children):
            // NO padding: the quote is a bar + indented children (harness
            // CAUGHT the padding this case briefly gained in the same-symbol
            // refactor — rendered 52 vs estimated 92).
            HStack(spacing: 8) {
                Rectangle().fill(theme.secondaryText.opacity(0.4)).frame(width: 3)
                EntityStack(entities: children, theme: theme, typography: typography)
            }
            .fixedSize(horizontal: false, vertical: true)

        case .details(let summary, let children):
            VStack(alignment: .leading, spacing: 6) {
                Text(summary).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                EntityStack(entities: children, theme: theme, typography: typography)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .stroke(theme.secondaryText.opacity(0.25), lineWidth: 1))

        case .thematicBreak:
            Divider()

        case .raw(let raw):
            Text(raw).foregroundStyle(theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
