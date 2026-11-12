import Foundation

/// How a card in Preview (Settings → Tool results) shortens its result: the
/// line counts of pi's own collapsed renderers — a shell's last 5 lines, a
/// read's first 10, grep's first 15, find's and ls's first 20 — plus
/// codemode's last 5 output lines, and the first 10 lines for any other tool
/// (pi's fallback). Only the result's main text is shortened; the call's
/// input (command, script, diff) and notices show as in full.
public struct ToolPreview: Equatable, Sendable {
    public let lines: Int
    /// Keep the LAST lines (a shell's output ends where it matters).
    public let fromEnd: Bool

    public init(lines: Int, fromEnd: Bool) {
        self.lines = lines
        self.fromEnd = fromEnd
    }

    public static func forTool(_ tool: String) -> ToolPreview {
        if ToolOutputClassifier.isBashFamily(tool) || ToolOutputClassifier.isCodemodeFamily(tool) {
            return ToolPreview(lines: 5, fromEnd: true)
        }
        switch tool {
        case "read": return ToolPreview(lines: 10, fromEnd: false)
        case "grep": return ToolPreview(lines: 15, fromEnd: false)
        case "find", "ls": return ToolPreview(lines: 20, fromEnd: false)
        default: return ToolPreview(lines: 10, fromEnd: false)
        }
    }

    /// `text` cut to the preview's lines, and how many lines that hid (0: the
    /// text is shown whole). Trailing empty lines don't count, as in pi.
    public func cut(_ text: String) -> (text: String, hidden: Int) {
        var all = text.split(separator: "\n", omittingEmptySubsequences: false)
        while let last = all.last, last.isEmpty { all.removeLast() }
        guard all.count > lines else { return (text, 0) }
        let kept = fromEnd ? all.suffix(lines) : all.prefix(lines)
        return (kept.joined(separator: "\n"), all.count - lines)
    }
}
