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

/// Session transcript: streamed Markdown (swift-markdown-ui) with Highlightr
/// code blocks, collapsible tool-call cards, and a text input bar (DESIGN §7).
struct TranscriptView: View {
    /// Binding id of the bottom sentinel cell. "The bottom" IS the sentinel —
    /// every bottom-targeting bind (arm / follow / re-trigger) anchors THIS
    /// cell to the viewport's bottom edge (anchoring the last message row
    /// instead would park the sentinel below the fold and read as user intent
    /// on the first follow, killing bottom-following). The two-way
    /// scrollPosition binding reads it back when the user settles at the
    /// bottom — that read IS the auto-re-arm signal.
    static let bottomSentinelID = "unbien.bottom-sentinel"

    let session: LiveSession
    @EnvironmentObject var model: AppModel
    @State private var selectedPanelKey: String?
    @Environment(\.appTheme) var theme
    @Environment(\.typography) var typography
    /// Pops the transcript (navigationDestination push) — used by the ended
    /// banner's Remove, which deletes the row it is displayed from.
    @Environment(\.dismiss) private var dismiss

    /// Restore runs once per view lifetime, after items first populate.
    @State var didRestoreScroll = false
    /// Restore LANDING polish (binding-era re-anchor): the restore bind lands
    /// on ESTIMATED geometry — fresh-open rows all claim the fallback height
    /// until they attach and measure, so the first landing is off and shifts
    /// again as measurement cascades. Re-issue the bind (nil → target, the
    /// bindBottom trick — same-value sets are no-ops) twice as the layout
    /// settles. Cancelled by a user gesture (their position wins).
    @State private var restorePolishTask: Task<Void, Never>?
    /// Last observed scroll phase — .animating (PROGRAMMATIC offset changes,
    /// e.g. content-growth adjustments during the walk) suspends the restore's
    /// movement backstop: those offset jumps are not user intent.
    @State private var lastScrollPhase: ScrollPhase = .idle
    /// Offset baseline captured when the restore-wait begins — the movement
    /// backstop is RELATIVE to it (an absolute threshold false-cancelled on
    /// inset churn at open).
    @State private var restoreBaselineScrollY: Double?
    /// The scrollPosition binding (design: scroll-position pin; prototype
    /// app/Prototypes/scroll-position-pin.swift) — the scroll view's ANCHOR
    /// and the ENTIRE scroll machinery. Setting it (sentinel / remembered
    /// row) is a PHASE-FREE command: no scroll phases are emitted, so nothing
    /// we do can masquerade as user input — the whole echo/suppression/
    /// attribution stack the scrollTo approach needed does not exist here.
    /// The user scrolling updates it (two-way): the readout IS their position,
    /// which is how user intent is detected (the binding reads anything but
    /// nil/sentinel while pinned ⇒ the user scrolled ⇒ disarm). There is no
    /// ScrollViewReader, no scrollTo, no proxy.
    @State var scrollAnchor: String?
    /// The standing decision to keep the reader at the bottom — the pin
    /// POLICY (declarative model). Writers: restore (position from history —
    /// restored mid-transcript ⇒ false, the pin "disappears"), submit
    /// (explicit intent), the output-start eval (ARM-ONLY: binding reads the
    /// sentinel ⇒ the reader is at the bottom when "…" appears), the settle
    /// auto-re-pin (scroll settles with the binding on the sentinel), and the
    /// disarm (the binding moves to a non-sentinel id while pinned = the user
    /// scrolled — their position stands). STICKY between writes — content
    /// growth never disarms, so a pinned reader's follow reclaims the bottom.
    @State var shouldPin = true
    /// Windowed-layout engine (design: transcript row-geometry). @State holds
    /// the reference for the view's lifetime; husks read membership at init
    /// and receive flips row-targeted.
    @State var windowDriver = TranscriptWindowDriver()
    /// Viewport height — the window math's input (+ the resize reclaim).
    @State var viewportHeight: Double?
    #if DEBUG
    /// Main-thread stall detector (iOS scroll-hang diagnosis): timestamp of
    /// the last head-probe preference frame. The probe fires per scroll
    /// frame, so a gap >60ms between frames = the main thread was blocked
    /// (layout storm or worse) — logged with the item count at the time.
    @State private var lastProbeNanos: UInt64?
    #endif

    /// Output-start evaluation (ARM-ONLY): the "…" appearing is when
    /// following becomes meaningful — the binding reads the sentinel ⇒ the
    /// reader is at the bottom ⇒ arm. `initial: true` covers a view REOPENED
    /// mid-stream, which never sees the busy TRANSITION (extracted from the
    /// body chain for the type-checker).
    private func handleOutputStart(_ busy: Bool) {
        guard busy, !shouldPin else { return }
        let atSentinel: Bool = scrollAnchor == Self.bottomSentinelID
        if atSentinel {
            shouldPin = true
            dbgScrollLog("output start → arm (binding on sentinel)")
        }
    }

    /// Binding-readout frame: log + user-intent disarm (extracted from the
    /// body chain for the type-checker).
    private func handleBindingChange(_ old: String?, _ new: String?) {
        let change: String = "binding \(old ?? "nil") → \(new ?? "nil") (pin \(shouldPin ? "on" : "off"))"
        dbgScrollLog(change)
        // IDENTITY-ANCHORED windowing (rendered state — user, 2026-09-17):
        // the readout names the row at the viewport's bottom edge — center
        // the driver's near window on it. This kills the registry-vs-rendered
        // divergence DEADLOCK (stale seeds + unmeasured new rows starved the
        // geometric mapping; far rows never measure, so the window never
        // self-corrected — the hands-off blank-tail bug).
        //
        // CRITICAL: `nil` KEEPS the current anchor. nil is our own bindBottom
        // re-trigger hop (it forces a binding CHANGE, not a position change) —
        // clearing here thrashed the window through the divergent geometric
        // mapping for the 16ms hop on EVERY arrival, cycling the streaming
        // row near→far→near: "briefly displays, then the last one is blank"
        // (run 2026-09-17). The geometric fallback only serves the
        // pre-first-bind state, where the anchor is still .none anyway.
        if let new = new {
            if new == Self.bottomSentinelID {
                windowDriver.updateTailAnchor()
            } else {
                windowDriver.update(anchorID: new)
            }
            // DISARM: while pinned, a binding that reads anything but
            // nil/sentinel is the user's position — the pin turns off
            // and their position stands (no binding write, no yank).
            if shouldPin, new != Self.bottomSentinelID {
                shouldPin = false
                dbgScrollLog("user intent → disarm")
            }
        }
    }

    /// Scroll-phase frame: gesture phases cancel pending restores + polish,
    /// settle re-pins at the sentinel. `.animating` (programmatic) is never
    /// user intent (extracted from the body chain for the type-checker).
    private func handleScrollPhase(_ newPhase: ScrollPhase) {
        lastScrollPhase = newPhase
        switch newPhase {
        case .tracking, .interacting, .decelerating:
            if !didRestoreScroll {
                dbgScrollLog("gesture phase while restore pending — cancelling")
            }
            restorePolishTask?.cancel()   // a gesture beats the polish — their position wins
            cancelPendingRestore()
        case .idle:
            if !shouldPin, scrollAnchor == Self.bottomSentinelID {
                shouldPin = true
                dbgScrollLog("settle at sentinel → auto re-pin")
            }
        default:
            break   // .animating = programmatic — never user intent
        }
    }

    /// Scroll-geometry frame: window feed + pre-restore backstop + DEBUG
    /// stall detection (extracted from the body chain: the chain's aggregate
    /// expression outgrew the type-checker).
    private func handleScrollGeometry(_ scrollY: Double) {
        #if DEBUG
        let now = DispatchTime.now().uptimeNanoseconds
        if let last = lastProbeNanos {
            let gapMs = Double(now - last) / 1_000_000
            if gapMs > 60 {
                let stall: String = "STALL \(Int(gapMs))ms between scroll frames (N=\(items.count))"
                dbgScrollLog(stall)
            }
        }
        lastProbeNanos = now
        #endif
        windowDriver.update(scrollY: scrollY)
        // Pre-restore movement backstop — RELATIVE to the offset baseline
        // (captured when the wait began), SUSPENDED while the phase is
        // .animating (programmatic offset jumps from content growth are not
        // user intent — the absolute 8pt/40pt forms false-cancelled restores
        // at open, run 2026-09-17). Gesture phases are the primary intent
        // signal; this catches silent offset moves only.
        if !didRestoreScroll, lastScrollPhase != .animating {
            if restoreBaselineScrollY == nil { restoreBaselineScrollY = scrollY }
            let delta = scrollY - (restoreBaselineScrollY ?? 0)
            if abs(delta) > 64 {
                let moved: String = "restore cancelled (offset moved \(Int(delta))pt without gesture)"
                dbgScrollLog(moved)
                cancelPendingRestore()
            }
        }
    }

    /// Follow a live arrival (extracted from the body chain: the modifier
    /// chain's aggregate expression got too big for the type-checker).
    private func handleLiveArrival(_ live: Int) {
        guard didRestoreScroll, shouldPin else {
            dbgScrollLog("live arrival #\(live) ignored (restore pending or not pinned)")
            return
        }
        dbgScrollLog("live arrival #\(live) → bind bottom (items=\(items.count))")
        bindBottom()
    }

    /// "Scroll to the bottom" — the prototype's re-trigger: nil → sentinel,
    /// one frame apart. The sentinel's id never changes, so re-setting the
    /// same value is a NO-OP (verified in the harness); the nil hop makes it
    /// a real binding change so the scroll fires on EVERY arrival. Both sets
    /// are phase-free. Known race (accepted, prototype-verbatim): a drag
    /// starting inside the 16ms gap can be yanked by the sentinel re-set —
    /// if that shows up on device, re-check `shouldPin` in the Task.
    private func bindBottom() {
        scrollAnchor = nil
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 16_000_000)   // one frame
            scrollAnchor = Self.bottomSentinelID
        }
    }

    /// Restore LANDING polish: re-issue the restore bind twice as the layout
    /// settles (250ms / 750ms). Same-value sets are no-ops, so the nil hop
    /// forces the re-scroll; each pass lands on progressively-measured
    /// geometry. Phase-free, so no echo; bounded (two passes, then done).
    /// A user gesture cancels it — their position wins. Accepted race: a
    /// drag starting INSIDE a pass's 16ms nil-gap can be yanked once (same
    /// accepted race as bindBottom).
    private func scheduleRestorePolish(target: String) {
        restorePolishTask?.cancel()
        restorePolishTask = Task { @MainActor in
            for nanos: UInt64 in [250_000_000, 750_000_000] {
                try? await Task.sleep(nanoseconds: nanos)
                guard !Task.isCancelled else { return }
                scrollAnchor = nil
                try? await Task.sleep(nanoseconds: 16_000_000)   // one frame
                guard !Task.isCancelled else { return }
                scrollAnchor = target
                dbgScrollLog("restore polish → re-bind \(target.suffix(8))")
            }
        }
    }

    var items: [TranscriptItem] {
        let all = model.transcripts[session.id]?.items ?? []
        guard !model.showThinking else { return all }
        // Preference: hide reasoning/thinking blocks from the transcript.
        return all.filter { if case .reasoning = $0 { return false } else { return true } }
    }

    /// The user scrolled during the backfill-wait restore — their intent wins
    /// (design 01M1B9F6): latch restore-done WITHOUT any programmatic scroll,
    /// so the normal machinery (capture + follow gates) arms at their
    /// position. The pending restore is abandoned; a later page carrying the
    /// remembered row becomes a no-op.
    private func cancelPendingRestore() {
        guard !didRestoreScroll else { return }
        didRestoreScroll = true
        dbgScrollLog("restore cancelled (user intent) — their position stands")
    }

    /// One scroll-restore attempt. Returns true when CONSUMED (restored, or
    /// bottom-fallback latched); false when still WAITING — the remembered
    /// row hasn't arrived and the paged backfill hasn't reached its terminal
    /// page. While waiting, NOTHING writes the binding (follows are gated on
    /// `didRestoreScroll`), so any binding change is the user's — see the
    /// binding handler in the body.
    private func attemptRestore() -> Bool {
        guard !items.isEmpty else { return false }
        guard !didRestoreScroll else { return true }
        if let remembered = model.rememberedScroll(session: session) {
            if items.contains(where: { $0.id == remembered }) {
                didRestoreScroll = true
                // Restore = POSITIONING + a pin EVALUATION (position from
                // history): restored mid-transcript ⇒ the pin "disappears".
                // A landing that's actually at the bottom re-arms via the
                // output-start eval or the settle auto-re-pin.
                shouldPin = false
                scrollAnchor = remembered
                scheduleRestorePolish(target: remembered)
                dbgScrollLog("restore → remembered row \(remembered) (pin off)")
                return true
            }
            // Paged-backfill × restore interaction (designs 01M1B9F6 +
            // 01M1BANZ): the remembered row sits near the END of the entry log,
            // but the first pages carry the OLDEST entries. WAIT for it instead
            // of consuming the restore with a bottom fallback that the following
            // pages then auto-follow to the transcript end (the "restore doesn't
            // stick across app relaunch" bug).
            if !model.backfilledSessions.contains(session.id) {
                dbgScrollLog("restore waiting for \(remembered.suffix(8)) (items=\(items.count))")
                return false
            }
            // Backfill complete and the row never appeared (compacted away /
            // filtered out): fall through to the bottom fallback.
        }
        // Nothing remembered (or it's permanently gone): land at the bottom
        // and stay pinned. "The bottom" is the SENTINEL — the binding's id.
        didRestoreScroll = true
        shouldPin = true
        scrollAnchor = Self.bottomSentinelID
        dbgScrollLog("restore → bottom fallback (sentinel-bound)")
        return true
    }

    var body: some View {
        VStack(spacing: 0) {
            if model.hasEnded(session) { endedBanner }
            if model.isDemo(session) { demoBanner }
            statusStrip
                ScrollView {
                    transcriptStack
                }
            .background(viewportProbe)
            // THE PIN (design: scroll-position pin; prototype
            // app/Prototypes/scroll-position-pin.swift): ONE binding is the
            // entire scroll machinery. Setting it is a PHASE-FREE command;
            // the user scrolling updates it — the readout IS their position.
            .scrollPosition(id: $scrollAnchor, anchor: .bottom)
            .onChange(of: items.count, initial: true) { _, _ in
                if !didRestoreScroll {
                    // May consume (restore / bottom fallback) or WAIT for a
                    // later page carrying the remembered row — see
                    // attemptRestore. (Follow is NOT count-gated: backfill
                    // pages arrive here too and must never move the reader.)
                    _ = attemptRestore()
                }
            }
            // Follow LIVE arrivals: pinned ⇒ re-trigger the sentinel bind.
            // That's the whole spec — binding sets are phase-free, so there
            // is no echo to suppress and no gesture attribution: a user who
            // scrolls away moves the binding and disarms the pin before the
            // next arrival can follow. Snap (no animation): animated
            // follows feel like fighting the user.
            .onChange(of: model.transcripts[session.id]?.liveArrivals ?? 0) { _, live in
                handleLiveArrival(live)
            }
            // The backfill's TERMINAL page (empty entries) doesn't change
            // items.count — give a waiting restore its final chance (bottom
            // fallback when the remembered row never arrived).
            .onChange(of: model.backfilledSessions.contains(session.id)) { _, complete in
                if complete, !didRestoreScroll {
                    _ = attemptRestore()
                }
            }
            // SCROLL POSITION SOURCE (single, committed): the scroll view's
            // OWN geometry — visibleRect.minY IS the content-coordinate top of
            // the viewport, inset-correct by definition. This replaces the TWO
            // child-frame probes (head preference + sentinel frame): both read
            // TRANSIENT mid-layout child positions, and on a large transcript
            // their two derivations disagreed frame-to-frame — the near set
            // oscillated empty↔full, mass-flipping content attach/detach and
            // relayouting the whole stack in a self-sustaining storm (the iOS
            // "can't scroll to the bottom" wedge; the visibly sinusoidal "…"
            // on macOS, run 2026-09-17). onScrollGeometryChange delivers
            // COMMITTED scroll-view geometry only — no child-frame echoes.
            // Inserts are covered by the driver's dirty-recompute at body time
            // (same scrollY + new order = the correct new window).
            .onScrollGeometryChange(for: Double.self) { geo in
                geo.visibleRect.minY
            } action: { _, scrollY in
                handleScrollGeometry(scrollY)
            }
            // The binding READOUT — every change passes through here. NOTE:
            // the readout is CONTENT-CHURN-SENSITIVE — when pages insert above
            // the viewport (the backfill walk), the visible row shifts under
            // the fixed offset and the readout updates with NO user input
            // (run 2026-09-17: passive assistant→assistant→user readout churn
            // mid-walk). So the readout is NEVER a user-intent signal for the
            // pending RESTORE — the geometry source (offset movement, which
            // inserts don't produce) owns that. The DISARM is still safe: it
            // only fires while PINNED, and a pinned reader sits on the sentinel
            // (inserts land above it), so the readout is stable there.
            .onChange(of: scrollAnchor) { old, new in
                handleBindingChange(old, new)
            }
            // Scroll phases have exactly two duties: cancel a pending
            // restore at GESTURE start (touch-down / drag / momentum), and
            // AUTO RE-PIN at settle. CRITICAL: only GESTURE phases are user
            // intent — .animating is emitted for PROGRAMMATIC/animated offset
            // changes (content-growth adjustments during the walk), and
            // treating it as intent silently cancelled pending restores with
            // nobody touching anything (run 2026-09-17: "restore cancelled
            // but I didn't touch the scrolling").
            .onScrollPhaseChange { _, newPhase in
                handleScrollPhase(newPhase)
            }
            // Viewport-resize RECLAIM (keyboard, queued-chips row, rotation):
            // the max offset moves with the resize and SwiftUI can leave the
            // offset beyond the new bounds until a gesture — blank
            // over-scroll zone. A pinned reader re-lands at the bottom.
            .onChange(of: viewportHeight) { _, _ in
                guard didRestoreScroll, shouldPin else { return }
                dbgScrollLog("viewport resize → reclaim bottom")
                bindBottom()
            }
            // OUTPUT-START EVALUATION (user: "the pin is only relevant when
            // … shows"): the "…" appearing is when following becomes
            // meaningful — read the binding immediately: it reads the
            // sentinel ⇒ the reader is at the bottom ⇒ arm. ARM-ONLY: a
            // reader elsewhere was already disarmed at their settle; a
            // content-displaced reader keeps the pin so the follow reclaims.
            // `initial: true` — a view REOPENED mid-stream never sees the
            // busy TRANSITION, so it evaluates at open instead.
            .onChange(of: model.activeTurnID(for: session) != nil, initial: true) { _, busy in
                handleOutputStart(busy)
            }
            #if os(iOS)
            // Swipe the transcript down to dismiss the composer keyboard.
            .scrollDismissesKeyboard(.interactively)
            #endif
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
        .onAppear {
            // LIFECYCLE-ONLY capture (user 2026-09-17: "don't save on scroll —
            // just quit and view exit / bg"): register the capture closure;
            // the model calls it at background/terminate flush points. No
            // per-flip capture — anchor + heights compute on demand.
            model.scrollCaptureHandlers[session.id] = {
                AppModel.LifecycleCapture(anchor: currentStableAnchor(),
                                          heights: stableHeights())
            }
            // Height-cache SEED (persistence tier): exact geometry at open —
            // the restore's binding jump then lands where it should instead
            // of the fallback-estimate cascade (the blank-bubble window).
            if let cached = model.seedHeights(for: session) {
                windowDriver.seedHeights(cached)
            }
        }
        .onDisappear {
            // View exit: the last lifecycle moment THIS view gets — capture +
            // persist now. (Quit-with-view-open routes through the registered
            // handler instead.)
            model.scrollCaptureHandlers[session.id] = nil
            if let anchor = currentStableAnchor() {
                model.rememberScroll(id: anchor, session: session)
            }
            model.rememberHeights(stableHeights(), session: session)
            model.flushScrollMemory()
        }
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
            // Manual dismiss (plan 01M18X3B): clear this ended chat from the
            // Home list straight from the banner. Client-side only — history
            // and on-disk pi logs untouched; a session that comes back live
            // resurrects its row (fresh `ub hello`). Pops the transcript.
            Button {
                model.removeEndedSession(session)
                dismiss()
            } label: {
                Text("Remove")
            }
            .buttonStyle(.bordered)
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

    private var inputBar: some View {
        // Submitting is intent to engage the newest content: cancel any
        // pending backfill-wait restore (their position wins), arm the pin,
        // and bind the bottom NOW — not just when the outgoing row echoes
        // back (a queued steer may not create a row for a while).
        ComposerBar(session: session, onSent: {
            cancelPendingRestore()
            // Submit = EXPLICIT intent: the one direct policy write; the
            // binding set is the phase-free command.
            shouldPin = true
            scrollAnchor = Self.bottomSentinelID
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
struct BusyIndicatorBox: View {
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
