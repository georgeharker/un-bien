import XCTest
@testable import UnBienApp
@testable import UnBienCore
import Highlighter

/// Tool-card INPUT faces (codemode-as-JS + bash-command-as-shell): the call's
/// identity renders as a highlighted snippet instead of raw args JSON. The
/// faces live in ToolCardView's static derivations so the estimator (height)
/// and the card can never disagree — these tests pin the shared logic.
final class ToolCardContentFaceTests: XCTestCase {

    // MARK: - highlight language normalization (the shell-alias gap)

    func testShellFamilyLanguagesNormalizeToBash() {
        // highlight.js registers bash's aliases as sh/zsh — NOT "shell" —
        // and an unknown language makes the engine return nil (plain-text
        // fallback). The chokepoint maps the family before the engine+key.
        for lang in ["shell", "sh", "zsh", "SHELL", "Zsh"] {
            XCTAssertEqual(AttributedTextCache.normalizeHighlightLanguage(lang), "bash",
                           "\(lang) must normalize to bash")
        }
        XCTAssertEqual(AttributedTextCache.normalizeHighlightLanguage("bash"), "bash")
        XCTAssertEqual(AttributedTextCache.normalizeHighlightLanguage("swift"), "swift")
        XCTAssertEqual(AttributedTextCache.normalizeHighlightLanguage(nil), nil)
        XCTAssertEqual(AttributedTextCache.normalizeHighlightLanguage(""), "")
    }

    func testShellHighlightEndToEnd() {
        // The live engine (highlight.js via JSContext): "shell" previously
        // produced nil — the plain-text fallback the bash command face showed.
        // After normalization the same call highlights.
        let result = AttributedTextCache.shared.highlighted(
            "cargo test --quiet", language: "shell", style: "xcode", font: nil)
        XCTAssertNotNil(result, "shell must highlight via the bash alias mapping")
    }

    func testBashEngineAugmentedForSearchTools() {
        // The engine POOLS augment bash's built_in list at creation (fork
        // seam, upstream PR #10): the shared cache's output for a grep
        // command must differ from an UN-augmented engine's — the command
        // word gains the built_in styling highlight.js's stock grammar omits.
        let command = "grep \"pattern\" path"
        let augmentedOutput = AttributedTextCache.shared.highlighted(
            command, language: "shell", style: "xcode", font: nil)
        guard let plainEngine = Highlighter() else { return XCTFail("engine") }
        _ = plainEngine.setTheme("xcode")
        let plainOutput = plainEngine.highlight(command, as: "bash")
        XCTAssertNotNil(augmentedOutput)
        XCTAssertNotNil(plainOutput)
        // The cache returns AttributedString; the raw engine NSAttributedString —
        // normalize so equality compares the ATTRIBUTES (the styling is the
        // difference; the plain string is identical by design).
        XCTAssertNotEqual(augmentedOutput!, AttributedString(plainOutput!),
                          "the augmented engine styles the grep command word")
    }

    private func card(tool: String, args: [String: JSONValue]) -> ToolCard {
        ToolCard(toolCallID: "t1", tool: tool, args: args)
    }

    // MARK: - MCP proxy → the proxied call as the header subtitle

    func testMCPSubtitleNamesTheProxiedCall() {
        // The argument shapes the mcp tool is called with in real sessions.
        XCTAssertEqual(ToolCardView.mcpSubtitle(for: card(tool: "mcp", args: [
            "tool": .string("svg-mcp_render_document"), "args": .string("{}")])),
            "svg-mcp_render_document")
        XCTAssertEqual(ToolCardView.mcpSubtitle(for: card(tool: "mcp", args: [
            "describe": .string("svg-mcp_import_svg")])), "describe svg-mcp_import_svg")
        XCTAssertEqual(ToolCardView.mcpSubtitle(for: card(tool: "mcp", args: [
            "search": .string("design_lookup"), "limit": .number(6)])), "search \"design_lookup\"")
        XCTAssertEqual(ToolCardView.mcpSubtitle(for: card(tool: "mcp", args: [
            "list": .bool(true), "server": .string("cribsheet")])), "list cribsheet")
    }

    func testMCPSubtitleOnlyForTheProxyAndOnlyWhenNamed() {
        XCTAssertNil(ToolCardView.mcpSubtitle(for: card(tool: "bash", args: ["tool": .string("x")])))
        XCTAssertNil(ToolCardView.mcpSubtitle(for: card(tool: "mcp", args: [:])))
        XCTAssertNil(ToolCardView.mcpSubtitle(for: card(tool: "mcp", args: ["tool": .string("")])))
    }

    // MARK: - codemode → JavaScript snippet

    func testCodemodeRendersArgsCodeAsJavaScript() {
        let code = """
        // @options: {"timeout_ms": 60000}
        const r = await tools.read({ path: "README.md" })
        return r
        """
        let c = card(tool: "codemode", args: ["code": .string(code)])
        let face = ToolCardView.content(for: c)
        XCTAssertEqual(face?.text, code)
        XCTAssertEqual(face?.lang, "javascript")
        // Rich BY IDENTITY — the snippet is small and IS the whole call.
        XCTAssertTrue(ToolCardView.isRich(c))
    }

    func testLegacyMcpscriptNameGetsTheJSFace() {
        // The JS meta-tool's earlier pi name: older backfilled transcripts
        // carry tool "mcpscript". Both names, both arg shapes (code, and
        // the legacy script fallback), same rich-by-identity default.
        let c = card(tool: "mcpscript", args: ["code": .string("return 1")])
        XCTAssertEqual(ToolCardView.content(for: c)?.text, "return 1")
        XCTAssertEqual(ToolCardView.content(for: c)?.lang, "javascript")
        XCTAssertTrue(ToolCardView.isRich(c))
        let legacyArg = card(tool: "mcpscript", args: ["script": .string("return 2")])
        XCTAssertEqual(ToolCardView.content(for: legacyArg)?.text, "return 2")
        XCTAssertTrue(ToolCardView.isRich(legacyArg))
    }

    func testCodemodeWithoutCodeIsNotRich() {
        let c = card(tool: "codemode", args: [:])
        XCTAssertNil(ToolCardView.content(for: c))
        XCTAssertFalse(ToolCardView.isRich(c))
    }

    // MARK: - bash-family → command as shell

    func testBashRendersCommandAsShellSnippet() {
        let c = card(tool: "bash", args: ["command": .string("cargo test --quiet")])
        let face = ToolCardView.content(for: c)
        XCTAssertEqual(face?.text, "cargo test --quiet")
        XCTAssertEqual(face?.lang, "shell")
        // Rich by the command face: "Expand rich tool results" opens it.
        XCTAssertTrue(ToolCardView.isRich(c))
        // A bash call with no command has no face, so stays collapsed.
        XCTAssertFalse(ToolCardView.isRich(card(tool: "bash", args: [:])))
    }

    /// The canonical result value the reducer gives every card.
    private func result(_ text: String, details: JSONValue? = nil) -> JSONValue {
        var fields: [String: JSONValue] = ["content": .array([.object(["type": .string("text"),
                                                                      "text": .string(text)])])]
        if let details { fields["details"] = details }
        return .object(fields)
    }

    func testShellCardShowsTheCommandAndThenItsOutput() {
        // COMMAND, then the unhighlighted OUTPUT.
        let plain = ToolCard(toolCallID: "t1", tool: "bash", args: ["command": .string("ls")],
                             result: result("a\nb"), state: .ok)
        XCTAssertEqual(ToolCardView.sectionLabels(for: plain, hideInputRich: true), 2)
        XCTAssertEqual(ToolCardView.resultParts(for: plain), [.label("output"), .mono("a\nb")])
        // A truncation notice is its own row.
        let truncated = ToolCard(toolCallID: "t2", tool: "bash", args: ["command": .string("seq 9")],
                                 result: result("9\n\n[Showing lines 9-9 of 9. Full output: /x]",
                                                details: .object(["truncation": .object([:])])),
                                 state: .ok)
        XCTAssertEqual(ToolCardView.resultParts(for: truncated),
                       [.label("output"), .mono("9"), .notice("Showing lines 9-9 of 9. Full output: /x")])
        XCTAssertEqual(ToolCardView.sectionLabels(for: truncated, hideInputRich: true), 3)
        // A write's content stands in for its bare result; the success line is a notice.
        let write = ToolCard(toolCallID: "t3", tool: "write", args: ["content": .string("x")],
                             result: result("Successfully wrote to /a"), state: .ok)
        XCTAssertEqual(ToolCardView.resultParts(for: write), [.notice("Successfully wrote to /a")])
        XCTAssertEqual(ToolCardView.sectionLabels(for: write, hideInputRich: true), 2, "CONTENT + notice")
        XCTAssertNil(ToolCardView.callFaceLabel(for: write))
    }

    /// A codemode card shows its SCRIPT, its nested CALLS, then its OUTPUT
    /// with the script header removed.
    func testCodemodeCardShowsTheScriptCallsAndOutput() {
        let details: JSONValue = .object(["calls": .array([.object([
            "id": .string("c/1"), "name": .string("read"), "args": .string("{}"),
            "status": .string("ok"), "durationMs": .number(420)])])])
        let content: JSONValue = .array([
            .object(["type": .string("text"), "text": .string("Script completed\nWall time 0.9 seconds\nOutput:\n")]),
            .object(["type": .string("text"), "text": .string("42")])])
        let card = ToolCard(toolCallID: "t4", tool: "codemode", args: ["code": .string("return 42")],
                            result: .object(["content": content, "details": details]), state: .ok)
        XCTAssertEqual(ToolCardView.callFaceLabel(for: card), "SCRIPT")
        XCTAssertEqual(ToolCardView.resultParts(for: card),
                       [.label("calls"), .mono("\u{2713} read {} 420ms"),
                        .label("output"), .code("42", lang: nil, face: "output")])
        XCTAssertEqual(ToolCardView.sectionLabels(for: card, hideInputRich: true), 3, "SCRIPT + CALLS + OUTPUT")
        XCTAssertEqual(ToolCardView.callFaceLabel(for: self.card(tool: "grep", args: [:])), "COMMAND")
    }

    /// A failed call shows its error text (from the content), not the word "error".
    func testFailedCardShowsItsErrorText() {
        let failed = ToolCard(toolCallID: "t5", tool: "read", args: ["path": .string("/m")],
                              result: result("ENOENT: no such file"), error: "error", state: .failed)
        XCTAssertEqual(ToolCardView.resultParts(for: failed), [.label("error"), .error("ENOENT: no such file")])
    }

    func testBashFamilyPatternCoversShellTools() {
        // The same pattern the OUTPUT classifier uses (shared via
        // ToolKinds.isBashFamily — the two must never disagree).
        for tool in ["bash", "shell", "zsh", "sh", "exec", "command", "run", "terminal"] {
            XCTAssertTrue(ToolKinds.isBashFamily(tool), "\(tool) should be bash-family")
        }
        XCTAssertFalse(ToolKinds.isBashFamily("codemode"))
        XCTAssertFalse(ToolKinds.isBashFamily("read"))
        XCTAssertFalse(ToolKinds.isBashFamily("edit"))
        XCTAssertFalse(ToolKinds.isBashFamily("grep"))
    }

    // MARK: - codemode result blocks (output side)

    func testCodemodeResultIsTheScriptFace() {
        // The JS meta-tool's result (console logs + the return value's JSON)
        // shows as its output, highlighted with the language auto-detected,
        // under either name, with the "Script completed" header dropped.
        let output = "{\"template\":\"rendered block: [HELLO → FROM → CODEMODE]\",\"isTest\":true}"
        for tool in ["codemode", "mcpscript"] {
            let card = ToolCard(toolCallID: "c", tool: tool, args: ["code": .string("return 1")],
                                result: .object(["content": .array([
                                    .object(["type": .string("text"),
                                             "text": .string("Script completed\nWall time 0.4 seconds\nOutput:\n")]),
                                    .object(["type": .string("text"), "text": .string(output)]),
                                ])]),
                                state: .ok)
            XCTAssertEqual(ToolCardView.resultParts(for: card),
                           [.label("output"), .code(output, lang: nil, face: "output")], tool)
        }
    }

    // MARK: - search tools (pi's grep/find) → shell-shaped face

    func testGrepToolComposesShellFaceFromPatternAndPath() {
        let c = card(tool: "grep", args: ["pattern": .string("UNBIEN_RELAY_BIND"),
                                          "path": .string("relay/src")])
        let face = ToolCardView.content(for: c)
        XCTAssertEqual(face?.text, "grep \"UNBIEN_RELAY_BIND\" relay/src")
        XCTAssertEqual(face?.lang, "shell")
        XCTAssertTrue(ToolCardView.isRich(c), "same default as bash-family")
    }

    func testGrepToolFaceEscapesEmbeddedQuotes() {
        let c = card(tool: "grep", args: ["pattern": .string("say \"hi\" now")])
        XCTAssertEqual(ToolCardView.content(for: c)?.text,
                       "grep \"say \\\"hi\\\" now\"")
    }

    func testFindToolFaceAndEmptyPatternIsRaw() {
        let c = card(tool: "find", args: ["pattern": .string("*.swift"),
                                         "path": .string("app")])
        XCTAssertEqual(ToolCardView.content(for: c)?.text, "find \"*.swift\" app")
        XCTAssertNil(ToolCardView.content(for: card(tool: "grep", args: [:])))
    }

    // MARK: - existing faces unchanged

    func testEditContentFaceStillWinsForEditTools() {
        let c = card(tool: "edit", args: ["path": .string("a.txt"),
                                          "new_string": .string("hello")])
        XCTAssertEqual(ToolCardView.content(for: c)?.text, "hello")
        XCTAssertTrue(ToolCardView.isRich(c))
    }

    func testWriteContentFaceUsesPathLanguage() {
        let c = card(tool: "write", args: ["path": .string("main.rs"),
                                           "content": .string("fn main() {}")])
        XCTAssertEqual(ToolCardView.content(for: c)?.text, "fn main() {}")
        XCTAssertEqual(ToolCardView.content(for: c)?.lang, "rust")
    }

    func testReadToolWithCommandArgIsNotBashFamily() {
        // `read` is read-family, NOT bash-family — even if it carried a
        // "command" arg, it must not take the shell face.
        let c = card(tool: "read", args: ["command": .string("echo hi")])
        XCTAssertNil(ToolCardView.content(for: c))
    }
}