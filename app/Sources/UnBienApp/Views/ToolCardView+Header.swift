import Foundation
import UnBienCore

// The header subtitle: what the call acts on, after the tool name. pi's
// renderers title a read with its path and line range, an edit, write or ls
// with its path; a web call shows its URL or query, an agent its task; pi's
// `mcp` tool is one tool for every MCP server, so its
// title alone ("mcp") says nothing — the call it makes rides its arguments.
extension ToolCardView {
    /// Whether `tool` is the MCP proxy tool.
    nonisolated static func isMCPProxy(_ tool: String) -> Bool {
        tool.lowercased() == "mcp"
    }

    /// The header subtitle for `card`, and whether it is a path (truncated at
    /// its head, so the file name and range stay visible). Nil when the
    /// arguments name nothing.
    nonisolated static func headerSubtitle(for card: ToolCard) -> (text: String, isPath: Bool)? {
        if let mcp = mcpSubtitle(for: card) { return (mcp, false) }
        // A web call's URL or query; an agent's task description.
        switch ToolFaceResolver.category(tool: card.tool) {
        case .web:
            if let url = stringArg(card.args, ["url"]), !url.isEmpty { return (url, true) }
            if let query = stringArg(card.args, ["query", "q"]), !query.isEmpty { return ("\"\(query)\"", false) }
            return nil
        case .agents:
            if let task = stringArg(card.args, ["description"]), !task.isEmpty { return (task, false) }
            return nil
        default:
            break
        }
        guard ["read", "edit", "write", "ls"].contains(card.tool),
              let path = stringArg(card.args, ["path", "file_path"]), !path.isEmpty
        else { return nil }
        return (card.tool == "read" ? path + readLineRange(card.args) : path, true)
    }

    /// A call's run time for the header: "840ms", "12.3s", "2m 05s"; nil
    /// when unmeasured.
    nonisolated static func durationText(_ ms: Int?) -> String? {
        guard let ms, ms >= 0 else { return nil }
        if ms < 1000 { return "\(ms)ms" }
        if ms < 60_000 { return String(format: "%.1fs", Double(ms) / 1000) }
        let seconds = ms / 1000
        return String(format: "%dm %02ds", seconds / 60, seconds % 60)
    }

    /// A read's line range as pi's read renderer writes it: ":start-end" with
    /// a limit, ":start" with only an offset, nothing for a whole file.
    nonisolated static func readLineRange(_ args: [String: JSONValue]) -> String {
        let offset = args["offset"]?.intValue
        let limit = args["limit"]?.intValue
        if offset == nil && limit == nil { return "" }
        let start = offset ?? 1
        return limit.map { ":\(start)-\(start + $0 - 1)" } ?? ":\(start)"
    }

    /// The header subtitle for an MCP proxy call: the proxied tool's name, or
    /// the discovery verb with its subject. Nil for other tools and for a call
    /// whose arguments name nothing.
    nonisolated static func mcpSubtitle(for card: ToolCard) -> String? {
        guard isMCPProxy(card.tool) else { return nil }
        let args = card.args
        if let tool = stringArg(args, ["tool"]), !tool.isEmpty { return tool }
        if let name = stringArg(args, ["describe"]), !name.isEmpty { return "describe \(name)" }
        if let query = stringArg(args, ["search"]), !query.isEmpty { return "search \"\(query)\"" }
        if args["list"] != nil {
            if let server = stringArg(args, ["server"]), !server.isEmpty { return "list \(server)" }
            return "list"
        }
        return nil
    }
}
