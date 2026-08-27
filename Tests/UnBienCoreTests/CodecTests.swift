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

    func testSessionHistoryDecodesCapabilities() throws {
        let line = #"{"type":"session_history","in_reply_to":"s1","session_started_at":1,"events":[],"eos":true,"truncated":false,"protocol_version":1,"capabilities":["thinking","models"]}"#
        guard case let .sessionHistory(_, _, _, _, _, version, caps) = try Codec.decodeServer(line) else {
            return XCTFail("not a session_history")
        }
        XCTAssertEqual(version, 1)
        XCTAssertEqual(caps, ["thinking", "models"])
    }

    func testSessionHistoryWithoutCapabilitiesDecodesNil() throws {
        let line = #"{"type":"session_history","in_reply_to":"s1","session_started_at":1,"events":[],"eos":true,"truncated":false}"#
        guard case let .sessionHistory(_, _, _, _, _, version, caps) = try Codec.decodeServer(line) else {
            return XCTFail("not a session_history")
        }
        XCTAssertNil(version)
        XCTAssertNil(caps)
    }

    func testSessionLaunchEncodes() throws {
        let data = try JSONEncoder().encode(
            ClientMessage.sessionLaunch(id: "l1", mode: "tmux", cwd: "/w", name: "job"))
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["type"] as? String, "session_launch")
        XCTAssertEqual(obj["mode"] as? String, "tmux")
        XCTAssertEqual(obj["cwd"] as? String, "/w")
        XCTAssertEqual(obj["name"] as? String, "job")
    }

    func testSessionLaunchOmitsNilCwdName() throws {
        let data = try JSONEncoder().encode(
            ClientMessage.sessionLaunch(id: "l1", mode: "tmux", cwd: nil, name: nil))
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(obj["cwd"])
        XCTAssertNil(obj["name"])
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

    func testAskEnrichmentDecodesFromExtensionUiRequest() throws {
        let ask = #""ask":{"flow_id":"f1","tool_call_id":null,"source":"tool","title":"Choose","# +
            #""questions":[{"id":"q1","label":"L","prompt":"Which?","type":"multi","required":true,"# +
            #""options":[{"value":"a","label":"A","freeform":false},{"value":"b","label":"B"}]}]}"#
        let line = #"{"type":"extension_ui_request","id":"r1","method":"select","# +
            #""title":"Pick","options":["a"],"# + ask + "}"
        guard case let .extensionUiRequest(request) = try Codec.decodeServer(line) else {
            return XCTFail("not an extension_ui_request")
        }
        let flow = try XCTUnwrap(request.askFlow)
        XCTAssertEqual(flow.flowID, "f1")
        XCTAssertNil(flow.toolCallID)
        XCTAssertEqual(flow.questions.first?.type, .multi)
        XCTAssertTrue(flow.questions.first?.required ?? false)
        XCTAssertEqual(flow.questions.first?.options.count, 2)
    }

    func testAskResponseEnrichmentEncodesRichSubmit() throws {
        let enrichment = AskResponseEnrichment.answer(
            flowID: "f1",
            answers: ["q1": AskAnswer(values: ["a", "b"], customText: "x", note: "n")])
        let message = ClientMessage.extensionUiResponse(.rich(id: "r1", enrichment: enrichment))
        let data = try Codec.encodeClientBody(message)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "extension_ui_response")
        XCTAssertEqual(object["id"] as? String, "r1")
        let ask = try XCTUnwrap(object["ask"] as? [String: Any])
        XCTAssertEqual(ask["flow_id"] as? String, "f1")
        XCTAssertEqual(ask["kind"] as? String, "answer")
        let answers = try XCTUnwrap(ask["answers"] as? [String: Any])
        let q1 = try XCTUnwrap(answers["q1"] as? [String: Any])
        XCTAssertEqual(q1["customText"] as? String, "x") // camelCase VERBATIM
        XCTAssertEqual((q1["values"] as? [String])?.sorted(), ["a", "b"])
        XCTAssertNil(object["value"])
        XCTAssertNil(object["confirmed"])
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
