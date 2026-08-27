import Foundation
import SwiftUI
import UnBienCore

public enum RelayHealth: Equatable, Sendable {
    case connecting, online, offline
    case failed(String)
}

/// A live session (Pi room) discovered on a relay via control frames.
public struct LiveSession: Identifiable, Equatable, Hashable, Sendable {
    public let relayID: UUID
    public let peerEPK: String
    public let roomID: String
    public var name: String
    public var cwd: String?
    public var model: String?

    public var id: String { "\(relayID.uuidString):\(peerEPK):\(roomID)" }
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
    /// Last hello `sessionId` seen per key (relayID:peer:room). A change means the
    /// pi session was replaced (new/fork/reload) within the same room/cwd — used
    /// to reset stale state so a reused session name doesn't bleed old content.
    private var sessionIds: [String: String] = [:]
    /// Pending interactive prompt per session (extension_ui_request).
    @Published public var prompts: [String: ExtensionUiRequest] = [:]
    /// Pending queued follow-up messages per session (queued_message_state).
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

    /// The active theme palette for the selected `themeID`.
    public var theme: AppTheme { themeID.theme }
    /// Current typography (text scale + mono font) for environment injection.
    public var typography: Typography {
        Typography(textScale: textScale, monoFontName: monoFontName)
    }

    public let mesh: MeshStore
    private var identityStore: OwnerIdentityStore
    private var owner: Ed25519Identity?
    private var connections: [UUID: RelayConnection] = [:]
    /// Consecutive failed connect attempts per relay, for exponential backoff.
    private var reconnectAttempts: [UUID: Int] = [:]
    /// In-flight reconnect timers per relay, cancelled on remove/success.
    private var reconnectTasks: [UUID: Task<Void, Never>] = [:]

    private static let iCloudDefaultsKey = "com.georgeharker.un-bien.owner-key.icloud-sync"
    private static let themeKey = "com.georgeharker.un-bien.theme"
    private static let showThinkingKey = "com.georgeharker.un-bien.show-thinking"
    private static let textScaleKey = "com.georgeharker.un-bien.text-scale"
    private static let monoFontKey = "com.georgeharker.un-bien.mono-font"
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

    public func removeRelay(id: UUID) {
        reconnectTasks[id]?.cancel()
        reconnectTasks[id] = nil
        reconnectAttempts[id] = nil
        connections[id] = nil
        relayHealth[id] = nil
        sessions = sessions.filter { $0.value.relayID != id }
        mesh.removeRelay(id: id)
    }

    private func connectAll() async {
        for relay in mesh.config.relays { await connect(relay) }
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
            let key = "\(relayID.uuidString):\(envelope.peer):\(envelope.room)"
            // Envelope route ({rpc|evt}): a fork advertising `rpc_envelope`
            // carries the transcript as pi rpc frames inside `ct`. Discriminate
            // by SHAPE — a stock ServerMessage decodes to an EnvelopeMessage with
            // both fields nil. The reducer owns the transcript for this key;
            // stock session-content is suppressed in `route`.
            if let env = try? envelope.decodeEnvelope() {
                // Envelope-native capability handshake: learn caps here (not just
                // from stock session_history) so the {rpc|evt} route + stock
                // suppression turn on before any session content arrives.
                if env.type == "hello" {
                    capabilities[key] = Set(env.caps ?? [])
                    // Session replacement detection: the room (cwd) is stable, but a
                    // new pi sessionId here means a different session reused it. Reset
                    // so the prior transcript/panels/prompt don't leak in; a fresh
                    // session_sync + live frames rebuild the new one.
                    if let sid = env.sessionId, let prev = sessionIds[key], prev != sid {
                        transcripts[key] = nil
                        envelopeReducers[key] = nil
                        panels[key] = nil
                        prompts[key] = nil
                    }
                    if let sid = env.sessionId { sessionIds[key] = sid }
                    if envelopeReducers[key] == nil { envelopeReducers[key] = EnvelopeReducer() }
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
                        route(pmsg, relayID: relayID, peer: envelope.peer, room: envelope.room)
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
                    return
                }
            }
            do {
                let message = try envelope.decodeServer()
                print("[un-bien] routed peer=\(envelope.peer.suffix(6)) room=\(envelope.room) msg=\(message.debugTag)")
                route(message, relayID: relayID, peer: envelope.peer, room: envelope.room)
            } catch {
                print("[un-bien] routed DECODE FAIL: \(error) ct-line=\(envelope.ct.prefix(24))…")
            }
        case let .control(event):
            print("[un-bien] control \(event)")
            handle(control: event, relayID: relayID)
        }
    }

    private func route(_ message: ServerMessage, relayID: UUID, peer: String, room: String) {
        let key = "\(relayID.uuidString):\(peer):\(room)"
        switch message {
        case let .sessionHistory(_, _, _, _, _, _, caps):
            // Envelope route reconstructs the transcript via {rpc} replay (see the
            // hello handshake), so the stock history is IGNORED — it must not
            // clobber the replayed transcript. Caps come from the hello; keep the
            // stock caps only as a fallback when the hello hasn't landed.
            if capabilities[key] == nil { capabilities[key] = Set(caps ?? []) }
            return
        case let .extensionUiRequest(request):
            prompts[key] = request
            return
        case let .queuedMessageState(_, text, items):
            if let items { queued[key] = items } else if let text, !text.isEmpty {
                queued[key] = [QueuedMessageItem(id: "0", text: text, editable: true, createdAt: 0)]
            } else {
                queued[key] = []
            }
            return
        case let .modelsList(_, models, current):
            availableModels[key] = models
            if let current { currentModel[key] = current }
            return
        case let .panelUpdate(panelKey, title, icon, data):
            let wasOpen = panels[key]?[panelKey]?.changed == false && openPanel == "\(key):\(panelKey)"
            var forSession = panels[key] ?? [:]
            forSession[panelKey] = PanelState(key: panelKey, title: title, icon: icon,
                                              data: data, changed: !wasOpen)
            panels[key] = forSession
            return
        default:
            break
        }
        // On the envelope route the reducer owns this session's transcript
        // (see `handle`); drop stock session-content so the two don't
        // double-render during the transition.
        if capabilities[key]?.contains("rpc_envelope") == true { return }
        var state = transcripts[key] ?? SessionState()
        if state.apply(message) { transcripts[key] = state }
    }

    private func handle(control event: RelayControlIn, relayID: UUID) {
        switch event {
        case let .rooms(peer, rooms):
            for room in rooms { upsertSession(relayID: relayID, peer: peer, room: room) }
        case let .roomAnnounced(peer, room):
            upsertSession(relayID: relayID, peer: peer, room: room)
        case let .roomEnded(peer, roomID, _):
            sessions["\(relayID.uuidString):\(peer):\(roomID)"] = nil
        case let .roomMetaUpdated(peer, roomID, model):
            let key = "\(relayID.uuidString):\(peer):\(roomID)"
            if var session = sessions[key] { session.model = model; sessions[key] = session }
        default:
            break
        }
    }

    private func upsertSession(relayID: UUID, peer: String, room: RoomInfo) {
        let session = LiveSession(relayID: relayID, peerEPK: peer, roomID: room.roomID,
                                  name: room.name, cwd: room.cwd, model: nil)
        sessions[session.id] = session
    }

    // MARK: - Session actions

    public func openSession(_ session: LiveSession, limit: Int = 100) async {
        guard let connection = connections[session.relayID] else {
            print("[un-bien] openSession NO CONNECTION for relay \(session.relayID)")
            return
        }
        print("[un-bien] openSession key=\(session.id) sending session_sync to peer=\(session.peerEPK.suffix(6)) room=\(session.roomID)")
        // Envelope-native resume request (was stock session_sync): the fork
        // replies with a {rpc} history replay folded via applyRPC. Reuse the
        // stock encoder to build the frame, then send it inside an envelope.
        if let data = try? Codec.encodeClientBody(.sessionSync(id: UUID().uuidString, limit: limit)),
           let frame = try? JSONDecoder().decode(JSONValue.self, from: data) {
            try? await connection.sendEnvelope(EnvelopeMessage(rpc: frame),
                                               toPeer: session.peerEPK, room: session.roomID)
        }
        if availableModels[session.id] == nil {
            try? await connection.send(.listModels(id: UUID().uuidString),
                                       toPeer: session.peerEPK, room: session.roomID)
        }
    }

    public func sendMessage(_ text: String, to session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(
            .userMessage(id: UUID().uuidString, text: text, images: nil, streamingBehavior: nil),
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
    public func launchSession(mode: String, cwd: String?, name: String?, session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        try? await connection.send(
            .sessionLaunch(id: UUID().uuidString, mode: mode,
                           cwd: (trimmedCwd?.isEmpty ?? true) ? nil : trimmedCwd,
                           name: (trimmedName?.isEmpty ?? true) ? nil : trimmedName),
            toPeer: session.peerEPK, room: session.roomID)
    }

    public func setThinking(_ level: ThinkingLevel, session: LiveSession) async {
        thinkingLevel[session.id] = level
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(.thinkingSet(id: UUID().uuidString, level: level),
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
        // Envelope-only: reuse the stock encoder to build the extension_ui_response
        // frame, then send it inside an {rpc} envelope (the fork routes it to the
        // ui bridge from the rpc path).
        guard let data = try? Codec.encodeClientBody(.extensionUiResponse(response)),
              let frame = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
        try? await connection.sendEnvelope(EnvelopeMessage(rpc: frame),
                                           toPeer: session.peerEPK, room: session.roomID)
    }

    // MARK: - Queued messages

    public func queueMessage(_ text: String, to session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(.queuedMessageSet(id: UUID().uuidString, text: text),
                                   toPeer: session.peerEPK, room: session.roomID)
    }

    public func clearQueued(targetID: String?, session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        try? await connection.send(.queuedMessageClear(id: UUID().uuidString, targetID: targetID),
                                   toPeer: session.peerEPK, room: session.roomID)
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
                        "No response from the machine. Is Pi running with remote-pi "
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
                                  name: "Demo (\(turns) turns)", cwd: "/demo", model: "claude-opus-4-8")
        sessions[session.id] = session
        transcripts[session.id] = .demo(turns: turns)
    }
    #endif
}
