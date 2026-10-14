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
    /// Self-signed pairing allow-list push (federation v2 §3): a device
    /// advertises the owner it belongs to. `blob`/`sig` are base64 of the
    /// machine-signed canonical blob / Ed25519 signature — see
    /// RelayConnection.pushPairingSet.
    case pairingSet(blob: String, sig: String)

    enum CodingKeys: String, CodingKey {
        case type, pubkey, sig, peers, blob
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
        case let .pairingSet(blob, sig):
            try container.encode("pairing_set", forKey: .type)
            try container.encode(blob, forKey: .blob)
            try container.encode(sig, forKey: .sig)
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
    /// Subagent nesting (via the relay's `room_meta` passthrough): the parent
    /// (spawning) room id, and the subagent record id, when this room is a
    /// subagent child session. Both absent for a normal top-level session.
    public let parent: String?
    public let subagentID: String?
    /// Pi ids from room_meta (extension sends them): the room's OWN sessionId and
    /// its parent's sessionId (subagent child). The app keys + nests by these;
    /// room_id stays relay-routing only.
    public let sessionID: String?
    public let parentSessionID: String?
    /// Caps the room advertises via room_meta; the presence daemon stamps
    /// `is_daemon` so its control room is filtered from the session list.
    public let caps: [String]?
    /// Launch-correlation echo (launch auto-open): the launcher daemon spawns
    /// pi with `UNBIEN_LAUNCH_REQ = <request id>` and the extension echoes it
    /// in its room_meta. Lets the app deterministically match a
    /// `session_launch`/resume request to the room it created (same mechanism
    /// as the fork flow's `forked_from_req` echo). Absent on older
    /// daemons/extensions — the session then just surfaces via normal
    /// discovery.
    public let launchReq: String?
    /// If present, this session lives on a FEDERATED (remote) peer relay —
    /// surfaced by that relay's rooms_check. The value is the peer relay's
    /// name (e.g. "droplet"); absent = the session is local to this relay.
    /// Rendered as a monochrome server icon + host label on the Home row.
    public var peerRelay: String?

    enum CodingKeys: String, CodingKey {
        case roomID = "room_id"
        case name, cwd, caps
        case startedAt = "started_at"
        case parent
        case subagentID = "subagentId"
        case sessionID = "sessionId"
        case parentSessionID = "parentSessionId"
        case launchReq = "launchReq"
        case peerRelay = "peerRelay"
    }
}

/// One federated-machine entry from the relay's `federated_peer_list` push:
/// the machine's epk + peer relay name + its advertised rooms (with
/// `peerRelay` stamped on each so SessionRow renders the server icon).
public struct FederatedPeer: Codable, Equatable, Sendable {
    public let epk: String
    public let relayName: String
    public let rooms: [RoomInfo]
    enum CodingKeys: String, CodingKey {
        case epk, rooms
        case relayName = "relay_name"
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
    /// `peer` is set when the relay ATTRIBUTES the error to a target machine
    /// (e.g. a rooms_check refusal for an unpaired peer, design 01M1ZE43);
    /// nil for an unattributed/auth-time rejection.
    case error(code: String?, message: String?, peer: String?)
    case peerOnline(peer: String)
    case peerOffline(peer: String, sinceTs: Int?)
    case presence(states: [PresenceState])
    case rooms(peer: String, rooms: [RoomInfo])
    case federatedPeerList(peers: [FederatedPeer])
    case roomAnnounced(peer: String, room: RoomInfo)
    case roomEnded(peer: String, roomID: String, sinceTs: Int?)
    case roomMetaUpdated(
        peer: String, roomID: String, model: String?, name: String?,
        parent: String?, parentSessionID: String?)
}
