import MarkdownUI
import SwiftUI
import UnBienCore

/// Session transcript: streamed Markdown (swift-markdown-ui) with Highlightr
/// code blocks, collapsible tool-call cards, and a text input bar (DESIGN §7).
struct TranscriptView: View {
    let session: LiveSession
    @EnvironmentObject var model: AppModel
    @State private var draft = ""
    @State private var selectedPanelKey: String?
    private let theme = AppTheme.tokyoNight

    private var items: [TranscriptItem] {
        model.transcripts[session.id]?.items ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(items) { item in
                            row(for: item).id(item.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: items.count) { _, _ in
                    if let last = items.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
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
        .sheet(isPresented: promptPresented) {
            if let request = model.prompts[session.id] {
                let respond: (ExtensionUiResponse) -> Void = { response in
                    Task { await model.respondToPrompt(response, session: session) }
                }
                if let flow = request.askFlow {
                    RichAskFlowView(flow: flow, requestID: request.id, onRespond: respond)
                        .presentationDetents([.large])
                } else {
                    ExtensionUIPromptView(
                        request: request,
                        onRespond: respond,
                        onCancel: { model.prompts[session.id] = nil }
                    )
                    .presentationDetents([.medium, .large])
                }
            }
        }
    }

    private var controlMenu: some View {
        Menu {
            let models = model.availableModels[session.id] ?? []
            if !models.isEmpty {
                let current = model.currentModel[session.id]
                Picker("Model", selection: Binding(
                    get: { current?.id },
                    set: { newID in
                        guard let pick = models.first(where: { $0.id == newID }) else { return }
                        Task { await model.setModel(pick, session: session) }
                    }
                )) {
                    ForEach(models, id: \.id) { entry in
                        Text(entry.name).tag(Optional(entry.id))
                    }
                }
            }
            Picker("Thinking", selection: Binding(
                get: { model.thinkingLevel[session.id] ?? .off },
                set: { level in Task { await model.setThinking(level, session: session) } }
            )) {
                ForEach(ThinkingLevel.allCases, id: \.self) { level in
                    Text(level.rawValue.capitalized).tag(level)
                }
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
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
    private var queuedChips: some View {
        let items = model.queued[session.id] ?? []
        if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(items, id: \.id) { item in
                        Button {
                            Task { await model.clearQueued(targetID: item.id, session: session) }
                        } label: {
                            HStack(spacing: 4) {
                                Text(item.text).lineLimit(1)
                                Image(systemName: "xmark.circle.fill")
                            }
                            .font(.caption)
                            .padding(.horizontal, 8).padding(.vertical, 5)
                            .background(theme.surface, in: Capsule())
                            .foregroundStyle(theme.secondaryText)
                        }
                    }
                }
                .padding(.horizontal, 10)
            }
            .padding(.top, 4)
        }
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task { await model.sendMessage(text, to: session) }
    }

    @ViewBuilder
    private func row(for item: TranscriptItem) -> some View {
        switch item {
        case let .user(bubble):
            bubbleView(text: bubble.text, role: "You", tint: theme.accent, align: .trailing)
        case let .reasoning(block):
            ReasoningBlockView(block: block, theme: theme)
        case let .assistant(bubble):
            assistantView(bubble)
        case let .tool(card):
            ToolCardView(card: card, theme: theme)
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
                    .markdownCodeSyntaxHighlighter(.highlightr(style: theme.codeHighlightStyle))
                    .markdownTextStyle { ForegroundColor(theme.text) }
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
                .padding(10)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
        .frame(maxWidth: .infinity, alignment: align == .trailing ? .trailing : .leading)
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            if model.activeTurnID(for: session) != nil {
                Button(role: .destructive) {
                    Task { await model.cancel(session) }
                } label: {
                    Image(systemName: "stop.circle.fill").font(.title2)
                }
            }
            TextField("Message", text: $draft)
                .textFieldStyle(.plain)
                .submitLabel(.send)
                .onSubmit(sendDraft)
                .padding(10)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
            Button {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                draft = ""
                Task { await model.queueMessage(text, to: session) }
            } label: {
                Image(systemName: "tray.and.arrow.down").font(.title3)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button(action: sendDraft) {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(10)
        .background(theme.background)
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
            if let platform = Self.decode(image) {
                #if os(macOS)
                Image(nsImage: platform).resizable().scaledToFit()
                #else
                Image(uiImage: platform).resizable().scaledToFit()
                #endif
            } else {
                Label("Unsupported image", systemImage: "photo")
                    .font(.caption).foregroundStyle(theme.secondaryText)
            }
        }
        .frame(maxWidth: 480, maxHeight: 480, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    /// Decode base64 tolerantly: strip a `data:<mime>;base64,` prefix and ignore
    /// whitespace/newlines (strict `Data(base64Encoded:)` fails on both), which
    /// is why images could arrive but not render.
    private static func decodedData(_ image: WireImage) -> Data? {
        var payload = image.data
        if let comma = payload.range(of: ","), payload.hasPrefix("data:") {
            payload = String(payload[comma.upperBound...])
        }
        return Data(base64Encoded: payload, options: .ignoreUnknownCharacters)
    }

    #if os(macOS)
    private static func decode(_ image: WireImage) -> NSImage? {
        guard let data = decodedData(image) else { return nil }
        return NSImage(data: data)
    }
    #else
    private static func decode(_ image: WireImage) -> UIImage? {
        guard let data = decodedData(image) else { return nil }
        return UIImage(data: data)
    }
    #endif
}

private struct ReasoningBlockView: View {
    let block: ReasoningBlock
    let theme: AppTheme
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(block.text)
                .font(.system(.caption, design: .monospaced))
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
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 6) {
                    if !card.args.isEmpty {
                        labeled("input", JSONValue.object(card.args).prettyString)
                    }
                    if let result = card.result {
                        labeled("output", result.prettyString)
                    }
                    if let error = card.error {
                        labeled("error", error).foregroundStyle(theme.error)
                    }
                }
                .font(.system(.caption, design: .monospaced))
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

    private func labeled(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.secondaryText)
            Text(value).foregroundStyle(theme.text).textSelection(.enabled)
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
