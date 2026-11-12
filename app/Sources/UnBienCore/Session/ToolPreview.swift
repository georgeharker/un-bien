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
        if ToolKinds.isBashFamily(tool) || ToolKinds.isCodemodeFamily(tool) {
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
    /// text is shown whole). Trailing empty lines don't count, as in pi. One
    /// byte scan counts the lines; only the kept ones are copied.
    public func cut(_ text: String) -> (text: String, hidden: Int) {
        let utf8 = text.utf8
        var end = utf8.endIndex
        while end > utf8.startIndex, utf8[utf8.index(before: end)] == 0x0A { end = utf8.index(before: end) }
        let body = utf8[utf8.startIndex..<end]
        let total = body.isEmpty ? 0 : body.reduce(1) { $1 == 0x0A ? $0 + 1 : $0 }
        guard total > lines else { return (text, 0) }
        var cutAt: String.Index
        if fromEnd {
            // Back from the end to the newline before the last `lines` lines.
            var seen = 0
            cutAt = end
            while cutAt > utf8.startIndex {
                let previous = utf8.index(before: cutAt)
                if utf8[previous] == 0x0A {
                    seen += 1
                    if seen == lines { break }
                }
                cutAt = previous
            }
            return (String(text[cutAt..<end]), total - lines)
        }
        var seen = 0
        cutAt = utf8.startIndex
        while cutAt < end {
            if utf8[cutAt] == 0x0A {
                seen += 1
                if seen == lines { break }
            }
            cutAt = utf8.index(after: cutAt)
        }
        return (String(text[utf8.startIndex..<cutAt]), total - lines)
    }
}
