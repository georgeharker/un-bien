import Foundation

/// App → Pi control surface (DESIGN §4). Carried base64-encoded inside a
/// ``RoutedEnvelope`` `ct` field. Discriminated by `type`.
public enum ClientMessage: Equatable, Sendable {
    case pairRequest(id: String, token: String, deviceName: String)
    case userMessage(id: String, text: String, images: [WireImage]?, streamingBehavior: String?)
    case queuedMessageSet(id: String, text: String)
    case queuedMessageClear(id: String, targetID: String?)
    case approveTool(id: String, toolCallID: String, decision: ToolDecision)
    case cancel(id: String, targetID: String)
    case ping(id: String)
    case sessionSync(id: String, limit: Int?)
    case sessionNew(id: String)
    case sessionCompact(id: String)
    case modelSet(id: String, provider: String, modelID: String)
    case thinkingSet(id: String, level: ThinkingLevel)
    case listModels(id: String)
    /// Response to an `extension_ui_request` (select/confirm/input/editor).
    case extensionUiResponse(ExtensionUiResponse)

    public enum ToolDecision: String, Codable, Sendable {
        case allow, deny
    }

    /// The `type` discriminator as it appears on the wire.
    public var typeTag: String {
        switch self {
        case .pairRequest: return "pair_request"
        case .userMessage: return "user_message"
        case .queuedMessageSet: return "queued_message_set"
        case .queuedMessageClear: return "queued_message_clear"
        case .approveTool: return "approve_tool"
        case .cancel: return "cancel"
        case .ping: return "ping"
        case .sessionSync: return "session_sync"
        case .sessionNew: return "session_new"
        case .sessionCompact: return "session_compact"
        case .modelSet: return "model_set"
        case .thinkingSet: return "thinking_set"
        case .listModels: return "list_models"
        case .extensionUiResponse: return "extension_ui_response"
        }
    }
}

/// Response to an `extension_ui_request`. The `ask` enrichment (pi-ask
/// multi/preview/notes) rides as an opaque passthrough for now (DESIGN §4).
public struct ExtensionUiResponse: Equatable, Sendable {
    public let id: String
    public let value: String?
    public let confirmed: Bool?
    public let cancelled: Bool?
    public let ask: JSONValue?

    public init(id: String, value: String? = nil, confirmed: Bool? = nil,
                cancelled: Bool? = nil, ask: JSONValue? = nil) {
        self.id = id
        self.value = value
        self.confirmed = confirmed
        self.cancelled = cancelled
        self.ask = ask
    }

    /// Rich pi-ask submit: carries ONLY the structured `ask` envelope (no
    /// value/confirmed/cancelled) — routing keys off `ask.kind` (DESIGN §4).
    public static func rich(id: String, enrichment: AskResponseEnrichment) -> ExtensionUiResponse {
        ExtensionUiResponse(id: id, ask: enrichment.toJSONValue())
    }
}
