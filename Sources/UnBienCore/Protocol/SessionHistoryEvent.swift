import Foundation

/// One entry in a `session_history` replay (DESIGN §4). Discriminated by `type`.
public enum SessionHistoryEvent: Equatable, Sendable, Codable {
    case userInput(timestamp: Int, id: String, text: String, images: [WireImage]?)
    case toolRequest(timestamp: Int, toolCallID: String, tool: String, args: [String: JSONValue])
    case toolResult(timestamp: Int, toolCallID: String, result: JSONValue?, error: String?)
    case agentMessage(timestamp: Int, inReplyTo: String, text: String, usage: Usage?, images: [WireImage]?)
    case compaction(timestamp: Int, summary: String, tokensBefore: Int)

    enum CodingKeys: String, CodingKey {
        case ts, type, id, text, images
        case toolCallID = "tool_call_id"
        case tool, args, result, error
        case inReplyTo = "in_reply_to"
        case usage, summary
        case tokensBefore = "tokens_before"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let timestamp = try container.decode(Int.self, forKey: .ts)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "user_input":
            self = .userInput(
                timestamp: timestamp,
                id: try container.decode(String.self, forKey: .id),
                text: try container.decode(String.self, forKey: .text),
                images: try container.decodeIfPresent([WireImage].self, forKey: .images)
            )
        case "tool_request":
            self = .toolRequest(
                timestamp: timestamp,
                toolCallID: try container.decode(String.self, forKey: .toolCallID),
                tool: try container.decode(String.self, forKey: .tool),
                args: try container.decode([String: JSONValue].self, forKey: .args)
            )
        case "tool_result":
            self = .toolResult(
                timestamp: timestamp,
                toolCallID: try container.decode(String.self, forKey: .toolCallID),
                result: try container.decodeIfPresent(JSONValue.self, forKey: .result),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )
        case "agent_message":
            self = .agentMessage(
                timestamp: timestamp,
                inReplyTo: try container.decode(String.self, forKey: .inReplyTo),
                text: try container.decode(String.self, forKey: .text),
                usage: try container.decodeIfPresent(Usage.self, forKey: .usage),
                images: try container.decodeIfPresent([WireImage].self, forKey: .images)
            )
        case "compaction":
            self = .compaction(
                timestamp: timestamp,
                summary: try container.decode(String.self, forKey: .summary),
                tokensBefore: try container.decode(Int.self, forKey: .tokensBefore)
            )
        default:
            throw DecodeError.unsupportedType(type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .userInput(timestamp, id, text, images):
            try container.encode(timestamp, forKey: .ts)
            try container.encode("user_input", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(images, forKey: .images)
        case let .toolRequest(timestamp, toolCallID, tool, args):
            try container.encode(timestamp, forKey: .ts)
            try container.encode("tool_request", forKey: .type)
            try container.encode(toolCallID, forKey: .toolCallID)
            try container.encode(tool, forKey: .tool)
            try container.encode(args, forKey: .args)
        case let .toolResult(timestamp, toolCallID, result, error):
            try container.encode(timestamp, forKey: .ts)
            try container.encode("tool_result", forKey: .type)
            try container.encode(toolCallID, forKey: .toolCallID)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encodeIfPresent(error, forKey: .error)
        case let .agentMessage(timestamp, inReplyTo, text, usage, images):
            try container.encode(timestamp, forKey: .ts)
            try container.encode("agent_message", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(usage, forKey: .usage)
            try container.encodeIfPresent(images, forKey: .images)
        case let .compaction(timestamp, summary, tokensBefore):
            try container.encode(timestamp, forKey: .ts)
            try container.encode("compaction", forKey: .type)
            try container.encode(summary, forKey: .summary)
            try container.encode(tokensBefore, forKey: .tokensBefore)
        }
    }
}
