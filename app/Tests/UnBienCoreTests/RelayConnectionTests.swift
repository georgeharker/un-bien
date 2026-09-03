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
