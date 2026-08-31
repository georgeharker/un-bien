import Foundation
import UnBienCore

// Panel + interactive-prompt actions split out of AppModel.swift (its 1000-line
// cap): mark-viewed/close/roster for the named side-panels, and replies to
// pending extension_ui prompts. The `openPanel` / `panels` / `prompts` stores
// stay on AppModel; this extension only drives them.

extension AppModel {
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
}
