import Foundation

/// One rendered row in a session transcript. The reducer (``SessionState``)
/// produces an ordered list of these from history replay + the live stream.
public enum TranscriptItem: Equatable, Sendable, Identifiable {
    case user(UserBubble)
    case reasoning(ReasoningBlock)
    case assistant(AssistantBubble)
    case tool(ToolCard)
    case compaction(CompactionMarker)
    case notice(NoticeItem)

    public var id: String {
        switch self {
        case let .user(bubble): return "user:\(bubble.id)"
        case let .reasoning(block): return "reasoning:\(block.id)"
        case let .assistant(bubble): return "assistant:\(bubble.inReplyTo)"
        case let .tool(card): return "tool:\(card.toolCallID)"
        case let .compaction(marker): return "compaction:\(marker.id)"
        case let .notice(notice): return "notice:\(notice.id)"
        }
    }
}

/// A system notice surfaced in the transcript — e.g. an `error` from the Pi
/// such as `unknown_peer` ("Peer not paired — re-scan QR").
public struct NoticeItem: Equatable, Sendable {
    public let id: String
    public let code: String
    public let message: String
    public init(id: String, code: String, message: String) {
        self.id = id
        self.code = code
        self.message = message
    }
}

public struct UserBubble: Equatable, Sendable {
    public let id: String
    public var text: String
    public var images: [WireImage]
    public init(id: String, text: String, images: [WireImage] = []) {
        self.id = id
        self.text = text
        self.images = images
    }
}

/// A streamed model-reasoning (thinking) block — un-bien fork extension
/// (`agent_reasoning`). Rendered collapsed by default. `id` distinguishes
/// multiple reasoning segments within one turn.
public struct ReasoningBlock: Equatable, Sendable {
    public let id: String
    public var text: String
    public var streaming: Bool
    public init(id: String, text: String, streaming: Bool) {
        self.id = id
        self.text = text
        self.streaming = streaming
    }
}

public struct AssistantBubble: Equatable, Sendable {
    public let inReplyTo: String
    public var text: String
    /// True while `agent_chunk`s are still arriving (before `agent_done`).
    public var streaming: Bool
    public var usage: Usage?
    /// Agent-emitted inline graphics (plots/diagrams), rendered in the bubble.
    /// Arrive on the settling `agent_message` (live + history), keeping images
    /// in the conversation flow rather than a separate row.
    public var images: [WireImage]
    public init(inReplyTo: String, text: String, streaming: Bool,
                usage: Usage? = nil, images: [WireImage] = []) {
        self.inReplyTo = inReplyTo
        self.text = text
        self.streaming = streaming
        self.usage = usage
        self.images = images
    }
}

public struct ToolCard: Equatable, Sendable {
    public enum State: Equatable, Sendable { case running, ok, failed }
    public let toolCallID: String
    public let tool: String
    public var args: [String: JSONValue]
    public var result: JSONValue?
    public var error: String?
    public var state: State
    public init(toolCallID: String, tool: String, args: [String: JSONValue],
                result: JSONValue? = nil, error: String? = nil, state: State = .running) {
        self.toolCallID = toolCallID
        self.tool = tool
        self.args = args
        self.result = result
        self.error = error
        self.state = state
    }
}

public struct CompactionMarker: Equatable, Sendable {
    public let id: String
    public let summary: String
    public let tokensBefore: Int
    public init(id: String, summary: String, tokensBefore: Int) {
        self.id = id
        self.summary = summary
        self.tokensBefore = tokensBefore
    }
}
