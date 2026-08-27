import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// User typography preferences, injected via the environment (like `appTheme`).
/// `monoFontName` is a registered family name (e.g. "MesloLGS Nerd Font") or
/// nil for the system monospaced font; it drives code blocks and the composer.
public struct Typography: Sendable, Equatable {
    public var textScale: Double
    public var monoFontName: String?

    public init(textScale: Double = 1.0, monoFontName: String? = nil) {
        self.textScale = textScale
        self.monoFontName = monoFontName
    }

    /// Base body point size (bubbles, markdown) after scaling.
    public var bodySize: CGFloat { 15 * textScale }
    /// Code / monospace point size after scaling.
    public var codeSize: CGFloat { 13 * textScale }

    /// SwiftUI monospaced font honoring the chosen family + size.
    public func monoFont(size: CGFloat? = nil) -> Font {
        let pt = size ?? codeSize
        if let name = monoFontName, !name.isEmpty {
            return .custom(name, fixedSize: pt)
        }
        return .system(size: pt, design: .monospaced)
    }

    #if os(macOS)
    /// Platform monospaced font for NSTextView / Highlightr.
    public func monoPlatformFont(size: CGFloat? = nil) -> NSFont {
        let pt = size ?? codeSize
        if let name = monoFontName, !name.isEmpty, let font = NSFont(name: name, size: pt) {
            return font
        }
        return .monospacedSystemFont(ofSize: pt, weight: .regular)
    }
    #else
    /// Platform monospaced font for UITextView / Highlightr.
    public func monoPlatformFont(size: CGFloat? = nil) -> UIFont {
        let pt = size ?? codeSize
        if let name = monoFontName, !name.isEmpty, let font = UIFont(name: name, size: pt) {
            return font
        }
        return .monospacedSystemFont(ofSize: pt, weight: .regular)
    }
    #endif
}

private struct TypographyKey: EnvironmentKey {
    static let defaultValue = Typography()
}

public extension EnvironmentValues {
    var typography: Typography {
        get { self[TypographyKey.self] }
        set { self[TypographyKey.self] = newValue }
    }
}
