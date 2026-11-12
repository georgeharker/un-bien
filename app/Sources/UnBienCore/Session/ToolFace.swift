import Foundation

/// What a tool card's RESULT shows, resolved from the tool's declared result
/// spec (design 01M77YDWSZFD6WCYVFT3Z73SWJ): the tool name plus the canonical
/// `{content, details?}` value (SessionState+ToolResult), identical live and on
/// replay. A built-in face applies only when `details` validates against that
/// tool's spec; tool names are not unique (pi-find ships its own grep/find), so
/// anything else falls back to `.text`. Pure; never throws.
///
/// The call's INPUT faces (command, script, search, edit content) are not here
/// — they come from args alone and are unchanged.
public enum ToolFace: Equatable, Sendable {
    /// No settled result yet (a running call without partial text).
    case pending
    /// Shell output, shown unhighlighted. `diff` is the parsed `diff` block
    /// when the output is a unified diff (e.g. `git diff`), shown as a diff.
    case terminal(text: String, notices: [String], diff: JSONValue?)
    /// A file read: the stored text as read, highlighted by `lang`.
    case file(text: String, lang: String?, notices: [String])
    /// An edit's diff from the RECORD: `hunks` parsed from `details.patch`,
    /// or nil when the record holds none (the view derives it from the stored
    /// args). `confirmation` is the success line.
    case diff(hunks: [JSONValue]?, confirmation: String?)
    /// A success line with nothing else to show (write).
    case confirmation(String)
    /// Search / listing output: one entry per line.
    case lines(text: String, notices: [String])
    /// A codemode script's nested calls and its output, header removed.
    case script(calls: [ScriptCall], output: String)
    /// A failed call's error text.
    case error(String)
    /// Prose (a fetched page, search results, an agent's report), rendered
    /// as markdown.
    case markdown(String)
    /// Plain text: the result's text blocks joined (the universal fallback).
    case text(String)
}

/// One nested call of a codemode script (`details.calls[]`).
public struct ScriptCall: Equatable, Sendable {
    public let name: String
    public let args: String
    public let status: String
    public let durationMs: Int?
    public let error: String?
}

/// The settings category a card's display default comes from.
public enum ToolCategory: String, CaseIterable, Sendable {
    case shell, reads, edits, writes, searches, codemode, mcp, agents, web, other
}

/// A resolved card result: the face, the category, and any harness
/// diagnostics (pi-durable appends them as a trailing `<harness>` block).
public struct ToolResultView: Equatable, Sendable {
    public let face: ToolFace
    public let category: ToolCategory
    public let diagnostics: [String]
    /// A unified diff found in a text or script face's output (an MCP or
    /// codemode result that is a patch), drawn as a diff. The terminal face
    /// carries its own.
    public let outputDiff: JSONValue?

    public init(face: ToolFace, category: ToolCategory, diagnostics: [String], outputDiff: JSONValue? = nil) {
        self.face = face
        self.category = category
        self.diagnostics = diagnostics
        self.outputDiff = outputDiff
    }

    /// Whether the result has a structured face (terminal output, a file, a
    /// diff, a confirmation, lines, a script) rather than plain text, an
    /// error or nothing yet. "Hide input on rich results" hides the raw
    /// arguments of such cards.
    public var isStructured: Bool {
        switch face {
        case .terminal, .file, .diff, .confirmation, .lines, .script, .markdown: return true
        case .pending, .error, .text: return false
        }
    }

    /// The face's name (conformance projection, logs).
    public var faceName: String {
        switch face {
        case .pending: return "pending"
        case .terminal(_, _, let diff): return diff == nil ? "terminal" : "terminal-diff"
        case .file: return "file"
        case .diff: return "diff"
        case .confirmation: return "confirmation"
        case .lines: return "lines"
        case .script: return "script"
        case .markdown: return "markdown"
        case .error: return "error"
        case .text: return "text"
        }
    }
}

public enum ToolFaceResolver {
    public static func category(tool: String) -> ToolCategory {
        if ToolKinds.isBashFamily(tool) { return .shell }
        if ToolKinds.isCodemodeFamily(tool) { return .codemode }
        switch tool {
        case _ where ToolKinds.isReadFamily(tool): return .reads
        case "edit": return .edits
        case "write": return .writes
        case "grep", "find", "ls": return .searches
        case "mcp": return .mcp
        case "subagent", "get_subagent_result", "steer_subagent", "agent", "Agent", "task": return .agents
        default:
            return tool.range(of: #"(^|_)web_(fetch|search)$"#, options: .regularExpression) != nil
                ? .web : .other
        }
    }

    /// The card's result view. Cards store it (`ToolCard.resultView`,
    /// refreshed when the result or state changes), so views, the estimator
    /// and prewarm read it instead of resolving per call.
    public static func resolve(_ card: ToolCard) -> ToolResultView {
        resolve(tool: card.tool, args: card.args, result: card.result, state: card.state)
    }

    public static func resolve(tool: String, args: [String: JSONValue], result: JSONValue?,
                               state: ToolCard.State) -> ToolResultView {
        let category = category(tool: tool)
        var raw = textBlocks(result)
        let diagnostics = takeHarnessBlock(&raw)
        // Text as pi's renderers show it: ANSI, control characters and
        // carriage returns removed.
        let texts = raw.map(ToolKinds.cleanOutput)
        let joined = texts.joined(separator: "\n")
        let details = result?.objectValue?["details"]
        let face: ToolFace
        var outputDiff: JSONValue?
        switch state {
        case .running:
            // Partial output streams as it arrives: shell as terminal text,
            // anything else (an agent's progress) as plain text.
            let text = trimLines(joined)
            if text.isEmpty {
                face = .pending
            } else {
                face = category == .shell ? .terminal(text: text, notices: [], diff: nil) : .text(text)
            }
        case .failed:
            // The call's own text, then its error diagnostics: pi-durable reports
            // an exit status or a missing file as an `[error]` diagnostic where
            // pi puts it in the text ("…\n\nCommand exited with code N").
            let text = trimLines(stripScriptHeader(texts, tool: tool).joined(separator: "\n"))
            let reasons = diagnostics.compactMap(Self.errorMessage)
            face = .error(([text] + reasons).filter { !$0.isEmpty }.joined(separator: "\n\n"))
        case .ok:
            if let result, case .object(let fields) = result, fields["content"] == nil {
                // Not a {content, details?} result (a foreign tool returning a
                // bare object): its JSON is all there is to show.
                face = .text(result.prettyString)
            } else {
                face = settledFace(tool: tool, args: args, category: category, texts: texts,
                                   joined: joined, details: details)
            }
            switch face {
            case .text(let text): outputDiff = outputDiffIn(text)
            case .script(_, let output): outputDiff = outputDiffIn(output)
            default: break
            }
        }
        return ToolResultView(face: face, category: category, diagnostics: diagnostics, outputDiff: outputDiff)
    }

    // MARK: - Settled faces

    private static func settledFace(tool: String, args: [String: JSONValue], category: ToolCategory,
                                    texts: [String], joined: String, details: JSONValue?) -> ToolFace {
        switch category {
        case .shell:
            guard detailsFit(details, ["truncation", "fullOutputPath"]) else { return .text(trimLines(joined)) }
            let (body, notices) = details?["truncation"] != nil
                ? splitNotice(joined) : (joined, [])
            let text = trimLines(body)
            return .terminal(text: text, notices: notices, diff: outputDiffIn(text))
        case .reads where tool == "read":
            guard detailsFit(details, ["truncation"]) else { return .text(trimLines(joined)) }
            let (body, notices) = splitReadNotice(joined)
            return .file(text: trimTrailingEmptyLines(body),
                         lang: path(args).flatMap(ToolKinds.language(forPath:)), notices: notices)
        case .reads:
            // Another agent's file reader: the text as read, highlighted by
            // its path; its details (if any) are not pi's, so no notices.
            return .file(text: trimTrailingEmptyLines(joined),
                         lang: path(args).flatMap(ToolKinds.language(forPath:)), notices: [])
        case .edits where tool == "edit":
            guard detailsFit(details, ["diff", "patch", "firstChangedLine"]) else { return .text(trimLines(joined)) }
            let hunks = (details?["patch"]?.stringValue).flatMap(ToolKinds.parseDiff)?["hunks"]?.arrayValue
            return .diff(hunks: hunks, confirmation: joined.isEmpty ? nil : joined)
        case .writes where tool == "write":
            guard detailsFit(details, []) else { return .text(trimLines(joined)) }
            return .confirmation(trimLines(joined))
        case .searches:
            let allowed: [String: [String]] = [
                "grep": ["truncation", "matchLimitReached", "linesTruncated"],
                "find": ["truncation", "resultLimitReached"],
                "ls": ["truncation", "entryLimitReached"],
            ]
            guard let keys = allowed[tool], detailsFit(details, keys) else { return .text(trimLines(joined)) }
            let flagged = !(details?.objectValue ?? [:]).isEmpty
            let (body, notices) = flagged ? splitNotice(joined) : (joined, [])
            return .lines(text: trimLines(body), notices: notices)
        case .codemode:
            // Older codemode (and mcpscript) results carry no details.calls:
            // still a script's output, with no calls to list.
            return .script(calls: scriptCalls(details) ?? [],
                           output: trimLines(stripScriptHeader(texts, tool: tool).joined(separator: "\n")))
        case .web, .agents:
            // Web and agent tools come from extensions with their own details;
            // their text is prose either way.
            let text = trimLines(joined)
            return text.isEmpty ? .text(text) : .markdown(text)
        default:
            return .text(trimLines(joined))
        }
    }

    /// Leading and trailing blank lines dropped (pi's renderers trim output);
    /// the first line's indentation is kept.
    static func trimLines(_ text: String) -> String {
        var view = Substring(text)
        while let last = view.last, last.isWhitespace { view = view.dropLast() }
        while let newline = view.firstIndex(of: "\n"),
              view[..<newline].allSatisfy(\.isWhitespace) {
            view = view[view.index(after: newline)...]
        }
        return String(view)
    }

    /// Trailing empty lines dropped (pi's read renderer).
    private static func trimTrailingEmptyLines(_ text: String) -> String {
        var view = Substring(text)
        while view.hasSuffix("\n") { view = view.dropLast() }
        return String(view)
    }

    // MARK: - Spec helpers

    /// The message of an `[error] …` harness diagnostic line, nil otherwise.
    public static func errorMessage(_ diagnostic: String) -> String? {
        diagnostic.hasPrefix("[error] ") ? String(diagnostic.dropFirst("[error] ".count)) : nil
    }

    /// A harness diagnostic line as a notice: `[info]` / `[warn]` dropped (pi
    /// shows the same notices bare); other severities kept.
    public static func noticeText(_ diagnostic: String) -> String {
        for prefix in ["[info] ", "[warn] "] where diagnostic.hasPrefix(prefix) {
            return String(diagnostic.dropFirst(prefix.count))
        }
        return diagnostic
    }

    /// `details` validates when absent / null, or an object whose keys are all
    /// among the tool's declared ones (pi omits empty details, or stores {}).
    private static func detailsFit(_ details: JSONValue?, _ keys: [String]) -> Bool {
        switch details {
        case nil, .null?: return true
        case .object(let fields)?: return Set(fields.keys).isSubset(of: Set(keys))
        default: return false
        }
    }

    private static func textBlocks(_ result: JSONValue?) -> [String] {
        (result?["content"]?.arrayValue ?? []).compactMap { block in
            block["type"]?.stringValue == "text" ? block["text"]?.stringValue : nil
        }
    }

    /// pi-durable's diagnostics block (harness/tool.js appendToolResult): the
    /// last text block, exactly `<harness>\n…\n</harness>`. Removed from the
    /// text and returned as one entry per diagnostic, `[severity] message`. A
    /// message may span lines (it is written unescaped), so a line that
    /// doesn't open with a severity continues the one before it.
    private static func takeHarnessBlock(_ texts: inout [String]) -> [String] {
        guard let last = texts.last, last.hasPrefix("<harness>\n"), last.hasSuffix("\n</harness>")
        else { return [] }
        texts.removeLast()
        var out: [String] = []
        for line in last.dropFirst("<harness>\n".count).dropLast("\n</harness>".count)
            .split(separator: "\n", omittingEmptySubsequences: false) {
            if line.range(of: #"^\[[a-z]+\] "#, options: .regularExpression) != nil || out.isEmpty {
                out.append(String(line))
            } else {
                out[out.count - 1] += "\n" + line
            }
        }
        return out.filter { !$0.isEmpty }
    }

    /// The trailing notice block pi appends after a blank line:
    /// `…\n\n[notice]` (bash truncation; grep/find/ls notices joined with
    /// ". " — kept as one line, since ". " also occurs inside a notice).
    private static func splitNotice(_ text: String) -> (String, [String]) {
        guard text.hasSuffix("]"), let open = text.range(of: "\n\n[", options: .backwards) else {
            return (text, [])
        }
        let notice = String(text[open.upperBound..<text.index(before: text.endIndex)])
        return (String(text[..<open.lowerBound]), [notice])
    }

    /// read's notices are recognised by their templates (a ranged read adds
    /// one with no details), so file text ending in brackets is never cut.
    private static func splitReadNotice(_ text: String) -> (String, [String]) {
        let (body, notices) = splitNotice(text)
        guard let notice = notices.first else { return (text, []) }
        let templates = [#"^\d+ more lines in file\. Use offset=\d+ to continue\.$"#,
                         #"^Showing lines \d+-\d+ of \d+( \([^)]*\))?\. Use offset=\d+ to continue\.$"#]
        let known = templates.contains { notice.range(of: $0, options: .regularExpression) != nil }
        return known ? (body, notices) : (text, [])
    }

    /// The parsed diff block when output is a unified diff. A plain `@@ -`
    /// search gates the parse, so output without one costs a single scan.
    static func outputDiffIn(_ text: String) -> JSONValue? {
        guard hasHunkHeaderStart(text) else { return nil }
        return ToolKinds.parseDiff(text)
    }

    /// Whether a line starts with `@@ -`: a byte scan (Foundation's
    /// `contains` costs ten times more on large output).
    private static func hasHunkHeaderStart(_ text: String) -> Bool {
        let bytes = Array("@@ -".utf8)
        var lineStart = true
        var matched = 0
        for byte in text.utf8 {
            if matched > 0 || lineStart {
                if byte == bytes[matched] {
                    matched += 1
                    if matched == bytes.count { return true }
                    lineStart = false
                    continue
                }
                matched = 0
            }
            lineStart = byte == 0x0A
        }
        return false
    }

    /// Text blocks without codemode's leading header block
    /// (`Script completed|failed\nWall time S seconds\nOutput:\n`).
    private static func stripScriptHeader(_ texts: [String], tool: String) -> [String] {
        guard ToolKinds.isCodemodeFamily(tool), let first = texts.first,
              first.range(of: #"^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$"#,
                          options: .regularExpression) != nil
        else { return texts }
        return Array(texts.dropFirst())
    }

    private static func scriptCalls(_ details: JSONValue?) -> [ScriptCall]? {
        guard let object = details?.objectValue, Set(object.keys).isSubset(of: ["calls", "fullOutputPath"]),
              let calls = object["calls"]?.arrayValue else { return nil }
        var out: [ScriptCall] = []
        for call in calls {
            guard let name = call["name"]?.stringValue, let status = call["status"]?.stringValue
            else { return nil }
            out.append(ScriptCall(name: name, args: call["args"]?.stringValue ?? "", status: status,
                                  durationMs: call["durationMs"]?.intValue, error: call["error"]?.stringValue))
        }
        return out
    }

    private static func path(_ args: [String: JSONValue]) -> String? {
        for key in ["path", "file_path"] {
            if let p = args[key]?.stringValue { return p }
        }
        return nil
    }
}

extension JSONValue {
    /// Pretty-printed JSON (the raw-args section, and a result that is a bare
    /// object).
    public var prettyString: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
        if let data = try? encoder.encode(self), let string = String(data: data, encoding: .utf8) {
            return string
        }
        return ""
    }
}
