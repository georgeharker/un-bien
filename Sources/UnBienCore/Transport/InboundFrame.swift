import Foundation

/// A single frame the relay pushes to the app. Either a routed application
/// message (`{peer, ct}` → ``RoutedEnvelope``) or a relay control event
/// (top-level `type`, no `ct` → ``RelayControlIn``). Mirrors the Flutter
/// `WsTransport` listener demux.
public enum InboundFrame: Equatable, Sendable {
    case routed(RoutedEnvelope)
    case control(RelayControlIn)

    /// Classify + parse one raw JSONL line from the relay socket.
    public static func parse(_ line: String) throws -> InboundFrame {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodeError.invalidMessage("not a JSON object")
        }
        if object["ct"] != nil, object["peer"] != nil {
            return .routed(try JSONDecoder().decode(RoutedEnvelope.self, from: data))
        }
        guard let type = object["type"] as? String else {
            throw DecodeError.invalidMessage("control frame missing 'type'")
        }
        return .control(try parseControl(type: type, object: object, data: data))
    }

    // swiftlint:disable:next cyclomatic_complexity
    private static func parseControl(type: String, object: [String: Any], data: Data) throws -> RelayControlIn {
        let decoder = JSONDecoder()
        func peer() throws -> String {
            guard let value = object["peer"] as? String else {
                throw DecodeError.invalidMessage("missing 'peer'")
            }
            return value
        }
        switch type {
        case "challenge":
            guard let nonce = object["nonce"] as? String else {
                throw DecodeError.invalidMessage("challenge missing 'nonce'")
            }
            return .challenge(nonce: nonce)
        case "error":
            return .error(code: object["code"] as? String, message: object["message"] as? String)
        case "peer_online":
            return .peerOnline(peer: try peer())
        case "peer_offline":
            return .peerOffline(peer: try peer(), sinceTs: object["since_ts"] as? Int)
        case "presence":
            let states = try decoder.decode(PresenceEnvelope.self, from: data).states
            return .presence(states: states)
        case "rooms":
            let value = try decoder.decode(RoomsEnvelope.self, from: data)
            return .rooms(peer: value.peer, rooms: value.rooms)
        case "room_announced":
            let room = try decoder.decode(RoomInfo.self, from: data)
            return .roomAnnounced(peer: try peer(), room: room)
        case "room_ended":
            guard let roomID = object["room_id"] as? String else {
                throw DecodeError.invalidMessage("room_ended missing 'room_id'")
            }
            return .roomEnded(peer: try peer(), roomID: roomID, sinceTs: object["since_ts"] as? Int)
        case "room_meta_updated":
            guard let roomID = object["room_id"] as? String else {
                throw DecodeError.invalidMessage("room_meta_updated missing 'room_id'")
            }
            let meta = object["meta"] as? [String: Any]
            return .roomMetaUpdated(peer: try peer(), roomID: roomID, model: meta?["model"] as? String)
        default:
            throw DecodeError.unsupportedType(type)
        }
    }

    private struct PresenceEnvelope: Decodable { let states: [PresenceState] }
    private struct RoomsEnvelope: Decodable { let peer: String; let rooms: [RoomInfo] }
}
