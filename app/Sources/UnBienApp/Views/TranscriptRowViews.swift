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
    let expandRich: Bool
    let hideInputRich: Bool

    nonisolated static func == (lhs: TranscriptRow, rhs: TranscriptRow) -> Bool {
        lhs.item == rhs.item && lhs.themeID == rhs.themeID && lhs.typography == rhs.typography
            && lhs.expandRich == rhs.expandRich && lhs.hideInputRich == rhs.hideInputRich
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
                         expandRich: expandRich, hideInputRich: hideInputRich)
        case let .compaction(marker):
            Label("Context compacted (\(marker.tokensBefore) tokens)", systemImage: "arrow.triangle.merge")
                .font(.caption).foregroundStyle(theme.secondaryText)
                .frame(maxWidth: .infinity)
        case let .notice(notice):
            Label(notice.message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(theme.error)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private func assistantView(_ bubble: AssistantBubble) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Pi").font(.caption.weight(.semibold)).foregroundStyle(theme.toolAccent)
                if bubble.streaming {
                    ProgressView().controlSize(.mini)
                }
            }
            if !bubble.text.isEmpty {
                Markdown(displayText(bubble.text))
                    .markdownCodeSyntaxHighlighter(.highlightr(
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
                        ScrollView(.horizontal, showsIndicators: false) {
                            configuration.label
                                .fixedSize(horizontal: false, vertical: true)
                                .font(typography.monoFont())
                                .padding(12)
                        }
                        .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
                        .markdownMargin(top: 8, bottom: 8)
                    }
                    .textSelection(.enabled)
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
            Text(role).font(.caption.weight(.semibold)).foregroundStyle(tint)
            Text(displayText(text)).foregroundStyle(theme.text)
                .font(typography.bodyFont())
                .textSelection(.enabled)
                .padding(10)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
        .frame(maxWidth: .infinity, alignment: align == .trailing ? .trailing : .leading)
    }
}

/// Renders a base64 `WireImage` (agent-emitted graphic) inline in the
/// transcript. Decodes to the platform image type; shows a placeholder if the
/// bytes don't decode.
private struct WireImageView: View {
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
        .frame(maxWidth: 480, maxHeight: 480, alignment: .leading)
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

/// Display budget for one row's rendered text (characters). The transcript
/// is a READING surface, not a fidelity viewer — real logs contain 400KB+
/// message entries (whole-file dumps ride inside assistant messages), and
/// MarkdownUI + Highlightr on such a blob blocks the main thread for ~a
/// minute (STALL 53716ms between scroll frames, run 2026-09-17). Truncate
/// what we RENDER; the full text stays in the session log. An expand
/// affordance is future work.
private let rowDisplayBudget = 8_000

private func displayText(_ text: String, budget: Int = rowDisplayBudget) -> String {
    guard text.count > budget else { return text }
    let omitted = text.count - budget
    return text.prefix(budget)
        + "\n\n… \(omitted) more characters truncated for display — full text in the session log"
}

private struct ReasoningBlockView: View {
    let block: ReasoningBlock
    let theme: AppTheme
    let typography: Typography
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(displayText(block.text))
                .font(typography.monoFont(size: typography.codeSize))
                .foregroundStyle(theme.secondaryText)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
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

private struct ToolCardView: View {
    let card: ToolCard
    let theme: AppTheme
    let typography: Typography
    let expandRich: Bool
    let hideInputRich: Bool
    @State private var expanded: Bool
    /// Edit-family Diff⇄Content toggle (design 01M177AF). false = Diff (default,
    /// most informative live); true = Content (the new text as a code block).
    @State private var showContent = false

    init(card: ToolCard, theme: AppTheme, typography: Typography,
         expandRich: Bool, hideInputRich: Bool) {
        self.card = card
        self.theme = theme
        self.typography = typography
        self.expandRich = expandRich
        self.hideInputRich = hideInputRich
        // Pref: rich cards (diff/code/content) start expanded when enabled.
        _expanded = State(initialValue: expandRich && Self.isRich(card))
    }

    /// A card is "rich" when it has a renderable output block, an input diff, or
    /// new content from args — i.e. something better than raw JSON to show.
    static func isRich(_ card: ToolCard) -> Bool {
        if card.output?["v"]?.intValue == 1,
           let blocks = card.output?["blocks"]?.arrayValue,
           blocks.contains(where: { renderableKinds.contains($0["kind"]?.stringValue ?? "") }) {
            return true
        }
        if let hunks = card.hunks, !hunks.isEmpty { return true }
        for key in ["content", "contents", "text", "new_string", "new_str", "newText"] {
            if let value = card.args[key]?.stringValue, !value.isEmpty { return true }
        }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 6) {
                    if let hunks = inputHunks, let content = contentText {
                        // Both present (live edit): toggle between the diff and
                        // the new text as a code block. Default Diff.
                        Picker("view", selection: $showContent) {
                            Text("Diff").tag(false)
                            Text("Content").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        if showContent {
                            codeView(content.text, lang: content.lang)
                        } else {
                            diffView(hunks)
                        }
                    } else {
                        if let hunks = inputHunks {
                            diffView(hunks)
                        } else if contentText == nil, !card.args.isEmpty,
                                  !(hideInputRich && !knownOutputBlocks.isEmpty) {
                            labeled("input", JSONValue.object(card.args).prettyString)
                        }
                        if !knownOutputBlocks.isEmpty {
                            outputBlocksView
                        } else if let content = contentText {
                            // Replay floor: no live diff, so show the new text
                            // (from persisted args) as a code block.
                            VStack(alignment: .leading, spacing: 2) {
                                Text("CONTENT").font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(theme.secondaryText)
                                codeView(content.text, lang: content.lang)
                            }
                        } else if let result = card.result {
                            labeled("output", result.prettyString)
                        }
                    }
                    if let error = card.error {
                        labeled("error", error).foregroundStyle(theme.error)
                    }
                }
                .font(typography.monoFont(size: typography.codeSize))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: icon).foregroundStyle(color)
                    Text(card.tool).font(.callout.weight(.medium)).foregroundStyle(theme.text)
                }
            }
            .tint(theme.toolAccent)
            // Tool-emitted images (screenshots/plots) sit below the card, always
            // visible so you don't have to expand to see them.
            ForEach(Array(card.images.enumerated()), id: \.offset) { _, image in
                WireImageView(image: image, theme: theme)
            }
        }
        .padding(10)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
    }

    // Input Edit diff (best-effort LIVE aux.hunks); nil when absent (e.g. replay).
    private var inputHunks: [JSONValue]? {
        if let hunks = card.hunks, !hunks.isEmpty { return hunks }
        return nil
    }

    // The new text an edit/write is applying, from persisted args — the Content
    // view / replay floor. `lang` inferred from the target file path.
    private var contentText: (text: String, lang: String?)? {
        for key in ["content", "contents", "text", "new_string", "new_str", "newText"] {
            if let text = card.args[key]?.stringValue, !text.isEmpty {
                return (text, contentLang)
            }
        }
        return nil
    }

    private var contentLang: String? {
        for key in ["path", "file", "filename", "filepath"] {
            if let path = card.args[key]?.stringValue {
                return ToolOutputClassifier.language(forPath: path)
            }
        }
        return nil
    }

    @ViewBuilder private var outputBlocksView: some View {
        ForEach(Array(knownOutputBlocks.enumerated()), id: \.offset) { _, block in
            switch block["kind"]?.stringValue {
            case "diff":
                if let hunks = block["hunks"]?.arrayValue, !hunks.isEmpty { diffView(hunks) }
            case "code":
                if let text = block["text"]?.stringValue, !text.isEmpty {
                    codeView(text, lang: block["lang"]?.stringValue)
                }
            default:
                EmptyView()
            }
        }
        if card.output?["truncated"]?.boolValue == true {
            Text("\u{2026} output truncated").font(.system(size: 9))
                .foregroundStyle(theme.secondaryText)
        }
    }

    @ViewBuilder
    private func diffView(_ hunks: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("DIFF").font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.secondaryText)
            ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                ForEach(Array((hunk["lines"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, line in
                    let kind = line["kind"]?.stringValue ?? ""
                    Text(diffPrefix(kind) + (line["text"]?.stringValue ?? ""))
                        .foregroundStyle(diffColor(kind))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func diffPrefix(_ kind: String) -> String {
        switch kind {
        case "remove": return "-"
        case "add": return "+"
        case "ellipsis": return " \u{22EF}"
        default: return " "
        }
    }

    private func diffColor(_ kind: String) -> Color {
        switch kind {
        case "remove": return theme.error
        case "add": return theme.success
        default: return theme.secondaryText
        }
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.secondaryText)
            Text(displayText(value)).foregroundStyle(theme.text).textSelection(.enabled)
        }
    }

    // Renderable blocks from the versioned `aux.output` container. Guards on
    // `v==1` and keeps only kinds the app knows how to draw; unknown kinds are
    // skipped so an empty result falls back to raw JSON.
    private static let renderableKinds: Set<String> = ["diff", "code"]
    private var knownOutputBlocks: [JSONValue] {
        guard card.output?["v"]?.intValue == 1,
              let blocks = card.output?["blocks"]?.arrayValue else { return [] }
        return blocks.filter { Self.renderableKinds.contains($0["kind"]?.stringValue ?? "") }
    }

    // `code` block: plain output text syntax-highlighted via the shared
    // HighlightEngine (Highlightr/highlight.js, cached + theme-matched, same path
    // as assistant-bubble code blocks). `lang` may be nil → highlight.js
    // auto-detects; a highlighter miss falls back to plain mono Text.
    @ViewBuilder
    private func codeView(_ text: String, lang: String?) -> some View {
        let font = typography.monoPlatformFont()
        // Budget BEFORE highlighting — Highlightr/highlight.js on a huge blob
        // is the dominant main-thread cost (see rowDisplayBudget).
        let text = displayText(text)
        if let highlighted = HighlightEngine.shared.highlighted(
            text, language: lang, style: theme.codeHighlightStyle, font: font) {
            Text(highlighted).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(text).foregroundStyle(theme.text).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var icon: String {
        switch card.state {
        case .running: return "gearshape.2"
        case .ok: return "checkmark.circle"
        case .failed: return "xmark.octagon"
        }
    }

    private var color: Color {
        switch card.state {
        case .running: return theme.secondaryText
        case .ok: return theme.success
        case .failed: return theme.error
        }
    }
}

private extension JSONValue {
    var prettyString: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
        if let data = try? encoder.encode(self), let string = String(data: data, encoding: .utf8) {
            return string
        }
        return ""
    }
}
