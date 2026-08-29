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

    /// Route a ``ClientMessage`` to a Pi peer/room. The app's stock command frame
    /// is mapped at THIS single seam to pi's first-class rpc verb (rpc plane, pi
    /// acts) or an un-bien-owned frame (ub plane, extension acts) — so AppModel
    /// call sites stay unchanged. See the app->pi command taxonomy decision.
    public func send(_ message: ClientMessage, toPeer peer: String, room: String) async throws {
        let data = try Codec.encodeClientBody(message)
        let frame = try JSONDecoder().decode(JSONValue.self, from: data)
        let (plane, mapped) = Self.mapToWire(frame)
        switch plane {
        case .rpc:
            try await sendEnvelope(EnvelopeMessage(rpc: mapped), toPeer: peer, room: room)
        case .ub:
            try await sendEnvelope(EnvelopeMessage(ub: mapped), toPeer: peer, room: room)
        }
    }

    private enum WirePlane { case rpc, ub }

    /// Map a stock-encoded ``ClientMessage`` frame to its pi first-class rpc verb
    /// (rpc plane) or un-bien-owned frame (ub plane), per the command taxonomy.
    /// user_message->prompt, cancel->abort, model_set->set_model,
    /// thinking_set->set_thinking_level, list_models->get_available_models,
    /// session_compact->compact, session_new->new_session. The message queue is
    /// pi-native: a `prompt` with `streamingBehavior:"followUp"` queues (no
    /// bespoke queue verb). Field renames match pi's rpc contract (text->message,
    /// model_id->modelId, streaming_behavior->streamingBehavior). session_sync /
    /// extension_ui_response (+ ping/approve_tool) pass through unchanged on the
    /// rpc plane THIS wave; session_sync/session_launch move to the un plane with
    /// the fork's un-dispatcher (a later wave).
    private static func mapToWire(_ frame: JSONValue) -> (WirePlane, JSONValue) {
        guard var obj = frame.objectValue, let type = obj["type"]?.stringValue else {
            return (.rpc, frame)
        }
        func rename(_ from: String, _ to: String) {
            if let v = obj.removeValue(forKey: from) { obj[to] = v }
        }
        switch type {
        case "user_message":
            obj["type"] = .string("prompt")
            rename("text", "message")
            rename("streaming_behavior", "streamingBehavior")
            return (.rpc, .object(obj))
        case "cancel":
            obj["type"] = .string("abort")
            obj.removeValue(forKey: "target_id")
            return (.rpc, .object(obj))
        case "model_set":
            obj["type"] = .string("set_model")
            rename("model_id", "modelId")
            return (.rpc, .object(obj))
        case "thinking_set":
            obj["type"] = .string("set_thinking_level")
            return (.rpc, .object(obj))
        case "list_models":
            obj["type"] = .string("get_available_models")
            return (.rpc, .object(obj))
        case "session_compact":
            obj["type"] = .string("compact")
            return (.rpc, .object(obj))
        case "session_new":
            obj["type"] = .string("new_session")
            return (.rpc, .object(obj))
        case "session_sync", "session_launch":
            // un-bien's OWN protocol (reconstruction request / mesh remote-launch)
            // — the extension acts. The frame keeps its inner type verbatim.
            return (.ub, frame)
        default:
            // extension_ui_response (matches pi's SDK ui contract) / ping /
            // approve_tool: pass through on the rpc plane.
            return (.rpc, frame)
        }
    }

    /// Send a bare (non-enveloped) ``ClientMessage`` as a routed frame. ONLY for
    /// the pre-attach pairing handshake: the fork's auto-listener decodes a raw
    /// `pair_request` before the {rpc} route (and capability handshake) exist.
    public func sendStock(_ message: ClientMessage, toPeer peer: String, room: String) async throws {
        let envelope = try RoutedEnvelope(peer: peer, room: room, message: message)
        try await channel.send(encode(envelope))
    }

    /// Route an rpc-envelope (`{rpc|evt|ub}`) to a Pi peer/room. Stamps each
    /// plane's REAL wrapper type ("rpc"/"evt"/"ub", no legacy "env") + timestamp,
    /// mirroring the fork's outbound choke.
    public func sendEnvelope(_ message: EnvelopeMessage, toPeer peer: String, room: String) async throws {
        let stamped = EnvelopeMessage(
            type: message.type ?? (message.ub != nil ? "ub" : message.evt != nil ? "evt" : "rpc"),
            ts: message.ts ?? Date().timeIntervalSince1970 * 1000,
            protocolVersion: message.protocolVersion,
            rpc: message.rpc, evt: message.evt, ub: message.ub)
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
