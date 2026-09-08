import SwiftUI
import MarkdownUI
import UnBienCore

/// The themed live-MarkdownUI render, SHARED by the streaming assistant bubble
/// and the MarkdownEntitiesView cache-MISS fallback. Code blocks WRAP (matching
/// the entity path) so a settling bubble goes streaming → fallback → EntityStack
/// with no plain-text or code-width height flash (design 01M127NC4 warm-at-settle).
@MainActor @ViewBuilder
func styledMarkdown(_ text: String, theme: AppTheme, typography: Typography) -> some View {
    Markdown(text).unbienStyled(theme: theme, typography: typography)
}

private extension Markdown {
    @MainActor @ViewBuilder
    func unbienStyled(theme: AppTheme, typography: Typography) -> some View {
        self
            .markdownCodeSyntaxHighlighter(.highlighter(
                style: theme.codeHighlightStyle,
                font: typography.monoPlatformFont()))
            .markdownTextStyle {
                ForegroundColor(theme.text)
                FontSize(typography.bodySize)
                if let body = typography.bodyFontName, !body.isEmpty {
                    FontFamily(.custom(body))
                }
            }
            .markdownBlockStyle(\.codeBlock) { configuration in
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .font(typography.monoFont())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
                    .markdownMargin(top: 8, bottom: 8)
            }
            .textSelection(.enabled)
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
                // Formatted fallback (not plain Text) so the settle transition
                // streaming → here → EntityStack has no height flash (01M127NC4).
                styledMarkdown(text, theme: theme, typography: typography)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: key) {
            entities = await MarkdownEntityStore.shared.produce(key, text: text, style: style)
        }
    }
}
