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
    /// Manually-dismissed ENDED chats (plan 01M18X3B): keyed by LiveSession.id,
    /// value kept so roomEnded can still resolve the ROUTING tuple after the
    /// row left `sessions`. A pin hides the row; the relay's lingering room
    /// snapshot or a re-announce does NOT re-add it — only PROOF OF LIFE does
    /// (a fresh instance's `ub hello`: the resume flow) or the room genuinely
    /// ending (roomEnded). Internal: AppModel+Inbound consults it.
    @Published public var dismissedSessions: [String: LiveSession] = [:]
    @Published public var transcripts: [String: SessionState] = [:]
    /// Per-session rpc-envelope reducers, keyed like `transcripts`. Populated
    /// when a fork speaks the `{rpc|evt}` route; each fold updates the matching
    /// `transcripts[key]` from `reducer.session`.
    /// Internal (not private): the AppModel+Inbound extension file — same
    /// module — folds envelope frames through these reducers.
    var envelopeReducers: [String: EnvelopeReducer] = [:]
    /// FULL walks in flight: session key → walk request id. While one pages in,
    /// live {rpc|evt} frames are QUEUED in `liveFrameBuffer` (never dropped —
    /// replay at terminal page / walk error / stale unblock; the only true loss
    /// is process death, covered by the log's durability net). A watchdog
    /// unblocks a LOST request AND RETRIES the walk from the cursor (a lost
    /// response — e.g. a silently-dead socket after an iOS background cycle —
    /// orphaned the response-driven paging loop forever, run 2026-09-17).
    /// NOTE: NO reset-at-first-page anymore — the boundary INSERTION (entries
    /// insert before the live tail) fixes the stranding without destroying
    /// anything; a reset collapsed the content mid-walk and blanked the view
    /// until the pages regrew it (user report 2026-09-17).
    var fullWalkInFlight: [String: String] = [:]
    /// Last page-arrival time per walk-in-flight session — the watchdog's STALL
    /// signal (a walk still receiving pages is alive; only a silent one retries).
    var walkLastActivity: [String: Date] = [:]
    var liveFrameBuffer: [String: [(env: EnvelopeMessage, envelope: RoutedEnvelope,
                                   relayID: UUID)]] = [:]
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
    /// Per-session scroll-position CAPTURE closures, registered by open
    /// TranscriptViews — the driver state that determines the visible anchor
    /// is VIEW-LOCAL, unreachable from here. Capture is LIFECYCLE-ONLY (user
    /// 2026-09-17: "don't save on scroll — just quit and view exit / bg"):
    /// the flush points call these, so the store updates only at view exit,
    /// background, and terminate — never per-scroll-flip.
    var scrollCaptureHandlers: [String: @MainActor () -> LifecycleCapture] = [:]
    /// LIVE DELTA COALESCER state (perf, run 2026-09-18 — driven from
    /// AppModel+Inbound; stored here because extensions can't hold stored
    /// properties): pending `message_update` frames per session + the
    /// flush-scheduled flag. ~15fps fold cadence — see
    /// AppModel+Inbound.handleEnvelopeContent for the design note.
    static let streamDeltaFlushNanos: UInt64 = 66_000_000
    var pendingStreamDeltas: [String: [(env: EnvelopeMessage,
                                        envelope: RoutedEnvelope,
                                        relayID: UUID)]] = [:]
    var streamDeltaFlushScheduled = false
    /// Connection generation per relay (run 2026-09-18 duplicate-delivery
    /// fix): incremented by every connect(); event loops carry their
    /// generation and refuse to tear down state when superseded — two
    /// racing connect() paths previously left two live subscribed sockets
    /// for one relay (every room frame delivered twice → every streamed
    /// chunk folded twice). Stored here (extensions can't hold properties);
    /// driven from AppModel+Relays.
    var connectionGeneration: [UUID: Int] = [:]
    /// Per-session retained row heights (persistence tier, design: transcript
    /// row-geometry): captured at the same lifecycle moments as scroll memory,
    /// seeded into the view's driver at open so a relaunch's restore lands on
    /// EXACT geometry instead of the fallback-estimate cascade. Entries carry
    /// a layout fingerprint (textScale/fonts/theme) — a mismatched entry is
    /// never seeded. Not width-fingerprinted: rotation staleness self-heals as
    /// rows re-measure on scroll-through (see RowBoundsStore.seed).
    var heightCache: [String: HeightCacheEntry] = [:]

    /// Lifecycle capture payload from an open TranscriptView: the visible
    /// stable anchor (scroll restore) + the driver's retained heights
    /// (geometry restore).
    struct LifecycleCapture {
        var anchor: String?
        var heights: [String: Double]
    }

    /// A persisted height-cache entry (one session).
    struct HeightCacheEntry: Codable {
        var fingerprint: String
        var heights: [String: Double]
        var at: Date
    }

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
    static let heightCacheKey = "com.georgeharker.un-bien.height-cache"
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
            log.notice("scroll memory loaded (\(saved.count, privacy: .public) sessions)")
        }
        self.identityStore = identityStore
            ?? KeychainOwnerIdentityStore(syncsToICloud: syncOn)
        // Demo default: ON only for a relay-less (fresh) install; an explicit
        // Settings choice persists and wins from then on. Runs AFTER full
        // initialization (loadDemoSessions touches published state).
        self.demoMode = (UserDefaults.standard.object(forKey: Self.demoModeKey) as? Bool)
            ?? mesh.config.relays.isEmpty
        // Height cache loads after full initialization (it touches stored
        // state; the scroll-memory load above is a direct property set).
        loadHeightCache()
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
                // DEBUG-only headless harness: when the flag is EXPLICITLY set
                // (the simulator diagnosis setup), skip onboarding on a fresh
                // install so the harness reaches the demo transcript without UI
                // interaction. No owner key — demo mode never connects, so
                // nothing needs one.
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
        // A previous full walk died mid-flight (connection drop): unblock its
        // buffered live frames before this walk proceeds.
        if fullWalkInFlight[session.id] != nil { replayLiveBuffer(key: session.id) }
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
        let walkID = UUID().uuidString
        // A FULL walk (no cursor) is authoritative history in log order — mark
        // it so the first page's fold RESETS the transcript first (ordering fix).
        if since == nil {
            fullWalkInFlight[session.id] = walkID
            walkLastActivity[session.id] = Date()
            scheduleWalkWatchdog(session: session, walkID: walkID)
        }
        try? await connection.send(.getEntries(id: walkID, since: since),
                                   toPeer: session.peerEPK, room: session.roomID)
        try? await connection.send(.sessionSync(id: UUID().uuidString, limit: nil),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    /// Walk-stall watchdog: a LOST walk response (a silently-dead socket — an
    /// iOS background/foreground cycle kills the WebSocket without ending the
    /// receive stream, so no reconnect ever fires — or a dropped frame)
    /// orphans the response-driven paging loop forever: no page arrives, no
    /// request is re-issued, history stays incomplete (run 2026-09-17: the
    /// walk died at "fetching next page" through a socket reset). After the
    /// stall window with NO page activity: unblock the buffered live frames,
    /// then RETRY the walk from the cursor (idempotent fold — a first-request
    /// loss retries as a fresh full walk). Two retries max; the next
    /// reconnect/open completes the walk regardless.
    private func scheduleWalkWatchdog(session: LiveSession, walkID: String, attempt: Int = 0) {
        let sid = session.id
        Task { @MainActor [weak self] in
            while let self {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                // Completed or superseded meanwhile — stand down.
                guard self.fullWalkInFlight[sid] == walkID else { return }
                // A page arrived recently: the walk is ALIVE (huge log, slow
                // pages) — keep waiting, never kill a progressing walk.
                if let last = self.walkLastActivity[sid],
                   Date().timeIntervalSince(last) < 30 { continue }
                // Genuinely stalled: unblock live content, then retry.
                self.replayLiveBuffer(key: sid)
                guard attempt < 2, let conn = self.connections[session.relayID] else {
                    // Give-up (retries exhausted / connection gone): the walk
                    // is over, incomplete. Mark the session backfilled so the
                    // TranscriptView spinner + restore waiter unblock, and the
                    // stall bookkeeping is already cleared by replayLiveBuffer.
                    // The next reconnect/open re-walks from the cursor
                    // regardless. Previously this returned SILENTLY: spinner
                    // stuck ON forever, live frames buffered behind a dead
                    // walk flag.
                    self.backfilledSessions.insert(sid)
                    return
                }
                let since = self.envelopeReducers[sid]?.leafId
                let retryID = UUID().uuidString
                // Re-mark under the retry id for BOTH retry kinds. A delta
                // retry (since != nil — any walk past its first applied page)
                // used to stay unmarked and UNCOVERED — no watchdog re-armed —
                // so a lost retry response orphaned the walk: spinner stuck
                // ON, live frames buffered forever. Re-marking re-buffers live
                // behind the retry (same ordering semantics as the original
                // walk) and lets the re-armed watchdog's guard match.
                self.fullWalkInFlight[sid] = retryID
                let sinceTail = since == nil ? "nil" : String(since!.suffix(8))
                self.log.notice("get_entries walk stalled — retry \(attempt + 1) from cursor (since=\(sinceTail, privacy: .public))")
                try? await conn.send(.getEntries(id: retryID, since: since),
                                     toPeer: session.peerEPK, room: session.roomID)
                self.scheduleWalkWatchdog(session: session, walkID: retryID, attempt: attempt + 1)
                return
            }
        }
    }

    /// Whether the paired pi session has shut down (`rpc:session_shutdown`).
    /// When true the transcript shows a "session ended" banner and refuses input.
    public func hasEnded(_ session: LiveSession) -> Bool {
        transcripts[session.id]?.ended ?? false
    }

    /// Whether a row may be REMOVED from the list (plan 01M18X3B). Two classes:
    /// a session the app watched END (`session_shutdown` → ended banner), and a
    /// subagent whose PULLED lifecycle status is terminal (done/failed — design
    /// 01M18PCM). A done subagent's room LINGERS at the relay by design (the
    /// keeper pattern) and never delivers session_shutdown to the app, so the
    /// ended flag alone would make done subagents permanently un-removable.
    /// Anything else (live root, running subagent, status not yet pulled) stays
    /// put — a live chat's destructive action is Terminate (own plan item),
    /// never a local hide.
    public func isRemovable(_ session: LiveSession) -> Bool {
        hasEnded(session) || session.isTerminalSubagent
    }

    /// Manually dismiss a chat that already ENDED on the machine (plan
    /// 01M18X3B): client-side ONLY — no wire command, nothing sent, on-disk pi
    /// history untouched. Drops the row from `sessions` and pins it in
    /// `dismissedSessions` so the relay's lingering room snapshot doesn't
    /// immediately re-add it. The in-memory transcript is KEPT: if the session
    /// proves live again (a fresh instance's `ub hello`), the row resurrects
    /// with its history and the ended banner retracts.
    /// Manually dismiss a chat that already ENDED on the machine (plan
    /// 01M18X3B): client-side ONLY — no wire command, nothing sent, on-disk pi
    /// history untouched. Drops the row from `sessions` and pins it in
    /// `dismissedSessions` so the relay's lingering room snapshot doesn't
    /// immediately re-add it. The in-memory transcript is KEPT: if the session
    /// proves live again (a fresh instance's `ub hello`), the row resurrects
    /// with its history and the ended banner retracts.
    public func removeEndedSession(_ session: LiveSession) {
        guard !isDemo(session) else { return }  // demo fixtures never persist pins
        guard isRemovable(session) else { return }  // a live row gets Terminate, never Remove
        sessions[session.id] = nil
        dismissedSessions[session.id] = session
        // Room-kill best-effort (plan [lifecycle][send]): a done subagent's
        // room LINGERS at the relay by design (keeper), so without this the
        // row resurrects on every app restart. Ask the PARENT to close the
        // child room — the relay's room_ended then purges + un-pins us.
        // Fire-and-forget: the local pin is optimistic; room_ended confirms.
        if session.isSubagent {
            sendCloseChildRoom(for: session)
        }
        forgetSession(key: session.id)
        log.notice("removed ended chat key=\(String(session.id.suffix(12)), privacy: .public)")
    }

    /// `close_child_room` to the PARENT of a (done) subagent — the only
    /// holder of a finished child's room. Best-effort: no parent row / parent
    /// lacking the cap => local pin only (the interim-resurrection path).
    private func sendCloseChildRoom(for child: LiveSession) {
        guard let connection = connections[child.relayID],
              let parent = sessions.values.first(where: {
                  $0.sessionID == child.parentSessionID
                      && $0.relayID == child.relayID
                      && $0.peerEPK == child.peerEPK
              }) else { return }
        let peerEPK = parent.peerEPK
        let parentRoomID = parent.roomID
        let childRoomID = child.roomID
        let rid = UUID().uuidString
        Task {
            try? await connection.send(.closeChildRoom(id: rid, roomID: childRoomID),
                                       toPeer: peerEPK, room: parentRoomID)
        }
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

    /// App-driven terminate (plan [lifecycle][send]): kill a LIVE chat —
    /// red trash + confirm on the Home row. The fork shuts its host down
    /// gracefully (pi session_shutdown → ended banner), the process exits,
    /// the relay fires room_ended, and the existing roomEnded path purges
    /// the row. Gated on the fork's advertised `remote_terminate` cap
    /// (config `allow_remote_terminate`, default on) — older forks simply
    /// never show the affordance.
    public func terminate(_ session: LiveSession) {
        guard !isDemo(session) else { return }
        guard supports("remote_terminate", session: session) else { return }
        guard let connection = connections[session.relayID] else { return }
        let peerEPK = session.peerEPK
        let roomID = session.roomID
        let rid = UUID().uuidString
        Task {
            try? await connection.send(.terminate(id: rid, reason: "app"),
                                       toPeer: peerEPK, room: roomID)
        }
        log.notice("terminate requested key=\(String(session.id.suffix(12)), privacy: .public)")
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
