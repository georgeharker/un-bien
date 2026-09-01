import Foundation
import SwiftUI
import UnBienCore
import os

/// Top-level app orchestrator: Owner-key custody, per-relay connections,
/// pairing, live session discovery, and per-session transcript reducers.
@MainActor
public final class AppModel: ObservableObject {
    @Published public var needsOnboarding = true
    @Published public var syncsToICloud: Bool
    @Published public var relayHealth: [UUID: RelayHealth] = [:]
    @Published public var sessions: [String: LiveSession] = [:]
    @Published public var transcripts: [String: SessionState] = [:]
    /// Per-session rpc-envelope reducers, keyed like `transcripts`. Populated
    /// when a fork speaks the `{rpc|evt}` route; each fold updates the matching
    /// `transcripts[key]` from `reducer.session`.
    /// Internal (not private): the AppModel+Inbound extension file — same
    /// module — folds envelope frames through these reducers.
    var envelopeReducers: [String: EnvelopeReducer] = [:]
    /// Pending interactive prompt per session (extension_ui_request).
    @Published public var prompts: [String: ExtensionUiRequest] = [:]
    /// Sessions whose get_entries backfill WALK has reached its terminal page
    /// (empty page / error / nil leaf) — the transcript is complete for now.
    /// TranscriptView's scroll-restore WAITS on this while pages stream in: the
    /// remembered anchor row sits near the END of the entry log, and the first
    /// pages carry the OLDEST entries — restoring on page 1 would consume the
    /// once-per-lifetime restore with a bottom fallback the following pages then
    /// auto-follow to the transcript end (paged backfill × scroll-restore
    /// interaction; designs 01M1B9F6 + 01M1BANZ). Mutated from AppModel+Inbound
    /// (page arrival / terminal) and requestReconstruction (fresh walk) — same
    /// module, so a plain internal setter (private(set) is FILE-scoped and the
    /// Inbound extension is a different file).
    @Published public var backfilledSessions: Set<String> = []
    /// Ask-reconciliation windows per session (see AskSyncWindow): the
    /// robustness backstop that retires a stale prompt whose dismissal notify
    /// was dropped — reconciled at `session_sync_end` in AppModel+Inbound.
    /// Deliberately NOT @Published: internal routing state, no view observes it.
    var askSyncWindows: [String: AskSyncWindow] = [:]
    /// Pending queued follow-up messages per session (pi-native `queue_update`).
    @Published public var queued: [String: [QueuedMessageItem]] = [:]
    /// rpc request/reply correlation (plan 01M1A39Y4G): continuations parked by
    /// `sendAwaitingReply` under the request id, resumed when the matching
    /// `{type:"response", id}` frame lands. AppModel is @MainActor — race-free.
    var pendingRpcReplies: [String: CheckedContinuation<JSONValue?, Never>] = [:]
    /// Named side-panels per session (plan/subagents/…), keyed by panel key.
    @Published public var panels: [String: [String: PanelState]] = [:]
    /// Available models per session (from `models_list`).
    @Published public var availableModels: [String: [WireModel]] = [:]
    /// Current model per session (from `models_list` / `model_set`).
    @Published public var currentModel: [String: WireModel] = [:]
    /// Thinking level the user last selected per session (`thinking_set`).
    @Published public var thinkingLevel: [String: ThinkingLevel] = [:]
    /// Capabilities advertised by the paired pi per session (handshake).
    @Published public var capabilities: [String: Set<String>] = [:]
    /// Daemon/machine status pulled via `presence_status` (design 01M1813Q),
    /// stored SEPARATELY from per-session `capabilities` — it describes an idle
    /// machine (launch caps + backend), not a live session. Keyed by the
    /// control-room key `relayID:daemonEPK:controlRoomID`.
    @Published public var daemonPresence: [String: DaemonPresence] = [:]
    /// A pairing invite opened via the `unbien://` scheme, awaiting a relay
    /// choice. Drives the deep-link relay chooser sheet.
    @Published public var pendingPairing: PendingPairing?
    /// A subagent session the user tapped in the subagents panel, to be pushed
    /// onto the Home nav stack. Transient (not persisted); HomeView consumes and
    /// clears it. Lets a panel row (in a sheet) navigate the underlying stack.
    @Published public var pendingSessionNav: LiveSession?

    // MARK: - Preferences (persisted)

    /// Selected UI theme (live picker). Persisted; drives `theme`.
    @Published public var themeID: ThemeID {
        didSet { UserDefaults.standard.set(themeID.rawValue, forKey: Self.themeKey) }
    }
    /// Whether reasoning/thinking blocks are shown in the transcript.
    @Published public var showThinking: Bool {
        didSet { UserDefaults.standard.set(showThinking, forKey: Self.showThinkingKey) }
    }
    /// Transcript/UI text scale (1.0 = default).
    @Published public var textScale: Double {
        didSet { UserDefaults.standard.set(textScale, forKey: Self.textScaleKey) }
    }
    /// Chosen monospaced font family (code + composer); nil = system mono.
    @Published public var monoFontName: String? {
        didSet { UserDefaults.standard.set(monoFontName, forKey: Self.monoFontKey) }
    }
    /// Chosen body/UI font family (bubbles, markdown); nil = system.
    @Published public var bodyFontName: String? {
        didSet { UserDefaults.standard.set(bodyFontName, forKey: Self.bodyFontKey) }
    }
    /// Show rich tool-result cards (diff/code) UNROLLED by default.
    @Published public var expandRichToolResults: Bool {
        didSet { UserDefaults.standard.set(expandRichToolResults, forKey: Self.expandRichKey) }
    }
    /// Hide the raw input block on a tool card when its output renders richly.
    @Published public var hideInputWhenRich: Bool {
        didSet { UserDefaults.standard.set(hideInputWhenRich, forKey: Self.hideInputRichKey) }
    }
    /// Show subagent child sessions nested under their parent in the home list.
    @Published public var showSubagentsOnHome: Bool {
        didSet { UserDefaults.standard.set(showSubagentsOnHome, forKey: Self.showSubagentsKey) }
    }
    /// Allow interacting with (prompting/steering) a subagent session. Off =
    /// view-only: the composer is hidden for subagent sessions.
    @Published public var subagentsInteractive: Bool {
        didSet { UserDefaults.standard.set(subagentsInteractive, forKey: Self.subagentsInteractiveKey) }
    }
    /// Demo mode (App Store reviewability, design 01M1CGET…): canned fixture
    /// sessions + a transient demo relay, read-only. DEFAULTS ON when no relay
    /// has ever been added (fresh install / App Review reviewer), turns OFF
    /// automatically when the first real relay is added; re-enable from
    /// Settings. Driver: AppModel+Demo.
    @Published public var demoMode: Bool = false {
        didSet { UserDefaults.standard.set(demoMode, forKey: Self.demoModeKey) }
    }

    /// The active theme palette for the selected `themeID`.
    public var theme: AppTheme { themeID.theme }
    /// Current typography (text scale + mono + body font) for environment injection.
    public var typography: Typography {
        Typography(textScale: textScale, monoFontName: monoFontName, bodyFontName: bodyFontName)
    }

    public let mesh: MeshStore
    var identityStore: OwnerIdentityStore
    var owner: Ed25519Identity?
    // Internal (not private): the AppModel+Queue / AppModel+Inbound extension
    // files — same module — route sends through the live per-relay connections.
    var connections: [UUID: RelayConnection] = [:]
    private let log = Logger(subsystem: "un-bien", category: "relay")
    /// Consecutive failed connect attempts per relay, for exponential backoff.
    var reconnectAttempts: [UUID: Int] = [:]
    /// In-flight reconnect timers per relay, cancelled on remove/success.
    var reconnectTasks: [UUID: Task<Void, Never>] = [:]
    /// Sessions the user has opened this run, keyed by session.id. On relay
    /// RECONNECT we re-issue reconstruction (get_entries + session_sync) for
    /// each on the reconnected relay — openSession only fires on view appear,
    /// not reconnect (design 01M15FMQ).
    var openSessions: [String: LiveSession] = [:]
    /// Last-viewed TOPMOST message id per session (session.id key), for
    /// scroll-restore on re-entry (design 01M1ADBB). Deliberately NOT @Published:
    /// it's written on every scroll-settle and read only once on restore, so
    /// observing it would rerender the whole transcript as the user scrolls.
    /// Best-effort persisted to UserDefaults so a cold relaunch can also restore.
    var lastViewedScroll: [String: String] = [:] {
        didSet {
            guard lastViewedScroll != oldValue else { return }
            scheduleScrollPersist()
        }
    }
    /// Debounced UserDefaults persistence for scroll memory (design 01M1B9F6):
    /// rememberScroll fires on every row materialization change while
    /// scrolling, so the write must not land per-settle (v1 persisted on every
    /// scroll settle).
    var scrollPersistTask: Task<Void, Never>?

    static let iCloudDefaultsKey = "com.georgeharker.un-bien.owner-key.icloud-sync"
    private static let themeKey = "com.georgeharker.un-bien.theme"
    private static let showThinkingKey = "com.georgeharker.un-bien.show-thinking"
    private static let textScaleKey = "com.georgeharker.un-bien.text-scale"
    private static let monoFontKey = "com.georgeharker.un-bien.mono-font"
    private static let bodyFontKey = "com.georgeharker.un-bien.body-font"
    private static let expandRichKey = "com.georgeharker.un-bien.expand-rich-tool-results"
    private static let hideInputRichKey = "com.georgeharker.un-bien.hide-input-when-rich"
    private static let showSubagentsKey = "com.georgeharker.un-bien.show-subagents-home"
    private static let subagentsInteractiveKey = "com.georgeharker.un-bien.subagents-interactive"
    static let lastViewedScrollKey = "com.georgeharker.un-bien.last-viewed-scroll"
    /// The demo mesh's transient relay id (AppModel+Demo). Hex-stable so the
    /// session-id namespace is deterministic across launches.
    public static let demoRelayID = UUID(uuidString: "D3A0DE00-0000-4000-8000-000000000001")!
    private static let demoModeKey = "com.georgeharker.un-bien.demo-mode"
    /// Backstop grace for an UNCONSUMED optimistic queued chip (design 01M158S7).
    /// Long by design: consumption (user message_end) is the primary clear, so
    /// this only catches truly-stuck chips (text-normalization miss / dropped
    /// followUp). Erring long avoids clearing a message that is still legitimately
    /// queued through a slow turn. App-owned timing — independent of pi's
    /// (uncertain) re-timestamping. Tunable.
    static let queuedChipGraceNanos: UInt64 = 5 * 60 * 1_000_000_000  // 5 min
    static let reconnectBaseDelay: Double = 1
    static let reconnectMaxDelay: Double = 30

    public init(mesh: MeshStore = MeshStore(), identityStore: OwnerIdentityStore? = nil) {
        self.mesh = mesh
        let syncOn = UserDefaults.standard.object(forKey: Self.iCloudDefaultsKey) as? Bool ?? true
        self.syncsToICloud = syncOn
        self.themeID = (UserDefaults.standard.string(forKey: Self.themeKey))
            .flatMap(ThemeID.init(rawValue:)) ?? .tokyoNight
        self.showThinking = UserDefaults.standard.object(forKey: Self.showThinkingKey) as? Bool ?? true
        let scale = UserDefaults.standard.object(forKey: Self.textScaleKey) as? Double ?? 1.0
        self.textScale = min(max(scale, 0.8), 1.8)
        self.monoFontName = UserDefaults.standard.string(forKey: Self.monoFontKey)
        self.bodyFontName = UserDefaults.standard.string(forKey: Self.bodyFontKey)
        self.expandRichToolResults =
            UserDefaults.standard.object(forKey: Self.expandRichKey) as? Bool ?? true
        self.hideInputWhenRich =
            UserDefaults.standard.object(forKey: Self.hideInputRichKey) as? Bool ?? true
        self.showSubagentsOnHome =
            UserDefaults.standard.object(forKey: Self.showSubagentsKey) as? Bool ?? true
        self.subagentsInteractive =
            UserDefaults.standard.object(forKey: Self.subagentsInteractiveKey) as? Bool ?? false
        if let data = UserDefaults.standard.data(forKey: Self.lastViewedScrollKey),
           let saved = try? JSONDecoder().decode([String: String].self, from: data) {
            self.lastViewedScroll = saved
        }
        self.identityStore = identityStore
            ?? KeychainOwnerIdentityStore(syncsToICloud: syncOn)
        // Demo default: ON only for a relay-less (fresh) install; an explicit
        // Settings choice persists and wins from then on. Runs AFTER full
        // initialization (loadDemoSessions touches published state).
        self.demoMode = (UserDefaults.standard.object(forKey: Self.demoModeKey) as? Bool)
            ?? mesh.config.relays.isEmpty
        if demoMode { loadDemoSessions() }
    }

    // MARK: - Onboarding / identity

    public func bootstrap() async {
        if let existing = try? identityStore.load() {
            owner = existing
            needsOnboarding = false
            await connectAll()
        } else {
            #if DEBUG
            if UserDefaults.standard.bool(forKey: "unbien.demo.stream-replay") {
                // TEMPORARY debug harness (scroll-follow diagnosis): skip
                // onboarding on a fresh simulator so the harness can reach the
                // demo transcript without UI interaction. No owner key — demo
                // mode never connects, so nothing needs one.
                needsOnboarding = false
                return
            }
            #endif
            needsOnboarding = true
        }
    }

    // MARK: - Session actions

    public func openSession(_ session: LiveSession, limit: Int = 100) async {
        openSessions[session.id] = session
        let rosterCount = availableModels[session.id]?.count ?? -1
        let hasCurrent = currentModel[session.id] != nil
        let thinking = thinkingLevel[session.id]?.rawValue ?? "nil"
        log.notice("open key=\(String(session.id.suffix(12)), privacy: .public) roster=\(rosterCount, privacy: .public) cur=\(hasCurrent, privacy: .public) think=\(thinking, privacy: .public)")
        guard let connection = connections[session.relayID] else {
            return
        }
        await requestReconstruction(session, connection: connection)
        // Re-fetch when the roster is nil OR EMPTY: a non-nil-but-empty roster
        // (a reply that legitimately carried zero models, or one that clobbered
        // a good list) must not stick forever — the picker would never return.
        if (availableModels[session.id] ?? []).isEmpty {
            try? await connection.send(.listModels(id: UUID().uuidString),
                                       toPeer: session.peerEPK, room: session.roomID)
        }
    }

    /// The TWO independent reconstruction requests (design 01M15FMQ), issued on
    /// open AND on relay reconnect: (1) native pi `get_entries` rpc for the
    /// TRANSCRIPT — `since` the last leaf cursor for a delta fetch, reduced by
    /// `SessionState.applyEntries`; (2) `session_sync` for un-bien's NON-rpc
    /// panels + pending extension_ui. Both are idempotent (identify dedup /
    /// panel ns-merge), so re-issuing them freely is safe.
    func requestReconstruction(_ session: LiveSession, connection: RelayConnection) async {
        let since = envelopeReducers[session.id]?.leafId
        // A fresh walk is starting: the restore waiter must not treat a stale
        // terminal flag as "the remembered row will never come" until this
        // walk's terminal page lands. A delta refetch (warm reconnect, since
        // != nil) re-marks it complete on its (usually empty) terminal page.
        backfilledSessions.remove(session.id)
        // Open the ask-reconciliation window: the sync reply replays every
        // still-pending ask to the sender ahead of its terminator, and the
        // session_sync_end handler in AppModel+Inbound retires a stored prompt
        // whose flow wasn't replayed (stale — its dismissal notify was dropped).
        // Reset-at-send keeps a late terminator from an older sync reconciling
        // against a stale set (a still-pending flow re-replays every sync).
        askSyncWindows[session.id] = AskSyncWindow()
        try? await connection.send(.getEntries(id: UUID().uuidString, since: since),
                                   toPeer: session.peerEPK, room: session.roomID)
        try? await connection.send(.sessionSync(id: UUID().uuidString, limit: nil),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    /// Whether the paired pi session has shut down (`rpc:session_shutdown`).
    /// When true the transcript shows a "session ended" banner and refuses input.
    public func hasEnded(_ session: LiveSession) -> Bool {
        transcripts[session.id]?.ended ?? false
    }

    public func sendMessage(_ text: String, to session: LiveSession) async {
        guard !isDemo(session) else { return }  // read-only fixture playback
        guard !hasEnded(session) else { return }
        guard let connection = connections[session.relayID] else { return }
        // Busy -> this STEERS into the running turn (pi holds it in the steering
        // queue until the model picks it up mid-turn — often not for a while), so
        // show a GREY pending chip so the text doesn't vanish from the composer.
        // Idle -> runs fresh; the user bubble is the feedback. (activeTurnID is the
        // same busy signal as the Stop icon.)
        if activeTurnID(for: session) != nil {
            insertPendingChip(text, session: session, kind: "steer")
        }
        try? await connection.send(
            .userMessage(id: UUID().uuidString, text: text, images: nil, streamingBehavior: "steer"),
            toPeer: session.peerEPK, room: session.roomID)
    }

    /// `target_id` of the turn currently streaming for a session, if any.
    public func activeTurnID(for session: LiveSession) -> String? {
        transcripts[session.id]?.activeTurnID
    }

    /// Whether the paired pi advertised a capability for this session. Default
    /// FALSE when no handshake was received (older pi) — the app gates UI off.
    public func supports(_ capability: String, session: LiveSession) -> Bool {
        capabilities[session.id]?.contains(capability) ?? false
    }

    /// Interrupt the in-flight turn (`cancel`).
    public func cancel(_ session: LiveSession) async {
        guard let connection = connections[session.relayID],
              let target = transcripts[session.id]?.activeTurnID else { return }
        try? await connection.send(.cancel(id: UUID().uuidString, targetID: target),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    // MARK: - Model / thinking control

    /// Ask the peer for its model roster (`list_models`).
    public func requestModels(for session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(.listModels(id: UUID().uuidString),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    public func setModel(_ model: WireModel, session: LiveSession) async {
        currentModel[session.id] = model
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(
            .modelSet(id: UUID().uuidString, provider: model.provider, modelID: model.id),
            toPeer: session.peerEPK, room: session.roomID)
    }

    public func setThinking(_ level: ThinkingLevel, session: LiveSession) async {
        thinkingLevel[session.id] = level
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(.thinkingSet(id: UUID().uuidString, level: level),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    /// Start a fresh pi session (`session_new` -> pi `new_session`). Wired to the
    /// envelope but NOT yet surfaced in the UI (no caller) — the fork handles it.
    public func newSession(_ session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(.sessionNew(id: UUID().uuidString),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    /// Compact the pi context (`session_compact` -> pi `compact`). Wired to the
    /// envelope but NOT yet surfaced in the UI (no caller) — the fork handles it.
    public func compact(_ session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(.sessionCompact(id: UUID().uuidString),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    // MARK: - Panels (plan / subagents / …)

    /// The `sessionID:panelKey` currently on screen, so live updates to it stay
    /// marked-read instead of re-badging under the user.
    @Published public var openPanel: String?

    // MARK: - Derived

    public func sessions(onRelay relayID: UUID) -> [LiveSession] {
        sessions.values.filter { $0.relayID == relayID }.sorted { $0.name < $1.name }
    }

    public func transcript(for session: LiveSession) -> SessionState {
        transcripts[session.id] ?? SessionState()
    }

    #if DEBUG
    /// Inject a large demo session so the real app UI (session list → transcript
    /// + panels) can be exercised WITHOUT a live protocol data feed. Launch with
    /// the `UNBIEN_DEMO` env var set to trigger it (see RootView).
    public func loadDemoSession(turns: Int = 140) {
        needsOnboarding = false
        // Canned fake relay so the session appears in HomeView (which groups
        // sessions under mesh.config.relays); transient, so it isn't persisted.
        let relayID = UUID(uuidString: "F00DBEEF-0000-4000-8000-000000000001")!
        mesh.addTransientRelay(RelayConfig(id: relayID, name: "Demo relay", url: "demo://local"))
        let session = LiveSession(relayID: relayID, peerEPK: "demo-peer", roomID: "demo-room",
                                  sessionID: "demo-session",
                                  name: "Demo (\(turns) turns)", cwd: "/demo", model: "claude-opus-4-8",
                                  parentSessionID: nil, parentRoomID: nil, subagentID: nil)
        sessions[session.id] = session
        transcripts[session.id] = .demo(turns: turns)
    }
    #endif
}
