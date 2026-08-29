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
