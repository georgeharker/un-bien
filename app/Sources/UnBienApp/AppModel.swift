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

    /// The active theme palette for the selected `themeID`.
    public var theme: AppTheme { themeID.theme }
    /// Current typography (text scale + mono + body font) for environment injection.
    public var typography: Typography {
        Typography(textScale: textScale, monoFontName: monoFontName, bodyFontName: bodyFontName)
    }

    public let mesh: MeshStore
    private var identityStore: OwnerIdentityStore
    private var owner: Ed25519Identity?
    // Internal (not private): the AppModel+Queue / AppModel+Inbound extension
    // files — same module — route sends through the live per-relay connections.
    var connections: [UUID: RelayConnection] = [:]
    private let log = Logger(subsystem: "un-bien", category: "relay")
    /// Consecutive failed connect attempts per relay, for exponential backoff.
    private var reconnectAttempts: [UUID: Int] = [:]
    /// In-flight reconnect timers per relay, cancelled on remove/success.
    private var reconnectTasks: [UUID: Task<Void, Never>] = [:]
    /// Sessions the user has opened this run, keyed by session.id. On relay
    /// RECONNECT we re-issue reconstruction (get_entries + session_sync) for
    /// each on the reconnected relay — openSession only fires on view appear,
    /// not reconnect (design 01M15FMQ).
    private var openSessions: [String: LiveSession] = [:]
    /// Last-viewed TOPMOST message id per session (session.id key), for
    /// scroll-restore on re-entry (design 01M1ADBB). Deliberately NOT @Published:
    /// it's written on every scroll-settle and read only once on restore, so
    /// observing it would rerender the whole transcript as the user scrolls.
    /// Best-effort persisted to UserDefaults so a cold relaunch can also restore.
    private var lastViewedScroll: [String: String] = [:] {
        didSet {
            guard lastViewedScroll != oldValue else { return }
            scheduleScrollPersist()
        }
    }
    /// Debounced UserDefaults persistence for scroll memory (design 01M1B9F6):
    /// rememberScroll fires on every row materialization change while
    /// scrolling, so the write must not land per-settle (v1 persisted on every
    /// scroll settle).
    private var scrollPersistTask: Task<Void, Never>?
    private func scheduleScrollPersist() {
        scrollPersistTask?.cancel()
        scrollPersistTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.persistLastViewedScroll()
        }
    }

    private static let iCloudDefaultsKey = "com.georgeharker.un-bien.owner-key.icloud-sync"
    private static let themeKey = "com.georgeharker.un-bien.theme"
    private static let showThinkingKey = "com.georgeharker.un-bien.show-thinking"
    private static let textScaleKey = "com.georgeharker.un-bien.text-scale"
    private static let monoFontKey = "com.georgeharker.un-bien.mono-font"
    private static let bodyFontKey = "com.georgeharker.un-bien.body-font"
    private static let expandRichKey = "com.georgeharker.un-bien.expand-rich-tool-results"
    private static let hideInputRichKey = "com.georgeharker.un-bien.hide-input-when-rich"
    private static let showSubagentsKey = "com.georgeharker.un-bien.show-subagents-home"
    private static let subagentsInteractiveKey = "com.georgeharker.un-bien.subagents-interactive"
    private static let lastViewedScrollKey = "com.georgeharker.un-bien.last-viewed-scroll"
    /// Backstop grace for an UNCONSUMED optimistic queued chip (design 01M158S7).
    /// Long by design: consumption (user message_end) is the primary clear, so
    /// this only catches truly-stuck chips (text-normalization miss / dropped
    /// followUp). Erring long avoids clearing a message that is still legitimately
    /// queued through a slow turn. App-owned timing — independent of pi's
    /// (uncertain) re-timestamping. Tunable.
    static let queuedChipGraceNanos: UInt64 = 5 * 60 * 1_000_000_000  // 5 min
    private static let reconnectBaseDelay: Double = 1
    private static let reconnectMaxDelay: Double = 30

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
    }

    // MARK: - Onboarding / identity

    public func bootstrap() async {
        if let existing = try? identityStore.load() {
            owner = existing
            needsOnboarding = false
            await connectAll()
        } else {
            needsOnboarding = true
        }
    }

    public func createOwnerKey() async {
        let identity = Ed25519Identity()
        identityStore = KeychainOwnerIdentityStore(syncsToICloud: syncsToICloud)
        try? identityStore.save(identity)
        UserDefaults.standard.set(syncsToICloud, forKey: Self.iCloudDefaultsKey)
        owner = identity
        needsOnboarding = false
        await connectAll()
    }

    // MARK: - Relays

    public func addRelay(name: String, url: String) async {
        let relay = RelayConfig(name: name, url: url)
        mesh.addRelay(relay)
        await connect(relay)
    }

    /// Parse an `unbien://pair?…` deep link (system Camera / pasted link) into a
    /// pending invite. The relay is NOT in the URL (the QR carries no `r`), so
    /// the UI then presents a relay chooser. Non-pairing URLs are ignored.
    public func handleOpenURL(_ url: URL) {
        guard let invite = try? PairingURI.parse(url.absoluteString) else { return }
        pendingPairing = PendingPairing(invite: invite)
    }

    public func removeRelay(id: UUID) {
        reconnectTasks[id]?.cancel()
        reconnectTasks[id] = nil
        reconnectAttempts[id] = nil
        connections[id] = nil
        relayHealth[id] = nil
        sessions = sessions.filter { $0.value.relayID != id }
        mesh.removeRelay(id: id)
    }

    /// Edit a relay's name/URL, then reconnect on the (possibly new) endpoint.
    /// Tears down the old connection first so a URL change takes effect.
    public func updateRelay(id: UUID, name: String, url: String) async {
        mesh.updateRelay(id: id, name: name, url: url)
        reconnectTasks[id]?.cancel()
        reconnectTasks[id] = nil
        reconnectAttempts[id] = nil
        connections[id] = nil
        relayHealth[id] = nil
        if let relay = mesh.config.relays.first(where: { $0.id == id }) {
            await connect(relay)
        }
    }

    private func connectAll() async {
        for relay in mesh.config.relays { await connect(relay) }
    }

    /// Home drag-to-refresh: re-request the rooms snapshot on every connected
    /// relay so a session whose `room_announced` push was missed still
    /// surfaces. The `.rooms` reconcile logs how many it recovered.
    func refreshRooms() async {
        for relay in mesh.config.relays {
            guard let connection = connections[relay.id] else { continue }
            let peers = mesh.config.machines(onRelay: relay.id).map(\.epk)
            try? await connection.refreshRooms(peers: peers)
        }
    }

    private func connect(_ relay: RelayConfig) async {
        guard let owner, let url = relay.webSocketURL else { return }
        reconnectTasks[relay.id]?.cancel()
        reconnectTasks[relay.id] = nil
        relayHealth[relay.id] = .connecting
        let channel = URLSessionWebSocketChannel(url: url)
        let connection = RelayConnection(channel: channel, identity: owner)
        do {
            try await connection.authenticate()
            let peers = mesh.config.machines(onRelay: relay.id).map(\.epk)
            try await connection.subscribe(peers: peers)
            connections[relay.id] = connection
            relayHealth[relay.id] = .online
            reconnectAttempts[relay.id] = 0
            startEventLoop(relayID: relay.id, connection: connection)
            // Recover every open session on this relay after a (re)connect: the
            // transcript (get_entries) + panels (session_sync). Idempotent, so a
            // first connect where nothing is open yet is a no-op.
            for session in openSessions.values where session.relayID == relay.id {
                await requestReconstruction(session, connection: connection)
            }
        } catch {
            relayHealth[relay.id] = .failed(String(describing: error))
            scheduleReconnect(relay)
        }
    }

    private func startEventLoop(relayID: UUID, connection: RelayConnection) {
        Task { @MainActor in
            let stream = await connection.events()
            for await frame in stream {
                handle(frame: frame, relayID: relayID)
            }
            // Stream ended = socket dropped. Only retry if the relay is still
            // known and we didn't tear it down deliberately (health cleared).
            guard relayHealth[relayID] != nil,
                  let relay = mesh.config.relays.first(where: { $0.id == relayID }) else { return }
            relayHealth[relayID] = .offline
            connections[relayID] = nil
            scheduleReconnect(relay)
        }
    }

    /// Retry a relay with exponential backoff (1s→…→30s), replacing any
    /// pending timer for it. `bootstrap`/`connect` reset the attempt counter.
    private func scheduleReconnect(_ relay: RelayConfig) {
        let attempt = reconnectAttempts[relay.id] ?? 0
        reconnectAttempts[relay.id] = attempt + 1
        let delay = min(Self.reconnectBaseDelay * pow(2, Double(attempt)), Self.reconnectMaxDelay)
        reconnectTasks[relay.id]?.cancel()
        reconnectTasks[relay.id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self,
                  self.mesh.config.relays.contains(where: { $0.id == relay.id }) else { return }
            await self.connect(relay)
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
    private func requestReconstruction(_ session: LiveSession, connection: RelayConnection) async {
        let since = envelopeReducers[session.id]?.leafId
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

    /// Ask the paired machine to spawn a NEW pi session (`session_launch`). Only
    /// meaningful when the pi advertised the `remote_launch` capability; the
    /// launched session appears via the normal room-announce discovery.
    public func launchSession(cwd: String?, name: String?, session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        // No mode: the machine's `launch.backend` config decides the backend.
        try? await connection.send(
            .sessionLaunch(id: UUID().uuidString, mode: nil,
                           cwd: (trimmedCwd?.isEmpty ?? true) ? nil : trimmedCwd,
                           name: (trimmedName?.isEmpty ?? true) ? nil : trimmedName),
            toPeer: session.peerEPK, room: session.roomID)
    }

    // MARK: - Idle-machine (presence daemon) control

    /// The MACHINE-caps store key: relay + canonical epk. Daemon caps are a
    /// MACHINE property, NOT associated with a room (design 01M1813Q) — the
    /// control room is only the transport address used to reach the daemon.
    func machineCapsKey(relayID: UUID, epk: String) -> String {
        "\(relayID.uuidString):\(Base64.canonicalKey(epk) ?? epk)"
    }

    /// Daemon/machine caps for a paired machine, if we've pulled them.
    public func daemonPresence(for machine: PairedMachine) -> DaemonPresence? {
        daemonPresence[machineCapsKey(relayID: machine.relayID, epk: machine.epk)]
    }

    /// True when the machine's presence daemon advertised `cap` (e.g.
    /// `remote_launch`). Gates the idle-machine launch affordance.
    public func daemonSupports(_ cap: String, machine: PairedMachine) -> Bool {
        daemonPresence(for: machine)?.supports(cap) ?? false
    }

    /// Pull a machine's daemon caps: derive its control room and send a
    /// `presence_status` request there (design 01M1813Q). The daemon, if up,
    /// replies with { caps, hostname, backend } into the `daemonPresence` store.
    public func requestDaemonStatus(machine: PairedMachine) async {
        guard let connection = connections[machine.relayID],
              let room = Base64.deriveControlRoom(epk: machine.epk) else { return }
        try? await connection.send(.presenceStatus(id: UUID().uuidString),
                                   toPeer: machine.epk, room: room)
    }

    /// Launch a session on an IDLE machine (no live session needed): send
    /// `session_launch` to the machine's control room, where the presence daemon
    /// spawns it. The new session then appears via the normal room-announce
    /// discovery. The machine's `launch.backend` config decides the backend.
    public func launchOnMachine(cwd: String?, name: String?, machine: PairedMachine) async {
        guard let connection = connections[machine.relayID],
              let room = Base64.deriveControlRoom(epk: machine.epk) else { return }
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        try? await connection.send(
            .sessionLaunch(id: UUID().uuidString, mode: nil,
                           cwd: (trimmedCwd?.isEmpty ?? true) ? nil : trimmedCwd,
                           name: (trimmedName?.isEmpty ?? true) ? nil : trimmedName),
            toPeer: machine.epk, room: room)
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

    public func markPanelViewed(_ panelKey: String, session: LiveSession) {
        panels[session.id]?[panelKey]?.changed = false
        openPanel = "\(session.id):\(panelKey)"
    }

    public func closePanel() { openPanel = nil }

    public func panels(for session: LiveSession) -> [PanelState] {
        (panels[session.id] ?? [:]).values.sorted { $0.key < $1.key }
    }

    // MARK: - Interactive prompts (extension_ui)

    /// Reply to the pending prompt for a session and clear it.
    public func respondToPrompt(_ response: ExtensionUiResponse, session: LiveSession) async {
        prompts[session.id] = nil
        guard let connection = connections[session.relayID] else { return }
        // Envelope-only: the fork routes the extension_ui_response to the ui
        // bridge from the rpc path.
        try? await connection.send(.extensionUiResponse(response),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    // MARK: - Scroll restore

    /// Remembered bottom-most visible STABLE row id for a session, or nil.
    public func rememberedScroll(session: LiveSession) -> String? {
        lastViewedScroll[session.id]
    }

    /// Record the bottom-most visible STABLE row id as the user scrolls
    /// (design 01M1B9F6).
    public func rememberScroll(id: String, session: LiveSession) {
        guard lastViewedScroll[session.id] != id else { return }
        lastViewedScroll[session.id] = id
    }

    private func persistLastViewedScroll() {
        guard let data = try? JSONEncoder().encode(lastViewedScroll) else { return }
        UserDefaults.standard.set(data, forKey: Self.lastViewedScrollKey)
    }

    /// Drop a dropped/ended session's remembered scroll (didSet re-persists, so
    /// the on-disk copy prunes too) — otherwise it accumulates as rooms end.
    func forgetSession(key: String) {
        lastViewedScroll[key] = nil
        // Flush immediately — the didSet only schedules a debounced write.
        scrollPersistTask?.cancel()
        persistLastViewedScroll()
    }

    // MARK: - Pairing

    /// Pair on a dedicated short-lived connection (keeps the persistent event
    /// loop's channel uncontended), then persist the machine and re-subscribe.
    public func pair(relay: RelayConfig, invite: PairingInvite, deviceName: String) async throws {
        guard let owner, let url = relay.webSocketURL else { return }
        let channel = URLSessionWebSocketChannel(url: url)
        let pairingConnection = RelayConnection(channel: channel, identity: owner)
        try await pairingConnection.authenticate()
        let result: PairResult
        do {
            result = try await withThrowingTaskGroup(of: PairResult.self) { group in
                group.addTask { try await pairingConnection.pair(invite: invite, deviceName: deviceName) }
                group.addTask {
                    try await Task.sleep(nanoseconds: 15_000_000_000)
                    throw RelayConnection.PairingError.unexpected(
                        "No response from the machine. Is Pi running with un-bien "
                        + "attached to this relay, and the code still valid?")
                }
                let first = try await group.next()!
                group.cancelAll()
                return first
            }
        } catch {
            await pairingConnection.close()
            throw error
        }
        await pairingConnection.close()

        mesh.upsertMachine(PairedMachine(
            epk: invite.epk, relayID: relay.id, nickname: nil,
            hostname: result.hostname, harnessName: result.harness?.name))

        if let connection = connections[relay.id] {
            let peers = mesh.config.machines(onRelay: relay.id).map(\.epk)
            try? await connection.subscribe(peers: peers)
        }
    }

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
