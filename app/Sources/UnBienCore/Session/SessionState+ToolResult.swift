import Foundation

// The ONE tool-result value a card holds, whichever path delivered it (design
// 01M77YDWSZFD6WCYVFT3Z73SWJ): pi's AgentToolResult reduced to what the
// session record also stores, `{content, details?}`.
//
//   live   — `tool_execution_end.result` (and `_update.partialResult`);
//   replay — the stored toolResult message's `content` and `details`.
//
// Fields only the live object carries (structuredContent, usage, terminate, a
// nested isError) are dropped: the record has no copy of them, so keeping them
// would make a live card differ from its own replay. `isError` and
// `durationMs` ride the frame / message top level and land on the card as
// state and duration.
extension SessionState {
    /// Canonical `{content, details?}` for any result shape a producer sends:
    /// pi's object; a bare content array; a joined-text string (the pre-1.5
    /// durable translator) — as the whole result or as `content`. `details` is
    /// kept exactly as sent: absent stays absent, and any JSON value (pi types
    /// it JsonValue) passes through. An object without content is a foreign
    /// shape, returned as-is.
    static func canonicalToolResult(_ raw: JSONValue?) -> JSONValue? {
        switch raw {
        case nil, .null?:
            return nil
        case .string(let text)?:
            return .object(["content": textContent(text)])
        case .array(let blocks)?:
            return .object(["content": .array(blocks)])
        case .object(let fields)?:
            let content: JSONValue
            switch fields["content"] {
            case .array(let blocks)?: content = .array(blocks)
            case .string(let text)?: content = textContent(text)
            default: return raw
            }
            var canonical: [String: JSONValue] = ["content": content]
            if let details = fields["details"] { canonical["details"] = details }
            return .object(canonical)
        default:
            return raw
        }
    }

    private static func textContent(_ text: String) -> JSONValue {
        .array([.object(["type": .string("text"), "text": .string(text)])])
    }

    /// The canonical result a STORED toolResult message carries.
    static func storedToolResult(_ message: JSONValue) -> JSONValue? {
        var fields: [String: JSONValue] = ["content": message["content"] ?? .array([])]
        if let details = message.objectValue?["details"] { fields["details"] = details }
        return canonicalToolResult(.object(fields))
    }
}

extension ToolCard {
    /// What a failed call reported, as its error face draws it: the content's
    /// text, then the harness block's error diagnostics (pi puts a thrown
    /// error's message, an exit status, or a script error in the content;
    /// pi-durable reports an exit status or a missing file as a diagnostic).
    /// nil unless the card failed.
    public var errorText: String? {
        guard state == .failed, case .error(let text) = ToolFaceResolver.resolve(self).face else { return nil }
        return text.isEmpty ? nil : text
    }
}
