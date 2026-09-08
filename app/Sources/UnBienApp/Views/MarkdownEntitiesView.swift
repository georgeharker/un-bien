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

/// Streaming assistant bubble rendered through the ENTITY renderer (design
/// 01M1YT1QGM): an off-main incremental segmenter re-segments only the changed
/// TAIL of the growing text and feeds the SAME EntityStack the settled bubble
/// uses — so there is no streaming->settled flip. Throttled (one segment at a
/// time, always the latest text, >=30ms between starts) so it neither starves
/// under a continuous stream nor spams; last-good entities held so it never
/// blanks. The segmenter is an actor, so [BlockNode] stays off-main and only
/// [MarkdownEntity] crosses back.
@MainActor
final class StreamingEntityCoordinator: ObservableObject {
    @Published private(set) var entities: [MarkdownEntity]?
    private var segmenter: MarkdownStreamSegmenter
    private var currentStyle: MarkdownProseStyle
    private var latest = ""
    private var running = false
    private var styleDirty = false
    private let minInterval: UInt64 = 30_000_000

    init(style: MarkdownProseStyle) {
        currentStyle = style
        segmenter = MarkdownStreamSegmenter(style: style)
    }

    func submit(_ text: String) {
        latest = text
        guard !running else { return }
        running = true
        Task { await pump() }
    }

    /// Theme/typography changed mid-stream: rebuild the segmenter (fresh prior
    /// state) with the new style; the pump re-segments the latest text with it.
    func updateStyle(_ style: MarkdownProseStyle) {
        guard style != currentStyle else { return }
        currentStyle = style
        segmenter = MarkdownStreamSegmenter(style: style)
        styleDirty = true
        if !running { running = true; Task { await pump() } }
    }

    private func pump() async {
        while true {
            styleDirty = false
            let snapshot = latest
            let seg = segmenter
            let produced = await seg.segment(snapshot)
            self.entities = produced
            try? await Task.sleep(nanoseconds: minInterval)
            if latest == snapshot && !styleDirty { running = false; return }
        }
    }
}

struct StreamingEntitiesView: View {
    let text: String
    let theme: AppTheme
    let typography: Typography
    @StateObject private var coord: StreamingEntityCoordinator

    init(text: String, theme: AppTheme, typography: Typography) {
        self.text = text
        self.theme = theme
        self.typography = typography
        _coord = StateObject(wrappedValue: StreamingEntityCoordinator(
            style: markdownProseStyle(theme: theme, typography: typography)))
    }

    private var style: MarkdownProseStyle { MarkdownStyleCache.style(theme: theme, typography: typography) }

    var body: some View {
        Group {
            if let entities = coord.entities {
                EntityStack(entities: entities, theme: theme, typography: typography)
            } else {
                // Formatted fallback for the one frame before the first segment
                // lands — same as the settled cache-miss (design 01M127NC4).
                styledMarkdown(text, theme: theme, typography: typography)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onAppear { coord.submit(text) }
        .onChange(of: text) { _, newText in coord.submit(newText) }
        .onChange(of: style) { _, newStyle in coord.updateStyle(newStyle) }
    }
}

/// Off-main producer + cache for `[MarkdownEntity]`, keyed per settled message.
/// Parsing + prose styling run on a background task; the result is memoized so
/// a husk re-materialization is a synchronous cache hit (no re-parse).
@MainActor
final class MarkdownEntityStore {
    static let shared = MarkdownEntityStore()

    /// LRU shared with AttributedTextCache (SeqStampLRU). FULLY LOCK-FREE here:
    /// @MainActor confines every store access to the main thread, and the render
    /// is on the main thread too, so render and store CAN'T RACE. Only the pure
    /// markdownEntities parse is off-main (Task.detached) and it touches NO store
    /// state — the cache read/write brackets the await back on the main actor.
    private var lru = SeqStampLRU<String, [MarkdownEntity]>(cap: 400)
    /// Max cached MESSAGES (per-bubble entity lists). Configurable (Settings);
    /// default 400 — the per-BUBBLE tier alongside AttributedTextCache.cacheLimit
    /// (per-BLOCK). Lowering it trims immediately (SeqStampLRU.cap didSet).
    var cap: Int {
        get { lru.cap }
        set { lru.cap = newValue }
    }

    func cached(_ key: String) -> [MarkdownEntity]? { lru.value(key) }   // peek: no touch

    func produce(_ key: String, text: String, style: MarkdownProseStyle) async -> [MarkdownEntity] {
        if let hit = lru.hit(key) { return hit }   // touch: stamp MRU, O(1)
        RenderActivity.produceStarted += 1
        let t0 = DispatchTime.now().uptimeNanoseconds
        let made = await Task.detached(priority: .userInitiated) {
            markdownEntities(text, style: style)
        }.value
        RenderActivity.produceLastMicros = Int((DispatchTime.now().uptimeNanoseconds - t0) / 1000)
        lru.insert(key, made)
        RenderActivity.produceFinished += 1
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
            // Wrap long lines instead of a horizontal ScrollView. A ScrollView
            // nested in the transcript's outer vertical ScrollView is heavy to
            // MINT per code block per band-entry (scroll infra + gesture wiring)
            // and is a known scrollable-in-scrollable smell (design 01M127NC4).
            AsyncAttributedText(producer: HighlightProducer(
                code: source, language: language, style: theme.codeHighlightStyle,
                font: typography.monoPlatformFont()))
                .font(typography.monoFont())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
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
