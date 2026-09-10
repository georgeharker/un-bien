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
    /// This row's entry is a fork point (>1 child) — annotate it. Per-row Bool
    /// (not the whole set) so only a row whose status flips re-renders.
    var isBranchPoint: Bool = false
    // Non-observing handle to the per-card UI-state store (seeds ToolCardView's
    // local @State). NOT part of `==` — it's a stable env value, so the
    // equatable perf gate is unaffected.
    @Environment(\.cardUIState) private var cardUI

    nonisolated static func == (lhs: TranscriptRow, rhs: TranscriptRow) -> Bool {
        lhs.item == rhs.item && lhs.themeID == rhs.themeID && lhs.typography == rhs.typography
            && lhs.expandRich == rhs.expandRich && lhs.hideInputRich == rhs.hideInputRich
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
                         expandRich: expandRich, hideInputRich: hideInputRich, store: cardUI,
                         themeID: themeID)
        case let .compaction(marker):
            Label("Context compacted (\(marker.tokensBefore) tokens)", systemImage: "arrow.triangle.merge")
                .font(.caption).foregroundStyle(theme.secondaryText)
                .frame(maxWidth: .infinity)
        case let .notice(notice):
            // A branch marker is INFORMATIONAL, not an error — green + branch
            // glyph. Real notices (provider_error, …) keep the red warning.
            Label(notice.message,
                  systemImage: notice.code == "branch"
                      ? "arrow.triangle.branch" : "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(notice.code == "branch" ? Color.green : theme.error)
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
private let toolBudget = 8_000

/// Budgeted content with an in-place expand: truncated rows render the
/// prefix + a SHOW ALL button (one user-initiated full parse — rare and
/// deliberate); everything else renders verbatim. Expanded state is
/// view-local: a husk rebirth (re-key) re-collapses — accepted.
private struct BudgetedContent<Content: View>: View {
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
private struct WarmAttributedText: View {
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
private struct DiffContentToggle: View {
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

private struct ToolCardView: View {
    let card: ToolCard
    let theme: AppTheme
    let typography: Typography
    let expandRich: Bool
    let hideInputRich: Bool
    let store: CardUIState
    let themeID: ThemeID  // diff-cache key discriminator (colors are theme-derived)
    // Expand + Diff⇄Content toggle (design 01M177AF) are LOCAL @State for
    // reactivity, SEEDED from CardUIState in init + written back onChange, so
    // they survive the windowed transcript destroying this view on scroll
    // ("edits disappear") WITHOUT making every card an @EnvironmentObject
    // subscriber (that made scrolling jerkier — design 01M1S9ET append). Local
    // @State keeps a toggle a card-only re-render (TranscriptRow.equatable()
    // intact); the store is touched only on materialize (read) + toggle (write).
    @State private var expanded: Bool
    @State private var showContent: Bool

    init(card: ToolCard, theme: AppTheme, typography: Typography,
         expandRich: Bool, hideInputRich: Bool, store: CardUIState, themeID: ThemeID) {
        self.card = card
        self.theme = theme
        self.typography = typography
        self.expandRich = expandRich
        self.hideInputRich = hideInputRich
        self.store = store
        self.themeID = themeID
        _expanded = State(initialValue: store.expanded(
            card.toolCallID, default: expandRich && Self.isRich(card)))
        _showContent = State(initialValue: store.showContent(card.toolCallID))
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
        // edits[]-shaped edit tools (run 2026-09-18: cards rendered as raw
        // JSON — the new text nests inside edits[].newText, which none of the
        // top-level keys above can see).
        if !editPairs(card.args).isEmpty { return true }
        return false
    }

    /// First non-empty string arg among `keys` (static: shared by isRich and
    /// the instance views).
    static func stringArg(_ dict: [String: JSONValue], _ keys: [String]) -> String? {
        for key in keys {
            if let s = dict[key]?.stringValue, !s.isEmpty { return s }
        }
        return nil
    }

    /// The edit args' old/new pairs — BOTH shapes: a single edit at the top
    /// level (camelCase + snake_case variants) and the `edits[]` array of
    /// pairs. Empty when the args aren't edit-shaped.
    static func editPairs(_ args: [String: JSONValue]) -> [(old: String?, new: String?)] {
        var pairs: [(old: String?, new: String?)] = []
        func pair(_ dict: [String: JSONValue]) -> (String?, String?)? {
            let old = stringArg(dict, ["oldText", "old_text", "old_string", "oldString"])
            let new = stringArg(dict, ["newText", "new_text", "new_string", "newString"])
            return (old != nil || new != nil) ? (old, new) : nil
        }
        if case .array(let edits)? = args["edits"] {
            for case .object(let e) in edits {
                if let p = pair(e) { pairs.append(p) }
            }
        } else if let p = pair(args) {
            pairs.append(p)
        }
        return pairs
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 6) {
                    if let hunks = inputHunks, let content = contentText {
                        // Both present (live edit): toggle between the diff and
                        // the new text as a code block. Default Diff. A lightweight
                        // SwiftUI toggle, NOT .pickerStyle(.segmented) — a segmented
                        // Picker bridges to a UISegmentedControl, and constructing
                        // that UIKit view on every husk→full attach is what hitched
                        // the scroll-in of edit cards.
                        DiffContentToggle(showContent: $showContent, theme: theme)
                        // Warm the OTHER (hidden) face through the SAME windowed,
                        // appearance-driven path as the visible one (renders
                        // nothing) so switching shows the ready result, not the
                        // plain-then-highlight pop.
                        WarmAttributedText(producer: showContent
                            ? (diffProducer(hunks) as any AttributedTextProducer)
                            : contentProducer(content))
                        if showContent {
                            codeView(content.text, lang: content.lang,
                                     identity: "\(card.toolCallID)\u{1}@source")
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
        // Persist toggles back to the windowing-surviving store (write-only on
        // change — never per-render).
        .onChange(of: expanded) { _, value in store.setExpanded(card.toolCallID, value) }
        .onChange(of: showContent) { _, value in store.setShowContent(card.toolCallID, value) }
    }

    // The content key matches codeView's BudgetedContent truncation, so the warm
    // hits the exact key the toggle will read.
    private func diffProducer(_ hunks: [JSONValue]) -> DiffProducer {
        DiffProducer(toolCallID: card.toolCallID, themeID: "\(themeID)", hunks: hunks,
                     add: theme.success, remove: theme.error, context: theme.secondaryText)
    }

    private func contentProducer(_ content: (text: String, lang: String?)) -> HighlightProducer {
        let truncated = content.text.count > toolBudget
        // Warm the INITIALLY-shown key: @source when it'll truncate, else the
        // full @source-all (matches codeView's initial render). The other key
        // materializes on demand if the user hits Show all.
        return HighlightProducer(
            code: truncated ? String(content.text.prefix(toolBudget)) : content.text,
            language: content.lang, style: theme.codeHighlightStyle,
            font: typography.monoPlatformFont(),
            identity: "\(card.toolCallID)\u{1}@source" + (truncated ? "" : "-all"))
    }

    // Input Edit diff: LIVE aux.hunks when present; otherwise DERIVED from
    // the persisted args (replay never carries sidecars — and run 2026-09-18
    // the live wire didn't either). The derivation shows the edit's substance
    // (− old / + new) without the on-disk context lines the extension adds.
    private var inputHunks: [JSONValue]? {
        if let hunks = card.hunks, !hunks.isEmpty { return hunks }
        var hunks: [JSONValue] = []
        for pair in Self.editPairs(card.args) {
            var lines: [JSONValue] = []
            if let old = pair.old, !old.isEmpty {
                lines += old.split(separator: "\n", omittingEmptySubsequences: false).map {
                    JSONValue.object(["kind": .string("remove"), "text": .string(String($0))])
                }
            }
            if let new = pair.new, !new.isEmpty {
                lines += new.split(separator: "\n", omittingEmptySubsequences: false).map {
                    JSONValue.object(["kind": .string("add"), "text": .string(String($0))])
                }
            }
            if !lines.isEmpty { hunks.append(.object(["lines": .array(lines)])) }
        }
        return hunks.isEmpty ? nil : hunks
    }

    // The new text an edit/write is applying, from persisted args — the Content
    // view / replay floor. `lang` inferred from the target file path. For
    // edits[]-shaped tools the new texts nest inside the array — join them.
    private var contentText: (text: String, lang: String?)? {
        for key in ["content", "contents", "text", "new_string", "new_str", "newText"] {
            if let text = card.args[key]?.stringValue, !text.isEmpty {
                return (text, contentLang)
            }
        }
        let newTexts = Self.editPairs(card.args).compactMap { $0.new }
        if !newTexts.isEmpty {
            return (newTexts.joined(separator: "\n"), contentLang)
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

    // Colored diff via the shared windowed cache (DiffProducer). The card's
    // diff is immutable, so it's produced once (per theme) and reused across
    // materializations — same cache + off-main pull as code blocks; only the
    // production differs (platform-colored lines vs highlight.js).
    private func diffView(_ hunks: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("DIFF").font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.secondaryText)
            AsyncAttributedText(producer: DiffProducer(
                toolCallID: card.toolCallID, themeID: "\(themeID)", hunks: hunks,
                add: theme.success, remove: theme.error, context: theme.secondaryText))
        }
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.secondaryText)
            BudgetedContent(text: value, budget: toolBudget) { budgeted in
                Text(budgeted).foregroundStyle(theme.text).textSelection(.enabled)
            }
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
    // Syntax-highlighted code via the shared windowed cache (HighlightProducer,
    // HighlighterSwift/highlight.js). `lang` may be nil → highlight.js
    // auto-detects. Budget applies BEFORE highlighting (toolBudget).
    // Assistant-bubble fences stay sync-on-miss: MarkdownUI's
    // CodeSyntaxHighlighter protocol is synchronous — same cache, cache-covered
    // after first render.
    @ViewBuilder
    private func codeView(_ text: String, lang: String?, identity: String? = nil) -> some View {
        let font = typography.monoPlatformFont()
        BudgetedContent(text: text, budget: toolBudget) { budgeted in
            // Two stable id keys: @source (truncated view) vs @source-all (full,
            // after Show all). The full view isn't pre-warmed, so it materializes
            // on demand the first time it's expanded.
            let id = identity.map { budgeted.count >= text.count ? "\($0)-all" : $0 }
            AsyncAttributedText(producer: HighlightProducer(
                code: budgeted, language: lang, style: theme.codeHighlightStyle,
                font: font, identity: id))
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
