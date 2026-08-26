import Highlightr
import MarkdownUI
import SwiftUI

/// Minimal design-token palette (Tokyo Night). The full curated multi-theme
/// system (DESIGN §11) is a later phase; this is the default so the transcript
/// renders in the intended shape now.
public struct AppTheme: Sendable {
    public let background: Color
    public let surface: Color
    public let text: Color
    public let secondaryText: Color
    public let accent: Color
    public let toolAccent: Color
    public let error: Color
    public let success: Color
    /// highlight.js style name used by Highlightr for code blocks.
    public let codeHighlightStyle: String

    public static let tokyoNight = AppTheme(
        background: Color(hex: 0x1A1B26),
        surface: Color(hex: 0x24283B),
        text: Color(hex: 0xC0CAF5),
        secondaryText: Color(hex: 0x565F89),
        accent: Color(hex: 0x7AA2F7),
        toolAccent: Color(hex: 0xBB9AF7),
        error: Color(hex: 0xF7768E),
        success: Color(hex: 0x9ECE6A),
        codeHighlightStyle: "tomorrow-night"
    )
}

public extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// Bridges Highlightr (highlight.js, 180+ languages) into swift-markdown-ui's
/// `CodeSyntaxHighlighter` (DESIGN §7). Agents emit arbitrary languages, so a
/// general highlighter is the right fit.
public struct HighlightrCodeSyntaxHighlighter: CodeSyntaxHighlighter {
    private let highlightr: Highlightr?

    public init(style: String) {
        let instance = Highlightr()
        instance?.setTheme(to: style)
        self.highlightr = instance
    }

    public func highlightCode(_ code: String, language: String?) -> Text {
        guard let highlightr,
              let highlighted = highlightr.highlight(code, as: language, fastRender: true) else {
            return Text(code)
        }
        return Text(AttributedString(highlighted))
    }
}

public extension CodeSyntaxHighlighter where Self == HighlightrCodeSyntaxHighlighter {
    static func highlightr(style: String) -> HighlightrCodeSyntaxHighlighter {
        HighlightrCodeSyntaxHighlighter(style: style)
    }
}
