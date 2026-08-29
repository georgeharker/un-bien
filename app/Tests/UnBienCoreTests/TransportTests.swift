import Foundation
import XCTest
@testable import UnBienCore

final class TransportTests: XCTestCase {
    func testRoutedEnvelopeWrapsClientMessage() throws {
        let message = ClientMessage.userMessage(
            id: "018f9c2a", text: "hello", images: nil, streamingBehavior: "steer")
        let envelope = try RoutedEnvelope(peer: "PEER_EPK", room: "main", message: message)
        XCTAssertEqual(envelope.peer, "PEER_EPK")
        XCTAssertEqual(envelope.room, "main")

        // ct must be base64 of the compact JSON body (no trailing newline).
        let bodyData = try XCTUnwrap(Data(base64Encoded: envelope.ct))
        let decoded = try JSONDecoder().decode(ClientMessage.self, from: bodyData)
        XCTAssertEqual(decoded, message)
        let bodyString = try XCTUnwrap(String(data: bodyData, encoding: .utf8))
        XCTAssertFalse(bodyString.hasSuffix("\n"))
    }

    func testInboundRoutedFrameCarriesServerMessage() throws {
        let serverLine = #"{"type":"models_list","in_reply_to":"r1","models":[]}"#
        let ct = Data(serverLine.utf8).base64EncodedString()
        let frame = #"{"peer":"PEER","room":"main","ct":"\#(ct)"}"#

        guard case let .routed(envelope) = try InboundFrame.parse(frame) else {
            return XCTFail("expected routed frame")
        }
        XCTAssertEqual(try envelope.decodeServer(),
                       .modelsList(inReplyTo: "r1", models: [], current: nil))
    }

    func testInboundControlChallenge() throws {
        guard case let .control(event) = try InboundFrame.parse(
            #"{"type":"challenge","nonce":"AAAA"}"#) else {
            return XCTFail("expected control frame")
        }
        XCTAssertEqual(event, .challenge(nonce: "AAAA"))
    }

    func testInboundControlPresenceAndRooms() throws {
        let presence = #"{"type":"presence","states":[{"peer":"P","online":true,"since_ts":null}]}"#
        guard case let .control(.presence(states)) = try InboundFrame.parse(presence) else {
            return XCTFail("expected presence")
        }
        XCTAssertEqual(states, [PresenceState(peer: "P", online: true, sinceTs: nil)])

        let rooms = #"{"type":"rooms","peer":"P","rooms":[{"room_id":"r1","name":"n","cwd":"/x","started_at":1}]}"#
        guard case let .control(.rooms(peer, list)) = try InboundFrame.parse(rooms) else {
            return XCTFail("expected rooms")
        }
        XCTAssertEqual(peer, "P")
        XCTAssertEqual(list.first?.roomID, "r1")
    }

    func testRelayControlOutEncoding() throws {
        let hello = RelayControlOut.hello(pubkey: "PK", roomID: "main")
        let data = try JSONEncoder().encode(hello)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "hello")
        XCTAssertEqual(object["pubkey"] as? String, "PK")
        XCTAssertEqual(object["room_id"] as? String, "main")
    }
}
