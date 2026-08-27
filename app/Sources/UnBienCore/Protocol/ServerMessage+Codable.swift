import Foundation

extension ServerMessage: Codable {
    private struct CodingKeys: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
        init(_ key: String) { self.stringValue = key }

        static let type = CodingKeys("type")
        static let inReplyTo = CodingKeys("in_reply_to")
        static let id = CodingKeys("id")
        static let sessionName = CodingKeys("session_name")
        static let sessionStartedAt = CodingKeys("session_started_at")
        static let roomID = CodingKeys("room_id")
        static let harness = CodingKeys("harness")
        static let hostname = CodingKeys("hostname")
        static let protocolVersion = CodingKeys("protocol_version")
        static let capabilities = CodingKeys("capabilities")
        static let code = CodingKeys("code")
        static let message = CodingKeys("message")
        static let text = CodingKeys("text")
        static let images = CodingKeys("images")
        static let streamingBehavior = CodingKeys("streaming_behavior")
        static let items = CodingKeys("items")
        static let delta = CodingKeys("delta")
        static let usage = CodingKeys("usage")
        static let summary = CodingKeys("summary")
        static let tokensBefore = CodingKeys("tokens_before")
        static let ts = CodingKeys("ts")
        static let toolCallID = CodingKeys("tool_call_id")
        static let tool = CodingKeys("tool")
        static let args = CodingKeys("args")
        static let result = CodingKeys("result")
        static let error = CodingKeys("error")
        static let targetID = CodingKeys("target_id")
        static let reason = CodingKeys("reason")
        static let events = CodingKeys("events")
        static let eos = CodingKeys("eos")
        static let truncated = CodingKeys("truncated")
        static let action = CodingKeys("action")
        static let models = CodingKeys("models")
        static let current = CodingKeys("current")
        static let key = CodingKeys("key")
        static let title = CodingKeys("title")
        static let icon = CodingKeys("icon")
        static let data = CodingKeys("data")
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        func str(_ key: CodingKeys) throws -> String { try container.decode(String.self, forKey: key) }
        func int(_ key: CodingKeys) throws -> Int { try container.decode(Int.self, forKey: key) }
        switch type {
        case "pair_ok":
            self = .pairOk(
                inReplyTo: try str(.inReplyTo), sessionName: try str(.sessionName),
                sessionStartedAt: try int(.sessionStartedAt), roomID: try str(.roomID),
                harness: try container.decodeIfPresent(Harness.self, forKey: .harness),
                hostname: try container.decodeIfPresent(String.self, forKey: .hostname))
        case "pair_error":
            self = .pairError(inReplyTo: try str(.inReplyTo),
                              code: try container.decode(PairErrorCode.self, forKey: .code),
                              message: try str(.message))
        case "user_input":
            self = .userInput(id: try str(.id), text: try str(.text),
                              streamingBehavior: try container.decodeIfPresent(String.self, forKey: .streamingBehavior))
        case "user_message":
            self = .userMessage(id: try str(.id), text: try str(.text),
                                images: try container.decodeIfPresent([WireImage].self, forKey: .images),
                                streamingBehavior: try container.decodeIfPresent(String.self, forKey: .streamingBehavior))
        case "queued_message_state":
            self = .queuedMessageState(
                id: try container.decodeIfPresent(String.self, forKey: .id),
                text: try container.decodeIfPresent(String.self, forKey: .text),
                items: try container.decodeIfPresent([QueuedMessageItem].self, forKey: .items))
        case "steer_consumed":
            self = .steerConsumed(id: try str(.id))
        case "agent_chunk":
            self = .agentChunk(inReplyTo: try str(.inReplyTo), delta: try str(.delta))
        case "agent_reasoning":
            self = .agentReasoning(inReplyTo: try str(.inReplyTo), delta: try str(.delta))
        case "agent_done":
            self = .agentDone(inReplyTo: try str(.inReplyTo),
                              usage: try container.decodeIfPresent(Usage.self, forKey: .usage))
        case "agent_message":
            self = .agentMessage(inReplyTo: try str(.inReplyTo), text: try str(.text),
                                 usage: try container.decodeIfPresent(Usage.self, forKey: .usage),
                                 images: try container.decodeIfPresent([WireImage].self, forKey: .images))
        case "compaction":
            self = .compaction(summary: try str(.summary), tokensBefore: try int(.tokensBefore),
                               timestamp: try container.decodeIfPresent(Int.self, forKey: .ts))
        case "tool_request":
            self = .toolRequest(toolCallID: try str(.toolCallID), tool: try str(.tool),
                                args: try container.decode([String: JSONValue].self, forKey: .args))
        case "tool_result":
            self = .toolResult(toolCallID: try str(.toolCallID),
                               result: try container.decodeIfPresent(JSONValue.self, forKey: .result),
                               error: try container.decodeIfPresent(String.self, forKey: .error),
                               images: try container.decodeIfPresent([WireImage].self, forKey: .images))
        case "error":
            self = .error(inReplyTo: try container.decodeIfPresent(String.self, forKey: .inReplyTo),
                          code: try str(.code), message: try str(.message))
        case "cancelled":
            self = .cancelled(inReplyTo: try str(.inReplyTo), targetID: try str(.targetID))
        case "pong":
            self = .pong(inReplyTo: try str(.inReplyTo))
        case "bye":
            self = .bye(reason: try container.decode(ByeReason.self, forKey: .reason))
        case "session_history":
            self = .sessionHistory(
                inReplyTo: try str(.inReplyTo), sessionStartedAt: try int(.sessionStartedAt),
                events: try container.decode([SessionHistoryEvent].self, forKey: .events),
                eos: try container.decode(Bool.self, forKey: .eos),
                truncated: try container.decode(Bool.self, forKey: .truncated),
                protocolVersion: try container.decodeIfPresent(Int.self, forKey: .protocolVersion),
                capabilities: try container.decodeIfPresent([String].self, forKey: .capabilities))
        case "action_ok":
            self = .actionOk(inReplyTo: try str(.inReplyTo),
                             action: try container.decode(ActionName.self, forKey: .action))
        case "action_error":
            self = .actionError(inReplyTo: try str(.inReplyTo),
                                action: try container.decode(ActionName.self, forKey: .action),
                                error: try str(.error))
        case "models_list":
            self = .modelsList(inReplyTo: try str(.inReplyTo),
                               models: try container.decode([WireModel].self, forKey: .models),
                               current: try container.decodeIfPresent(WireModel.self, forKey: .current))
        case "extension_ui_request":
            self = .extensionUiRequest(try ExtensionUiRequest(from: decoder))
        case "panel_update":
            self = .panelUpdate(
                key: try str(.key), title: try str(.title),
                icon: try container.decodeIfPresent(String.self, forKey: .icon),
                data: try container.decode(JSONValue.self, forKey: .data))
        default:
            throw DecodeError.unsupportedType(type)
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .pairOk(inReplyTo, sessionName, sessionStartedAt, roomID, harness, hostname):
            try container.encode("pair_ok", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(sessionName, forKey: .sessionName)
            try container.encode(sessionStartedAt, forKey: .sessionStartedAt)
            try container.encode(roomID, forKey: .roomID)
            try container.encodeIfPresent(harness, forKey: .harness)
            try container.encodeIfPresent(hostname, forKey: .hostname)
        case let .pairError(inReplyTo, code, message):
            try container.encode("pair_error", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
        case let .userInput(id, text, streamingBehavior):
            try container.encode("user_input", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(streamingBehavior, forKey: .streamingBehavior)
        case let .userMessage(id, text, images, streamingBehavior):
            try container.encode("user_message", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(images, forKey: .images)
            try container.encodeIfPresent(streamingBehavior, forKey: .streamingBehavior)
        case let .queuedMessageState(id, text, items):
            try container.encode("queued_message_state", forKey: .type)
            try container.encodeIfPresent(id, forKey: .id)
            try container.encodeIfPresent(text, forKey: .text)
            try container.encodeIfPresent(items, forKey: .items)
        case let .steerConsumed(id):
            try container.encode("steer_consumed", forKey: .type)
            try container.encode(id, forKey: .id)
        case let .agentChunk(inReplyTo, delta):
            try container.encode("agent_chunk", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(delta, forKey: .delta)
        case let .agentReasoning(inReplyTo, delta):
            try container.encode("agent_reasoning", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(delta, forKey: .delta)
        case let .agentDone(inReplyTo, usage):
            try container.encode("agent_done", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encodeIfPresent(usage, forKey: .usage)
        case let .agentMessage(inReplyTo, text, usage, images):
            try container.encode("agent_message", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(usage, forKey: .usage)
            try container.encodeIfPresent(images, forKey: .images)
        case let .compaction(summary, tokensBefore, timestamp):
            try container.encode("compaction", forKey: .type)
            try container.encode(summary, forKey: .summary)
            try container.encode(tokensBefore, forKey: .tokensBefore)
            try container.encodeIfPresent(timestamp, forKey: .ts)
        case let .toolRequest(toolCallID, tool, args):
            try container.encode("tool_request", forKey: .type)
            try container.encode(toolCallID, forKey: .toolCallID)
            try container.encode(tool, forKey: .tool)
            try container.encode(args, forKey: .args)
        case let .toolResult(toolCallID, result, error, images):
            try container.encode("tool_result", forKey: .type)
            try container.encode(toolCallID, forKey: .toolCallID)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encodeIfPresent(error, forKey: .error)
            try container.encodeIfPresent(images, forKey: .images)
        case let .error(inReplyTo, code, message):
            try container.encode("error", forKey: .type)
            try container.encodeIfPresent(inReplyTo, forKey: .inReplyTo)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
        case let .cancelled(inReplyTo, targetID):
            try container.encode("cancelled", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(targetID, forKey: .targetID)
        case let .pong(inReplyTo):
            try container.encode("pong", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
        case let .bye(reason):
            try container.encode("bye", forKey: .type)
            try container.encode(reason, forKey: .reason)
        case let .sessionHistory(inReplyTo, sessionStartedAt, events, eos, truncated, protocolVersion, capabilities):
            try container.encode("session_history", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(sessionStartedAt, forKey: .sessionStartedAt)
            try container.encode(events, forKey: .events)
            try container.encode(eos, forKey: .eos)
            try container.encode(truncated, forKey: .truncated)
            try container.encodeIfPresent(protocolVersion, forKey: .protocolVersion)
            try container.encodeIfPresent(capabilities, forKey: .capabilities)
        case let .actionOk(inReplyTo, action):
            try container.encode("action_ok", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(action, forKey: .action)
        case let .actionError(inReplyTo, action, error):
            try container.encode("action_error", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(action, forKey: .action)
            try container.encode(error, forKey: .error)
        case let .modelsList(inReplyTo, models, current):
            try container.encode("models_list", forKey: .type)
            try container.encode(inReplyTo, forKey: .inReplyTo)
            try container.encode(models, forKey: .models)
            try container.encodeIfPresent(current, forKey: .current)
        case let .extensionUiRequest(request):
            try request.encode(to: encoder)
        case let .panelUpdate(key, title, icon, data):
            try container.encode("panel_update", forKey: .type)
            try container.encode(key, forKey: .key)
            try container.encode(title, forKey: .title)
            try container.encodeIfPresent(icon, forKey: .icon)
            try container.encode(data, forKey: .data)
        }
    }
}

extension ExtensionUiRequest: Codable {
    enum CodingKeys: String, CodingKey {
        case type, id, method, title, message, options, placeholder, prefill
        case notifyType = "notify_type"
        case ask
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.method = try container.decode(Method.self, forKey: .method)
        self.title = try container.decodeIfPresent(String.self, forKey: .title)
        self.message = try container.decodeIfPresent(String.self, forKey: .message)
        self.options = try container.decodeIfPresent([String].self, forKey: .options)
        self.placeholder = try container.decodeIfPresent(String.self, forKey: .placeholder)
        self.prefill = try container.decodeIfPresent(String.self, forKey: .prefill)
        self.notifyType = try container.decodeIfPresent(String.self, forKey: .notifyType)
        self.ask = try container.decodeIfPresent(JSONValue.self, forKey: .ask)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("extension_ui_request", forKey: .type)
        try container.encode(id, forKey: .id)
        try container.encode(method, forKey: .method)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(message, forKey: .message)
        try container.encodeIfPresent(options, forKey: .options)
        try container.encodeIfPresent(placeholder, forKey: .placeholder)
        try container.encodeIfPresent(prefill, forKey: .prefill)
        try container.encodeIfPresent(notifyType, forKey: .notifyType)
        try container.encodeIfPresent(ask, forKey: .ask)
    }
}
