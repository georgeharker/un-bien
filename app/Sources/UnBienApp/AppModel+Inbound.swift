import Foundation
import os
import UnBienCore

// Inbound routing helpers split out of AppModel.swift (its 1000-line cap):
// the rpc-command RESPONSE router and the panel decode path. Both act on the
// per-session state AppModel owns (availableModels / currentModel / panels),
// keyed by the pi-sessionId composite key — same keying as AppModel's
// envelope handler, which calls in.

private let log = Logger(subsystem: "un-bien", category: "relay")

extension AppModel {
    /// Resume a continuation parked under this response's request id (the
    /// reply half of `sendAwaitingReply`). Called for EVERY rpc response BEFORE
    /// `handleRpcResponse` — correlation is by id, side effects by command.
    func resumeAwaitedReply(_ rpc: JSONValue) {
        if let replyID = rpc["id"]?.stringValue,
           let parked = pendingRpcReplies.removeValue(forKey: replyID) {
            parked.resume(returning: rpc)
        }
    }

    /// Await ONE rpc command response (request/reply correlation, plan
    /// 01M1A39Y4G): park a continuation under `reqID`, send, and resume when the
    /// matching `{type:"response", id}` frame lands in handle(frame:) — or on
    /// timeout / send failure, so a dead session can't leak the continuation.
    /// Returns the FULL response frame (nil when no reply landed) — callers
    /// check `success` themselves. AppModel is @MainActor, so the map + both
    /// resume paths are race-free (whichever removeValue wins, the other no-ops).
    func sendAwaitingReply(_ message: ClientMessage, reqID: String,
                           to session: LiveSession, over connection: RelayConnection,
                           timeout: TimeInterval = 5) async -> JSONValue? {
        await withCheckedContinuation { continuation in
            pendingRpcReplies[reqID] = continuation
            // Timeout backstop: a dropped/dead session never answers.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                if let parked = self?.pendingRpcReplies.removeValue(forKey: reqID) {
                    parked.resume(returning: nil)
                }
            }
            Task { @MainActor [weak self] in
                do {
                    try await connection.send(message, toPeer: session.peerEPK,
                                               room: session.roomID)
                } catch {
                    if let parked = self?.pendingRpcReplies.removeValue(forKey: reqID) {
                        parked.resume(returning: nil)
                    }
                }
            }
        }
    }

    /// App-side effects of an rpc command RESPONSE envelope
    /// (`{type:"response", command, id, success, data?, error?}`). One place per
    /// command, so adding a future response handler is a single case — responses
    /// used to be handled ad-hoc (or not at all, which is why the model picker
    /// went silently empty when `list_models` became `get_available_models`).
    /// Failures LOG the extension's error text instead of vanishing — a
    /// `set_model` "not in registry" rejection is now visible, not just ignored.
    func handleRpcResponse(_ rpc: JSONValue, key: String) {
        let command = rpc["command"]?.stringValue ?? ""
        guard rpc["success"]?.boolValue ?? false else {
            let detail = rpc["error"]?.stringValue ?? "?"
            log.error("rpc response \(command, privacy: .public) failed: \(detail, privacy: .public)")
            return
        }
        switch command {
        case "get_available_models":
            // data: { models: [WireModel], current?: WireModel }. Synthesize the
            // stock models_list frame (same JSON shapes) and reuse its decoder so
            // the roster decode stays single-sourced with the retired stock path.
            var frame: [String: JSONValue] = [
                "type": .string("models_list"),
                "in_reply_to": .string(rpc["id"]?.stringValue ?? ""),
                "models": rpc["data"]?["models"] ?? .array([]),
            ]
            if let current = rpc["data"]?["current"] { frame["current"] = current }
            if let data = try? JSONEncoder().encode(JSONValue.object(frame)),
               let line = String(data: data, encoding: .utf8),
               let decoded = try? Codec.decodeServer(line),
               case let .modelsList(_, models, current) = decoded {
                availableModels[key] = models
                if let current { currentModel[key] = current }
            }
        case "set_model":
            // data: the newly-set model (WireModel) — authoritative, replaces the
            // optimistic pick setModel(_:session:) made before sending.
            if let data = rpc["data"],
               let encoded = try? JSONEncoder().encode(data),
               let model = try? JSONDecoder().decode(WireModel.self, from: encoded) {
                currentModel[key] = model
            }
        default:
            break // transcript-relevant responses are the reducer's; unknown commands are forward-compat no-ops
        }
    }

    // Only reached from the envelope PANEL path: {evt channel:"panel"} decodes
    // to a stock `panel_update` frame and routes here. All other stock session
    // frames are gone from the fork (E1–E7), so no general receive fallback.
    func route(_ message: ServerMessage, relayID: UUID, peer: String, sessionID: String) {
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
}
