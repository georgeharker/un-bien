import XCTest
@testable import UnBienApp
@testable import UnBienCore

/// The demo transcript (App Review's demo mode) is in pi's real shapes, so
/// it shows the faces real sessions do: the edit settles to its recorded
/// patch, the test run to terminal output, both with run times.
final class DemoFixtureTests: XCTestCase {
    private func demoMain() throws -> SessionState {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Shared/DemoFixtures/demo-main.jsonl")
        let text = try String(contentsOf: url, encoding: .utf8)
        var reducer = EnvelopeReducer()
        for line in text.split(separator: "\n") {
            let data = Data(line.utf8)
            let value = try JSONDecoder().decode(JSONValue.self, from: data)
            // As AppModel.demoFixtures loads them: envelopes, or bare rpc frames.
            if value["rpc"] != nil {
                reducer.apply(try JSONDecoder().decode(EnvelopeMessage.self, from: data))
            } else {
                reducer.apply(EnvelopeMessage(rpc: value))
            }
        }
        return reducer.session
    }

    func testTheDemoToolCardsUseTheirRealFaces() throws {
        var cards: [ToolCard] = []
        for case .tool(let card) in try demoMain().items { cards.append(card) }
        XCTAssertEqual(cards.map(\.tool), ["edit", "bash"])

        let edit = cards[0]
        XCTAssertEqual(edit.state, .ok)
        guard case .diff(let hunks?, let confirmation) = edit.resultView.face else {
            return XCTFail("edit: \(edit.resultView.face)")
        }
        XCTAssertEqual(confirmation, "Successfully replaced 1 block(s) in src/server.ts.")
        XCTAssertEqual(ToolCardView.diffFace(for: edit), "diff-patch", "the recorded patch wins over the live hunks")
        // The live hunks (shown while the edit runs) say what the patch says.
        let kinds = { (hunks: [JSONValue]) in
            hunks.flatMap { $0["lines"]?.arrayValue ?? [] }.map {
                "\($0["kind"]?.stringValue ?? "") \($0["text"]?.stringValue ?? "")"
            }
        }
        XCTAssertEqual(kinds(edit.hunks ?? []), kinds(hunks))
        XCTAssertEqual(ToolCardView.headerSubtitle(for: edit)?.text, "src/server.ts")
        XCTAssertEqual(edit.durationMs, 42)

        let bash = cards[1]
        guard case .terminal(let output, _, _) = bash.resultView.face else {
            return XCTFail("bash: \(bash.resultView.face)")
        }
        XCTAssertTrue(output.hasSuffix("3 tests passed"))
        XCTAssertEqual(bash.durationMs, 1840)
    }
}
