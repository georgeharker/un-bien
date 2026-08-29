import Foundation

/// Classifies a RAW tool `result` into the versioned multi-block display
/// container the transcript renders — the `aux.output` shape
/// `{ v:1, blocks:[{kind,...}], truncated? }`.
///
/// Output classification is APP-SIDE (design 01M177AF): the source material is
/// the persisted tool `result`, which the reducer has identically for a live
/// frame and a `get_entries` replay entry, so running this in `fillToolCard`
/// enriches BOTH paths from one implementation — replay is enriched by
/// construction, with no extension in the loop. Ported from the extension's
/// former `classify_output.ts`. Pure; never throws (a bad result yields nil).
public enum ToolOutputClassifier {
    // Payload caps — bound how much a single result inflates a card. Mirror the
    // extension constants; enforcement is generic so future kinds inherit it.
    private static let maxBlocks = 32
    private static let maxBlockBytes = 128 * 1024
    private static let maxTotalBytes = 256 * 1024

    // Diff detection (a `@@ -N +N @@` hunk header anywhere in the text).
    private static let hasHunkPattern = #"@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@"#
    // Tools whose STRING result is code-ish and worth syntax highlighting.
    private static let bashToolPattern = "^(bash|shell|zsh|sh|exec|command|run|terminal)"
    private static let readToolPattern = "(read|view|cat|open|file)"

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

    /// Classify a tool's raw result into the display container, or nil when
    /// nothing is recognised (the common case — the card then renders raw JSON).
    public static func classify(tool: String, result: JSONValue?, args: JSONValue?) -> JSONValue? {
        var blocks: [JSONValue] = []
        let text = resultToText(result)
        if !text.isEmpty, matches(hasHunkPattern, text), let diff = parseDiff(text) {
            blocks.append(diff)
        }
        // Code/highlight only when it isn't already a structured diff (a colored
        // `git diff` reads better as the diff block than as highlighted text).
        if blocks.isEmpty {
            let plain = plainText(result)
            if !plain.isEmpty, let code = classifyCode(tool: tool, text: plain, args: args) {
                blocks.append(code)
            }
        }
        if blocks.isEmpty { return nil }
        return capBlocks(blocks)
    }

    // MARK: - Detectors

    /// Parse a unified-diff text into a `diff` block: one hunk per `@@` header;
    /// within a hunk `' '`→context, `'-'`→remove, `'+'`→add, seeding line
    /// counters from the header. Preamble and `+++`/`---` markers are ignored.
    private static func parseDiff(_ text: String) -> JSONValue? {
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

    /// Classify code-ish output into a `code` block (plain text + optional
    /// language the app highlights). Only bash-family (→ `shell`) and read-family
    /// (→ language from the file extension) qualify. Stray ANSI is stripped;
    /// unknown language is omitted so the highlighter auto-detects.
    private static func classifyCode(tool: String, text: String, args: JSONValue?) -> JSONValue? {
        let isBash = matches(bashToolPattern, tool, caseInsensitive: true)
        let isRead = matches(readToolPattern, tool, caseInsensitive: true)
        if !isBash && !isRead { return nil }
        let clean = stripAnsi(text)
        if clean.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        var lang: String? = isBash ? "shell" : nil
        if let path = pickPath(args), let ext = extLang(path) { lang = ext }
        var obj: [String: JSONValue] = ["kind": .string("code"), "text": .string(clean)]
        if let lang { obj["lang"] = .string(lang) }
        return .object(obj)
    }

    // MARK: - Caps

    private static func capBlocks(_ blocks: [JSONValue]) -> JSONValue? {
        var kept: [JSONValue] = []
        var total = 0
        var truncated = false
        for block in blocks {
            if kept.count >= maxBlocks { truncated = true; break }
            let bytes = blockBytes(block)
            if bytes > maxBlockBytes || total + bytes > maxTotalBytes {
                truncated = true
                continue // a later smaller block may still fit
            }
            kept.append(block)
            total += bytes
        }
        if kept.isEmpty { return nil }
        var obj: [String: JSONValue] = ["v": .number(1), "blocks": .array(kept)]
        if truncated { obj["truncated"] = .bool(true) }
        return .object(obj)
    }

    private static func blockBytes(_ block: JSONValue) -> Int {
        (try? JSONEncoder().encode(block).count) ?? Int.max
    }

    // MARK: - Text extraction

    /// Plain-text view for diff detection: bare string, `{content:[text]}`, else
    /// a JSON serialization (so an embedded diff inside a wrapper is still found).
    private static func resultToText(_ result: JSONValue?) -> String {
        guard let result else { return "" }
        switch result {
        case .string(let s):
            return s
        case .array, .object:
            if let content = result["content"]?.arrayValue {
                let parts = content.compactMap { block -> String? in
                    block["type"]?.stringValue == "text" ? block["text"]?.stringValue : nil
                }
                if !parts.isEmpty { return parts.joined() }
            }
            return jsonString(result)
        default:
            return ""
        }
    }

    /// Strict text view for the CODE path: a genuine textual result only (bare
    /// string or `{content:[text]}`), NEVER the JSON fallback — so a stringified
    /// object is never mislabeled "code".
    private static func plainText(_ result: JSONValue?) -> String {
        guard let result else { return "" }
        if case .string(let s) = result { return s }
        if let content = result["content"]?.arrayValue {
            return content.compactMap { block -> String? in
                block["type"]?.stringValue == "text" ? block["text"]?.stringValue : nil
            }.joined()
        }
        return ""
    }

    private static func pickPath(_ args: JSONValue?) -> String? {
        guard let args else { return nil }
        for key in ["path", "file", "filename", "filepath"] {
            if let s = args[key]?.stringValue { return s }
        }
        return nil
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

    /// Strip ANSI control sequences (OSC then CSI/SGR) — not interpreted; pi
    /// delivers plain text and this only cleans stray escapes.
    private static func stripAnsi(_ s: String) -> String {
        var out = s.replacingOccurrences(
            of: #"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"#, with: "", options: .regularExpression)
        out = out.replacingOccurrences(
            of: #"\x1b\[[0-9;?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
        return out
    }

    private static func jsonString(_ v: JSONValue) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        if let data = try? enc.encode(v), let s = String(data: data, encoding: .utf8) { return s }
        return ""
    }
}
