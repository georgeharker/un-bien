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
        codeHighlightStyle: "tokyo-night-dark",
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

    // MARK: - Neovim-space themes (user 2026-09-17). Code-highlight styles map
    // to the nearest style BUNDLED with Highlightr — catppuccin and jellybeans
    // have no bundled highlight.js style, so they borrow the closest dark
    // pastel/warm style until custom CSS injection lands.

    /// Catppuccin Mocha — base/mantle/surface0 + text/subtext0 + blue/mauve/
    /// red/green (catppuccin.com/palette, verified 2026-09-17).
    public static let catppuccinMocha = AppTheme(
        background: Color(hex: 0x1E1E2E),
        surface: Color(hex: 0x313244),
        text: Color(hex: 0xCDD6F4),
        secondaryText: Color(hex: 0xA6ADC8),
        accent: Color(hex: 0x89B4FA),
        toolAccent: Color(hex: 0xCBA6F7),
        error: Color(hex: 0xF38BA8),
        success: Color(hex: 0xA6E3A1),
        // No bundled catppuccin style — tokyo-night-dark is the nearest soft
        // pastel dark.
        codeHighlightStyle: "tokyo-night-dark",
        isDark: true
    )

    /// Dracula — canonical palette (draculatheme.com).
    public static let dracula = AppTheme(
        background: Color(hex: 0x282A36),
        surface: Color(hex: 0x44475A),
        text: Color(hex: 0xF8F8F2),
        secondaryText: Color(hex: 0x6272A4),
        accent: Color(hex: 0xBD93F9),
        toolAccent: Color(hex: 0xFF79C6),
        error: Color(hex: 0xFF5555),
        success: Color(hex: 0x50FA7B),
        codeHighlightStyle: "dracula",
        isDark: true
    )

    /// One Dark — Atom One Dark / onedark.nvim.
    public static let oneDark = AppTheme(
        background: Color(hex: 0x282C34),
        surface: Color(hex: 0x3E4451),
        text: Color(hex: 0xABB2BF),
        secondaryText: Color(hex: 0x5C6370),
        accent: Color(hex: 0x61AFEF),
        toolAccent: Color(hex: 0xC678DD),
        error: Color(hex: 0xE06C75),
        success: Color(hex: 0x98C379),
        codeHighlightStyle: "onedark",
        isDark: true
    )

    /// Jellybeans — nanotech/jellybeans.vim (hexes verified from source:
    /// bg #151515, fg #E8E8D3, Comment #888888, String #99AD6A,
    /// Identifier #C6B6EE, PreProc #8FBFDC; its warm red #CF6A4C).
    public static let jellybeans = AppTheme(
        background: Color(hex: 0x151515),
        surface: Color(hex: 0x303030),
        text: Color(hex: 0xE8E8D3),
        secondaryText: Color(hex: 0x888888),
        accent: Color(hex: 0x8FBFDC),
        toolAccent: Color(hex: 0xC6B6EE),
        error: Color(hex: 0xCF6A4C),
        success: Color(hex: 0x99AD6A),
        // No bundled jellybeans style — monokai is the nearest warm dark.
        codeHighlightStyle: "monokai",
        isDark: true
    )

    /// Rosé Pine — main variant (palette.json, verified 2026-09-17: pine is
    /// teal #31748F, foam #9CCFD8, iris #C4A7E7).
    public static let rosePine = AppTheme(
        background: Color(hex: 0x191724),
        surface: Color(hex: 0x1F1D2E),
        text: Color(hex: 0xE0DEF4),
        secondaryText: Color(hex: 0x908CAA),
        accent: Color(hex: 0x31748F),
        toolAccent: Color(hex: 0xC4A7E7),
        error: Color(hex: 0xEB6F92),
        success: Color(hex: 0x9CCFD8),
        codeHighlightStyle: "rose-pine",
        isDark: true
    )

    /// Monokai — the classic (bg #272822, the purist's default before themes
    /// had names).
    public static let monokai = AppTheme(
        background: Color(hex: 0x272822),
        surface: Color(hex: 0x3E3D32),
        text: Color(hex: 0xF8F8F2),
        secondaryText: Color(hex: 0x75715E),
        accent: Color(hex: 0x66D9EF),
        toolAccent: Color(hex: 0xAE81FF),
        error: Color(hex: 0xF92672),
        success: Color(hex: 0xA6E22E),
        codeHighlightStyle: "monokai",
        isDark: true
    )

    /// Kanagawa Wave — rebelangelton/kanagawa.nvim default (hexes from its
    /// palette: sumiInk1 bg, sumiInk2 surface, sumiInk4 grey, fujiWhite fg,
    /// crystalBlue, oniViolet, springGreen, samuraiRed).
    public static let kanagawa = AppTheme(
        background: Color(hex: 0x1F1F28),
        surface: Color(hex: 0x2A2A37),
        text: Color(hex: 0xDCDCDC),
        secondaryText: Color(hex: 0x727169),
        accent: Color(hex: 0x7E9CD8),
        toolAccent: Color(hex: 0x957FB8),
        error: Color(hex: 0xE46876),
        success: Color(hex: 0x98BB6C),
        // No bundled kanagawa style — tokyo-night-dark is the nearest
        // blue/violet-toned dark.
        codeHighlightStyle: "tokyo-night-dark",
        isDark: true
    )

    /// Everforest (medium dark) — sainnhe/everforest, gruvbox-inspired but
    /// forest-toned and lower contrast.
    public static let everforest = AppTheme(
        background: Color(hex: 0x2B3339),
        surface: Color(hex: 0x323C41),
        text: Color(hex: 0xD3C6AA),
        secondaryText: Color(hex: 0x9DA9A0),
        accent: Color(hex: 0x7FBBB3),
        toolAccent: Color(hex: 0xD699B6),
        error: Color(hex: 0xE67E80),
        success: Color(hex: 0xA7C080),
        // No bundled everforest style — gruvbox-dark-soft is the nearest
        // low-contrast warm dark (everforest is gruvbox-inspired).
        codeHighlightStyle: "gruvbox-dark-soft",
        isDark: true
    )

    /// Ayu Dark — ayu.nvim's flagship variant (signature cyan-blue accents
    /// on near-black).
    public static let ayuDark = AppTheme(
        background: Color(hex: 0x0B0E14),
        surface: Color(hex: 0x131721),
        text: Color(hex: 0xBFBDB6),
        secondaryText: Color(hex: 0x5C6773),
        accent: Color(hex: 0x39BAE6),
        toolAccent: Color(hex: 0xD2A6FF),
        error: Color(hex: 0xE06B75),
        success: Color(hex: 0xAAD94C),
        // No bundled ayu style — atom-one-dark is the nearest.
        codeHighlightStyle: "atom-one-dark",
        isDark: true
    )

    /// Melange (dark) — savq/melange-nvim (hexes verified from its palette
    /// source: "control flow warm, data cold" — hence warm bg, cool accents).
    public static let melange = AppTheme(
        background: Color(hex: 0x292522),
        surface: Color(hex: 0x34302C),
        text: Color(hex: 0xECE1D7),
        secondaryText: Color(hex: 0xC1A78E),
        accent: Color(hex: 0xA3A9CE),
        toolAccent: Color(hex: 0xCF9BC2),
        error: Color(hex: 0xD47766),
        success: Color(hex: 0x85B695),
        // No bundled melange style — gruvbox-dark-soft is the nearest warm,
        // low-contrast dark.
        codeHighlightStyle: "gruvbox-dark-soft",
        isDark: true
    )

    /// Modus Vivendi — Protesilaos's Emacs flagship, ported widely; black bg,
    /// high-contrast WCAG-compliant palette (hexes verified from
    /// modus-themes.el).
    public static let modusVivendi = AppTheme(
        background: Color(hex: 0x000000),
        surface: Color(hex: 0x1E1E1E),
        text: Color(hex: 0xFFFFFF),
        secondaryText: Color(hex: 0x989898),
        accent: Color(hex: 0x2FAFFF),
        toolAccent: Color(hex: 0xFEACD0),
        error: Color(hex: 0xFF5F59),
        success: Color(hex: 0x44BC44),
        // No bundled modus style — vs-dark is the nearest flat high-contrast
        // dark.
        codeHighlightStyle: "vs",
        isDark: true
    )

    /// Catppuccin Frappé — the mid-tone flavor.
    public static let catppuccinFrappe = AppTheme(
        background: Color(hex: 0x303446),
        surface: Color(hex: 0x414559),
        text: Color(hex: 0xC6D0F5),
        secondaryText: Color(hex: 0xA5ADCE),
        accent: Color(hex: 0x8CAAEE),
        toolAccent: Color(hex: 0xCAAAEE),
        error: Color(hex: 0xE78284),
        success: Color(hex: 0xA6D189),
        codeHighlightStyle: "tokyo-night-dark",   // nearest (no bundled catppuccin)
        isDark: true
    )

    /// Catppuccin Macchiato — the mid-dark flavor.
    public static let catppuccinMacchiato = AppTheme(
        background: Color(hex: 0x24273A),
        surface: Color(hex: 0x363A4F),
        text: Color(hex: 0xCAD3F5),
        secondaryText: Color(hex: 0xA5ADCB),
        accent: Color(hex: 0x8AADF4),
        toolAccent: Color(hex: 0xC6A0F6),
        error: Color(hex: 0xED8796),
        success: Color(hex: 0xA6DA95),
        codeHighlightStyle: "tokyo-night-dark",   // nearest (no bundled catppuccin)
        isDark: true
    )

    /// Catppuccin Latte — the LIGHT flavor.
    public static let catppuccinLatte = AppTheme(
        background: Color(hex: 0xEFF1F5),
        surface: Color(hex: 0xCCD0DA),
        text: Color(hex: 0x4C4F69),
        secondaryText: Color(hex: 0x6C6F85),
        accent: Color(hex: 0x1E66F5),
        toolAccent: Color(hex: 0x8839EF),
        error: Color(hex: 0xD20F39),
        success: Color(hex: 0x40A02B),
        codeHighlightStyle: "one-light",   // nearest light (no bundled catppuccin)
        isDark: false
    )

    /// Rosé Pine Moon — the mid-dark variant (palette.json, verified).
    public static let rosePineMoon = AppTheme(
        background: Color(hex: 0x232136),
        surface: Color(hex: 0x2A273F),
        text: Color(hex: 0xE0DEF4),
        secondaryText: Color(hex: 0x908CAA),
        accent: Color(hex: 0x3E8FB0),
        toolAccent: Color(hex: 0xC4A7E7),
        error: Color(hex: 0xEB6F92),
        success: Color(hex: 0x9CCFD8),
        codeHighlightStyle: "rose-pine-moon",
        isDark: true
    )

    /// Rosé Pine Dawn — the LIGHT variant (palette.json, verified).
    public static let rosePineDawn = AppTheme(
        background: Color(hex: 0xFAF4ED),
        surface: Color(hex: 0xFFF9F5),
        text: Color(hex: 0x524F6D),
        secondaryText: Color(hex: 0x9893A5),
        accent: Color(hex: 0x286983),
        toolAccent: Color(hex: 0x907AA9),
        error: Color(hex: 0xB4637A),
        success: Color(hex: 0x56949F),
        codeHighlightStyle: "rose-pine-dawn",
        isDark: false
    )
}

/// Selectable theme identity (persisted as its raw value). The curated set for
/// the live picker (DESIGN §11).
public enum ThemeID: String, CaseIterable, Sendable, Identifiable {
    case tokyoNight, nord, gruvboxDark, solarizedLight
    case catppuccinMocha, catppuccinFrappe, catppuccinMacchiato, catppuccinLatte
    case dracula, oneDark, jellybeans, rosePine, rosePineMoon, rosePineDawn
    case monokai, kanagawa, everforest, ayuDark, melange, modusVivendi

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .tokyoNight: return "Tokyo Night"
        case .nord: return "Nord"
        case .gruvboxDark: return "Gruvbox Dark"
        case .solarizedLight: return "Solarized Light"
        case .catppuccinMocha: return "Catppuccin Mocha"
        case .catppuccinFrappe: return "Catppuccin Frappé"
        case .catppuccinMacchiato: return "Catppuccin Macchiato"
        case .catppuccinLatte: return "Catppuccin Latte"
        case .dracula: return "Dracula"
        case .oneDark: return "One Dark"
        case .jellybeans: return "Jellybeans"
        case .rosePine: return "Rosé Pine"
        case .rosePineMoon: return "Rosé Pine Moon"
        case .rosePineDawn: return "Rosé Pine Dawn"
        case .monokai: return "Monokai"
        case .kanagawa: return "Kanagawa Wave"
        case .everforest: return "Everforest"
        case .ayuDark: return "Ayu Dark"
        case .melange: return "Melange"
        case .modusVivendi: return "Modus Vivendi"
        }
    }

    public var theme: AppTheme {
        switch self {
        case .tokyoNight: return .tokyoNight
        case .nord: return .nord
        case .gruvboxDark: return .gruvboxDark
        case .solarizedLight: return .solarizedLight
        case .catppuccinMocha: return .catppuccinMocha
        case .catppuccinFrappe: return .catppuccinFrappe
        case .catppuccinMacchiato: return .catppuccinMacchiato
        case .catppuccinLatte: return .catppuccinLatte
        case .dracula: return .dracula
        case .oneDark: return .oneDark
        case .jellybeans: return .jellybeans
        case .rosePine: return .rosePine
        case .rosePineMoon: return .rosePineMoon
        case .rosePineDawn: return .rosePineDawn
        case .monokai: return .monokai
        case .kanagawa: return .kanagawa
        case .everforest: return .everforest
        case .ayuDark: return .ayuDark
        case .melange: return .melange
        case .modusVivendi: return .modusVivendi
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
    private let style: String
    private let font: PlatformFont?

    // Cheap to construct (swift-markdown-ui rebuilds this per render): the JS
    // runtime + highlight results live in the shared bounded `HighlightEngine`,
    // so no Highlightr is spun up here and repeated blocks hit the cache.
    public init(style: String, font: PlatformFont? = nil) {
        self.style = style
        self.font = font
    }

    public func highlightCode(_ code: String, language: String?) -> Text {
        if let attributed = HighlightEngine.shared.highlighted(code, language: language,
                                                               style: style, font: font) {
            return Text(attributed)
        }
        return Text(code)
    }
}

public extension CodeSyntaxHighlighter where Self == HighlightrCodeSyntaxHighlighter {
    static func highlightr(style: String, font: PlatformFont? = nil) -> HighlightrCodeSyntaxHighlighter {
        HighlightrCodeSyntaxHighlighter(style: style, font: font)
    }
}
