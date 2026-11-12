import Foundation

/// How a tool card starts: open, open as a short preview, or closed. A tap on
/// the card still opens or closes it, and that choice is remembered per card.
public enum ToolDisclosure: String, CaseIterable, Codable, Sendable {
    case expanded
    /// A short preview (pi-style: the last lines of shell output, the first of
    /// a search). Until the preview body lands (tool faces stage 5) a preview
    /// card opens fully, as reads and searches did before categories.
    case preview
    case collapsed
}

/// The per-category display defaults (Settings → Tool results), plus "always
/// open failed calls". One value flows to the card, the height estimator and
/// the prewarm resolver, and its `fingerprint` keys the height cache, so a
/// changed default never leaves stale heights behind (design
/// 01M77YDWSZFD6WCYVFT3Z73SWJ).
public struct ToolDisplayPolicy: Equatable, Hashable, Codable, Sendable {
    /// Keyed by `ToolCategory.rawValue` so the stored JSON stays stable.
    public private(set) var defaults: [String: ToolDisclosure]
    public var expandFailed: Bool

    public init(defaults: [ToolCategory: ToolDisclosure], expandFailed: Bool) {
        self.defaults = Dictionary(uniqueKeysWithValues: defaults.map { ($0.key.rawValue, $0.value) })
        self.expandFailed = expandFailed
    }

    /// Shell output and diffs open; reads and searches preview; MCP, agents,
    /// web and other tools closed; failed calls open.
    public static let standard = ToolDisplayPolicy(defaults: [
        .shell: .expanded, .edits: .expanded, .writes: .expanded, .codemode: .expanded,
        .reads: .preview, .searches: .preview,
        .mcp: .collapsed, .agents: .collapsed, .web: .collapsed, .other: .collapsed,
    ], expandFailed: true)

    /// Every category closed (the former "Expand rich tool results" off).
    public static let allCollapsed = ToolDisplayPolicy(
        defaults: Dictionary(uniqueKeysWithValues: ToolCategory.allCases.map { ($0, ToolDisclosure.collapsed) }),
        expandFailed: true)

    /// The default for `category`; a category missing from stored settings
    /// (one added after they were saved) takes the standard default.
    public subscript(category: ToolCategory) -> ToolDisclosure {
        get { defaults[category.rawValue] ?? Self.standard.defaults[category.rawValue] ?? .collapsed }
        set { defaults[category.rawValue] = newValue }
    }

    /// How `card` starts, before any tap.
    public func disclosure(for card: ToolCard) -> ToolDisclosure {
        if expandFailed && card.state == .failed { return .expanded }
        return self[ToolFaceResolver.category(tool: card.tool)]
    }

    /// Stable identity of the layout this policy produces (height-cache key).
    public var fingerprint: String {
        let parts = ToolCategory.allCases.map { "\($0.rawValue)=\(self[$0].rawValue)" }
        return parts.joined(separator: ",") + "|failed=\(expandFailed)"
    }
}
