import MarkdownUI
import SwiftUI
import UnBienCore
#if canImport(WebKit)
import WebKit
#endif

/// Session transcript: streamed Markdown (swift-markdown-ui) with Highlightr
/// code blocks, collapsible tool-call cards, and a text input bar (DESIGN §7).
struct TranscriptView: View {
    let session: LiveSession
    @EnvironmentObject var model: AppModel
    @State private var selectedPanelKey: String?
    @State private var showLaunch = false
    @Environment(\.appTheme) private var theme
    @Environment(\.typography) private var typography

    private var items: [TranscriptItem] {
        let all = model.transcripts[session.id]?.items ?? []
        guard !model.showThinking else { return all }
        // Preference: hide reasoning/thinking blocks from the transcript.
        return all.filter { if case .reasoning = $0 { return false } else { return true } }
    }

    var body: some View {
        VStack(spacing: 0) {
            if model.hasEnded(session) { endedBanner }
            statusStrip
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(items) { item in
                            TranscriptRow(item: item, themeID: model.themeID,
                                          theme: theme, typography: typography,
                                          expandRich: model.expandRichToolResults,
                                          hideInputRich: model.hideInputWhenRich)
                                .equatable()
                                .id(item.id)
                        }
                    }
                    .padding()
                    // Cap line length on wide windows; centered. No-op on phones.
                    .frame(maxWidth: 1100, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .onChange(of: items.count) { _, _ in
                    if let last = items.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
                #if os(iOS)
                // Swipe the transcript down to dismiss the composer keyboard.
                .scrollDismissesKeyboard(.interactively)
                #endif
            }
            queuedChips
            inputBar
        }
        .background(theme.background)
        .navigationTitle(session.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await model.openSession(session) }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                controlMenu
                if model.supports("remote_launch", session: session) {
                    Button { showLaunch = true } label: {
                        Image(systemName: "plus.bubble")
                    }
                }
                ForEach(model.panels(for: session)) { panel in
                    Button {
                        model.markPanelViewed(panel.key, session: session)
                        selectedPanelKey = panel.key
                    } label: {
                        Image(systemName: panelSymbol(panel))
                            .overlay(alignment: .topTrailing) {
                                if panel.changed {
                                    Circle().fill(theme.error).frame(width: 7, height: 7).offset(x: 3, y: -3)
                                }
                            }
                    }
                }
            }
        }
        .sheet(isPresented: panelPresented, onDismiss: { model.closePanel() }) {
            if let key = selectedPanelKey, let panel = model.panels[session.id]?[key] {
                PanelHostView(panel: panel)
            }
        }
        .sheet(isPresented: $showLaunch) {
            LaunchSessionSheet(session: session).environmentObject(model)
        }
        .sheet(isPresented: promptPresented) {
            if let request = model.prompts[session.id] {
                let respond: (ExtensionUiResponse) -> Void = { response in
                    Task { await model.respondToPrompt(response, session: session) }
                }
                if let flow = request.askFlow {
                    RichAskFlowView(flow: flow, requestID: request.id, onRespond: respond)
                    #if os(macOS)
                        // macOS ignores presentationDetents — size the sheet
                        // explicitly so a multi-question Form isn't cramped.
                        .frame(minWidth: 440, idealWidth: 520, minHeight: 360, idealHeight: 560)
                    #else
                        .presentationDetents([.large])
                        .presentationDragIndicator(.visible)
                    #endif
                } else {
                    ExtensionUIPromptView(
                        request: request,
                        onRespond: respond,
                        onCancel: { model.prompts[session.id] = nil }
                    )
                    #if os(macOS)
                        .frame(minWidth: 380, idealWidth: 460, minHeight: 220, idealHeight: 420)
                    #else
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                    #endif
                }
            }
        }
    }

    /// Model + thinking controls, gated on the pi's advertised capabilities
    /// (hidden entirely when the pi supports neither / sent no handshake).
    @ViewBuilder
    private var controlMenu: some View {
        let showModels = model.supports("models", session: session)
        let showThinking = model.supports("thinking", session: session)
        if showModels || showThinking {
            Menu {
                if showModels {
                    // Identify models by provider+id, not id alone: two providers
                    // can offer the SAME model id, so keying by id both collides in
                    // ForEach ("occurs multiple times") and would drop a legitimate
                    // entry on dedupe. Composite also removes exact list_models dupes.
                    let models: [WireModel] = {
                        var seen = Set<String>()
                        return (model.availableModels[session.id] ?? [])
                            .filter { seen.insert("\($0.provider)/\($0.id)").inserted }
                    }()
                    if !models.isEmpty {
                        let current = model.currentModel[session.id]
                        Picker("Model", selection: Binding(
                            get: { current.map { "\($0.provider)/\($0.id)" } },
                            set: { newKey in
                                guard let pick = models.first(where: { "\($0.provider)/\($0.id)" == newKey }) else { return }
                                Task { await model.setModel(pick, session: session) }
                            }
                        )) {
                            ForEach(Array(models.enumerated()), id: \.offset) { _, entry in
                                // Include provider so same-named models from different
                                // providers are distinguishable in the picker.
                                Text("\(entry.name) — \(entry.provider)")
                                    .tag(Optional("\(entry.provider)/\(entry.id)"))
                            }
                        }
                    }
                }
                if showThinking {
                    Picker("Thinking", selection: Binding(
                        get: { model.thinkingLevel[session.id] ?? .off },
                        set: { level in Task { await model.setThinking(level, session: session) } }
                    )) {
                        ForEach(ThinkingLevel.allCases, id: \.self) { level in
                            Text(level.rawValue.capitalized).tag(level)
                        }
                    }
                }
            } label: {
                Image(systemName: "slider.horizontal.3")
            }
        }
    }

    private var panelPresented: Binding<Bool> {
        Binding(get: { selectedPanelKey != nil }, set: { if !$0 { selectedPanelKey = nil } })
    }

    private var promptPresented: Binding<Bool> {
        Binding(
            get: { model.prompts[session.id] != nil },
            set: { if !$0 { model.prompts[session.id] = nil } }
        )
    }


    @ViewBuilder
    private var statusStrip: some View {
        let state = model.transcripts[session.id]
        let modelName = model.currentModel[session.id]?.name ?? session.model
        let usage = state?.latestUsage
        let compacted = state?.lastCompaction != nil
        if modelName != nil || usage != nil || compacted {
            HStack(spacing: 12) {
                if let modelName {
                    Label(modelName, systemImage: "cpu").lineLimit(1)
                }
                if let usage {
                    Label("\(usage.inputTokens)↑ \(usage.outputTokens)↓", systemImage: "number")
                }
                if compacted {
                    Label("compacted", systemImage: "arrow.triangle.merge")
                }
                Spacer(minLength: 0)
            }
            .font(.caption2)
            .foregroundStyle(theme.secondaryText)
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(theme.surface.opacity(0.5))
        }
    }

    private var endedBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "moon.zzz.fill")
            Text("Session ended")
            Spacer(minLength: 0)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(theme.background)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.secondaryText)
    }

    @ViewBuilder
    private var queuedChips: some View {
        let items = model.queued[session.id] ?? []
        if !items.isEmpty {
            // Vertical stack, oldest at top (natural array order) so the queue
            // reads top-to-bottom like the transcript it precedes.
            VStack(alignment: .leading, spacing: 4) {
                ForEach(items, id: \.id) { item in
                    // Mirror pi's TUI tracking: BLUE = queued (followUp, runs
                    // after the turn), GREY = steer (interrupts mid-turn). Both
                    // are optimistic until the model consumes them.
                    let isSteer = item.kind == "steer"
                    let tint: Color = isSteer ? .gray : .blue
                    HStack(spacing: 4) {
                        Image(systemName: isSteer ? "arrow.turn.up.right" : "clock")
                        Text(item.text).lineLimit(2)
                    }
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(tint.opacity(0.12), in: Capsule())
                    .foregroundStyle(tint.opacity(0.7))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.top, 4)
        }
    }

    private var inputBar: some View {
        ComposerBar(session: session)
    }
}

/// The message input bar. Owns its own `draft` so keystrokes re-render only
/// this small bar — not the whole transcript, whose `body` recomputes `items`
/// and diffs the entire message list on every evaluation.
private struct ComposerBar: View {
    let session: LiveSession
    @EnvironmentObject private var model: AppModel
    @Environment(\.appTheme) private var theme
    @Environment(\.typography) private var typography
    @State private var draft = ""

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var ended: Bool { model.hasEnded(session) }

    var body: some View {
        HStack(spacing: 8) {
            if model.activeTurnID(for: session) != nil {
                Button(role: .destructive) {
                    Task { await model.cancel(session) }
                } label: {
                    Image(systemName: "stop.circle.fill").font(.title2)
                }
            }
            MessageComposer(text: $draft, placeholder: ended ? "Session ended" : "Message",
                            font: typography.monoPlatformFont(size: typography.bodySize),
                            onSend: send)
                .padding(.horizontal, 6)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
                .disabled(ended)
            Button {
                guard !trimmed.isEmpty else { return }
                let text = trimmed
                draft = ""
                Task { await model.queueMessage(text, to: session) }
            } label: {
                Image(systemName: "tray.and.arrow.down").font(.title3)
            }
            .disabled(trimmed.isEmpty || ended)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(trimmed.isEmpty || ended)
        }
        .padding(10)
        .background(theme.background)
    }

    private func send() {
        let text = trimmed
        guard !text.isEmpty else { return }
        draft = ""
        Task { await model.sendMessage(text, to: session) }
    }
}

/// One transcript row, extracted as an `Equatable` view so `.equatable()` lets
/// SwiftUI SKIP re-rendering settled rows while only the streaming row updates
/// (render-on-need). Equality is (item, themeID, typography): a theme/font
/// change still re-renders (themeID/typography differ); a sibling row changing
/// does not. NOTE: scroll/visual correctness needs on-device verification.
private struct TranscriptRow: View, Equatable {
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
                Markdown(bubble.text)
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
            Text(text).foregroundStyle(theme.text)
                .font(typography.bodyFont())
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

private struct ReasoningBlockView: View {
    let block: ReasoningBlock
    let theme: AppTheme
    let typography: Typography
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(block.text)
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
            Text(value).foregroundStyle(theme.text).textSelection(.enabled)
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

#if DEBUG
/// Scroll-perf harness: a large synthetic transcript rendered exactly as the
/// live view (TranscriptRow + .equatable() in a LazyVStack), so scroll can be
/// profiled in Xcode / the simulator BEFORE the protocol data-feed exists.
private struct TranscriptPerfPreview: View {
    private let theme = ThemeID.tokyoNight.theme
    private let typography = Typography()
    private let items: [TranscriptItem]

    init() {
        items = (0..<400).map { index in
            switch index % 4 {
            case 0:
                return .user(UserBubble(id: "u\(index)", text: "Question \(index): how do I do the thing?"))
            case 1:
                return .assistant(AssistantBubble(
                    id: "a\(index)", inReplyTo: "u\(index - 1)",
                    text: "Answer \(index): some **markdown** plus code.\n\n```swift\nlet value = \(index)\nprint(value)\n```\n",
                    streaming: false))
            case 2:
                return .tool(ToolCard(
                    toolCallID: "t\(index)", tool: "bash",
                    args: ["command": .string("echo \(index)")],
                    result: .string("output line \(index)"), state: .ok))
            default:
                return .reasoning(ReasoningBlock(id: "r\(index)", text: "Considering approach \(index)\u{2026}", streaming: false))
            }
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(items) { item in
                    TranscriptRow(item: item, themeID: .tokyoNight, theme: theme,
                                  typography: typography, expandRich: true, hideInputRich: true)
                        .equatable()
                        .id(item.id)
                }
            }
            .padding()
        }
        .background(theme.background)
    }
}

#Preview("Transcript scroll perf") { TranscriptPerfPreview() }
#endif
