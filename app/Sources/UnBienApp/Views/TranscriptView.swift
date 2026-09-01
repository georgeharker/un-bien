import MarkdownUI
import os
import SwiftUI
import UnBienCore

#if DEBUG
/// Scroll-machinery diagnostics (scroll redesign diagnosis): pin transitions,
/// follows, restores. Read with:
/// `log stream --level debug --predicate 'subsystem == "un-bien" AND category == "scroll"'`
private let scrollLog = Logger(subsystem: "un-bien", category: "scroll")
private func dbgScrollLog(_ message: String) {
    scrollLog.info("\(message, privacy: .public)")
}
#else
/// No-op in release: the scroll diagnostics are a DEBUG harness.
private func dbgScrollLog(_ message: String) {}
#endif

/// Content-head offset in the scroll's visible frame, from the TOP probe
/// (design 01M1B9F6). Backfill pages APPEND below the head, so content growth
/// never moves it — any real change is USER scroll. Used to cancel a pending
/// backfill-wait restore (design 01M1B9F6: user intent wins). NOTE: the bottom
/// pin no longer uses geometry at all — see the sentinel cell in the LazyVStack.
private struct TopOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Session transcript: streamed Markdown (swift-markdown-ui) with Highlightr
/// code blocks, collapsible tool-call cards, and a text input bar (DESIGN §7).
struct TranscriptView: View {
    /// Scroll-target id of the bottom sentinel cell. "The bottom" IS the
    /// sentinel — every bottom-targeting scroll anchors THIS cell to the
    /// viewport's bottom edge (anchoring the last message row instead would
    /// park the sentinel below the fold and disarm the pin on the first
    /// follow, killing bottom-following).
    private static let bottomSentinelID = "unbien.bottom-sentinel"

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
    /// Whether the reader is AT THE BOTTOM — driven by the bottom sentinel
    /// cell's MATERIALIZATION (onAppear/onDisappear), not geometry. The
    /// sentinel is the last cell of the LazyVStack (doubles as the busy "…"
    /// indicator while a turn runs), so it only exists on screen when the
    /// reader is actually looking at the transcript's end — no estimated-
    /// geometry pin math to misread, and a drag away from the bottom un-pins
    /// the moment the cell leaves the window. Gates auto-follow.
    @State private var atBottom = true
    /// Set by ComposerBar.onSent: scroll to the end IMMEDIATELY on submit —
    /// don't wait for the outgoing row to echo back (a queued steer may not
    /// create a row for a while). Consumed inside the ScrollViewReader scope
    /// by the `.onChange(of: pendingScrollToEnd)` handler.
    @State private var pendingScrollToEnd = false
    /// Debounced-unpin task for the bottom sentinel (see bottomSentinel):
    /// transient dematerialization during growth churn doesn't drop the pin;
    /// a real scroll-away does.
    @State private var sentinelUnpinTask: Task<Void, Never>?
    /// Content-head offset in the scroll's visible frame, from the TOP probe
    /// (every frame). Backfill pages APPEND below the head, so growth never
    /// moves it — any real change is USER scroll. Used to cancel a pending
    /// backfill-wait restore (design 01M1B9F6: user intent wins).
    @State private var topOffset: CGFloat = 0

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
        if target == Self.bottomSentinelID {
            // Sentinel re-anchor: onAppear (atBottom) means REAL geometry —
            // polish the estimated restore/jump so the cell sits exactly at
            // the viewport's bottom edge.
            if atBottom {
                reanchorTarget = nil
                proxy.scrollTo(Self.bottomSentinelID, anchor: .bottom)
            }
            return
        }
        guard items.contains(where: { $0.id == target }) else {
            reanchorTarget = nil
            return
        }
        if materializedIDs.contains(target) {
            reanchorTarget = nil
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    /// The user scrolled during the backfill-wait restore — their intent wins
    /// (design 01M1B9F6): arm the normal machinery (capture + follow gates) at
    /// their position WITHOUT any programmatic scroll. The pending restore is
    /// abandoned; a later page carrying the remembered row becomes a no-op.
    private func cancelPendingRestore() {
        guard !didRestoreScroll else { return }
        didRestoreScroll = true
        reanchorTarget = nil
    }

    /// Scroll "to the bottom" — target the SENTINEL cell, anchored to the
    /// viewport's bottom edge, with an estimated-geometry correction pass:
    /// a scrollTo computed while the sentinel is dematerialized or the lazy
    /// layout is mid-growth can land a row-height (a screen, for text rows)
    /// past the real end. The deferred pass re-runs against SETTLED geometry
    /// (~one layout cycle later), guarded on still-at-bottom so it can never
    /// yank a reader who started dragging in between. Idempotent when the
    /// first scroll already landed right.
    private func scrollToBottom(proxy: ScrollViewProxy) {
        proxy.scrollTo(Self.bottomSentinelID, anchor: .bottom)
        dbgScrollLog("follow → sentinel (immediate)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            guard atBottom else {
                dbgScrollLog("follow deferred pass skipped (unpinned)")
                return
            }
            dbgScrollLog("follow → sentinel (deferred re-anchor)")
            proxy.scrollTo(Self.bottomSentinelID, anchor: .bottom)
        }
    }

    /// One scroll-restore attempt (design 01M1B9F6). Returns true when CONSUMED
    /// (restored, or bottom-fallback latched); false when still WAITING — the
    /// remembered row hasn't arrived yet and the paged backfill hasn't reached
    /// its terminal page. While waiting, auto-follow stays off (it's gated on
    /// `didRestoreScroll`) and capture stays off, so nothing fights the pages
    /// streaming in — the view simply sits until the anchor row lands and the
    /// restore fires mid-walk (or the user scrolls first, which cancels it —
    /// see cancelPendingRestore).
    private func attemptRestore(proxy: ScrollViewProxy) -> Bool {
        guard !items.isEmpty else { return false }
        guard !didRestoreScroll else { return true }
        if let remembered = model.rememberedScroll(session: session) {
            if items.contains(where: { $0.id == remembered }) {
                didRestoreScroll = true
                dbgScrollLog("restore → remembered row \(remembered)")
                // Restore to the remembered STABLE row, attaching at the BOTTOM
                // of its extent. The scrollTo runs on ESTIMATED geometry for a
                // far-down, not-yet-materialized row; the materialized pass
                // re-anchors (reanchorIfNeeded).
                proxy.scrollTo(remembered, anchor: .bottom)
                reanchorTarget = remembered
                // The sentinel never appeared before this programmatic scroll;
                // sync the auto-follow gate so a mid-transcript restore isn't
                // immediately yanked down by the next incoming message.
                atBottom = remembered == items.last?.id
                return true
            }
            // Paged-backfill × restore interaction (designs 01M1B9F6 +
            // 01M1BANZ): the remembered row sits near the END of the entry log,
            // but the first pages carry the OLDEST entries. WAIT for it instead
            // of consuming the restore with a bottom fallback that the following
            // pages then auto-follow to the transcript end (the "restore doesn't
            // stick across app relaunch" bug).
            if !model.backfilledSessions.contains(session.id) { return false }
            // Backfill complete and the row never appeared (compacted away /
            // filtered out): fall through to the bottom fallback.
        }
        // Nothing remembered (or it's permanently gone): land at the bottom.
        // "The bottom" is the SENTINEL cell, not the last row — anchoring the
        // last row would park the sentinel below the viewport and disarm the
        // pin on the very first follow.
        didRestoreScroll = true
        dbgScrollLog("restore → bottom fallback (sentinel-anchored)")
        scrollToBottom(proxy: proxy)
        reanchorTarget = Self.bottomSentinelID
        atBottom = true
        return true
    }

    var body: some View {
        VStack(spacing: 0) {
            if model.hasEnded(session) { endedBanner }
            if model.isDemo(session) { demoBanner }
            statusStrip
            ScrollViewReader { proxy in
                ScrollView {
                    // Top probe (pairs with the bottom sentinel): reports the
                    // content head's offset every frame. Growth-proof — pages
                    // append BELOW the head — so movement here is user scroll.
                    Color.clear.frame(height: 1)
                        .background(GeometryReader { geo in
                            Color.clear.preference(
                                key: TopOffsetKey.self,
                                value: geo.frame(in: .named("transcript-scroll")).minY)
                        })
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
                        // Bottom sentinel cell — MATERIALIZATION IS THE PIN.
                        // As a LazyVStack cell it only exists on screen when the
                        // reader is actually at the transcript's end: no
                        // geometry math against estimated row heights to
                        // misread, and a drag away from the bottom un-pins the
                        // moment the cell leaves the window. Doubles as the busy
                        // indicator: a small "…" box while a turn runs (the same
                        // signal that shows the composer's stop button), an
                        // invisible 2pt cell when idle.
                        bottomSentinel
                    }
                    .padding()
                    // Cap line length on wide windows; centered. No-op on phones.
                    .frame(maxWidth: 1100, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .coordinateSpace(name: "transcript-scroll")
                .onChange(of: items.count, initial: true) { _, _ in
                    if !didRestoreScroll {
                        // May consume (restore / bottom fallback) or WAIT for a
                        // later page carrying the remembered row — see
                        // attemptRestore. (Follow is NOT count-gated: backfill
                        // pages arrive here too and must never move the reader.)
                        _ = attemptRestore(proxy: proxy)
                    }
                }
                // Follow LIVE arrivals only (scroll design: live-vs-replay is
                // the trigger, the sentinel is the pin). `liveArrivals` is
                // bumped by the LIVE reducer path (rpc frames: streamed deltas,
                // new rows, tool updates) and NEVER by get_entries backfill —
                // so replayed/restored history can't yank a reader, while a
                // bottom-pinned reader tracks every live delta. Scroll target is
                // the SENTINEL (not the last row) so the pin survives its own
                // follow. Snap (no animation): animated follows during streaming
                // are what made the pull-down feel like fighting the user.
                .onChange(of: model.transcripts[session.id]?.liveArrivals ?? 0) { _, live in
                    guard didRestoreScroll else {
                        dbgScrollLog("live arrival #\(live) ignored (restore pending)")
                        return
                    }
                    guard atBottom else {
                        dbgScrollLog("live arrival #\(live) ignored (not at bottom)")
                        return
                    }
                    dbgScrollLog("live arrival #\(live) → follow (items=\(items.count))")
                    scrollToBottom(proxy: proxy)
                }
                // The backfill's TERMINAL page (empty entries) doesn't change
                // items.count — give a waiting restore its final chance (bottom
                // fallback when the remembered row never arrived).
                .onChange(of: model.backfilledSessions.contains(session.id)) { _, complete in
                    if complete, !didRestoreScroll {
                        _ = attemptRestore(proxy: proxy)
                    }
                }
                // Capture: remember the bottom-most visible row (design 01M1B9F6);
                // consume a pending restore re-anchor when its row materializes.
                .onChange(of: materializedIDs) { _, _ in
                    rememberVisibleAnchor()
                    reanchorIfNeeded(proxy: proxy)
                }
                .onPreferenceChange(TopOffsetKey.self) { offset in
                    topOffset = offset
                    // During the backfill-wait restore, ANY real scroll movement
                    // is user intent — cancel the pending restore so their
                    // position wins ("the app never moves a user who has already
                    // moved themselves"). Threshold ignores sub-pixel jitter.
                    if !didRestoreScroll, abs(offset) > 8 {
                        cancelPendingRestore()
                    }
                }
                // Submit-consumed: jump to the end the moment a message is sent
                // or queued (not just when its row echoes back). Target the
                // sentinel so the submit jump lands with the pin armed.
                .onChange(of: pendingScrollToEnd) { _, want in
                    guard want, didRestoreScroll else { return }
                    pendingScrollToEnd = false
                    scrollToBottom(proxy: proxy)
                    reanchorTarget = Self.bottomSentinelID
                }
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

    /// Demo-mode banner (AppModel+Demo): honest labeling so the canned
    /// transcript reads as "the app works", never as a live session.
    private var demoBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "theatermasks.fill")
            Text("Demo data — canned transcript, read-only")
            Spacer(minLength: 0)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(theme.background)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.accent)
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

    /// Bottom sentinel cell — see the LazyVStack. Busy: a small animated
    /// "…" box (turn running — the same signal as the composer's stop
    /// button). Idle: an invisible 2pt cell. Either way its on-screen
    /// existence IS the at-bottom pin.
    private var bottomSentinel: some View {
        Group {
            if model.activeTurnID(for: session) != nil, !model.hasEnded(session) {
                BusyIndicatorBox(theme: theme)
            } else {
                Color.clear.frame(height: 2)
            }
        }
        .id(Self.bottomSentinelID)
        .onAppear {
            sentinelUnpinTask?.cancel()
            sentinelUnpinTask = nil
            if !atBottom { dbgScrollLog("sentinel appeared → PINNED") }
            atBottom = true
        }
        .onDisappear {
            // DEBOUNCED unpin: growth between deltas (or lazy-estimate churn)
            // can push the sentinel transiently below the fold — the next
            // follow re-pins it within a frame or two, and re-materialization
            // cancels this task. Only a REAL departure (the reader scrolled
            // away and stayed away) lets the debounce lapse.
            sentinelUnpinTask?.cancel()
            sentinelUnpinTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard !Task.isCancelled else {
                    dbgScrollLog("unpin debounce cancelled (re-appeared)")
                    return
                }
                if atBottom { dbgScrollLog("unpin debounce lapsed → UNPINNED") }
                atBottom = false
            }
        }
    }

    private var inputBar: some View {
        // Submitting is intent to engage the newest content: cancel any
        // pending backfill-wait restore (their position wins), re-pin the
        // follow gate, and scroll to the END immediately — not just when the
        // outgoing row echoes back.
        ComposerBar(session: session, onSent: {
            cancelPendingRestore()
            atBottom = true
            pendingScrollToEnd = true
        })
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

/// The busy half of the transcript's bottom sentinel cell: a small "…"
/// box shown while a turn runs. Doubles as the at-bottom pin (see
/// TranscriptView.bottomSentinel) — when it's on screen, the reader is at
/// the transcript's end and live arrivals may follow.
private struct BusyIndicatorBox: View {
    let theme: AppTheme
    @State private var phase = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { dot in
                Circle()
                    .fill(theme.secondaryText)
                    .frame(width: 5, height: 5)
                    .opacity(phase ? 0.25 : 1.0)
                    .animation(
                        .easeInOut(duration: 0.6)
                            .repeatForever(autoreverses: true)
                            .delay(Double(dot) * 0.2),
                        value: phase)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(theme.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
        .frame(maxWidth: 1100, alignment: .leading)
        .accessibilityLabel("Session working")
        .onAppear { phase = true }
    }
}
