import Highlightr
import MarkdownUI
import SwiftUI
#if os(macOS)
import AppKit
public typealias PlatformFont = NSFont
#else
import UIKit
public typealias PlatformFont = UIFont
#endif

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
    /// Drives `preferredColorScheme` so system controls match the palette.
    public let isDark: Bool

    public static let tokyoNight = AppTheme(
        background: Color(hex: 0x1A1B26),
        surface: Color(hex: 0x24283B),
        text: Color(hex: 0xC0CAF5),
        secondaryText: Color(hex: 0x565F89),
        accent: Color(hex: 0x7AA2F7),
        toolAccent: Color(hex: 0xBB9AF7),
        error: Color(hex: 0xF7768E),
        success: Color(hex: 0x9ECE6A),
        codeHighlightStyle: "tomorrow-night",
        isDark: true
    )

    public static let nord = AppTheme(
        background: Color(hex: 0x2E3440),
        surface: Color(hex: 0x3B4252),
        text: Color(hex: 0xD8DEE9),
        secondaryText: Color(hex: 0x616E88),
        accent: Color(hex: 0x88C0D0),
        toolAccent: Color(hex: 0xB48EAD),
        error: Color(hex: 0xBF616A),
        success: Color(hex: 0xA3BE8C),
        codeHighlightStyle: "nord",
        isDark: true
    )

    public static let gruvboxDark = AppTheme(
        background: Color(hex: 0x282828),
        surface: Color(hex: 0x3C3836),
        text: Color(hex: 0xEBDBB2),
        secondaryText: Color(hex: 0x928374),
        accent: Color(hex: 0x83A598),
        toolAccent: Color(hex: 0xD3869B),
        error: Color(hex: 0xFB4934),
        success: Color(hex: 0xB8BB26),
        codeHighlightStyle: "gruvbox-dark",
        isDark: true
    )

    public static let solarizedLight = AppTheme(
        background: Color(hex: 0xFDF6E3),
        surface: Color(hex: 0xEEE8D5),
        text: Color(hex: 0x073642),
        secondaryText: Color(hex: 0x93A1A1),
        accent: Color(hex: 0x268BD2),
        toolAccent: Color(hex: 0x6C71C4),
        error: Color(hex: 0xDC322F),
        success: Color(hex: 0x859900),
        codeHighlightStyle: "solarized-light",
        isDark: false
    )
}

/// Selectable theme identity (persisted as its raw value). The curated set for
/// the live picker (DESIGN §11).
public enum ThemeID: String, CaseIterable, Sendable, Identifiable {
    case tokyoNight, nord, gruvboxDark, solarizedLight

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .tokyoNight: return "Tokyo Night"
        case .nord: return "Nord"
        case .gruvboxDark: return "Gruvbox Dark"
        case .solarizedLight: return "Solarized Light"
        }
    }

    public var theme: AppTheme {
        switch self {
        case .tokyoNight: return .tokyoNight
        case .nord: return .nord
        case .gruvboxDark: return .gruvboxDark
        case .solarizedLight: return .solarizedLight
        }
    }
}

/// Environment injection so every view reads the *selected* theme without
/// threading it through initializers. Set once at the app root.
private struct AppThemeKey: EnvironmentKey {
    static let defaultValue: AppTheme = .tokyoNight
}

public extension EnvironmentValues {
    var appTheme: AppTheme {
        get { self[AppThemeKey.self] }
        set { self[AppThemeKey.self] = newValue }
    }
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

    public init(style: String, font: PlatformFont? = nil) {
        let instance = Highlightr()
        instance?.setTheme(to: style)
        if let font { instance?.theme.setCodeFont(font) }
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
    static func highlightr(style: String, font: PlatformFont? = nil) -> HighlightrCodeSyntaxHighlighter {
        HighlightrCodeSyntaxHighlighter(style: style, font: font)
    }
}
