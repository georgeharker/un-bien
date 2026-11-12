import XCTest
@testable import UnBienCore

/// The 1.6.0 review findings on the resolver, one test each: output cleanup
/// (ANSI, control characters, carriage returns) and trimming as pi's
/// renderers do, shell-name matching, read-like tools, multi-line harness
/// diagnostics, results without content, diffs in any output, and the
/// stored result view following its card.
final class ToolFaceReviewTests: XCTestCase {
    private func text(_ s: String) -> JSONValue {
        .object(["content": .array([.object(["type": .string("text"), "text": .string(s)])])])
    }

    private func settled(_ tool: String, _ result: JSONValue?, args: [String: JSONValue] = [:]) -> ToolCard {
        ToolCard(toolCallID: "t", tool: tool, args: args, result: result, state: .ok)
    }

    // MARK: - Output cleanup (pi render-utils getTextOutput)

    func testCleanOutputStripsAnsiControlsAndCarriageReturns() {
        XCTAssertEqual(ToolKinds.cleanOutput("\u{1B}[31mred\u{1B}[0m ok"), "red ok")
        XCTAssertEqual(ToolKinds.cleanOutput("\u{1B}]8;;https://x\u{07}link\u{1B}]8;;\u{07}"), "link", "OSC hyperlink")
        XCTAssertEqual(ToolKinds.cleanOutput("50%\r100%\r\ndone"), "50%100%\ndone", "pi removes \\r")
        XCTAssertEqual(ToolKinds.cleanOutput("a\u{08}b\u{00}c\td"), "abc\td", "controls go, tab stays")
        let plain = "no escapes here\n\tindented"
        XCTAssertEqual(ToolKinds.cleanOutput(plain), plain)
    }

    func testTerminalOutputIsCleanedAndTrimmed() {
        let card = settled("bash", text("\n\n\u{1B}[32mPASS\u{1B}[0m all\r\n  two\n\n"))
        XCTAssertEqual(card.resultView.face, .terminal(text: "PASS all\n  two", notices: [], diff: nil))
    }

    func testRunningOutputIsCleanedToo() {
        var card = ToolCard(toolCallID: "t", tool: "bash", args: [:])
        card.result = text("\u{1B}[1mbuilding\u{1B}[0m\r")
        XCTAssertEqual(card.resultView.face, .terminal(text: "building", notices: [], diff: nil))
    }

    // MARK: - Shell names

    func testShellFamilyIsWholeNamesNotPrefixes() {
        for tool in ["bash", "Bash", "shell", "zsh", "sh", "exec", "exec_command", "command", "terminal",
                     "run", "run_terminal_cmd", "run_shell_command", "powershell", "pwsh"] {
            XCTAssertTrue(ToolKinds.isBashFamily(tool), tool)
        }
        for tool in ["show_diff", "share_link", "shopify_orders", "run_tests", "execute_query",
                     "shellcheck", "commander", "read"] {
            XCTAssertFalse(ToolKinds.isBashFamily(tool), tool)
        }
    }

    // MARK: - Read-like tools

    func testReadLikeToolsGetTheFileFace() {
        for tool in ["read_file", "view", "cat", "open_file", "file_read", "read_text_file"] {
            let card = settled(tool, text("let x = 1\n"), args: ["path": .string("a.swift")])
            XCTAssertEqual(card.resultView.category, .reads, tool)
            XCTAssertEqual(card.resultView.face, .file(text: "let x = 1", lang: "swift", notices: []), tool)
        }
        XCTAssertEqual(ToolFaceResolver.category(tool: "review"), .other)
    }

    // MARK: - Harness diagnostics

    func testMultiLineDiagnosticsStayOneEntry() {
        var card = ToolCard(toolCallID: "t", tool: "bash", args: [:],
                            result: .object(["content": .array([
                                .object(["type": .string("text"), "text": .string("out")]),
                                .object(["type": .string("text"),
                                         "text": .string("<harness>\n[error] line one\nline two\n[info] next\n</harness>")]),
                            ])]))
        card.state = .failed
        XCTAssertEqual(card.resultView.diagnostics, ["[error] line one\nline two", "[info] next"])
        XCTAssertEqual(card.resultView.face, .error("out\n\nline one\nline two"))
    }

    // MARK: - Results without content, diffs in any output

    func testABareObjectResultShowsItsJSON() {
        let card = settled("custom_tool", .object(["ok": .bool(true), "count": .number(3)]))
        guard case .text(let shown) = card.resultView.face else { return XCTFail("\(card.resultView.face)") }
        XCTAssertTrue(shown.contains("\"count\" : 3"), shown)
        XCTAssertTrue(shown.contains("\"ok\" : true"), shown)
    }

    func testADiffInAnyOutputIsFound() {
        let patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"
        let mcp = settled("mcp", text(patch))
        XCTAssertEqual(mcp.resultView.outputDiff?["hunks"]?.arrayValue?.count, 1)
        let script = ToolCard(toolCallID: "s", tool: "codemode", args: [:],
                              result: .object(["content": .array([
                                  .object(["type": .string("text"),
                                           "text": .string("Script completed\nWall time 0.1 seconds\nOutput:\n")]),
                                  .object(["type": .string("text"), "text": .string(patch)]),
                              ])]), state: .ok)
        XCTAssertNotNil(script.resultView.outputDiff)
        XCTAssertNil(settled("mcp", text("no @@ here\n@@ not a header")).resultView.outputDiff)
    }

    // MARK: - The stored view

    func testTheStoredViewFollowsItsCard() {
        var card = ToolCard(toolCallID: "t", tool: "bash", args: ["command": .string("ls")])
        XCTAssertEqual(card.resultView.face, .pending)
        card.result = text("a\nb")
        XCTAssertEqual(card.resultView, ToolFaceResolver.resolve(card))
        card.state = .ok
        XCTAssertEqual(card.resultView.face, .terminal(text: "a\nb", notices: [], diff: nil))
        card.state = .failed
        XCTAssertEqual(card.resultView, ToolFaceResolver.resolve(card))
    }
}
