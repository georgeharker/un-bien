import SwiftUI
import MarkdownUI
import UnBienCore

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
