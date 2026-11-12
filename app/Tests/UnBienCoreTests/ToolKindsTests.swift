import XCTest
@testable import UnBienCore

/// ToolKinds: the unified-diff parser the tool faces use, a path's highlight
/// language, and the tool families.
final class ToolKindsTests: XCTestCase {
    private func hunks(_ text: String) -> [JSONValue]? {
        ToolKinds.parseDiff(text)?["hunks"]?.arrayValue
    }

    func testParsesUnifiedDiffWithLineCounters() throws {
        let diff = [
            "--- a/foo.txt", "+++ b/foo.txt", "@@ -1,3 +1,3 @@",
            " context one", "-removed two", "+added two", " context three",
        ].joined(separator: "\n")
        let lines = try XCTUnwrap(hunks(diff)?[0]["lines"]?.arrayValue)
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
        let all = try XCTUnwrap(hunks(diff))
        XCTAssertEqual(all.count, 2)
        let firstLine = try XCTUnwrap(all[1]["lines"]?.arrayValue?[0])
        XCTAssertEqual(firstLine["kind"]?.stringValue, "context")
        XCTAssertEqual(firstLine["oldLine"]?.intValue, 10)
        XCTAssertEqual(firstLine["newLine"]?.intValue, 10)
        XCTAssertEqual(firstLine["text"]?.stringValue, "keep")
    }

    func testNilWithoutAHunkHeader() {
        XCTAssertNil(ToolKinds.parseDiff("just some output\nno markers here"))
        XCTAssertNil(ToolKinds.parseDiff("@@ historical @@\n-a\n+b"))
    }

    func testLanguageFromPath() {
        XCTAssertEqual(ToolKinds.language(forPath: "/a/b/Foo.swift"), "swift")
        XCTAssertEqual(ToolKinds.language(forPath: "x.tsx"), "typescript")
        XCTAssertNil(ToolKinds.language(forPath: "/a/b.unknownext"))
        XCTAssertNil(ToolKinds.language(forPath: "Makefile"))
    }

    func testFamilies() {
        XCTAssertTrue(ToolKinds.isBashFamily("bash"))
        XCTAssertTrue(ToolKinds.isBashFamily("Shell"))
        XCTAssertFalse(ToolKinds.isBashFamily("read"))
        XCTAssertTrue(ToolKinds.isCodemodeFamily("codemode"))
        XCTAssertTrue(ToolKinds.isCodemodeFamily("mcpscript"))
        XCTAssertFalse(ToolKinds.isCodemodeFamily("bash"))
    }
}
