import MarkdownUI
import SwiftUI
import UnBienCore
#if canImport(WebKit)
import WebKit
#endif

// The per-row transcript views split out of TranscriptView.swift (its 1000-line
// cap): the Equatable row (render-on-need), its wire/SVG image views, reasoning
// block, tool card, and the JSONValue pretty-print helper they share.
// TranscriptView.swift keeps the scroll-memory system and sheet wiring.

/// One transcript row, extracted as an `Equatable` view so `.equatable()` lets
/// SwiftUI SKIP re-rendering settled rows while only the streaming row updates
/// (render-on-need). Equality is (item, themeID, typography): a theme/font
/// change still re-renders (themeID/typography differ); a sibling row changing
/// does not. NOTE: scroll/visual correctness needs on-device verification.
/// (Internal — not private — so the extracted TranscriptPerfPreview harness and
/// previews can reuse the exact live rendering.)
struct TranscriptRow: View, Equatable {
    let item: TranscriptItem
    let themeID: ThemeID
    let theme: AppTheme
    let typography: Typography
    let displayPolicy: ToolDisplayPolicy
    let hideInputRich: Bool
    /// This row's entry is a fork point (>1 child) — annotate it. Per-row Bool
    /// (not the whole set) so only a row whose status flips re-renders.
    var isBranchPoint: Bool = false
    // Non-observing handle to the per-card UI-state store (seeds ToolCardView's
    // local @State). NOT part of `==` — it's a stable env value, so the
    // equatable perf gate is unaffected.
    @Environment(\.cardUIState) private var cardUI

    nonisolated static func == (lhs: TranscriptRow, rhs: TranscriptRow) -> Bool {
        lhs.item == rhs.item && lhs.themeID == rhs.themeID && lhs.typography == rhs.typography
            && lhs.displayPolicy == rhs.displayPolicy && lhs.hideInputRich == rhs.hideInputRich
            && lhs.isBranchPoint == rhs.isBranchPoint
    }

    /// Fork-point glyph shown beside the Pi/You label (design 01M1FTV2).
    private var branchMarker: some View {
        Image(systemName: "arrow.triangle.branch")
            .font(.caption2)
            .foregroundStyle(theme.secondaryText)
            .accessibilityLabel("Branch point — this message has other versions")
    }

    var body: some View {
        switch item {
        case let .user(bubble):
            bubbleView(text: bubble.text, role: "You", tint: theme.accent, align: .trailing)
        case let .reasoning(block):
            ReasoningBlockView(block: block, theme: theme, typography: typography)
        case let .assistant(bubble):
            assistantView(bubble)
        case let .tool(card):
            ToolCardView(card: card, theme: theme, typography: typography,
                         displayPolicy: displayPolicy, hideInputRich: hideInputRich, store: cardUI,
                         themeID: themeID)
        case let .compaction(marker):
            Label("Context compacted (\(marker.tokensBefore) tokens)", systemImage: "arrow.triangle.merge")
                .font(.caption).foregroundStyle(theme.secondaryText)
                .frame(maxWidth: .infinity)
        case let .notice(notice):
            // Notice classes: branch (green), custom/mesh announcements
            // (INFO — theme text + full markdown: mesh announces carry
            // formatting and are reading material, not warnings), and
            // genuine errors (red warning). The branch marker was the first
            // informational class; custom messages (extension/mesh
            // announcements: name assignments, pair/join events, wake
            // notes) are the second.
            if notice.code == "custom" {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "info.circle")
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                        .padding(.top, 2)
                    styledMarkdown(notice.message, theme: theme, typography: typography)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, 8)
            } else {
                Label(notice.message,
                      systemImage: notice.code == "branch"
                          ? "arrow.triangle.branch" : "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(notice.code == "branch" ? Color.green : theme.error)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }

    private func assistantView(_ bubble: AssistantBubble) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                // "Pi" header — natural height ≈ TranscriptMetrics.assistantHeaderHeight:
                // CHANGE THAT CONSTANT if the caption font/weight changes (it is
                // ESTIMATE-ONLY — no literal here to share).
                Text("Pi").font(.caption.weight(.semibold)).foregroundStyle(theme.toolAccent)
                if bubble.streaming {
                    ProgressView().controlSize(.mini)
                }
                if isBranchPoint { branchMarker }
            }
            if !bubble.text.isEmpty {
                if bubble.streaming {
                // Stream through the ENTITY renderer (design 01M1YT1QGM): an
                // off-main incremental segmenter re-segments only the changed tail
                // and feeds the SAME EntityStack the settled bubble uses -> no
                // streaming->settled flip, and the main thread never parses.
                BudgetedContent(text: bubble.text, budget: markdownBudget) { budgeted in
                    StreamingEntitiesView(text: budgeted, theme: theme, typography: typography)
                }
                } else {
                    // Settled: render off-main-produced entities (prose as cached
                    // Text, code/table/list/blockquote plugged) — keeps fast scroll
                    // jank-free vs live MarkdownUI's on-frame parse+layout.
                    MarkdownEntitiesView(
                        text: bubble.text, id: bubble.id,
                        theme: theme, typography: typography)
                }
            }
            ForEach(Array(bubble.images.enumerated()), id: \.offset) { _, image in
                WireImageView(image: image, theme: theme)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func bubbleView(text: String, role: String, tint: Color,
                            align: HorizontalAlignment) -> some View {
        VStack(alignment: align, spacing: 4) {
            HStack(spacing: 6) {
                Text(role).font(.caption.weight(.semibold)).foregroundStyle(tint)
                if isBranchPoint { branchMarker }
            }
            BudgetedContent(text: text, budget: markdownBudget) { budgeted in
                Text(budgeted).foregroundStyle(theme.text)
                    .font(typography.bodyFont())
                    .textSelection(.enabled)
                    .padding(10)
                    .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .frame(maxWidth: .infinity, alignment: align == .trailing ? .trailing : .leading)
    }
}

/// Renders a base64 `WireImage` (agent-emitted graphic) inline in the
/// transcript. Decodes to the platform image type; shows a placeholder if the
/// bytes don't decode.
struct WireImageView: View {
    let image: WireImage
    let theme: AppTheme

    var body: some View {
        Group {
            #if canImport(WebKit)
            if let svg = svgMarkup {
                // UIImage/NSImage can't decode SVG — render it in a WKWebView at
                // full width, height from the viewBox aspect ratio.
                SVGImageView(svg: svg)
            } else if let platform = ImageCache.shared.image(for: image) {
                platformImage(platform)
            } else {
                unsupported
            }
            #else
            if let platform = ImageCache.shared.image(for: image) {
                platformImage(platform)
            } else {
                unsupported
            }
            #endif
        }
        .frame(maxWidth: TranscriptMetrics.imageCap, maxHeight: TranscriptMetrics.imageCap,
               alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder private func platformImage(_ platform: PlatformImage) -> some View {
        #if os(macOS)
        Image(nsImage: platform).resizable().scaledToFit()
        #else
        Image(uiImage: platform).resizable().scaledToFit()
        #endif
    }

    private var unsupported: some View {
        Label("Unsupported image", systemImage: "photo")
            .font(.caption).foregroundStyle(theme.secondaryText)
    }

    /// Non-nil only for SVG payloads. `data` is normally base64; tolerate raw SVG text.
    private var svgMarkup: String? {
        guard image.mime.contains("svg") else { return nil }
        if let data = ImageCache.decodedData(image),
           let s = String(data: data, encoding: .utf8), s.contains("<svg") {
            return s
        }
        return image.data.contains("<svg") ? image.data : nil
    }
}

#if canImport(WebKit)
/// Renders an SVG at full container width; height derives from the viewBox
/// aspect ratio (WKWebView has no intrinsic content size). JS is disabled —
/// the SVG is agent output.
private struct SVGImageView: View {
    let svg: String
    var body: some View {
        SVGWebView(svg: svg).aspectRatio(Self.aspect(svg), contentMode: .fit)
    }

    /// width/height from `viewBox="minX minY W H"` (fallback 4:3).
    static func aspect(_ svg: String) -> CGFloat {
        guard let regex = try? NSRegularExpression(
                pattern: #"viewBox\s*=\s*[\"']?\s*[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)"#),
              let match = regex.firstMatch(in: svg, range: NSRange(svg.startIndex..., in: svg)),
              let widthRange = Range(match.range(at: 1), in: svg),
              let heightRange = Range(match.range(at: 2), in: svg),
              let width = Double(svg[widthRange]), let height = Double(svg[heightRange]),
              width > 0, height > 0 else {
            return 4.0 / 3.0
        }
        return CGFloat(width / height)
    }
}

private enum SVGHTML {
    static func wrap(_ svg: String) -> String {
        """
        <!DOCTYPE html><html><head>\
        <meta name="viewport" content="width=device-width,initial-scale=1">\
        <style>*{margin:0;padding:0;border:0}html,body{background:transparent}\
        svg{width:100%;height:auto;display:block}</style></head><body>\(svg)</body></html>
        """
    }

    @MainActor
    static func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        return WKWebView(frame: .zero, configuration: config)
    }
}

#if os(macOS)
private struct SVGWebView: NSViewRepresentable {
    let svg: String
    func makeNSView(context: Context) -> WKWebView { SVGHTML.makeWebView() }
    func updateNSView(_ wv: WKWebView, context: Context) {
        wv.loadHTMLString(SVGHTML.wrap(svg), baseURL: nil)
    }
}
#else
private struct SVGWebView: UIViewRepresentable {
    let svg: String
    func makeUIView(context: Context) -> WKWebView {
        let wv = SVGHTML.makeWebView()
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.isScrollEnabled = false
        return wv
    }
    func updateUIView(_ wv: WKWebView, context: Context) {
        wv.loadHTMLString(SVGHTML.wrap(svg), baseURL: nil)
    }
}
#endif
#endif

// MARK: - Display budgets (tiered, with an in-place SHOW ALL affordance)

/// Display budgets per row KIND (characters) — the transcript is a READING
/// surface, not a fidelity viewer, and MarkdownUI + HighlighterSwift on an
/// unbounded blob blocks the main thread (STALL 53716ms on a 437KB entry,
/// run 2026-09-17). Tiers (user, 2026-09-18: flat 8K bit normal long
/// messages): assistant markdown is READING material — generous; reasoning
/// is collapsed-by-default — moderate; tool results / code are the
/// pathological dump carriers AND the expensive highlight path — tight.
/// Parse cost scales ~linearly: 32K ≈ 4ms/row worst-case device.
private let markdownBudget = 32_000
private let reasoningBudget = 16_000
// Shared: card rendering + the prewarm resolver must truncate identically.
let toolBudget = 8_000

/// Budgeted content with an in-place expand: truncated rows render the
/// prefix + a SHOW ALL button (one user-initiated full parse — rare and
/// deliberate); everything else renders verbatim. Expanded state is
/// view-local: a husk rebirth (re-key) re-collapses — accepted.
struct BudgetedContent<Content: View>: View {
    let text: String
    let budget: Int
    @ViewBuilder let render: (String) -> Content
    @State private var expanded = false

    var body: some View {
        if text.count > budget, !expanded {
            render(String(text.prefix(budget)))
            Button {
                expanded = true
            } label: {
                Label("Show all — \(text.count - budget) more characters",
                      systemImage: "chevron.down")
                    .font(.caption)
                    .foregroundStyle(.tint)
            }
            .buttonStyle(.borderless)
            .padding(.top, 2)
        } else {
            render(text)
        }
    }
}

/// The ONE windowed pull view for every attributed-text producer (highlighter,
/// diff, …). Cache HIT renders synchronously (the repeat case); a MISS shows
/// the producer's plain fallback for one frame while it produces off-main. The
/// `.task` IS the queue entry's lifetime: SwiftUI cancels it when the row
/// leaves the near window, the ticket flips, and the queue drain DROPS the
/// entry before the expensive part — the "mutable queue". The near-window
/// produces AHEAD of the viewport, so a warm row hits the sync cache and there
/// is no visible frame delay.
/// Warm-only sibling of AsyncAttributedText: drives a producer through the SAME
/// windowed, appearance-driven off-main path (its `.task` fires when the row is
/// in the near-window; the ticket cancels when it leaves), but renders NOTHING
/// — so a hidden toggle face is cached ahead of a switch without being laid out
/// or drawn. Same mechanism as the highlighted-code warm, just no output.
struct WarmAttributedText: View {
    let producer: any AttributedTextProducer
    @Environment(\.sessionScope) private var sessionScope

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .task(id: AttributedTextCache.scopedKey(sessionScope, producer.cacheKey)) {
                if AttributedTextCache.shared.cached(producer, scope: sessionScope) == nil {
                    _ = await AttributedTextCache.shared.attributed(producer, scope: sessionScope)
                }
            }
    }
}

struct AsyncAttributedText: View {
    let producer: any AttributedTextProducer
    @State private var landed: AttributedString?
    @Environment(\.sessionScope) private var sessionScope

    var body: some View {
        Group {
            if let hit = AttributedTextCache.shared.cached(producer, scope: sessionScope) ?? landed {
                Text(hit)
            } else {
                Text(producer.plainText)
                    .task(id: AttributedTextCache.scopedKey(sessionScope, producer.cacheKey)) {
                        landed = await AttributedTextCache.shared.attributed(producer, scope: sessionScope)
                    }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ReasoningBlockView: View {
    let block: ReasoningBlock
    let theme: AppTheme
    let typography: Typography
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            BudgetedContent(text: block.text, budget: reasoningBudget) { budgeted in
                Text(budgeted)
                    .font(typography.monoFont(size: typography.codeSize))
                    .foregroundStyle(theme.secondaryText)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "brain").foregroundStyle(theme.secondaryText)
                Text(block.streaming ? "Thinking…" : "Thought")
                    .font(.caption).foregroundStyle(theme.secondaryText)
                if block.streaming { ProgressView().controlSize(.mini) }
            }
        }
        .tint(theme.secondaryText)
        .padding(10)
        .background(theme.surface.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// Lightweight Diff/Content toggle — two tappable labels over a capsule track,
/// pure SwiftUI. Deliberately NOT a segmented Picker: that bridges to a
/// UISegmentedControl, whose per-attach construction hitched edit cards as they
/// scrolled into the window. Text + a Capsule cost effectively nothing to build.
struct DiffContentToggle: View {
    /// ESTIMATE-OWNED by this component (analytic height tier): the toggle's
    /// natural height. CHANGE THIS IF THE VIEW CHANGES (padding/segment size) —
    /// RowHeightEstimator reads it directly, so the estimate lives WITH the
    /// render code it estimates.
    /// Nonisolated: the estimator reads this from its off-main flight, so
    /// View-conformance MainActor inference would make the read illegal.
    nonisolated static let estimatedHeight: Double = 30

    @Binding var showContent: Bool
    let theme: AppTheme

    var body: some View {
        HStack(spacing: 2) {
            segment("Diff", selected: !showContent) { showContent = false }
            segment("Content", selected: showContent) { showContent = true }
        }
        .padding(2)
        .background(theme.surface, in: Capsule())
        .fixedSize()
    }

    private func segment(_ title: String, selected: Bool,
                         _ tap: @escaping () -> Void) -> some View {
        Text(title)
            .font(.caption.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? theme.text : theme.secondaryText)
            .padding(.vertical, 4)
            .padding(.horizontal, 12)
            .background {
                if selected { Capsule().fill(theme.toolAccent.opacity(0.30)) }
            }
            .contentShape(Capsule())
            .onTapGesture(perform: tap)
    }
}
