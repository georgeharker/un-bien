import XCTest
@testable import UnBienCore

/// Ported from the extension's former `classify_output.test.ts` — output
/// classification is now app-side (design 01M177AF).
final class ToolOutputClassifierTests: XCTestCase {
    private func classify(_ tool: String, _ result: JSONValue?, args: JSONValue? = nil) -> JSONValue? {
        ToolOutputClassifier.classify(tool: tool, result: result, args: args)
    }

    // MARK: - diff kind

    func testParsesUnifiedDiffWithLineCounters() throws {
        let diff = [
            "--- a/foo.txt", "+++ b/foo.txt", "@@ -1,3 +1,3 @@",
            " context one", "-removed two", "+added two", " context three",
        ].joined(separator: "\n")
        let out = try XCTUnwrap(classify("edit", .string(diff)))
        XCTAssertEqual(out["v"]?.intValue, 1)
        let blocks = try XCTUnwrap(out["blocks"]?.arrayValue)
        XCTAssertEqual(blocks[0]["kind"]?.stringValue, "diff")
        let lines = try XCTUnwrap(blocks[0]["hunks"]?.arrayValue?[0]["lines"]?.arrayValue)
        XCTAssertEqual(lines[0]["kind"]?.stringValue, "context")
        XCTAssertEqual(lines[0]["oldLine"]?.intValue, 1)
        XCTAssertEqual(lines[0]["newLine"]?.intValue, 1)
        XCTAssertEqual(lines[0]["text"]?.stringValue, "context one")
        XCTAssertEqual(lines[1]["kind"]?.stringValue, "remove")
        XCTAssertEqual(lines[1]["oldLine"]?.intValue, 2)
        XCTAssertEqual(lines[2]["kind"]?.stringValue, "add")
        XCTAssertEqual(lines[2]["newLine"]?.intValue, 2)
    }

    func testEmitsOneHunkPerHeader() throws {
        let diff = ["@@ -1 +1 @@", "-a", "+b", "@@ -10,2 +10,2 @@", " keep", "-old", "+new"]
            .joined(separator: "\n")
        let out = try XCTUnwrap(classify("edit", .string(diff)))
        let hunks = try XCTUnwrap(out["blocks"]?.arrayValue?[0]["hunks"]?.arrayValue)
        XCTAssertEqual(hunks.count, 2)
        let firstLine = try XCTUnwrap(hunks[1]["lines"]?.arrayValue?[0])
        XCTAssertEqual(firstLine["kind"]?.stringValue, "context")
        XCTAssertEqual(firstLine["oldLine"]?.intValue, 10)
        XCTAssertEqual(firstLine["newLine"]?.intValue, 10)
        XCTAssertEqual(firstLine["text"]?.stringValue, "keep")
    }

    func testExtractsDiffFromContentTextShape() throws {
        let result = JSONValue.object(["content": .array([
            .object(["type": .string("text"), "text": .string("@@ -1 +1 @@\n-x\n+y")]),
        ])])
        let out = try XCTUnwrap(classify("bash", result))
        XCTAssertEqual(out["blocks"]?.arrayValue?[0]["kind"]?.stringValue, "diff")
    }

    func testNilForNonDiffPlainTextFromNonCodeTool() {
        XCTAssertNil(classify("grep", .string("just some output\nno markers here")))
    }

    func testNilForNonStringNonDiffResult() {
        XCTAssertNil(classify("bash", .object(["ok": .bool(true), "count": .number(3)])))
        XCTAssertNil(classify("bash", JSONValue.null))
        XCTAssertNil(classify("bash", nil))
    }

    // MARK: - code kind

    func testCodeBlockShellForBash() throws {
        let out = try XCTUnwrap(classify("bash", .string("total 8\nfile.txt")))
        XCTAssertEqual(out["v"]?.intValue, 1)
        let block = try XCTUnwrap(out["blocks"]?.arrayValue?[0])
        XCTAssertEqual(block["kind"]?.stringValue, "code")
        XCTAssertEqual(block["text"]?.stringValue, "total 8\nfile.txt")
        XCTAssertEqual(block["lang"]?.stringValue, "shell")
    }

    func testInfersLangFromReadFileExtension() throws {
        let out = try XCTUnwrap(classify("read", .string("let x = 1"),
                                         args: .object(["path": .string("/a/b/Foo.swift")])))
        let block = try XCTUnwrap(out["blocks"]?.arrayValue?[0])
        XCTAssertEqual(block["kind"]?.stringValue, "code")
        XCTAssertEqual(block["text"]?.stringValue, "let x = 1")
        XCTAssertEqual(block["lang"]?.stringValue, "swift")
    }

    func testOmitsLangForUnknownExtension() throws {
        let out = try XCTUnwrap(classify("read", .string("data here"),
                                         args: .object(["path": .string("/a/b.unknownext")])))
        let block = try XCTUnwrap(out["blocks"]?.arrayValue?[0])
        XCTAssertEqual(block["kind"]?.stringValue, "code")
        XCTAssertNil(block["lang"])
    }

    func testStripsStrayAnsi() throws {
        let out = try XCTUnwrap(classify("bash", .string("\u{1B}[31mred\u{1B}[0m done")))
        XCTAssertEqual(out["blocks"]?.arrayValue?[0]["text"]?.stringValue, "red done")
    }

    func testNilForNonCodeTool() {
        XCTAssertNil(classify("grep", .string("match one\nmatch two")))
    }

    func testNilForEmptyWhitespaceOutput() {
        XCTAssertNil(classify("bash", .string("   \n  ")))
    }
}
