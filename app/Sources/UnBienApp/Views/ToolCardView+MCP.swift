import Foundation
import UnBienCore

// The MCP proxy tool's header subtitle. pi's `mcp` tool is one tool for every
// MCP server, so the card title alone ("mcp") says nothing; the call it makes
// rides its arguments — the proxied tool name for a call, or the
// search / describe / list it ran.
extension ToolCardView {
    /// Whether `tool` is the MCP proxy tool.
    nonisolated static func isMCPProxy(_ tool: String) -> Bool {
        tool.lowercased() == "mcp"
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
