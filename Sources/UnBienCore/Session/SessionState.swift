import Foundation

/// Reduces a session's `session_history` replay + live `ServerMessage` stream
/// into an ordered transcript (DESIGN §4 reducer rules):
/// - `tool_request` opens a card keyed by `tool_call_id`; the later
///   `tool_result` with the same id fills it.
/// - `agent_chunk` deltas append to the in-flight assistant bubble keyed by
///   `in_reply_to` until `agent_done`; `agent_message` is a settled bubble.
///
/// Not thread-safe by itself; drive it from a single actor/`@MainActor` owner.
public struct SessionState: Equatable, Sendable {
    public private(set) var items: [TranscriptItem] = []
    public private(set) var sessionStartedAt: Int?

    /// `in_reply_to` of the turn currently streaming (chunks or reasoning),
    /// or `nil` when idle. This is the `target_id` a `cancel` should carry.
    public private(set) var activeTurnID: String?

    /// Index of each addressable item so updates are O(1).
    /// Index of the assistant bubble currently accepting streamed chunks. A
    /// tool card (or any inserted row) closes it, so post-tool text starts a
    /// NEW bubble below the card — preserving mid-turn interleaving.
    private var openAssistantIndex: Int?
    /// Index of the reasoning block currently accepting `agent_reasoning`
    /// deltas. Closed by the following text/tool row, like the assistant tail.
    private var openReasoningIndex: Int?
    private var toolIndex: [String: Int] = [:]       // toolCallID → items index
    private var compactionSeq = 0
    private var reasoningSeq = 0
    private var noticeSeq = 0
    private var assistantSeq = 0
    // rpc-envelope reduction state
    private var rpcTurn: String?
    private var rpcTurnSeq = 0
    private var rpcUserSeq = 0

    public init() {}

    /// Usage from the most recent assistant turn that reported it (for a status
    /// line). `agent_done`/`agent_message` carry per-turn token counts.
    public var latestUsage: Usage? {
        for item in items.reversed() {
            if case let .assistant(bubble) = item, let usage = bubble.usage { return usage }
        }
        return nil
    }

    /// The last context-compaction marker, if the session has compacted.
    public var lastCompaction: CompactionMarker? {
        for item in items.reversed() {
            if case let .compaction(marker) = item { return marker }
        }
        return nil
    }

    /// Rebuild from a history replay (replaces current state).
    public mutating func loadHistory(_ events: [SessionHistoryEvent], sessionStartedAt: Int) {
        self = SessionState()
        self.sessionStartedAt = sessionStartedAt
        for event in events { applyHistory(event) }
    }

    public mutating func applyHistory(_ event: SessionHistoryEvent) {
        switch event {
        case let .userInput(_, id, text, images):
            append(.user(UserBubble(id: id, text: text, images: images ?? [])))
        case let .toolRequest(_, toolCallID, tool, args):
            openToolCard(toolCallID: toolCallID, tool: tool, args: args)
        case let .toolResult(_, toolCallID, result, error, images):
            fillToolCard(toolCallID: toolCallID, result: result, error: error, images: images ?? [])
        case let .agentMessage(_, inReplyTo, text, usage, images):
            settleAssistant(inReplyTo: inReplyTo, text: text, usage: usage, images: images ?? [])
        case let .compaction(_, summary, tokensBefore):
            appendCompaction(summary: summary, tokensBefore: tokensBefore)
        }
    }

    /// Apply one live server message. Returns `false` for messages that carry
    /// no transcript effect (status/lifecycle), so callers can route those
    /// separately without special-casing here.
    @discardableResult
    public mutating func apply(_ message: ServerMessage) -> Bool {
        switch message {
        case let .userMessage(id, text, images, _):
            append(.user(UserBubble(id: id, text: text, images: images ?? [])))
            return true
        case let .userInput(id, text, _):
            append(.user(UserBubble(id: id, text: text)))
            return true
        case let .agentChunk(inReplyTo, delta):
            appendChunk(inReplyTo: inReplyTo, delta: delta)
            return true
        case let .agentReasoning(inReplyTo, delta):
            appendReasoning(inReplyTo: inReplyTo, delta: delta)
            return true
        case let .agentDone(inReplyTo, usage):
            finishStreaming(inReplyTo: inReplyTo, usage: usage)
            return true
        case let .agentMessage(inReplyTo, text, usage, images):
            settleAssistant(inReplyTo: inReplyTo, text: text, usage: usage, images: images ?? [])
            return true
        case let .toolRequest(toolCallID, tool, args):
            openToolCard(toolCallID: toolCallID, tool: tool, args: args)
            return true
        case let .toolResult(toolCallID, result, error, images):
            fillToolCard(toolCallID: toolCallID, result: result, error: error, images: images ?? [])
            return true
        case let .compaction(summary, tokensBefore, _):
            appendCompaction(summary: summary, tokensBefore: tokensBefore)
            return true
        case .cancelled:
            activeTurnID = nil
            closeOpenAssistant()
            return true
        case let .error(_, code, message):
            noticeSeq += 1
            append(.notice(NoticeItem(id: "n\(noticeSeq)", code: code, message: message)))
            return true
        default:
            return false
        }
    }

    // MARK: - Mutators

    /// Append a non-chunk row. Closes the open streaming bubble first, so the
    /// next chunk starts a new bubble AFTER this row (mid-turn interleaving).
    private mutating func append(_ item: TranscriptItem) {
        closeOpenAssistant()
        items.append(item)
    }

    /// Mark any currently-open streaming block (assistant text or reasoning)
    /// as settled and forget it, so the next inserted row starts fresh.
    private mutating func closeOpenAssistant() {
        if let index = openAssistantIndex, case var .assistant(bubble) = items[index] {
            bubble.streaming = false
            items[index] = .assistant(bubble)
        }
        if let index = openReasoningIndex, case var .reasoning(block) = items[index] {
            block.streaming = false
            items[index] = .reasoning(block)
        }
        openAssistantIndex = nil
        openReasoningIndex = nil
    }

    private mutating func appendReasoning(inReplyTo: String, delta: String) {
        if let index = openReasoningIndex, case var .reasoning(block) = items[index] {
            block.text += delta
            block.streaming = true
            items[index] = .reasoning(block)
        } else {
            reasoningSeq += 1
            append(.reasoning(ReasoningBlock(id: "\(reasoningSeq)", text: delta, streaming: true)))
            openReasoningIndex = items.count - 1
        }
        activeTurnID = inReplyTo
    }

    private mutating func appendChunk(inReplyTo: String, delta: String) {
        if let index = openAssistantIndex, case var .assistant(bubble) = items[index],
           bubble.inReplyTo == inReplyTo {
            bubble.text += delta
            bubble.streaming = true
            items[index] = .assistant(bubble)
        } else {
            assistantSeq += 1
            append(.assistant(AssistantBubble(id: "a\(assistantSeq)", inReplyTo: inReplyTo,
                                              text: delta, streaming: true)))
            openAssistantIndex = items.count - 1
        }
        activeTurnID = inReplyTo
    }

    private mutating func finishStreaming(inReplyTo: String, usage: Usage?) {
        if let index = openAssistantIndex, case var .assistant(bubble) = items[index] {
            bubble.usage = usage ?? bubble.usage
            items[index] = .assistant(bubble)
        }
        if activeTurnID == inReplyTo { activeTurnID = nil }
        closeOpenAssistant()
    }

    private mutating func settleAssistant(inReplyTo: String, text: String, usage: Usage?,
                                          images: [WireImage] = []) {
        if let index = openAssistantIndex, case var .assistant(bubble) = items[index],
           bubble.inReplyTo == inReplyTo {
            bubble.text = text
            bubble.usage = usage ?? bubble.usage
            if !images.isEmpty { bubble.images = images }
            items[index] = .assistant(bubble)
            closeOpenAssistant()
        } else {
            assistantSeq += 1
            append(.assistant(AssistantBubble(id: "a\(assistantSeq)", inReplyTo: inReplyTo,
                                              text: text, streaming: false,
                                              usage: usage, images: images)))
        }
        if activeTurnID == inReplyTo { activeTurnID = nil }
    }

    private mutating func openToolCard(toolCallID: String, tool: String, args: [String: JSONValue]) {
        if let index = toolIndex[toolCallID] { // idempotent re-open (re-sync)
            items[index] = .tool(ToolCard(toolCallID: toolCallID, tool: tool, args: args))
        } else {
            append(.tool(ToolCard(toolCallID: toolCallID, tool: tool, args: args)))
            toolIndex[toolCallID] = items.count - 1
        }
    }

    private mutating func fillToolCard(toolCallID: String, result: JSONValue?, error: String?,
                                       images: [WireImage] = []) {
        guard let index = toolIndex[toolCallID], case var .tool(card) = items[index] else { return }
        card.result = result
        card.error = error
        card.state = error == nil ? .ok : .failed
        if !images.isEmpty { card.images = images }
        items[index] = .tool(card)
    }

    private mutating func appendCompaction(summary: String, tokensBefore: Int) {
        compactionSeq += 1
        append(.compaction(CompactionMarker(id: "\(compactionSeq)", summary: summary,
                                            tokensBefore: tokensBefore)))
    }

    // MARK: - RPC (rpc-envelope) reduction

    /// Fold one verbatim pi rpc frame into the transcript — the rpc-envelope
    /// path, mirroring the stock `apply`. Streaming deltas build in-flight
    /// bubbles; `message_end` is authoritative; `tool_execution_*` drive cards.
    /// Panels (`subagents:*`/`plan:*`) are the {evt} plane and are NOT handled
    /// here — see `EnvelopeReducer`.
    public mutating func applyRPC(_ frame: JSONValue) {
        guard let type = frame["type"]?.stringValue else { return }
        switch type {
        case "turn_start":
            rpcTurnSeq += 1
            rpcTurn = "t\(rpcTurnSeq)"
            activeTurnID = rpcTurn
        case "turn_end":
            closeOpenAssistant()
        case "message_end":
            applyRPCMessageEnd(frame["message"])
        case "message_update":
            applyRPCDelta(frame["assistantMessageEvent"])
        case "tool_execution_start":
            openToolCard(toolCallID: frame["toolCallId"]?.stringValue ?? "",
                         tool: frame["toolName"]?.stringValue ?? "",
                         args: frame["args"]?.objectValue ?? [:])
        case "tool_execution_update":
            updateToolCard(toolCallID: frame["toolCallId"]?.stringValue ?? "",
                           partial: frame["partialResult"])
        case "tool_execution_end":
            let isError = frame["isError"]?.boolValue ?? false
            fillToolCard(toolCallID: frame["toolCallId"]?.stringValue ?? "",
                         result: frame["result"], error: isError ? "error" : nil,
                         images: Self.imagesFromToolResult(frame["result"]))
        case "compaction_end":
            if let result = frame["result"], result != .null {
                appendCompaction(summary: result["summary"]?.stringValue ?? "",
                                 tokensBefore: result["tokensBefore"]?.intValue ?? 0)
            }
        case "agent_settled":
            if let turn = rpcTurn, activeTurnID == turn { activeTurnID = nil }
            closeOpenAssistant()
        default:
            break
        }
    }

    private mutating func applyRPCMessageEnd(_ message: JSONValue?) {
        guard let role = message?["role"]?.stringValue else { return }
        let turn = rpcTurn ?? "t0"
        switch role {
        case "user":
            rpcUserSeq += 1
            let id = message?["id"]?.stringValue ?? "u\(rpcUserSeq)"
            append(.user(UserBubble(id: id, text: message?["content"]?.joinedText() ?? "")))
        case "assistant":
            if message?["stopReason"]?.stringValue == "error" {
                // Forward a failed turn as a notice (mirrors the fork's `error`).
                noticeSeq += 1
                append(.notice(NoticeItem(id: "err\(noticeSeq)", code: "provider_error",
                                          message: message?["errorMessage"]?.stringValue ?? "Provider error")))
            } else {
                // Inline graphics settle here on the assistant message (the live
                // stream is text deltas only). Attach to the delta-built bubble,
                // or fall back to authoritative text when no delta opened one.
                let images = Self.imagesFromContent(message?["content"])
                if openAssistantIndex != nil {
                    // Finalize WITHOUT clobbering delta-built interleaving; keep
                    // activeTurnID (turn isn't done until agent_settled).
                    if !images.isEmpty { attachImages(images) }
                    closeOpenAssistant()
                } else {
                    let text = message?["content"]?.joinedText() ?? ""
                    if !text.isEmpty || !images.isEmpty {
                        settleAssistant(inReplyTo: turn, text: text, usage: nil, images: images)
                    }
                }
            }
        case "custom":
            noticeSeq += 1
            append(.notice(NoticeItem(id: "custom\(noticeSeq)", code: "custom",
                                      message: message?["content"]?.joinedText() ?? "")))
        default:
            break  // toolResult is rendered via tool_execution_*, not as a row
        }
    }

    private mutating func applyRPCDelta(_ event: JSONValue?) {
        guard let type = event?["type"]?.stringValue else { return }
        let turn = rpcTurn ?? "t0"
        switch type {
        case "text_delta":
            appendChunk(inReplyTo: turn, delta: event?["delta"]?.stringValue ?? "")
        case "thinking_delta":
            appendReasoning(inReplyTo: turn, delta: event?["delta"]?.stringValue ?? "")
        default:
            break  // *_start/_end + toolcall_*: bubbles open lazily; cards via tool_execution_*
        }
    }

    private mutating func updateToolCard(toolCallID: String, partial: JSONValue?) {
        guard let index = toolIndex[toolCallID], case var .tool(card) = items[index] else { return }
        if let partial { card.result = partial }
        items[index] = .tool(card)
    }

    /// Attach settled inline images to the open assistant bubble (message_end).
    private mutating func attachImages(_ images: [WireImage]) {
        guard let index = openAssistantIndex, case var .assistant(bubble) = items[index] else { return }
        bubble.images = images
        items[index] = .assistant(bubble)
    }

    /// Image blocks (`{type:"image", data, mimeType}`) from a message `content`
    /// array — mirrors the fork's `_imagesFromContent`.
    static func imagesFromContent(_ content: JSONValue?) -> [WireImage] {
        guard let blocks = content?.arrayValue else { return [] }
        return blocks.compactMap { block in
            guard block["type"]?.stringValue == "image",
                  let data = block["data"]?.stringValue,
                  let mime = block["mimeType"]?.stringValue else { return nil }
            return WireImage(data: data, mime: mime)
        }
    }

    /// Images from a `tool_execution_end` result — the live result is a wrapper
    /// `{content:[...], details}`; unwrap `content` (mirrors `_imagesFromToolResult`).
    static func imagesFromToolResult(_ value: JSONValue?) -> [WireImage] {
        if value?.arrayValue != nil { return imagesFromContent(value) }
        if let content = value?["content"] { return imagesFromContent(content) }
        return []
    }

}
