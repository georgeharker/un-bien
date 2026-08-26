import Foundation

/// The relay control layer — raw JSON frames the app exchanges with the relay
/// directly (never routed to a Pi). Distinct from application
/// ``ClientMessage``/``ServerMessage``, which travel inside a ``RoutedEnvelope``.

/// App → relay auth/control frames.
public enum RelayControlOut: Codable, Equatable, Sendable {
    case hello(pubkey: String, roomID: String)
    case auth(sig: String)
    case subscribePresence(peers: [String])
    case subscribeRooms(peers: [String])
    case unsubscribePresence(peers: [String])
    case unsubscribeRooms(peers: [String])
    case presenceCheck(peers: [String])
    case roomsCheck(peers: [String])

    enum CodingKeys: String, CodingKey {
        case type, pubkey, sig, peers
        case roomID = "room_id"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(pubkey, roomID):
            try container.encode("hello", forKey: .type)
            try container.encode(pubkey, forKey: .pubkey)
            try container.encode(roomID, forKey: .roomID)
        case let .auth(sig):
            try container.encode("auth", forKey: .type)
            try container.encode(sig, forKey: .sig)
        case let .subscribePresence(peers):
            try container.encode("subscribe_presence", forKey: .type)
            try container.encode(peers, forKey: .peers)
        case let .subscribeRooms(peers):
            try container.encode("subscribe_rooms", forKey: .type)
            try container.encode(peers, forKey: .peers)
        case let .unsubscribePresence(peers):
            try container.encode("unsubscribe_presence", forKey: .type)
            try container.encode(peers, forKey: .peers)
        case let .unsubscribeRooms(peers):
            try container.encode("unsubscribe_rooms", forKey: .type)
            try container.encode(peers, forKey: .peers)
        case let .presenceCheck(peers):
            try container.encode("presence_check", forKey: .type)
            try container.encode(peers, forKey: .peers)
        case let .roomsCheck(peers):
            try container.encode("rooms_check", forKey: .type)
            try container.encode(peers, forKey: .peers)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        func peers() throws -> [String] { try container.decode([String].self, forKey: .peers) }
        switch type {
        case "hello":
            self = .hello(pubkey: try container.decode(String.self, forKey: .pubkey),
                          roomID: try container.decode(String.self, forKey: .roomID))
        case "auth":
            self = .auth(sig: try container.decode(String.self, forKey: .sig))
        case "subscribe_presence": self = .subscribePresence(peers: try peers())
        case "subscribe_rooms": self = .subscribeRooms(peers: try peers())
        case "unsubscribe_presence": self = .unsubscribePresence(peers: try peers())
        case "unsubscribe_rooms": self = .unsubscribeRooms(peers: try peers())
        case "presence_check": self = .presenceCheck(peers: try peers())
        case "rooms_check": self = .roomsCheck(peers: try peers())
        default: throw DecodeError.unsupportedType(type)
        }
    }
}

/// One room announced by a peer (in `rooms` snapshots / `room_announced`).
public struct RoomInfo: Codable, Equatable, Sendable {
    public let roomID: String
    public let name: String
    public let cwd: String
    public let startedAt: Int

    enum CodingKeys: String, CodingKey {
        case roomID = "room_id"
        case name, cwd
        case startedAt = "started_at"
    }
}

public struct PresenceState: Codable, Equatable, Sendable {
    public let peer: String
    public let online: Bool
    public let sinceTs: Int?

    enum CodingKeys: String, CodingKey {
        case peer, online
        case sinceTs = "since_ts"
    }
}

/// Relay → app control events (auth challenge + presence/rooms fan-out).
public enum RelayControlIn: Equatable, Sendable {
    case challenge(nonce: String)
    case error(code: String?, message: String?)
    case peerOnline(peer: String)
    case peerOffline(peer: String, sinceTs: Int?)
    case presence(states: [PresenceState])
    case rooms(peer: String, rooms: [RoomInfo])
    case roomAnnounced(peer: String, room: RoomInfo)
    case roomEnded(peer: String, roomID: String, sinceTs: Int?)
    case roomMetaUpdated(peer: String, roomID: String, model: String?)
}
