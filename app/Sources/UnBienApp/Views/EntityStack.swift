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

    @ViewBuilder
    private func entityView(_ entity: MarkdownEntity) -> some View {
        switch entity {
        case .prose(let attributed):
            Text(attributed).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

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
            HStack(spacing: 8) {
                Rectangle().fill(theme.secondaryText.opacity(0.4)).frame(width: 3)
                EntityStack(entities: children, theme: theme, typography: typography)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(TranscriptMetrics.quotePadding)

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
