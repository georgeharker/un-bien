import SwiftUI
import MarkdownUI

/// Off-main producer + cache for `[MarkdownEntity]`, keyed per settled message.
/// Parsing + prose styling run on a background task; the result is memoized so
/// a husk re-materialization is a synchronous cache hit (no re-parse).
@MainActor
final class MarkdownEntityStore {
    static let shared = MarkdownEntityStore()

    private var cache: [String: [MarkdownEntity]] = [:]
    private var order: [String] = []
    private let cap = 400

    func cached(_ key: String) -> [MarkdownEntity]? { cache[key] }

    func produce(_ key: String, text: String, style: MarkdownProseStyle) async -> [MarkdownEntity] {
        if let hit = cache[key] { return hit }
        let made = await Task.detached(priority: .userInitiated) {
            markdownEntities(text, style: style)
        }.value
        cache[key] = made
        order.append(key)
        if order.count > cap {
            let drop = order.removeFirst()
            cache[drop] = nil
        }
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

private func tableColumnAlignment(_ alignments: [MarkdownTableModel.Alignment], _ index: Int) -> HorizontalAlignment {
    guard index < alignments.count else { return .leading }
    switch alignments[index] {
    case .center: return .center
    case .right: return .trailing
    case .left, .none: return .leading
    }
}

/// The settled-message render: produces entities off-main (plain-text fallback
/// for the one frame before the first parse lands / on a cold cache), then
/// renders them through the recursive `EntityStack`.
struct MarkdownEntitiesView: View {
    let text: String
    let id: String
    let theme: AppTheme
    let typography: Typography
    @State private var entities: [MarkdownEntity]?

    // Key = message identity + a hash of the WHOLE style, so any palette/font/
    // size change re-produces without hand-listing each field in the key.
    private var style: MarkdownProseStyle { MarkdownStyleCache.style(theme: theme, typography: typography) }
    private var key: String { "\(id)\u{1}\(style.hashValue)" }

    var body: some View {
        Group {
            if let resolved = entities ?? MarkdownEntityStore.shared.cached(key) {
                EntityStack(entities: resolved, theme: theme, typography: typography)
            } else {
                Text(text).foregroundStyle(theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: key) {
            entities = await MarkdownEntityStore.shared.produce(key, text: text, style: style)
        }
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
        VStack(alignment: .leading, spacing: 8) {
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
                .padding(.top, level <= 2 ? 8 : 4)

        case .code(let language, let source):
            ScrollView(.horizontal, showsIndicators: false) {
                AsyncAttributedText(producer: HighlightProducer(
                    code: source, language: language, style: theme.codeHighlightStyle,
                    font: typography.monoPlatformFont()))
                    .font(typography.monoFont())
                    .padding(12)
            }
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
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))

        case .list(let model):
            VStack(alignment: .leading, spacing: model.isTight ? 2 : 8) {
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

        case .thematicBreak:
            Divider()

        case .raw(let raw):
            Text(raw).foregroundStyle(theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
