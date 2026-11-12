import Foundation

/// What a tool is, from its name and arguments: the shell and codemode
/// families, a path's highlight language, and the unified-diff parser the
/// tool faces use for a patch in a result or a diff in shell output. The
/// result itself is drawn from the tool's declared spec (ToolFaceResolver).
public enum ToolKinds {
    // Whole names, or a family name followed by `_` (exec_command,
    // run_terminal_cmd); a bare prefix would take show_*, share_*, run_tests
    // or shopify_* for shell. `run` alone is a shell; `run_*` only when it
    // names one.
    private static let bashToolPattern =
        "^((bash|shell|zsh|sh|exec|command|terminal|powershell|pwsh)(_.*)?|run(_(terminal|shell|command)(_.*)?)?)$"
    // The JS meta-tool, both its names (the earlier mcpscript and codemode).
    private static let codemodeToolPattern = "^(codemode|mcpscript)"
    // File readers by other names (read_file, view, cat, open_file, …).
    private static let readToolPattern = "^(read|view|cat|open)(_(text_)?file)?$|^file_read$"

    /// Whether `tool` is bash-family (its command shows as a shell snippet,
    /// its result as terminal output).
    public static func isBashFamily(_ tool: String) -> Bool {
        matches(bashToolPattern, tool, caseInsensitive: true)
    }

    /// Whether `tool` reads a file (pi's `read`, or another agent's reader).
    public static func isReadFamily(_ tool: String) -> Bool {
        matches(readToolPattern, tool, caseInsensitive: true)
    }

    /// Tool output as pi's renderers show it (render-utils getTextOutput):
    /// ANSI escapes stripped, control characters other than tab and newline
    /// removed (sanitizeBinaryOutput), carriage returns removed. Text without
    /// any of them is returned untouched (one scan).
    public static func cleanOutput(_ text: String) -> String {
        var hasEscape = false
        var hasControl = false
        for unit in text.utf8 where unit < 0x20 && unit != 0x0A && unit != 0x09 {
            if unit == 0x1B { hasEscape = true } else { hasControl = true }
            if hasEscape && hasControl { break }
        }
        let c1 = text.unicodeScalars.contains { $0.value == 0x9B || $0.value == 0x9C || (0xFFF9...0xFFFB).contains($0.value) }
        guard hasEscape || hasControl || c1 else { return text }
        var out = text
        if hasEscape || c1 {
            out = out.replacingOccurrences(of: ansiPattern, with: "", options: .regularExpression)
        }
        return out.replacingOccurrences(of: #"[\x00-\x08\x0B-\x1F\x{FFF9}-\x{FFFB}]"#, with: "",
                                        options: .regularExpression)
    }

    // pi's utils/ansi.ts: OSC up to its string terminator, or a CSI sequence.
    private static let ansiPattern =
        #"(?:\x1B\][\s\S]*?(?:\x07|\x1B\\|\x{9C}))|[\x1B\x{9B}][\[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]"#

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
