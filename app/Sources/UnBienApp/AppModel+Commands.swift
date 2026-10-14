import Foundation
import UnBienCore

// Session COMMAND wrappers (model roster + thinking level + session_new /
// compact) carved from AppModel.swift (its 1000-line cap). Thin send-side
// helpers: each guards on the live connection, addresses the session's routing
// tuple, and leaves response handling to AppModel+Inbound (handleRpcResponse).
// State stays on AppModel; this extension only drives it.

extension AppModel {
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
}