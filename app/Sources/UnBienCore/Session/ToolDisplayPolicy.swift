import Foundation

/// How a tool card starts: open, open as a short preview, or closed. A tap on
/// the card still opens or closes it, and that choice is remembered per card.
public enum ToolDisclosure: String, CaseIterable, Codable, Sendable {
    case expanded
    /// Open, with the result shortened as pi's collapsed renderers do (the
    /// last lines of shell output, the first of a read or search: ToolPreview)
    /// and an "N more lines" row that shows it in full.
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
    /// Agent cards show the task they were given (a PROMPT section) above
    /// the agent's report. Separate from "Hide input on rich results", which
    /// hides the raw arguments.
    public var showAgentPrompts: Bool

    public init(defaults: [ToolCategory: ToolDisclosure], expandFailed: Bool, showAgentPrompts: Bool = true) {
        self.defaults = Dictionary(uniqueKeysWithValues: defaults.map { ($0.key.rawValue, $0.value) })
        self.expandFailed = expandFailed
        self.showAgentPrompts = showAgentPrompts
    }

    private enum CodingKeys: String, CodingKey { case defaults, expandFailed, showAgentPrompts }

    /// Settings saved before a field existed take its standard value.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaults = try container.decode([String: ToolDisclosure].self, forKey: .defaults)
        expandFailed = try container.decodeIfPresent(Bool.self, forKey: .expandFailed) ?? true
        showAgentPrompts = try container.decodeIfPresent(Bool.self, forKey: .showAgentPrompts) ?? true
    }

    /// Shell output and diffs open; reads and searches preview; MCP, agents,
    /// web and other tools closed; failed calls open.
    public static let standard = ToolDisplayPolicy(defaults: [
        .shell: .expanded, .edits: .expanded, .writes: .expanded, .codemode: .expanded,
        .reads: .preview, .searches: .preview,
        .mcp: .collapsed, .agents: .collapsed, .web: .collapsed, .other: .collapsed,
    ], expandFailed: true)

    /// Every category closed; failed calls still open.
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
        return parts.joined(separator: ",") + "|failed=\(expandFailed)|prompts=\(showAgentPrompts)"
    }
}
