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

    public let mesh: MeshStore
    private var identityStore: OwnerIdentityStore
    private var owner: Ed25519Identity?
    private var connections: [UUID: RelayConnection] = [:]

    private static let iCloudDefaultsKey = "un-bien.owner-key.icloud-sync"

    public init(mesh: MeshStore = MeshStore(), identityStore: OwnerIdentityStore? = nil) {
        self.mesh = mesh
        let syncOn = UserDefaults.standard.object(forKey: Self.iCloudDefaultsKey) as? Bool ?? true
        self.syncsToICloud = syncOn
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
        relayHealth[relay.id] = .connecting
        let channel = URLSessionWebSocketChannel(url: url)
        let connection = RelayConnection(channel: channel, identity: owner)
        do {
            try await connection.authenticate()
            let peers = mesh.config.machines(onRelay: relay.id).map(\.epk)
            try await connection.subscribe(peers: peers)
            connections[relay.id] = connection
            relayHealth[relay.id] = .online
            startEventLoop(relayID: relay.id, connection: connection)
        } catch {
            relayHealth[relay.id] = .failed(String(describing: error))
        }
    }

    private func startEventLoop(relayID: UUID, connection: RelayConnection) {
        Task { @MainActor in
            let stream = await connection.events()
            for await frame in stream {
                handle(frame: frame, relayID: relayID)
            }
            if case .online = relayHealth[relayID] { relayHealth[relayID] = .offline }
        }
    }

    // MARK: - Inbound

    private func handle(frame: InboundFrame, relayID: UUID) {
        switch frame {
        case let .routed(envelope):
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
        case let .sessionHistory(_, startedAt, events, _, _):
            var state = SessionState()
            state.loadHistory(events, sessionStartedAt: startedAt)
            transcripts[key] = state
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
        try? await connection.send(.sessionSync(id: UUID().uuidString, limit: limit),
                                   toPeer: session.peerEPK, room: session.roomID)
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
        try? await connection.send(.extensionUiResponse(response),
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
}
