import Foundation

/// One authenticated connection to a single relay (DESIGN §6). Opens the
/// WebSocket, runs the Ed25519 `hello`/`challenge`/`auth` handshake with the
/// Owner identity, then exposes inbound frames as an `AsyncStream`.
///
/// The app connects on `room_id: "main"` (its own control channel); routed
/// application traffic to a Pi carries the Pi's room in each ``RoutedEnvelope``.
public actor RelayConnection {
    public enum ConnectionError: Error, Equatable {
        case handshakeTimeout
        case rejected(code: String?, message: String?)
        case unexpectedFrame(String)
    }

    private let channel: WebSocketChannel
    private let identity: Ed25519Identity
    private let appRoomID: String
    private var eventContinuation: AsyncStream<InboundFrame>.Continuation?

    public init(channel: WebSocketChannel, identity: Ed25519Identity, appRoomID: String = "main") {
        self.channel = channel
        self.identity = identity
        self.appRoomID = appRoomID
    }

    /// Run the handshake. Sends `hello`, awaits `challenge`, replies `auth`.
    /// The relay starts routing silently after `auth` (no explicit ack).
    public func authenticate() async throws {
        let hello = RelayControlOut.hello(pubkey: identity.publicKeyBase64, roomID: appRoomID)
        try await channel.send(encode(hello))

        let firstLine = try await channel.receive()
        let frame = try InboundFrame.parse(firstLine)
        guard case let .control(event) = frame else {
            throw ConnectionError.unexpectedFrame(firstLine)
        }
        switch event {
        case let .challenge(nonce):
            guard let nonceBytes = Base64.decodeTolerant(nonce) else {
                throw ConnectionError.unexpectedFrame(firstLine)
            }
            let sig = try identity.sign(nonceBytes)
            try await channel.send(encode(RelayControlOut.auth(sig: Base64.standard(sig))))
        case let .error(code, message):
            throw ConnectionError.rejected(code: code, message: message)
        default:
            throw ConnectionError.unexpectedFrame(firstLine)
        }
    }

    /// Inbound frames (routed application messages + relay control events),
    /// starting a background receive loop. Call after ``authenticate()``.
    public func events() -> AsyncStream<InboundFrame> {
        AsyncStream { continuation in
            self.eventContinuation = continuation
            Task { await self.receiveLoop() }
            continuation.onTermination = { [weak self] _ in
                Task { await self?.finishStream() }
            }
        }
    }

    /// Subscribe to presence + rooms for a set of peers, then request a
    /// snapshot — the sequence the Flutter app runs post-auth.
    public func subscribe(peers: [String]) async throws {
        try await channel.send(encode(RelayControlOut.subscribePresence(peers: peers)))
        try await channel.send(encode(RelayControlOut.subscribeRooms(peers: peers)))
        try await channel.send(encode(RelayControlOut.presenceCheck(peers: peers)))
        try await channel.send(encode(RelayControlOut.roomsCheck(peers: peers)))
    }

    /// Route a ``ClientMessage`` to a Pi peer/room via a ``RoutedEnvelope``.
    public func send(_ message: ClientMessage, toPeer peer: String, room: String) async throws {
        let envelope = try RoutedEnvelope(peer: peer, room: room, message: message)
        try await channel.send(encode(envelope))
    }

    /// Route an rpc-envelope (`{rpc|evt}`) to a Pi peer/room. Stamps the wrapper
    /// kind (`type:"env"`) + timestamp, mirroring the fork's outbound choke.
    public func sendEnvelope(_ message: EnvelopeMessage, toPeer peer: String, room: String) async throws {
        let stamped = EnvelopeMessage(
            type: message.type ?? "env",
            ts: message.ts ?? Date().timeIntervalSince1970 * 1000,
            caps: message.caps, rpc: message.rpc, evt: message.evt)
        let routed = try RoutedEnvelope(peer: peer, room: room, envelope: stamped)
        try await channel.send(encode(routed))
    }

    /// Send a bare relay-control frame.
    public func sendControl(_ control: RelayControlOut) async throws {
        try await channel.send(encode(control))
    }

    public func close() {
        channel.close()
        finishStream()
    }

    /// Read and parse the next frame directly from the socket. Used by the
    /// handshake and pairing, before the ``events()`` loop owns the channel.
    /// Skips frames that fail to parse.
    func nextFrame() async throws -> InboundFrame {
        while true {
            let line = try await channel.receive()
            if let frame = try? InboundFrame.parse(line) { return frame }
        }
    }

    // MARK: - Private

    private func receiveLoop() async {
        while true {
            do {
                let line = try await channel.receive()
                guard let frame = try? InboundFrame.parse(line) else { continue }
                eventContinuation?.yield(frame)
            } catch {
                finishStream()
                return
            }
        }
    }

    private func finishStream() {
        eventContinuation?.finish()
        eventContinuation = nil
    }

    private func encode(_ value: some Encodable) -> String {
        // Control/envelope encoders never fail for these fixed shapes.
        let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
