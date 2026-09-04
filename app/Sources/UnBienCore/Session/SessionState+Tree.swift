import Foundation

/// One row of the branch/tree browser — a flattened view of the session's entry
/// tree (design 01M1FTV2, append 8). Depth increments ONLY past a branch point,
/// so a linear run stays flush-left and only actual divergence indents.
public struct BranchTreeRow: Identifiable, Equatable, Sendable {
    public let id: String          // pi entry id (navigate target)
    public let depth: Int          // indent level (branch-point count above)
    public let label: String       // display text OR a synthesized summary
    public let kind: String        // user/assistant/tool/reasoning/image/…
    public let isLeaf: Bool         // a branch TIP (no children)
    public let isOnPath: Bool       // on the current active path
    public let isBranchPoint: Bool  // has >1 child
}

extension SessionState {
    /// True when the tree diverges anywhere (some entry has >1 child, or there
    /// is >1 root). Drives whether the tree badge shows at all — a linear
    /// session has no tree to browse.
    public var hasBranches: Bool {
        var counts: [String: Int] = [:]
        for (_, parent) in entryParent { counts[parent, default: 0] += 1 }
        return counts.contains { $0.value > 1 }
    }

    /// Ids of entries that HAVE more than one child — the fork points. Used to
    /// annotate the transcript (a branch glyph next to the Pi/You indicator).
    public var branchPointIds: Set<String> {
        var counts: [String: Int] = [:]
        for (_, parent) in entryParent { counts[parent, default: 0] += 1 }
        var out = Set<String>()
        for (parent, n) in counts where n > 1 && !parent.isEmpty { out.insert(parent) }
        return out
    }

    /// Fuller entry text for the long-press preview — untruncated for
    /// user/assistant messages, the synthesized summary for non-text kinds.
    public func entryPreview(_ id: String) -> String {
        let e = entriesById[id]
        switch Self.treeKind(e) {
        case "user", "assistant":
            let t = (e?["message"]?["content"]?.joinedText() ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? Self.treeLabel(e) : t
        default:
            return Self.treeLabel(e)
        }
    }

    /// The tree flattened into display order (DFS from roots, children by id).
    /// `leavesOnly` emits only the branch tips; otherwise every entry as one
    /// inset line (pi /tree style). Reads the retained tree — no wire call.
    public func branchTreeRows(leavesOnly: Bool) -> [BranchTreeRow] {
        var children: [String: [String]] = [:]
        for (id, parent) in entryParent { children[parent, default: []].append(id) }
        for k in children.keys { children[k]?.sort() }
        // Roots = entries whose parent is "" or points outside the folded set.
        let roots = entryParent.keys
            .filter { (entryParent[$0]?.isEmpty ?? true)
                || entriesById[entryParent[$0] ?? ""] == nil }
            .sorted()

        var rows: [BranchTreeRow] = []
        var seen = Set<String>()
        func visit(_ id: String, _ depth: Int) {
            guard seen.insert(id).inserted else { return }  // cycle guard
            let kids = children[id] ?? []
            let isLeaf = kids.isEmpty
            let branchPoint = kids.count > 1
            if !leavesOnly || isLeaf {
                rows.append(BranchTreeRow(
                    id: id, depth: depth,
                    label: Self.treeLabel(entriesById[id]),
                    kind: Self.treeKind(entriesById[id]),
                    isLeaf: isLeaf, isOnPath: pathIds.contains(id),
                    isBranchPoint: branchPoint))
            }
            let childDepth = branchPoint ? depth + 1 : depth
            for kid in kids { visit(kid, childDepth) }
        }
        for r in roots { visit(r, 0) }
        return rows
    }

    // MARK: - Label synthesis (design append 8: non-text entries get a summary)

    static func treeKind(_ entry: JSONValue?) -> String {
        switch entry?["type"]?.stringValue {
        case "compaction": return "compaction"
        case "branch_summary": return "branch"
        case "model_change": return "model"
        case "thinking_level_change": return "thinking"
        case "message":
            let msg = entry?["message"]
            switch msg?["role"]?.stringValue {
            case "user": return "user"
            case "toolResult": return "toolResult"
            case "assistant":
                if let t = msg?["content"]?.joinedText(),
                   !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return "assistant"
                }
                let blocks = msg?["content"]?.arrayValue ?? []
                if blocks.contains(where: { $0["type"]?.stringValue == "toolCall" }) { return "tool" }
                if blocks.contains(where: { $0["type"]?.stringValue == "thinking" }) { return "reasoning" }
                if blocks.contains(where: { $0["type"]?.stringValue == "image" }) { return "image" }
                return "assistant"
            default: return "message"
            }
        default: return "other"
        }
    }

    static func treeLabel(_ entry: JSONValue?) -> String {
        func trim(_ s: String, _ n: Int = 64) -> String {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\n", with: " ")
            return t.count > n ? String(t.prefix(n)) + "…" : t
        }
        let msg = entry?["message"]
        switch treeKind(entry) {
        case "user":
            let t = trim(msg?["content"]?.joinedText() ?? "")
            if !t.isEmpty { return t }
            if (msg?["content"]?.arrayValue ?? []).contains(where: {
                $0["type"]?.stringValue == "image"
            }) { return "🖼 image" }
            return "(user)"
        case "assistant":
            return trim(msg?["content"]?.joinedText() ?? "")
        case "tool":
            let name = (msg?["content"]?.arrayValue ?? [])
                .first(where: { $0["type"]?.stringValue == "toolCall" })?["name"]?
                .stringValue ?? "tool"
            return "🔧 " + name
        case "reasoning": return "💭 reasoning"
        case "image": return "🖼 image"
        case "toolResult": return "✓ tool result"
        case "compaction": return "⚙︎ context compacted"
        case "branch":
            return "⎇ " + trim(entry?["summary"]?.stringValue ?? "branch summary")
        case "model":
            return "model: " + (entry?["provider"]?.stringValue
                ?? entry?["model"]?.stringValue ?? "changed")
        case "thinking":
            return "thinking: " + (entry?["level"]?.stringValue ?? "changed")
        default:
            return entry?["type"]?.stringValue ?? "entry"
        }
    }
}
