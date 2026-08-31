import MarkdownUI
import SwiftUI
import UnBienCore

/// Y offset of the bottom sentinel within the ScrollView's visible frame,
/// reported EVERY FRAME — "pinned to bottom" is derived continuously from
/// it (design 01M1B9F6). Appearance events lose the race against streaming
/// arrivals: a follow scrollTo can re-pin the sentinel before its
/// onDisappear ever lands, so a user who just scrolled up keeps getting
/// yanked. Continuous evaluation closes that race within one frame.
private struct SentinelMinYKey: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = min(value, nextValue()) }
}

/// Visible height of the transcript ScrollView.
private struct ViewportHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Session transcript: streamed Markdown (swift-markdown-ui) with Highlightr
/// code blocks, collapsible tool-call cards, and a text input bar (DESIGN §7).
struct TranscriptView: View {
    let session: LiveSession
    @EnvironmentObject var model: AppModel
    @State private var selectedPanelKey: String?
    @Environment(\.appTheme) private var theme
    @Environment(\.typography) private var typography

    /// Restore runs once per view lifetime, after items first populate.
    @State private var didRestoreScroll = false
    /// Pending second-pass re-anchor (design 01M1B9F6 follow-up): the restore
    /// scrollTo computes against ESTIMATED geometry for a not-yet-materialized
    /// lazy row and can land top-of-box instead of bottom-of-box. Set at
    /// restore; consumed in `reanchorIfNeeded(proxy:)` once the target row
    /// actually renders (real height), or cleared if it leaves items.
    @State private var reanchorTarget: String?
    /// Currently-materialized row ids (LazyVStack onAppear/onDisappear) — the
    /// capture source for scroll memory (design 01M1B9F6): the bottom-most
    /// visible row is approximately the highest-index materialized row (may
    /// overshoot into the prefetch buffer by a row or two — accepted).
    /// Self-heals: onAppear re-fires on re-materialization.
    @State private var materializedIDs: Set<String> = []
    /// Whether the viewport is PINNED to the transcript's bottom edge — gates
    /// auto-follow so an incoming row only scrolls a reader who was already at
    /// the bottom. Evaluated CONTINUOUSLY from the sentinel probe's geometry
    /// (every frame), not appearance events (design 01M1B9F6).
    @State private var atBottom = true
    /// Visible height of the transcript ScrollView (pairs with the sentinel's
    /// minY to evaluate the pin).
    @State private var viewportHeight: CGFloat = 0

    private var items: [TranscriptItem] {
        let all = model.transcripts[session.id]?.items ?? []
        guard !model.showThinking else { return all }
        // Preference: hide reasoning/thinking blocks from the transcript.
        return all.filter { if case .reasoning = $0 { return false } else { return true } }
    }

    /// Record the scroll position (design 01M1B9F6): the bottom-most
    /// materialized row, mapped to the nearest replay-STABLE anchor
    /// at-or-above. Transient rows (streaming/positional bubbles, reasoning,
    /// notices) are never persisted, so the memory survives the
    /// streaming→settle re-key and get_entries re-syncs.
    private func rememberVisibleAnchor() {
        guard didRestoreScroll else { return }
        guard let bottom = items.lastIndex(where: { materializedIDs.contains($0.id) }) else { return }
        if let anchor = items.stableAnchor(atOrAbove: bottom) {
            model.rememberScroll(id: anchor, session: session)
        }
    }

    /// Second-pass re-anchor: when the restore target row materializes (its id
    /// enters the materialized set — real height, not an estimate), issue the
    /// scrollTo ONE more time so the anchor lands on true geometry. Self-resolves
    /// within a frame or two of the restore; cleared when the target leaves
    /// items so it can never fire late and fight the user.
    private func reanchorIfNeeded(proxy: ScrollViewProxy) {
        guard let target = reanchorTarget else { return }
        guard items.contains(where: { $0.id == target }) else {
            reanchorTarget = nil
            return
        }
        if materializedIDs.contains(target) {
            reanchorTarget = nil
            proxy.scrollTo(target, anchor: .bottom)
        }
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
                                .onAppear { materializedIDs.insert(item.id) }
                                .onDisappear { materializedIDs.remove(item.id) }
                        }
                    }
                    .padding()
                    // Cap line length on wide windows; centered. No-op on phones.
                    .frame(maxWidth: 1100, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                    // Bottom sentinel probe: reports its Y offset within the
                    // ScrollView's visible frame every frame; `atBottom` is
                    // derived from it continuously. (Row onAppear is flaky under
                    // LazyVStack recycling, and appearance events lose the race
                    // against streaming arrivals.)
                    Color.clear.frame(height: 1)
                        .background(GeometryReader { geo in
                            Color.clear.preference(
                                key: SentinelMinYKey.self,
                                value: geo.frame(in: .named("transcript-scroll")).minY)
                        })
                }
                .coordinateSpace(name: "transcript-scroll")
                .background(GeometryReader { geo in
                    Color.clear.preference(key: ViewportHeightKey.self, value: geo.size.height)
                })
                .onChange(of: items.count, initial: true) { _, _ in
                    guard !items.isEmpty else { return }
                    if !didRestoreScroll {
                        didRestoreScroll = true
                        // Restore to the remembered STABLE row, attaching at the
                        // BOTTOM of its extent; fall back to the bottom when
                        // nothing is remembered (or it's gone).
                        if let remembered = model.rememberedScroll(session: session),
                           items.contains(where: { $0.id == remembered }) {
                            proxy.scrollTo(remembered, anchor: .bottom)
                            // The scrollTo above runs on ESTIMATED geometry for a
                            // far-down, not-yet-materialized row; re-anchor on the
                            // materialized pass (reanchorIfNeeded).
                            reanchorTarget = remembered
                            // The sentinel never appeared before this programmatic
                            // scroll; sync the auto-follow gate so a mid-transcript
                            // restore isn't immediately yanked down by the next
                            // incoming message.
                            atBottom = remembered == items.last?.id
                        } else if let last = items.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                            reanchorTarget = last.id
                            atBottom = true
                        }
                    } else if atBottom, let last = items.last {
                        // Only follow new rows while pinned to the bottom. Snap
                        // (no animation): animated follows during streaming are
                        // what made the pull-down feel like fighting the user.
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
                // Capture: remember the bottom-most visible row (design 01M1B9F6);
                // consume a pending restore re-anchor when its row materializes.
                .onChange(of: materializedIDs) { _, _ in
                    rememberVisibleAnchor()
                    reanchorIfNeeded(proxy: proxy)
                }
                .onPreferenceChange(SentinelMinYKey.self) { minY in
                    // Pinned: the content's end sits at (or within a small slack
                    // of) the viewport's bottom edge.
                    atBottom = minY < viewportHeight + 24
                }
                .onPreferenceChange(ViewportHeightKey.self) { viewportHeight = $0 }
                #if os(iOS)
                // Swipe the transcript down to dismiss the composer keyboard.
                .scrollDismissesKeyboard(.interactively)
                #endif
            }
            if session.isSubagent && !model.subagentsInteractive {
                readOnlyNote
            } else {
                queuedChips
                inputBar
            }
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
                PanelHostView(panel: panel, onSelectSubagent: { sessionID in
                    // Map the panel row (child sessionId) to its session, dismiss
                    // the sheet, and let Home push it onto the nav stack.
                    if let child = model.subagentSession(sessionID: sessionID, under: session) {
                        selectedPanelKey = nil
                        model.pendingSessionNav = child
                    }
                })
            }
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
                        // Remove this queued message: pi has no per-item delete,
                        // so AppModel clears the queue and reissues the survivors.
                        Button {
                            Task { await model.deleteQueued(item, from: session) }
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove queued message")
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
        // Sending/queueing is intent to engage the newest content: re-pin the
        // follow gate so the outgoing row (and its reply) are followed even if
        // the user had scrolled up first.
        ComposerBar(session: session, onSent: { atBottom = true })
    }

    /// Composer replacement for a view-only subagent session (read-only).
    private var readOnlyNote: some View {
        Text("View-only subagent session")
            .font(.footnote)
            .foregroundStyle(theme.secondaryText)
            .frame(maxWidth: .infinity)
            .padding(10)
            .background(theme.background)
    }
}
