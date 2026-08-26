import XCTest
@testable import UnBienCore

final class CodecTests: XCTestCase {
    /// Server-type fixtures — decodeServer must accept each line.
    private let serverFixtures: Set<String> = [
        "pair_ok.jsonl", "pair_error.jsonl", "user_input.jsonl", "agent_stream.jsonl",
        "agent_message.jsonl", "tool_request.jsonl", "tool_result.jsonl", "error.jsonl",
        "cancelled.jsonl", "pong.jsonl", "bye.jsonl", "session_history.jsonl",
    ]

    private func fixture(_ name: String) throws -> [String] {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: name, withExtension: nil, subdirectory: "Fixtures"))
        return try String(contentsOf: url, encoding: .utf8)
            .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    func testServerFixturesDecode() throws {
        for name in serverFixtures {
            for line in try fixture(name) {
                XCTAssertNoThrow(try Codec.decodeServer(line), "decoding \(name): \(line)")
            }
        }
    }

    func testInvalidJSONIsInvalidMessage() {
        XCTAssertThrowsError(try Codec.decodeServer("not json {{{")) { error in
            XCTAssertEqual(error as? DecodeError, .invalidMessage("not JSON: The data couldn’t be read because it isn’t in the correct format."))
        }
    }

    func testMissingTypeIsInvalidMessage() {
        XCTAssertThrowsError(try Codec.decodeServer(#"{"foo":1}"#)) { error in
            guard case .invalidMessage = error as? DecodeError else {
                return XCTFail("expected invalidMessage, got \(error)")
            }
        }
    }

    func testUnknownTypeIsUnsupported() {
        XCTAssertThrowsError(try Codec.decodeServer(#"{"type":"made_up"}"#)) { error in
            guard case .unsupportedType = error as? DecodeError else {
                return XCTFail("expected unsupportedType, got \(error)")
            }
        }
    }

    func testEncodeClientEndsWithNewline() throws {
        let encoded = try Codec.encodeClient(.ping(id: "018f9c2a"))
        XCTAssertTrue(encoded.hasSuffix("\n"))
    }

    func testClientRoundTrip() throws {
        let messages: [ClientMessage] = [
            .ping(id: "018f9c2a"),
            .userMessage(id: "018f9c2a", text: "hello", images: nil, streamingBehavior: nil),
            .userMessage(id: "018f9c2a", text: "refine", images: nil, streamingBehavior: "steer"),
            .approveTool(id: "abc", toolCallID: "tc_1", decision: .allow),
            .sessionSync(id: "s1", limit: 30),
            .modelSet(id: "m1", provider: "anthropic", modelID: "claude-opus-4-7"),
            .thinkingSet(id: "t1", level: .high),
        ]
        for message in messages {
            let body = try Codec.encodeClientBody(message)
            let decoded = try JSONDecoder().decode(ClientMessage.self, from: body)
            XCTAssertEqual(decoded, message)
        }
    }

    /// Client-only fixtures must be rejected by decodeServer as unsupported.
    func testClientFixturesRejectedByServerDecoder() throws {
        for name in ["pair_request.jsonl", "approve_tool.jsonl", "cancel.jsonl", "session_sync.jsonl"] {
            for line in try fixture(name) {
                XCTAssertThrowsError(try Codec.decodeServer(line)) { error in
                    guard case .unsupportedType = error as? DecodeError else {
                        return XCTFail("expected unsupportedType for \(name), got \(error)")
                    }
                }
            }
        }
    }
}
