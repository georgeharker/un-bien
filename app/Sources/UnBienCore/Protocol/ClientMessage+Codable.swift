import Foundation

extension ClientMessage: Codable {
    private struct CodingKeys: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
        init(_ key: String) { self.stringValue = key }

        static let type = CodingKeys("type")
        static let id = CodingKeys("id")
        static let token = CodingKeys("token")
        static let deviceName = CodingKeys("device_name")
        static let text = CodingKeys("text")
        static let images = CodingKeys("images")
        static let streamingBehavior = CodingKeys("streaming_behavior")
        static let targetID = CodingKeys("target_id")
        static let toolCallID = CodingKeys("tool_call_id")
        static let decision = CodingKeys("decision")
        static let limit = CodingKeys("limit")
        static let provider = CodingKeys("provider")
        static let modelID = CodingKeys("model_id")
        static let level = CodingKeys("level")
        static let mode = CodingKeys("mode")
        static let cwd = CodingKeys("cwd")
        static let name = CodingKeys("name")
        static let value = CodingKeys("value")
        static let confirmed = CodingKeys("confirmed")
        static let cancelled = CodingKeys("cancelled")
        static let ask = CodingKeys("ask")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(typeTag, forKey: .type)
        switch self {
        case let .pairRequest(id, token, deviceName):
            try container.encode(id, forKey: .id)
            try container.encode(token, forKey: .token)
            try container.encode(deviceName, forKey: .deviceName)
        case let .userMessage(id, text, images, streamingBehavior):
            try container.encode(id, forKey: .id)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(images, forKey: .images)
            try container.encodeIfPresent(streamingBehavior, forKey: .streamingBehavior)
        case let .approveTool(id, toolCallID, decision):
            try container.encode(id, forKey: .id)
            try container.encode(toolCallID, forKey: .toolCallID)
            try container.encode(decision, forKey: .decision)
        case let .cancel(id, targetID):
            try container.encode(id, forKey: .id)
            try container.encode(targetID, forKey: .targetID)
        case let .ping(id):
            try container.encode(id, forKey: .id)
        case let .sessionSync(id, limit):
            try container.encode(id, forKey: .id)
            try container.encodeIfPresent(limit, forKey: .limit)
        case let .sessionNew(id):
            try container.encode(id, forKey: .id)
        case let .sessionCompact(id):
            try container.encode(id, forKey: .id)
        case let .modelSet(id, provider, modelID):
            try container.encode(id, forKey: .id)
            try container.encode(provider, forKey: .provider)
            try container.encode(modelID, forKey: .modelID)
        case let .thinkingSet(id, level):
            try container.encode(id, forKey: .id)
            try container.encode(level, forKey: .level)
        case let .listModels(id):
            try container.encode(id, forKey: .id)
        case let .sessionLaunch(id, mode, cwd, name):
            try container.encode(id, forKey: .id)
            try container.encode(mode, forKey: .mode)
            try container.encodeIfPresent(cwd, forKey: .cwd)
            try container.encodeIfPresent(name, forKey: .name)
        case let .extensionUiResponse(response):
            try container.encode(response.id, forKey: .id)
            try container.encodeIfPresent(response.value, forKey: .value)
            try container.encodeIfPresent(response.confirmed, forKey: .confirmed)
            try container.encodeIfPresent(response.cancelled, forKey: .cancelled)
            try container.encodeIfPresent(response.ask, forKey: .ask)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        func string(_ key: CodingKeys) throws -> String {
            try container.decode(String.self, forKey: key)
        }
        switch type {
        case "pair_request":
            self = .pairRequest(id: try string(.id), token: try string(.token),
                                deviceName: try string(.deviceName))
        case "user_message":
            self = .userMessage(
                id: try string(.id),
                text: try string(.text),
                images: try container.decodeIfPresent([WireImage].self, forKey: .images),
                streamingBehavior: try container.decodeIfPresent(String.self, forKey: .streamingBehavior)
            )
        case "approve_tool":
            self = .approveTool(
                id: try string(.id),
                toolCallID: try string(.toolCallID),
                decision: try container.decode(ToolDecision.self, forKey: .decision)
            )
        case "cancel":
            self = .cancel(id: try string(.id), targetID: try string(.targetID))
        case "ping":
            self = .ping(id: try string(.id))
        case "session_sync":
            self = .sessionSync(
                id: try string(.id),
                limit: try container.decodeIfPresent(Int.self, forKey: .limit)
            )
        case "session_new":
            self = .sessionNew(id: try string(.id))
        case "session_compact":
            self = .sessionCompact(id: try string(.id))
        case "model_set":
            self = .modelSet(id: try string(.id), provider: try string(.provider),
                             modelID: try string(.modelID))
        case "thinking_set":
            self = .thinkingSet(id: try string(.id),
                                level: try container.decode(ThinkingLevel.self, forKey: .level))
        case "list_models":
            self = .listModels(id: try string(.id))
        case "extension_ui_response":
            self = .extensionUiResponse(ExtensionUiResponse(
                id: try string(.id),
                value: try container.decodeIfPresent(String.self, forKey: .value),
                confirmed: try container.decodeIfPresent(Bool.self, forKey: .confirmed),
                cancelled: try container.decodeIfPresent(Bool.self, forKey: .cancelled),
                ask: try container.decodeIfPresent(JSONValue.self, forKey: .ask)
            ))
        default:
            throw DecodeError.unsupportedType(type)
        }
    }
}
