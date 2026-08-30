import Foundation
import SwiftUI
import UnBienCore
import os

public enum RelayHealth: Equatable, Sendable {
    case connecting, online, offline
    case failed(String)
}

/// A live session (Pi room) discovered on a relay via control frames.
public struct LiveSession: Identifiable, Equatable, Hashable, Sendable {
    public let relayID: UUID
    public let peerEPK: String
    /// Relay room id — mesh/relay ROUTING only (addressing frames to this
    /// session). NOT the identity.
    public let roomID: String
    /// The pi sessionId — the session IDENTITY (wire identity). All per-session
    /// state keys on this, never on roomID.
    public let sessionID: String
    public var name: String
    public var cwd: String?
    public var model: String?
    /// Parent pi sessionId when this is a subagent child (from room_meta); the
    /// app nests + associates by this pi id.
    public var parentSessionID: String?
    /// Supplementary relay metadata — kept, but NOT logic keys.
    public var parentRoomID: String?
    public var subagentID: String?
    /// Subagent lifecycle status (done/failed/in_progress/pending), PULLED over
    /// this session's own connection via `get_session_info` (design 01M18PCM) —
    /// not room_meta. nil until the pull answers.
    public var status: String? = nil

    /// Identity = pi sessionId, NOT the routing roomId.
    public var id: String { "\(relayID.uuidString):\(peerEPK):\(sessionID)" }
    public var isSubagent: Bool { parentSessionID != nil }
}

/// Daemon/machine status pulled via a `presence_status` request (design
/// 01M1813Q) — an idle machine's launch capabilities + configured backend,
/// kept SEPARATE from per-session `capabilities` (there is no session here).
public struct DaemonPresence: Equatable, Sendable {
    public var caps: Set<String>
    public var hostname: String?
    public var backend: String?
    public init(caps: Set<String>, hostname: String?, backend: String?) {
        self.caps = caps
        self.hostname = hostname
        self.backend = backend
    }
    public func supports(_ cap: String) -> Bool { caps.contains(cap) }
}

/// A named side-panel (plan, subagents, …) mirrored from a cooperating event
/// source, surfaced as a top-bar item that badges when it changes.
public struct PanelState: Identifiable, Equatable, Sendable {
    public let key: String
    public var title: String
    public var icon: String?
    public var data: JSONValue
    /// True since the last update; cleared when the user opens the panel.
    public var changed: Bool
    public var id: String { key }
}

/// A pairing invite that arrived via the `unbien://` URL scheme (system Camera
/// or an external link) and is awaiting a relay choice. The QR carries no relay
/// (DESIGN: `r` dropped), so the deep-link flow must pick one.
public struct PendingPairing: Identifiable {
    public let id = UUID()
    public let invite: PairingInvite
    public init(invite: PairingInvite) { self.invite = invite }
}

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
    private var envelopeReducers: [String: EnvelopeReducer] = [:]
    /// Pending interactive prompt per session (extension_ui_request).
    @Published public var prompts: [String: ExtensionUiRequest] = [:]
    /// Pending queued follow-up messages per session (pi-native `queue_update`).
    @Published public var queued: [String: [QueuedMessageItem]] = [:]
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
    private var connections: [UUID: RelayConnection] = [:]
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
    /// Backstop grace for an UNCONSUMED optimistic queued chip (design 01M158S7).
    /// Long by design: consumption (user message_end) is the primary clear, so
    /// this only catches truly-stuck chips (text-normalization miss / dropped
    /// followUp). Erring long avoids clearing a message that is still legitimately
    /// queued through a slow turn. App-owned timing — independent of pi's
    /// (uncertain) re-timestamping. Tunable.
    private static let queuedChipGraceNanos: UInt64 = 5 * 60 * 1_000_000_000  // 5 min
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

    // MARK: - Inbound

    private func handle(frame: InboundFrame, relayID: UUID) {
        switch frame {
        case let .routed(envelope):
            // Envelope route ({rpc|evt}): a fork advertising `rpc_envelope`
            // carries the transcript as pi rpc frames inside `ct`. Discriminate
            // by SHAPE — a stock ServerMessage decodes to an EnvelopeMessage with
            // both fields nil. The reducer owns the transcript for this key;
            // stock session-content is suppressed in `route`.
            if let env = try? envelope.decodeEnvelope() {
                // Key per-session state on the pi sessionId (wire identity); the
                // outer room is mesh/relay ROUTING only.
                let key = "\(relayID.uuidString):\(envelope.peer):\(env.sessionId ?? envelope.room)"
                // Envelope-native capability handshake: learn caps here (not just
                // from stock session_history) so the {rpc|evt} route + stock
                // suppression turn on before any session content arrives.
                // Envelope-native capability handshake on the un-bien plane: a
                // {type:"ub", ub:{type:"hello", caps, sessionId}} frame the APP
                // acts on (learn caps + session identity) so the {rpc|evt} route
                // + stock suppression turn on before any session content arrives.
                if env.type == "ub", let ub = env.ub, ub["type"]?.stringValue == "hello" {
                    // Last NON-EMPTY wins: re-hellos (session_sync/attach, N clients)
                    // carry the pi's current caps; a legit change is still a
                    // non-empty set. But an empty/degraded hello must NOT clobber a
                    // good set — that silently gates off thinking/models/panels.
                    let caps = ub["caps"]?.arrayValue?.compactMap { $0.stringValue }
                    if let caps, !caps.isEmpty {
                        capabilities[key] = Set(caps)
                    } else if capabilities[key] == nil {
                        capabilities[key] = []
                    }
                    // The key IS the pi sessionId now, so a replaced session is
                    // simply a NEW key with fresh state — no reset needed here.
                    if envelopeReducers[key] == nil { envelopeReducers[key] = EnvelopeReducer() }
                    return
                }
                // Daemon caps PULL response (design 01M1813Q): a DAEMON-SPECIFIC
                // {type:"presence_status", caps, hostname, backend} frame. Store
                // machine/daemon status SEPARATELY from per-session capabilities
                // (this describes an idle machine, not a session) — do NOT fold
                // it into the transcript reducer. Keyed by the control-room key.
                if env.type == "ub", let ub = env.ub,
                   ub["type"]?.stringValue == "presence_status" {
                    let caps = ub["caps"]?.arrayValue?.compactMap { $0.stringValue } ?? []
                    // MACHINE-caps entry: key by the MACHINE (relay + canonical
                    // epk), NOT the control room. The room is only transport.
                    let mkey = machineCapsKey(relayID: relayID, epk: envelope.peer)
                    daemonPresence[mkey] = DaemonPresence(
                        caps: Set(caps),
                        hostname: ub["hostname"]?.stringValue,
                        backend: ub["backend"]?.stringValue)
                    return
                }
                // Response to a `get_session_info` PULL: a subagent reporting its
                // own lifecycle status over its connection (design 01M18PCM). Set
                // it on the child LiveSession, keyed by the child's pi sessionId,
                // so the home-row checkmark reads it WITHOUT the parent's panel.
                if env.type == "ub", let ub = env.ub,
                   ub["type"]?.stringValue == "session_info" {
                    if var s = sessions[key] {
                        s.status = ub["status"]?.stringValue
                        sessions[key] = s
                    }
                    return
                }
                // Other un-bien-plane frames (the session_sync_end terminator):
                // fold via the reducer as a frame — its inner `.type` drives
                // applyRPC, exactly like an rpc-plane frame.
                if env.type == "ub", let ub = env.ub {
                    var reducer = envelopeReducers[key] ?? EnvelopeReducer()
                    reducer.apply(EnvelopeMessage(rpc: ub))
                    envelopeReducers[key] = reducer
                    transcripts[key] = reducer.session
                    return
                }
                if env.rpc != nil || env.evt != nil {
                    var reducer = envelopeReducers[key] ?? EnvelopeReducer()
                    reducer.apply(env)
                    envelopeReducers[key] = reducer
                    transcripts[key] = reducer.session
                    // Panels are envelope-only: {evt channel:"panel"} carries a
                    // panel_update; decode it with the stock decoder and route it
                    // into the panel store (reuses PanelState + the panel UI).
                    if let evt = env.evt, evt.channel == "panel",
                       let pdata = try? JSONEncoder().encode(evt.data),
                       let pline = String(data: pdata, encoding: .utf8),
                       let pmsg = try? Codec.decodeServer(pline) {
                        route(pmsg, relayID: relayID, peer: envelope.peer,
                              sessionID: env.sessionId ?? envelope.room)
                    }
                    // extension_ui is envelope-only: the {rpc} extension_ui_request
                    // frame is the same JSON as the stock ServerMessage, so reuse
                    // the stock decoder to surface it in the existing prompt UI.
                    if let rpc = env.rpc, rpc["type"]?.stringValue == "extension_ui_request",
                       let data = try? JSONEncoder().encode(rpc),
                       let line = String(data: data, encoding: .utf8),
                       let decoded = try? Codec.decodeServer(line),
                       case let .extensionUiRequest(request) = decoded {
                        prompts[key] = request
                    }
                    // models_list is envelope-only: the {rpc} models_list frame
                    // is the same JSON as the stock ServerMessage, so reuse the
                    // stock decoder to update the per-session model catalog.
                    if let rpc = env.rpc, rpc["type"]?.stringValue == "models_list",
                       let data = try? JSONEncoder().encode(rpc),
                       let line = String(data: data, encoding: .utf8),
                       let decoded = try? Codec.decodeServer(line),
                       case let .modelsList(_, models, current) = decoded {
                        availableModels[key] = models
                        if let current { currentModel[key] = current }
                    }
                    // Queue display is APP-OWNED. pi never delivers queue_update
                    // to extensions — it's routed only to the host subscribe stream,
                    // never to pi.on / the ExtensionAPI (which exposes just
                    // hasPendingMessages():Bool, no queue text) — so the fork can't
                    // send us a queue snapshot. Instead: an optimistic pending chip
                    // on Queue submit, RESOLVED when the MODEL consumes the message.
                    // The model "saw the post" when pi dequeues + runs it, which
                    // surfaces as a user message_end here; correlate by TEXT only
                    // (timestamp / send-id don't persist) and clear that chip. The
                    // queueMessage timeout is the backstop. Design 01M158S7.
                    if let rpc = env.rpc, rpc["type"]?.stringValue == "message_end",
                       rpc["message"]?["role"]?.stringValue == "user" {
                        let text = rpc["message"]?["content"]?.joinedText() ?? ""
                        if !text.isEmpty {
                            let norm = text.trimmingCharacters(in: .whitespacesAndNewlines)
                            // ONE consumption clears ONE pending chip. If the same
                            // text was queued twice, each run clears the FIRST
                            // (oldest / FIFO — pi delivers in order) match, not all
                            // identical-in-flight copies.
                            if let idx = queued[key]?.firstIndex(where: {
                                $0.pending && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == norm
                            }) {
                                queued[key]?.remove(at: idx)
                            }
                        }
                    }
                    return
                }
            }
        case let .control(event):
            handle(control: event, relayID: relayID)
        }
    }

    // Only reached from the envelope PANEL path: {evt channel:"panel"} decodes
    // to a stock `panel_update` frame and routes here. All other stock session
    // frames are gone from the fork (E1–E7), so no general receive fallback.
    private func route(_ message: ServerMessage, relayID: UUID, peer: String, sessionID: String) {
        let key = "\(relayID.uuidString):\(peer):\(sessionID)"
        switch message {
        case let .panelUpdate(panelKey, title, icon, data):
            let wasOpen = panels[key]?[panelKey]?.changed == false && openPanel == "\(key):\(panelKey)"
            var forSession = panels[key] ?? [:]
            forSession[panelKey] = PanelState(key: panelKey, title: title, icon: icon,
                                              data: data, changed: !wasOpen)
            panels[key] = forSession
        default:
            break
        }
    }

    private func handle(control event: RelayControlIn, relayID: UUID) {
        switch event {
        case let .rooms(peer, rooms):
            // Authoritative per-peer snapshot (rooms_check on subscribe): RECONCILE,
            // don't just add. Drop any session for this (relay, peer) whose room
            // isn't in the snapshot — it ended while we were disconnected/backgrounded
            // (missed roomEnded); add-only left those as ghosts ("old chats in the
            // mix"). Then upsert the live ones. Scoped to this peer, so other
            // machines' sessions are untouched. See design 01M18AK9.
            // Sessions are keyed by pi sessionId now, so match the snapshot on the
            // LiveSession.roomID FIELD (routing) — NOT by parsing the key (which is
            // the sessionId). Parsing the key would treat every sessionId as an
            // unknown room and purge all live sessions.
            let liveRoomIDs = Set(rooms.map(\.roomID))
            // Observability: rooms in the snapshot we didn't already have live
            // are room_announced pushes we missed — on first connect this is the
            // initial load, on a manual refresh a non-zero count means a push
            // was dropped.
            let knownRoomIDs = Set(sessions.values
                .filter { $0.relayID == relayID && $0.peerEPK == peer }
                .map(\.roomID))
            let recovered = liveRoomIDs.subtracting(knownRoomIDs).count
            if recovered > 0 {
                log.info("rooms_check recovered \(recovered, privacy: .public) not-live room(s) for peer \(String(peer.prefix(8)), privacy: .public) (initial load or missed room_announced)")
            }
            for (key, session) in sessions
            where session.relayID == relayID && session.peerEPK == peer
            && !liveRoomIDs.contains(session.roomID) {
                sessions[key] = nil
            }
            for room in rooms { upsertSession(relayID: relayID, peer: peer, room: room) }
        case let .roomAnnounced(peer, room):
            upsertSession(relayID: relayID, peer: peer, room: room)
        case let .roomEnded(peer, roomID, _):
            if let k = sessionKey(relayID: relayID, peer: peer, roomID: roomID) {
                sessions[k] = nil
                forgetSession(key: k)
            }
        case let .roomMetaUpdated(peer, roomID, model, parent, parentSessionID):
            if let k = sessionKey(relayID: relayID, peer: peer, roomID: roomID),
               var session = sessions[k] {
                let wasSubagent = session.isSubagent
                if let model { session.model = model }
                // Last-info-wins parentage (present-only, never clears): a
                // LATE-advertised parent (in-process subagent, after attach)
                // re-nests the child. Reassigning sessions[k] re-derives
                // HomeView's top/kids grouping so the row moves in the hierarchy.
                if let parentSessionID { session.parentSessionID = parentSessionID }
                if let parent { session.parentRoomID = parent }
                sessions[k] = session
                // Newly a subagent -> pull its lifecycle status (mirror upsert).
                if !wasSubagent, session.isSubagent,
                   let connection = connections[relayID] {
                    let peerEPK = session.peerEPK
                    let rid = session.roomID
                    Task {
                        try? await connection.send(
                            .getSessionInfo(id: UUID().uuidString),
                            toPeer: peerEPK, room: rid)
                    }
                }
            }
        default:
            break
        }
    }

    private func upsertSession(relayID: UUID, peer: String, room: RoomInfo) {
        // The presence daemon's control room is not a chat session: it carries the
        // `is_daemon` cap, its roomId is the control-room derivation, and it has no
        // pi sessionId (a real session's wire identity).
        if room.caps?.contains("is_daemon") == true { return }
        if let control = Base64.deriveControlRoom(epk: peer), room.roomID == control { return }
        guard let sessionID = room.sessionID else { return }
        var session = LiveSession(relayID: relayID, peerEPK: peer, roomID: room.roomID,
                                  sessionID: sessionID,
                                  name: room.name, cwd: room.cwd, model: nil,
                                  parentSessionID: room.parentSessionID,
                                  parentRoomID: room.parent, subagentID: room.subagentID)
        // Carry a known status across re-announce (reconnect/relaunch replays
        // room_announced); the pull below refreshes it.
        session.status = sessions[session.id]?.status
        sessions[session.id] = session
        // PULL the subagent's lifecycle status over its OWN connection, re-issued
        // on every announce so it survives app relaunch (design 01M18PCM). The
        // send itself is what makes the child room attach + answer.
        if session.isSubagent, let connection = connections[relayID] {
            let peerEPK = session.peerEPK
            let roomID = session.roomID
            Task { try? await connection.send(.getSessionInfo(id: UUID().uuidString),
                                              toPeer: peerEPK, room: roomID) }
        }
    }

    /// The child subagent session for a subagents-panel record id, on the same
    /// machine as `parent`. nil until that subagent's room is announced.
    public func subagentSession(sessionID: String, under parent: LiveSession) -> LiveSession? {
        sessions.values.first {
            $0.sessionID == sessionID
                && $0.relayID == parent.relayID
                && $0.peerEPK == parent.peerEPK
        }
    }

    /// Resolve a relay (peer, roomID) ROUTING tuple to the pi-sessionId state key
    /// (LiveSession.id) — for control frames keyed by roomID.
    private func sessionKey(relayID: UUID, peer: String, roomID: String) -> String? {
        sessions.values.first {
            $0.relayID == relayID && $0.peerEPK == peer && $0.roomID == roomID
        }?.id
    }

    // MARK: - Session actions

    public func openSession(_ session: LiveSession, limit: Int = 100) async {
        openSessions[session.id] = session
        guard let connection = connections[session.relayID] else {
            return
        }
        await requestReconstruction(session, connection: connection)
        if availableModels[session.id] == nil {
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
    private func machineCapsKey(relayID: UUID, epk: String) -> String {
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

    // MARK: - Queued messages

    public func queueMessage(_ text: String, to session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        // Busy -> followUp QUEUES until the turn ends; show a BLUE pending chip.
        // Idle -> runs fresh (bubble is the feedback). Same trick as steer, just a
        // different color + it clears later (after the turn vs mid-turn).
        if activeTurnID(for: session) != nil {
            insertPendingChip(text, session: session, kind: "followUp")
        }
        // pi's native queue: a `prompt` with `followUp` behavior queues while the
        // turn streams (fresh turn when idle).
        try? await connection.send(
            .userMessage(id: UUID().uuidString, text: text, images: nil, streamingBehavior: "followUp"),
            toPeer: session.peerEPK, room: session.roomID)
    }

    /// Insert an OPTIMISTIC pending chip for a message submitted WHILE BUSY. Both
    /// steer (grey, interrupts mid-turn) and followUp (blue, after the turn) sit in
    /// a pi queue until the model consumes them, so show the text instead of
    /// letting it vanish from the composer. Cleared by consumption (user
    /// message_end, text-correlated in handle()); a long backstop timer drops a
    /// never-consumed chip (design 01M158S7).
    private func insertPendingChip(_ text: String, session: LiveSession, kind: String) {
        let tempID = "pending-\(UUID().uuidString)"
        var forSession = queued[session.id] ?? []
        forSession.append(QueuedMessageItem(id: tempID, text: text, editable: false,
                                            createdAt: Int(Date().timeIntervalSince1970 * 1000),
                                            pending: true, kind: kind))
        queued[session.id] = forSession
        let sid = session.id
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.queuedChipGraceNanos)
            self?.queued[sid]?.removeAll { $0.id == tempID && $0.pending }
        }
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
