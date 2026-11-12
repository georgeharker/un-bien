import Foundation

/// What a tool is, from its name and arguments: the shell and codemode
/// families, a path's highlight language, and the unified-diff parser the
/// tool faces use for a patch in a result or a diff in shell output. The
/// result itself is drawn from the tool's declared spec (ToolFaceResolver).
public enum ToolKinds {
    private static let bashToolPattern = "^(bash|shell|zsh|sh|exec|command|run|terminal)"
    // The JS meta-tool, both its names (the earlier mcpscript and codemode).
    private static let codemodeToolPattern = "^(codemode|mcpscript)"

    /// Whether `tool` is bash-family (its command shows as a shell snippet,
    /// its result as terminal output).
    public static func isBashFamily(_ tool: String) -> Bool {
        matches(bashToolPattern, tool, caseInsensitive: true)
    }

    /// Whether `tool` is the JS meta-tool (codemode / legacy mcpscript).
    public static func isCodemodeFamily(_ tool: String) -> Bool {
        matches(codemodeToolPattern, tool, caseInsensitive: true)
    }

    // File extension → highlight.js language id. Unknown ext → nil (app auto-detects).
    private static let extLangMap: [String: String] = [
        "swift": "swift", "ts": "typescript", "tsx": "typescript",
        "js": "javascript", "jsx": "javascript", "py": "python", "rs": "rust",
        "go": "go", "java": "java", "kt": "kotlin", "rb": "ruby", "c": "c",
        "h": "c", "cc": "cpp", "cpp": "cpp", "cxx": "cpp", "hpp": "cpp",
        "cs": "csharp", "json": "json", "yaml": "yaml", "yml": "yaml",
        "toml": "toml", "md": "markdown", "markdown": "markdown", "sh": "bash",
        "bash": "bash", "zsh": "bash", "html": "xml", "xml": "xml", "css": "css",
        "scss": "scss", "sql": "sql", "php": "php", "lua": "lua",
        "scala": "scala", "dart": "dart", "m": "objectivec", "mm": "objectivec",
    ]

    /// highlight.js language id for a file path (via its extension), or nil when
    /// unknown so the highlighter auto-detects. Exposed for the app's Content
    /// view (an edit's new text shown as a highlighted code block).
    public static func language(forPath path: String) -> String? { extLang(path) }

    // MARK: - Diffs

    /// Parse a unified-diff text into a `diff` block: one hunk per `@@` header;
    /// within a hunk `' '`→context, `'-'`→remove, `'+'`→add, seeding line
    /// counters from the header. Preamble and `+++`/`---` markers are ignored.
    static func parseDiff(_ text: String) -> JSONValue? {
        var hunks: [JSONValue] = []
        var current: [JSONValue] = []
        var inHunk = false
        var oldLine = 0
        var newLine = 0
        func flush() { if inHunk { hunks.append(.object(["lines": .array(current)])) } }
        for row in text.components(separatedBy: "\n") {
            if let header = parseHunkHeader(row) {
                flush()
                current = []
                inHunk = true
                oldLine = header.old
                newLine = header.new
                continue
            }
            if !inHunk { continue }
            if row.hasPrefix("+++") || row.hasPrefix("---") { continue }
            guard let marker = row.first else { continue }
            let body = String(row.dropFirst())
            switch marker {
            case "-":
                current.append(.object(["kind": .string("remove"),
                                        "oldLine": .number(Double(oldLine)), "text": .string(body)]))
                oldLine += 1
            case "+":
                current.append(.object(["kind": .string("add"),
                                        "newLine": .number(Double(newLine)), "text": .string(body)]))
                newLine += 1
            case " ":
                current.append(.object(["kind": .string("context"),
                                        "oldLine": .number(Double(oldLine)),
                                        "newLine": .number(Double(newLine)), "text": .string(body)]))
                oldLine += 1
                newLine += 1
            default:
                break
            }
        }
        flush()
        if hunks.isEmpty { return nil }
        return .object(["kind": .string("diff"), "hunks": .array(hunks)])
    }

    private static func extLang(_ path: String) -> String? {
        guard let dot = path.range(of: #"\.([A-Za-z0-9]+)$"#, options: .regularExpression) else { return nil }
        let ext = path[dot].dropFirst().lowercased()
        return extLangMap[String(ext)]
    }

    // MARK: - Helpers

    private static func matches(_ pattern: String, _ s: String, caseInsensitive: Bool = false) -> Bool {
        var options: String.CompareOptions = [.regularExpression]
        if caseInsensitive { options.insert(.caseInsensitive) }
        return s.range(of: pattern, options: options) != nil
    }

    /// Parse the start lines out of a `@@ -old[,c] +new[,c] @@` hunk header;
    /// nil when the row isn't a well-formed header.
    private static func parseHunkHeader(_ row: String) -> (old: Int, new: Int)? {
        guard row.range(of: #"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@"#, options: .regularExpression) != nil
        else { return nil }
        let parts = row.split(separator: " ")
        guard parts.count >= 3,
              let old = Int(parts[1].dropFirst().split(separator: ",")[0]),
              let new = Int(parts[2].dropFirst().split(separator: ",")[0]) else { return nil }
        return (old, new)
    }
}
