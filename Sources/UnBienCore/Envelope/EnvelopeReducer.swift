import Foundation

/// Canonical interpreted state produced by folding an envelope stream. This is
/// the conformance target both the Swift (app) and TS (fork) reducers serialize
/// to. Transcript reduces from the rpc plane (message_end authoritative), panels
/// from the {evt} plane; UI effects from extension_ui_request.
public struct EnvelopeState: Equatable, Sendable {
    public var session: SessionSnapshot?
    public var transcript: [TranscriptEntry] = []
    public var subagents: [SubagentEntry] = []
    public var plan: PlanSnapshot?
    public var notifications: [UINotification] = []
    public var status: [String: String] = [:]
    public var widgets: [String: [String]] = [:]
    public var title: String?

    public init() {}
}

public struct SessionSnapshot: Equatable, Sendable {
    public var model: String?
    public var provider: String?
    public var thinkingLevel: String?
    public var isStreaming: Bool?
    public var sessionId: String?
    public var messageCount: Int?
}

public struct TranscriptEntry: Equatable, Sendable {
    public enum Kind: String, Sendable, Codable { case user, assistant, custom, tool }
    public var kind: Kind
    public var text: String
    public var toolName: String?
    public var isError: Bool?
}

public struct SubagentEntry: Equatable, Sendable {
    public var id: String
    public var type: String?
    public var description: String?
    public var status: String
    public var result: String?
    public var error: String?
}

public struct PlanSnapshot: Equatable, Sendable {
    public var project: String?
    public var itemCount: Int
}

public struct UINotification: Equatable, Sendable {
    public var level: String
    public var message: String
}

/// Folds envelope messages into `EnvelopeState`. Order-independent across the
/// two planes: transcript from rpc order, panels from evt order.
public struct EnvelopeReducer {
    public private(set) var state = EnvelopeState()

    public init() {}

    public mutating func apply(_ message: EnvelopeMessage) {
        if let evt = message.evt { applyEvt(evt) }
        if let rpc = message.rpc { applyRpc(rpc) }
    }

    public mutating func apply<S: Sequence>(_ messages: S) where S.Element == EnvelopeMessage {
        for message in messages { apply(message) }
    }

    // MARK: - evt plane (panels)

    private mutating func applyEvt(_ evt: EnvelopeEvt) {
        switch evt.channel {
        case "subagents:started", "subagents:steered", "subagents:completed", "subagents:failed":
            guard let id = evt.data["id"]?.stringValue else { return }
            let status = String(evt.channel.dropFirst("subagents:".count))
            upsertSubagent(
                id: id,
                type: evt.data["type"]?.stringValue,
                description: evt.data["description"]?.stringValue,
                status: status,
                result: evt.data["result"]?.stringValue,
                error: evt.data["error"]?.stringValue
            )
        case "plan:snapshot", "plan:update":
            let items = evt.data["items"]?.arrayValue?.count ?? 0
            state.plan = PlanSnapshot(project: evt.data["project"]?.stringValue, itemCount: items)
        default:
            break
        }
    }

    private mutating func upsertSubagent(
        id: String, type: String?, description: String?,
        status: String, result: String?, error: String?
    ) {
        let entry = SubagentEntry(
            id: id, type: type, description: description,
            status: status, result: result, error: error
        )
        if let idx = state.subagents.firstIndex(where: { $0.id == id }) {
            // Keep last-known type/description if the update omits them.
            var merged = entry
            if merged.type == nil { merged.type = state.subagents[idx].type }
            if merged.description == nil { merged.description = state.subagents[idx].description }
            state.subagents[idx] = merged
        } else {
            state.subagents.append(entry)
        }
    }

    // MARK: - rpc plane (transcript / ui / session)

    private mutating func applyRpc(_ rpc: JSONValue) {
        guard let type = rpc["type"]?.stringValue else { return }
        switch type {
        case "message_end":
            applyMessageEnd(rpc["message"])
        case "tool_execution_end":
            applyToolEnd(rpc)
        case "extension_ui_request":
            applyExtensionUI(rpc)
        case "response" where rpc["command"]?.stringValue == "get_state":
            applyState(rpc["data"])
        default:
            break
        }
    }

    private mutating func applyMessageEnd(_ message: JSONValue?) {
        guard let role = message?["role"]?.stringValue,
              let kind = TranscriptEntry.Kind(rawValue: role) else { return }
        let text = Self.extractText(message?["content"])
        state.transcript.append(TranscriptEntry(kind: kind, text: text, toolName: nil, isError: nil))
    }

    private mutating func applyToolEnd(_ rpc: JSONValue) {
        let toolName = rpc["toolName"]?.stringValue
        let text = Self.extractText(rpc["result"]?["content"])
        let isError = rpc["isError"]?.boolValue
        state.transcript.append(TranscriptEntry(kind: .tool, text: text, toolName: toolName, isError: isError))
    }

    private mutating func applyExtensionUI(_ rpc: JSONValue) {
        switch rpc["method"]?.stringValue {
        case "notify":
            let level = rpc["notifyType"]?.stringValue ?? "info"
            let message = rpc["message"]?.stringValue ?? ""
            state.notifications.append(UINotification(level: level, message: message))
        case "setStatus":
            guard let key = rpc["statusKey"]?.stringValue else { return }
            if let text = rpc["statusText"]?.stringValue {
                state.status[key] = Self.stripANSI(text)   // set
            } else {
                state.status.removeValue(forKey: key)       // empty text = clear
            }
        case "setWidget":
            guard let key = rpc["widgetKey"]?.stringValue else { return }
            let lines = rpc["widgetLines"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            if lines.isEmpty {
                state.widgets.removeValue(forKey: key)      // empty lines = clear
            } else {
                state.widgets[key] = lines.map(Self.stripANSI)
            }
        case "setTitle":
            state.title = rpc["title"]?.stringValue
        default:
            break
        }
    }

    private mutating func applyState(_ data: JSONValue?) {
        let model = data?["model"]
        state.session = SessionSnapshot(
            model: model?["id"]?.stringValue,
            provider: model?["provider"]?.stringValue,
            thinkingLevel: data?["thinkingLevel"]?.stringValue,
            isStreaming: data?["isStreaming"]?.boolValue,
            sessionId: data?["sessionId"]?.stringValue,
            messageCount: data?["messageCount"]?.intValue
        )
    }

    // MARK: - helpers

    /// Assistant/user content is a `[TextContent | ...]` array or a bare string
    /// (custom messages); concatenate the text blocks.
    static func extractText(_ content: JSONValue?) -> String {
        if let string = content?.stringValue { return string }
        guard let blocks = content?.arrayValue else { return "" }
        return blocks.compactMap { block in
            block["type"]?.stringValue == "text" ? block["text"]?.stringValue : nil
        }.joined()
    }

    /// Strip CSI SGR color sequences (`ESC[...m`) that extension status/widget text carries.
    static func stripANSI(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
    }
}
