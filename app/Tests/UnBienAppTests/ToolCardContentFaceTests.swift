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
        // NOT rich by the command face — expansion default stays unchanged
        // for all existing shell-call history (face renders on expand).
        XCTAssertFalse(ToolCardView.isRich(c))
    }

    func testBashFamilyPatternCoversShellTools() {
        // The same pattern the OUTPUT classifier uses (shared via
        // ToolOutputClassifier.isBashFamily — the two must never disagree).
        for tool in ["bash", "shell", "zsh", "sh", "exec", "command", "run", "terminal"] {
            XCTAssertTrue(ToolOutputClassifier.isBashFamily(tool), "\(tool) should be bash-family")
        }
        XCTAssertFalse(ToolOutputClassifier.isBashFamily("codemode"))
        XCTAssertFalse(ToolOutputClassifier.isBashFamily("read"))
        XCTAssertFalse(ToolOutputClassifier.isBashFamily("edit"))
        XCTAssertFalse(ToolOutputClassifier.isBashFamily("grep"))
    }

    // MARK: - search tools (pi's grep/find) → shell-shaped face

    func testGrepToolComposesShellFaceFromPatternAndPath() {
        let c = card(tool: "grep", args: ["pattern": .string("UNBIEN_RELAY_BIND"),
                                          "path": .string("relay/src")])
        let face = ToolCardView.content(for: c)
        XCTAssertEqual(face?.text, "grep \"UNBIEN_RELAY_BIND\" relay/src")
        XCTAssertEqual(face?.lang, "shell")
        XCTAssertFalse(ToolCardView.isRich(c), "same default as bash-family — face on expand")
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