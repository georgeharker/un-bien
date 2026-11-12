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
}

public enum ToolFaceResolver {
    public static func category(tool: String) -> ToolCategory {
        if ToolOutputClassifier.isBashFamily(tool) { return .shell }
        if ToolOutputClassifier.isCodemodeFamily(tool) { return .codemode }
        switch tool {
        case "read": return .reads
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

    public static func resolve(_ card: ToolCard) -> ToolResultView {
        let category = category(tool: card.tool)
        var texts = textBlocks(card.result)
        let diagnostics = takeHarnessBlock(&texts)
        let joined = texts.joined(separator: "\n")
        let details = card.result?.objectValue?["details"]
        let face: ToolFace
        switch card.state {
        case .running:
            // Partial output streams as it arrives: shell as terminal text,
            // anything else (an agent's progress) as plain text.
            if joined.isEmpty {
                face = .pending
            } else {
                face = category == .shell ? .terminal(text: joined, notices: [], diff: nil) : .text(joined)
            }
        case .failed:
            face = .error(stripScriptHeader(texts, tool: card.tool).joined(separator: "\n"))
        case .ok:
            face = settledFace(card, category: category, texts: texts, joined: joined, details: details)
        }
        return ToolResultView(face: face, category: category, diagnostics: diagnostics)
    }

    // MARK: - Settled faces

    private static func settledFace(_ card: ToolCard, category: ToolCategory, texts: [String],
                                    joined: String, details: JSONValue?) -> ToolFace {
        switch category {
        case .shell:
            guard detailsFit(details, ["truncation", "fullOutputPath"]) else { return .text(joined) }
            let (body, notices) = details?["truncation"] != nil
                ? splitNotice(joined) : (joined, [])
            return .terminal(text: body, notices: notices, diff: shellDiff(body))
        case .reads where card.tool == "read":
            guard detailsFit(details, ["truncation"]) else { return .text(joined) }
            let (body, notices) = splitReadNotice(joined)
            return .file(text: body, lang: path(card.args).flatMap(ToolOutputClassifier.language(forPath:)),
                         notices: notices)
        case .edits where card.tool == "edit":
            guard detailsFit(details, ["diff", "patch", "firstChangedLine"]) else { return .text(joined) }
            let hunks = (details?["patch"]?.stringValue).flatMap(ToolOutputClassifier.parseDiff)?["hunks"]?.arrayValue
            return .diff(hunks: hunks, confirmation: joined.isEmpty ? nil : joined)
        case .writes where card.tool == "write":
            guard detailsFit(details, []) else { return .text(joined) }
            return .confirmation(joined)
        case .searches:
            let allowed: [String: [String]] = [
                "grep": ["truncation", "matchLimitReached", "linesTruncated"],
                "find": ["truncation", "resultLimitReached"],
                "ls": ["truncation", "entryLimitReached"],
            ]
            guard let keys = allowed[card.tool], detailsFit(details, keys) else { return .text(joined) }
            let flagged = !(details?.objectValue ?? [:]).isEmpty
            let (body, notices) = flagged ? splitNotice(joined) : (joined, [])
            return .lines(text: body, notices: notices)
        case .codemode:
            guard let calls = scriptCalls(details) else { return .text(joined) }
            return .script(calls: calls, output: stripScriptHeader(texts, tool: card.tool).joined(separator: "\n"))
        default:
            return .text(joined)
        }
    }

    // MARK: - Spec helpers

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
    /// text and returned as its lines.
    private static func takeHarnessBlock(_ texts: inout [String]) -> [String] {
        guard let last = texts.last, last.hasPrefix("<harness>\n"), last.hasSuffix("\n</harness>")
        else { return [] }
        texts.removeLast()
        return last.dropFirst("<harness>\n".count).dropLast("\n</harness>".count)
            .split(separator: "\n").map(String.init)
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

    /// The parsed diff block when shell output is a unified diff.
    private static func shellDiff(_ text: String) -> JSONValue? {
        guard text.range(of: #"(?m)^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@"#, options: .regularExpression) != nil
        else { return nil }
        return ToolOutputClassifier.parseDiff(text)
    }

    /// Text blocks without codemode's leading header block
    /// (`Script completed|failed\nWall time S seconds\nOutput:\n`).
    private static func stripScriptHeader(_ texts: [String], tool: String) -> [String] {
        guard ToolOutputClassifier.isCodemodeFamily(tool), let first = texts.first,
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
