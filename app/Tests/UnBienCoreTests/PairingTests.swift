import Foundation
import XCTest
@testable import UnBienCore

/// Minimal scripted channel: serves pre-queued inbound lines, records outbound.
private actor ScriptedChannel: WebSocketChannel {
    private var inbound: [String]
    private(set) var sent: [String] = []
    init(inbound: [String]) { self.inbound = inbound }
    func send(_ text: String) async throws { sent.append(text) }
    func receive() async throws -> String {
        guard !inbound.isEmpty else { throw DecodeError.invalidMessage("drained") }
        return inbound.removeFirst()
    }
    nonisolated func close() {}
    func sentFrames() -> [String] { sent }
}

final class PairingTests: XCTestCase {
    func testParseFullQRURI() throws {
        let invite = try PairingURI.parse(
            "unbien://pair?t=TOKEN123"
            + "&epk=0Umma2Xg5AyTvU4DMFXcPoA7xMbLnfGVeImWp2QVFvY"
            + "&n=un-bien%20%C2%B7%20main&rm=aB12CD34eF56")
        XCTAssertEqual(invite.token, "TOKEN123")
        // base64url QR epk is canonicalized to standard padded base64.
        XCTAssertEqual(invite.epk, "0Umma2Xg5AyTvU4DMFXcPoA7xMbLnfGVeImWp2QVFvY=")
        XCTAssertEqual(invite.sessionName, "un-bien · main")
        XCTAssertEqual(invite.roomID, "aB12CD34eF56")
        XCTAssertNil(invite.relayURL)
    }

    func testRoomDefaultsToMainWhenAbsent() throws {
        let invite = try PairingURI.parse("unbien://pair?t=T&epk=E&n=x")
        XCTAssertEqual(invite.roomID, "main")
    }

    func testRejectsNonPairingURI() {
        XCTAssertThrowsError(try PairingURI.parse("https://example.com")) { error in
            XCTAssertEqual(error as? PairingURIError, .notAPairingURI)
        }
    }

    func testMissingTokenAndEPK() {
        XCTAssertThrowsError(try PairingURI.parse("unbien://pair?epk=E")) { error in
            XCTAssertEqual(error as? PairingURIError, .missingToken)
        }
        XCTAssertThrowsError(try PairingURI.parse("unbien://pair?t=T")) { error in
            XCTAssertEqual(error as? PairingURIError, .missingEPK)
        }
    }

    func testOwnerIdentityBlobRoundTrip() throws {
        let identity = Ed25519Identity()
        let blob = OwnerIdentityBlob.encode(identity)
        XCTAssertEqual(blob.count, 64)
        XCTAssertEqual(blob.prefix(32), identity.publicKeyRaw)
        let restored = try OwnerIdentityBlob.decode(blob)
        XCTAssertEqual(restored.publicKeyRaw, identity.publicKeyRaw)
        XCTAssertEqual(restored.rawSeed, identity.rawSeed)
    }

    func testInMemoryStoreLoadSaveDelete() throws {
        let store = InMemoryOwnerIdentityStore()
        XCTAssertNil(try store.load())
        let identity = Ed25519Identity()
        try store.save(identity)
        XCTAssertEqual(try store.load()?.publicKeyRaw, identity.publicKeyRaw)
        try store.delete()
        XCTAssertNil(try store.load())
    }

    func testPairSendsRoutedRequestAndReturnsResult() async throws {
        let identity = Ed25519Identity()
        let epk = "0Umma2Xg5AyTvU4DMFXcPoA7xMbLnfGVeImWp2QVFvY=" // canonical
        let invite = PairingInvite(token: "TOK", epk: epk, sessionName: "s",
                                   roomID: "room1", relayURL: nil)
        let requestID = "req-123"
        let pairOk = ServerMessage.pairOk(
            inReplyTo: requestID, sessionName: "Pi on Mac", sessionStartedAt: 1_716_234_500_000,
            roomID: "room1", harness: Harness(name: "Pi coding agent", version: "1.0"),
            hostname: "MacBook")
        let okLine = try encodeServer(pairOk)
        let inboundEnvelope = #"{"peer":"\#(epk)","room":"room1","ct":"\#(Data(okLine.utf8).base64EncodedString())"}"#
        let channel = ScriptedChannel(inbound: [inboundEnvelope])
        let connection = RelayConnection(channel: channel, identity: identity)

        let result = try await connection.pair(invite: invite, deviceName: "iPhone", requestID: requestID)
        XCTAssertEqual(result.sessionName, "Pi on Mac")
        XCTAssertEqual(result.roomID, "room1")
        XCTAssertEqual(result.harness?.name, "Pi coding agent")

        // The outbound frame must be a routed {peer,room,ct} pair_request.
        let frames = await channel.sentFrames()
        let sent = try XCTUnwrap(frames.first)
        let object = try JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any]
        XCTAssertEqual(object?["peer"] as? String, epk)
        XCTAssertEqual(object?["room"] as? String, "room1")
        let body = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(object?["ct"] as? String)))
        let decoded = try JSONDecoder().decode(ClientMessage.self, from: body)
        XCTAssertEqual(decoded, .pairRequest(id: requestID, token: "TOK", deviceName: "iPhone"))
    }

    private func encodeServer(_ message: ServerMessage) throws -> String {
        String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
    }
}
