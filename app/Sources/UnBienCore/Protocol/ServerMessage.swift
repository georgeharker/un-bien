import Foundation

/// Pi → App render + status surface (DESIGN §4). Carried base64-encoded inside
/// a ``RoutedEnvelope`` `ct` field. Discriminated by `type`.
public enum ServerMessage: Equatable, Sendable {
    case pairOk(inReplyTo: String, sessionName: String, sessionStartedAt: Int,
                roomID: String, harness: Harness?, hostname: String?)
    case pairError(inReplyTo: String, code: PairErrorCode, message: String)
    case modelsList(inReplyTo: String, models: [WireModel], current: WireModel?)
    case extensionUiRequest(ExtensionUiRequest)
    /// un-bien fork extension: a named side-panel's state snapshot (plan,
    /// subagents, …), forwarded from a cooperating event source. Rendered as
    /// a top-bar item that badges on change. `icon` is an optional SF Symbol.
    case panelUpdate(key: String, title: String, icon: String?, data: JSONValue)

    /// Short `type`-tag for logging/diagnostics.
    public var debugTag: String {
        switch self {
        case .pairOk: return "pair_ok"
        case .pairError: return "pair_error"
        case .modelsList: return "models_list"
        case .extensionUiRequest: return "extension_ui_request"
        case .panelUpdate: return "panel_update"
        }
    }
}

public struct QueuedMessageItem: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let editable: Bool
    public let createdAt: Int

    public init(id: String, text: String, editable: Bool, createdAt: Int) {
        self.id = id
        self.text = text
        self.editable = editable
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, text, editable
        case createdAt = "created_at"
    }
}

/// Interactive extension prompt (ask_user via pi-ask). The `ask` enrichment is
/// preserved as an opaque passthrough for now (DESIGN §4).
public struct ExtensionUiRequest: Equatable, Sendable {
    public let id: String
    public let method: Method
    public let title: String?
    public let message: String?
    public let options: [String]?
    public let placeholder: String?
    public let prefill: String?
    public let notifyType: String?
    public let ask: JSONValue?

    public enum Method: String, Codable, Sendable {
        case select, confirm, input, editor, notify
    }

    /// The pi-ask rich flow, when this prompt carries one (else nil → render
    /// the degraded base method).
    public var askFlow: AskEnrichment? { AskEnrichment.from(ask) }
}
