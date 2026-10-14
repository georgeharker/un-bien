import Foundation
import XCTest
@testable import UnBienCore

/// A scripted in-memory channel: yields queued inbound lines, records outbound.
private actor FakeChannel: WebSocketChannel {
    private var inbound: [String]
    private(set) var sent: [String] = []
    private var waiters: [CheckedContinuation<String, Error>] = []

    init(inbound: [String]) { self.inbound = inbound }

    func send(_ text: String) async throws { sent.append(text) }

    func receive() async throws -> String {
        if !inbound.isEmpty { return inbound.removeFirst() }
        return try await withCheckedThrowingContinuation { waiters.append($0) }
    }

    nonisolated func close() {}

    func ping(timeout: TimeInterval) async throws {
        // Fake channels never die silently — ping always succeeds. (The
        // ping-timeout path is exercised by the real URLSession channel.)
    }

    func push(_ line: String) {
        if !waiters.isEmpty { waiters.removeFirst().resume(returning: line) } else { inbound.append(line) }
    }

    func sentFrames() -> [String] { sent }
}

final class RelayConnectionTests: XCTestCase {
    func testHandshakeSignsChallengeNonce() async throws {
        let identity = Ed25519Identity()
        let nonce = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let challenge = #"{"type":"challenge","nonce":"\#(Base64.standard(nonce))"}"#
        let channel = FakeChannel(inbound: [challenge])
        let connection = RelayConnection(channel: channel, identity: identity)

        try await connection.authenticate()

        let sent = await channel.sentFrames()
        XCTAssertEqual(sent.count, 2)

        // Frame 0: hello with our standard-base64 pubkey and room_id "main".
        let hello = try JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as? [String: Any]
        XCTAssertEqual(hello?["type"] as? String, "hello")
        XCTAssertEqual(hello?["pubkey"] as? String, identity.publicKeyBase64)
        XCTAssertEqual(hello?["room_id"] as? String, "main")

        // Frame 1: auth signature that verifies over the DECODED nonce bytes.
        let auth = try JSONSerialization.jsonObject(with: Data(sent[1].utf8)) as? [String: Any]
        XCTAssertEqual(auth?["type"] as? String, "auth")
        let sig = try XCTUnwrap(Base64.decodeTolerant(try XCTUnwrap(auth?["sig"] as? String)))
        XCTAssertTrue(Ed25519.verify(signature: sig, message: nonce,
                                     publicKeyRaw: identity.publicKeyRaw))
    }

    func testRejectionSurfacesError() async throws {
        let channel = FakeChannel(inbound: [#"{"type":"error","code":"room_already_open"}"#])
        let connection = RelayConnection(channel: channel, identity: Ed25519Identity())
        do {
            try await connection.authenticate()
            XCTFail("expected rejection")
        } catch let RelayConnection.ConnectionError.rejected(code, _) {
            XCTAssertEqual(code, "room_already_open")
        }
    }

    /// Live smoke test — runs only when UNBIEN_RELAY is set. Proves the app
    /// identity can complete the real handshake against a running relay.
    func testLiveRelayHandshake() async throws {
        guard let raw = ProcessInfo.processInfo.environment["UNBIEN_RELAY"],
              let url = Self.wsURL(raw) else {
            throw XCTSkip("UNBIEN_RELAY not set")
        }
        let channel = URLSessionWebSocketChannel(url: url)
        let connection = RelayConnection(channel: channel, identity: Ed25519Identity())
        try await connection.authenticate()
        // No throw == relay accepted hello, issued a challenge, and took our
        // auth without closing. Give the socket a beat, then close cleanly.
        try await Task.sleep(nanoseconds: 300_000_000)
        await connection.close()
    }

    /// Live pairing probe — runs only when PROBE_* env vars are set. Sends a
    /// real pair_request to a machine's epk/room and prints the outcome. An
    /// expired/unknown token yields a pair_error (routing OK); a timeout means
    /// the Pi isn't reachable on that room. Env: PROBE_RELAY, PROBE_EPK,
    /// PROBE_ROOM, PROBE_TOKEN.
    func testLivePairProbe() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["PROBE_RELAY"], let url = Self.wsURL(raw),
              let epk = env["PROBE_EPK"], let room = env["PROBE_ROOM"] else {
            throw XCTSkip("PROBE_* not set")
        }
        let token = env["PROBE_TOKEN"] ?? "dummy-expired-token"
        let channel = URLSessionWebSocketChannel(url: url)
        let connection = RelayConnection(channel: channel, identity: Ed25519Identity())
        try await connection.authenticate()
        print("PROBE: authenticated to \(raw)")
        let invite = PairingInvite(token: token, epk: epk, sessionName: "probe",
                                   roomID: room, relayURL: nil)
        do {
            let result = try await withThrowingTaskGroup(of: PairResult.self) { group in
                group.addTask { try await connection.pair(invite: invite, deviceName: "probe") }
                group.addTask {
                    try await Task.sleep(nanoseconds: 8_000_000_000)
                    throw RelayConnection.ConnectionError.handshakeTimeout
                }
                let first = try await group.next()!
                group.cancelAll()
                return first
            }
            print("PROBE: pair_ok — \(result)")
        } catch let RelayConnection.PairingError.failed(code, message) {
            print("PROBE: pair_error \(code.rawValue): \(message) (routing works)")
        } catch RelayConnection.ConnectionError.handshakeTimeout {
            print("PROBE: TIMEOUT — no pair reply in 8s (Pi not reachable on this room)")
        }
        await connection.close()
    }

    private static func wsURL(_ raw: String) -> URL? {
        var value = raw
        if value.hasPrefix("https://") { value = "wss://" + value.dropFirst("https://".count) }
        else if value.hasPrefix("http://") { value = "ws://" + value.dropFirst("http://".count) }
        else if !value.hasPrefix("ws") { value = "wss://" + value }
        return URL(string: value)
    }
}

/// The device-advertises-its-owner pairing push (federation v2 §3): a
/// self-signed pairing_set that names the owner this device belongs to.
/// Federated reply legs are refused at the remote machine's relay without
/// it (strict owner-set gates, relay slice 2).
final class PairingSetPushTests: XCTestCase {
    private func decodeBlob(_ base64String: String) throws -> PairingSetBlob {
        let data = try XCTUnwrap(Base64.decodeTolerant(base64String))
        return try JSONDecoder().decode(PairingSetBlob.self, from: data)
    }

    func testBlobNamesTheOwnerAndSignatureVerifies() throws {
        let identity = Ed25519Identity()
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let (blob, sig) = RelayConnection.buildPairingSet(identity: identity, now: now)
        XCTAssertFalse(blob.isEmpty)
        XCTAssertFalse(sig.isEmpty)
        // The signature verifies over the EXACT blob bytes with the identity key.
        XCTAssertTrue(Ed25519.verify(signature: sig, message: blob, publicKeyRaw: identity.publicKeyRaw))
        // Field names round-trip (they must match the relay's PairingBlob);
        // the device advertises its owner — for the app that IS its own key
        // (machine_pk == owners).
        let fields = try decodeBlob(Base64.standard(blob))
        XCTAssertEqual(fields.machinePk, identity.publicKeyBase64)
        XCTAssertEqual(fields.owners, [identity.publicKeyBase64])
        XCTAssertEqual(fields.version, 1_760_000_000)
        XCTAssertEqual(fields.issuedAt, 1_760_000_000_000)
    }

    func testPushSendsAPairingSetControlFrame() async throws {
        let channel = FakeChannel(inbound: [])
        let connection = RelayConnection(channel: channel, identity: Ed25519Identity())
        await connection.pushPairingSet(now: Date(timeIntervalSince1970: 1_760_000_000))
        let sent = await channel.sent
        XCTAssertEqual(sent.count, 1)
        let frame = try JSONDecoder().decode([String: JSONValue].self,
                                             from: Data(sent[0].utf8))
        XCTAssertEqual(frame["type"]?.stringValue ?? nil, "pairing_set")
        // Self-consistency — the same check the relay performs: the signature
        // verifies over the EXACT blob bytes with the key the blob names.
        let blobB64 = try XCTUnwrap(frame["blob"]?.stringValue ?? nil)
        let sigB64 = try XCTUnwrap(frame["sig"]?.stringValue ?? nil)
        let blob = try XCTUnwrap(Base64.decodeTolerant(blobB64))
        let sig = try XCTUnwrap(Base64.decodeTolerant(sigB64))
        let fields = try JSONDecoder().decode(PairingSetBlob.self, from: blob)
        XCTAssertEqual(fields.owners, [fields.machinePk])
        let machineKey = try XCTUnwrap(Base64.decodeTolerant(fields.machinePk))
        XCTAssertTrue(Ed25519.verify(signature: sig, message: blob, publicKeyRaw: machineKey))
    }
}

/// Plane-mapping regression guard (the silent-drop bug class).
///
/// `RelayConnection.mapToWire` routes every outbound ClientMessage to the rpc
/// plane (pi-native verbs) or the ub plane (un-bien's own protocol). Its
/// `default:` branch silently sends unrecognized types on the rpc plane — and
/// the daemon/extension reads `env.ub` only, so a MISROUTED frame is dropped
/// with no error on either side (the request just times out; happened with
/// `sessions_list`). The expected-plane switch below has NO default: adding a
/// ClientMessage case without classifying it fails to COMPILE this test.
final class ClientMessagePlaneMappingTests: XCTestCase {
    private static func expectedPlane(
        _ message: ClientMessage
    ) -> RelayConnection.WirePlane {
        switch message {
        case .sessionSync, .sessionLaunch, .presenceStatus, .getSessionInfo,
             .terminate, .closeChildRoom, .sessionFork, .sessionNavigate,
             .sessionsList:
            // un-bien's own protocol — extension/daemon acts, inner type verbatim.
            return .ub
        case .pairRequest, .userMessage, .approveTool, .cancel, .ping,
             .getEntries, .sessionNew, .sessionCompact, .getState, .modelSet,
             .thinkingSet, .listModels, .extensionUiResponse, .clearQueue,
             .setSessionName:
            // pi-native rpc verbs (possibly renamed by mapToWire).
            return .rpc
        }
    }

    private static func samples() -> [(typeTag: String, message: ClientMessage)] {
        [
            ("pair_request", .pairRequest(id: "t", token: "t", deviceName: "t")),
            ("user_message", .userMessage(id: "t", text: "t", images: nil, streamingBehavior: nil)),
            ("approve_tool", .approveTool(id: "t", toolCallID: "t", decision: .allow)),
            ("cancel", .cancel(id: "t", targetID: "t")),
            ("ping", .ping(id: "t")),
            ("session_sync", .sessionSync(id: "t", limit: nil)),
            ("get_entries", .getEntries(id: "t", since: nil)),
            ("session_new", .sessionNew(id: "t")),
            ("session_compact", .sessionCompact(id: "t")),
            ("get_state", .getState(id: "t")),
            ("model_set", .modelSet(id: "t", provider: "p", modelID: "m")),
            ("thinking_set", .thinkingSet(id: "t", level: .off)),
            ("list_models", .listModels(id: "t")),
            ("session_launch", .sessionLaunch(id: "t", mode: nil, cwd: nil, name: nil, resume: nil)),
            ("sessions_list", .sessionsList(id: "t", scope: "all", cwd: nil, filter: nil)),
            ("presence_status", .presenceStatus(id: "t")),
            ("get_session_info", .getSessionInfo(id: "t")),
            ("extension_ui_response", .extensionUiResponse(
                ExtensionUiResponse(id: "t", value: nil, confirmed: nil, cancelled: nil, ask: nil))),
            ("clear_queue", .clearQueue(id: "t")),
            ("set_session_name", .setSessionName(id: "t", name: "n")),
            ("session_fork", .sessionFork(id: "t", entryID: "e", position: nil)),
            ("session_navigate", .sessionNavigate(id: "t", entryID: "e")),
            ("terminate", .terminate(id: "t", reason: nil)),
            ("close_child_room", .closeChildRoom(id: "t", roomID: "r")),
        ]
    }

    func testEveryClientMessageMapsToItsIntendedPlane() throws {
        for (typeTag, message) in Self.samples() {
            let data = try Codec.encodeClientBody(message)
            let frame = try JSONDecoder().decode(JSONValue.self, from: data)
            let (plane, mapped) = RelayConnection.mapToWire(frame)

            XCTAssertEqual(
                plane, Self.expectedPlane(message),
                "\(typeTag) routed to the wrong plane — a misroute here is a SILENT drop " +
                    "on the receiving side (the daemon/extension reads only one plane).")

            if plane == .ub {
                // ub frames keep their inner type verbatim — the daemon
                // dispatches on it (handleUbFrame switches on ub.type).
                XCTAssertEqual(
                    mapped["type"]?.stringValue, typeTag,
                    "\(typeTag) must keep its inner type on the ub plane.")
            }
        }
    }
}
