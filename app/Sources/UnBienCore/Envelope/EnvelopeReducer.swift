import Foundation

/// Session/model snapshot from an rpc `get_state` response.
public struct SessionSnapshot: Equatable, Sendable {
    public var model: String?
    public var provider: String?
    public var thinkingLevel: String?
    public var isStreaming: Bool?
    public var sessionId: String?
    public var messageCount: Int?
}

/// One subagent's live panel state, folded from the `subagents:*` {evt} plane.
public struct SubagentEntry: Equatable, Sendable {
    public var id: String
    public var type: String?
    public var description: String?
    public var status: String
    public var result: String?
    public var error: String?
}

/// Plan panel state, folded from `plan:snapshot` {evt}.
public struct PlanSnapshot: Equatable, Sendable {
    public var project: String?
    public var itemCount: Int
}

public struct UINotification: Equatable, Sendable {
    public var level: String
    public var message: String
}

/// A blocking extension_ui dialog awaiting the app's `extension_ui_response`.
public struct PendingAsk: Equatable, Sendable {
    public var id: String
    public var method: String       // select | confirm | input | editor
    public var title: String?
    public var message: String?
    public var options: [String]?
}

/// Folds an rpc-envelope stream (see docs/rpc-envelope.md) into the transcript
/// plus the {evt} panels and extension_ui side-state. Transcript reduction is
/// delegated to `SessionState.applyRPC` — the SAME mutators the stock path uses,
/// so streaming/thinking/tool-card/turn handling isn't reinvented here. Panels
/// come only from the {evt} plane; session/ui from rpc responses + extension_ui.
public struct EnvelopeReducer {
    public private(set) var session = SessionState()
    public private(set) var subagents: [SubagentEntry] = []
    public private(set) var plan: PlanSnapshot?
    public private(set) var snapshot: SessionSnapshot?
    public private(set) var notifications: [UINotification] = []
    public private(set) var status: [String: String] = [:]
    public private(set) var widgets: [String: [String]] = [:]
    public private(set) var title: String?
    public private(set) var pendingAsks: [PendingAsk] = []
    /// Leaf-entry cursor from the last `get_entries` response — the app resends
    /// it as `since` for a delta refetch (design 01M15FMQ).
    public private(set) var leafId: String?

    public init() {}

    public mutating func apply(_ message: EnvelopeMessage) {
        if let evt = message.evt { applyEvt(evt) }
        if let rpc = message.rpc { applyRpc(rpc, aux: message.aux) }
    }

    public mutating func apply<S: Sequence>(_ messages: S) where S.Element == EnvelopeMessage {
        for message in messages { apply(message) }
    }

    // MARK: - rpc plane

    private mutating func applyRpc(_ rpc: JSONValue, aux: JSONValue? = nil) {
        switch rpc["type"]?.stringValue {
        case "extension_ui_request":
            applyExtensionUI(rpc)
        case "response" where rpc["command"]?.stringValue == "get_state":
            applyState(rpc["data"])
        case "response" where rpc["command"]?.stringValue == "get_entries":
            // Native pi get_entries: reduce the raw entry log into the transcript
            // (idempotent via identify) + keep the leaf cursor for a delta refetch.
            if let entries = rpc["data"]?["entries"]?.arrayValue { session.applyEntries(entries) }
            if let leaf = rpc["data"]?["leafId"]?.stringValue { leafId = leaf }
        case "response":
            break   // other command responses carry no transcript/side effect here
        default:
            session.applyRPC(rpc)   // message / tool / turn / compaction → transcript
            // After the card is opened, attach any Edit-diff hunks the envelope
            // carried in its `aux` sidecar (args stay raw — untouched above).
            if rpc["type"]?.stringValue == "tool_execution_start",
               let toolCallID = rpc["toolCallId"]?.stringValue,
               let hunks = aux?["hunks"]?.arrayValue {
                session.attachToolHunks(toolCallID: toolCallID, hunks: hunks)
            }
            // On tool_execution_end, attach any classified OUTPUT sidecar the
            // envelope carried (rpc.result stays raw — untouched above).
            if rpc["type"]?.stringValue == "tool_execution_end",
               let output = aux?["output"] {
                session.attachToolOutput(toolCallID: rpc["toolCallId"]?.stringValue ?? "", output: output)
            }
        }
    }

    private mutating func applyExtensionUI(_ rpc: JSONValue) {
        switch rpc["method"]?.stringValue {
        case "notify":
            notifications.append(UINotification(level: rpc["notifyType"]?.stringValue ?? "info",
                                                message: rpc["message"]?.stringValue ?? ""))
        case "setStatus":
            guard let key = rpc["statusKey"]?.stringValue else { return }
            if let text = rpc["statusText"]?.stringValue {
                status[key] = text.strippingANSI()        // set
            } else {
                status.removeValue(forKey: key)            // empty text = clear
            }
        case "setWidget":
            guard let key = rpc["widgetKey"]?.stringValue else { return }
            let lines = rpc["widgetLines"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            if lines.isEmpty {
                widgets.removeValue(forKey: key)           // empty lines = clear
            } else {
                widgets[key] = lines.map { $0.strippingANSI() }
            }
        case "setTitle":
            title = rpc["title"]?.stringValue
        case "select", "confirm", "input", "editor":
            pendingAsks.append(PendingAsk(id: rpc["id"]?.stringValue ?? "",
                                          method: rpc["method"]?.stringValue ?? "",
                                          title: rpc["title"]?.stringValue,
                                          message: rpc["message"]?.stringValue,
                                          options: rpc["options"]?.arrayValue?.compactMap { $0.stringValue }))
        default:
            break
        }
    }

    private mutating func applyState(_ data: JSONValue?) {
        let model = data?["model"]
        snapshot = SessionSnapshot(model: model?["id"]?.stringValue,
                                   provider: model?["provider"]?.stringValue,
                                   thinkingLevel: data?["thinkingLevel"]?.stringValue,
                                   isStreaming: data?["isStreaming"]?.boolValue,
                                   sessionId: data?["sessionId"]?.stringValue,
                                   messageCount: data?["messageCount"]?.intValue)
    }

    // MARK: - evt plane (panels)

    private mutating func applyEvt(_ evt: EnvelopeEvt) {
        switch evt.channel {
        case "subagents:started", "subagents:steered", "subagents:completed", "subagents:failed":
            guard let id = evt.data["id"]?.stringValue else { return }
            let status = String(evt.channel.dropFirst("subagents:".count))
            upsertSubagent(id: id,
                           type: evt.data["type"]?.stringValue,
                           description: evt.data["description"]?.stringValue,
                           status: status,
                           result: evt.data["result"]?.stringValue,
                           error: evt.data["error"]?.stringValue)
        case "plan:snapshot", "plan:update":
            plan = PlanSnapshot(project: evt.data["project"]?.stringValue,
                                itemCount: evt.data["items"]?.arrayValue?.count ?? 0)
        default:
            break
        }
    }

    private mutating func upsertSubagent(id: String, type: String?, description: String?,
                                         status: String, result: String?, error: String?) {
        var entry = SubagentEntry(id: id, type: type, description: description,
                                  status: status, result: result, error: error)
        if let idx = subagents.firstIndex(where: { $0.id == id }) {
            if entry.type == nil { entry.type = subagents[idx].type }
            if entry.description == nil { entry.description = subagents[idx].description }
            subagents[idx] = entry
        } else {
            subagents.append(entry)
        }
    }
}
