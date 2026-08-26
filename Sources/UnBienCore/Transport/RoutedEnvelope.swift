import Foundation

/// The relay's outer routing envelope for application messages
/// (`{peer, room, ct}`). `ct` is base64(UTF-8 of a ``ClientMessage`` /
/// ``ServerMessage`` JSON body) — NOT encrypted in this protocol revision.
///
/// - `peer`: destination Pi's Ed25519 public key, standard padded base64.
/// - `room`: the Pi-side room id (cwd session); `"main"` when unspecified.
public struct RoutedEnvelope: Codable, Equatable, Sendable {
    public let peer: String
    public let room: String
    public let ct: String

    public init(peer: String, room: String, ct: String) {
        self.peer = peer
        self.room = room
        self.ct = ct
    }

    /// Wrap a ``ClientMessage`` for a peer/room. Mirrors the Flutter app's
    /// `WsTransport.send` (`ct = base64(utf8(encodeClient(msg).trimRight()))`).
    public init(peer: String, room: String, message: ClientMessage) throws {
        let body = try Codec.encodeClientBody(message)
        self.init(peer: peer, room: room, ct: body.base64EncodedString())
    }

    /// Decode the carried ``ServerMessage`` from `ct`.
    public func decodeServer() throws -> ServerMessage {
        guard let data = Data(base64Encoded: ct),
              let line = String(data: data, encoding: .utf8) else {
            throw DecodeError.invalidMessage("ct not base64/UTF-8")
        }
        return try Codec.decodeServer(line)
    }
}
