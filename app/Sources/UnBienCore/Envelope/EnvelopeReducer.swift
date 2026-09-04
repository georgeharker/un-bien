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

    /// Retract the session-ended state: the pi session was RESUMED (the fresh
    /// extension instance re-joined the same room under the durable session
    /// id). Forwarded by the app on room re-advertise / hello — it must clear
    /// the reducer's own copy too, or the next `apply` fold would resurrect
    /// the flag when it overwrites `transcripts[key]` from `session`.
    public mutating func markResumed() {
        session.markResumed()
    }

    /// Append an informational notice row to the transcript — app-side routing
    /// of extension_ui `notify` frames (see AppModel+Inbound). Forwarded so the
    /// app can fold it into the reducer's session and publish the transcript.
    public mutating func appendNotice(code: String, message: String) {
        session.appendNotice(code: code, message: message)
    }

    /// Thread the app's thinking-visibility pref into the transcript reducer:
    /// the follow counter (liveArrivals) must only count arrivals the reader
    /// can SEE — a hidden reasoning delta is not "new output" and must not
    /// pin a bottom reader during a quiet thinking phase (the "…" lock).
    /// Re-applied by the app at every fold, so a mid-session pref change takes
    /// effect on the next frame.
    public mutating func setHideReasoning(_ hide: Bool) {
        session.hideReasoning = hide
    }

    /// Full-walk reset (ordering fix — see SessionState.resetTranscript): the
    /// app calls this BEFORE folding a since==nil get_entries response,
    /// correlated by request id (AppModel.pendingFullReplay).
    public mutating func resetTranscript() {
        session.resetTranscript()
    }

    /// CACHE-REPLAY FOLD (design 01M1M4N8RZZANDX6NWY7FCSBT5): the same effect
    /// as a get_entries response fold, fed from the local entry cache instead
    /// of the wire — idempotent via identify, log-ordered, and the leaf cursor
    /// advances so the following delta fetch continues from the cache tail.
    /// The cache's leafId is the COMPLETING walk's active leaf — a TRUSTED
    /// beacon for Stage 0's path derivation (derive + render in one shot).
    public mutating func applyEntries(_ entries: [JSONValue], leafId: String?) {
        session.applyEntries(entries, leafId: leafId)
        if let leafId { self.leafId = leafId }
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
            // STAGE 0 leaf beacon: a PARTIAL page's leafId is its last entry's
            // id (the resume CURSOR) — deriving from it would build a partial
            // path. Trust leafId as the ACTIVE LEAF only when the page
            // COMPLETES the log: entries empty (the walk terminal —
            // unambiguous), or leafId != the page's last entry id (a
            // completing page whose active leaf isn't the log's final entry —
            // the branchy case; the rare corner where the moved leaf IS the
            // final entry resolves on the next empty terminal).
            if let entries = rpc["data"]?["entries"]?.arrayValue {
                let leaf = rpc["data"]?["leafId"]?.stringValue
                let trusted = entries.isEmpty || leaf != entries.last?["id"]?.stringValue
                session.applyEntries(entries, leafId: trusted ? leaf : nil)
            }
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
            // OUTPUT enrichment is app-side (design 01M177AF): SessionState
            // classifies the raw result in fillToolCard, covering live AND
            // get_entries replay. No aux.output is read from the wire.
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
        // Authoritative busy reconcile (design 01M1NFAE): a peer reporting NOT
        // streaming while we still hold an open stream/turn means we missed the
        // terminal events — clear the stuck bubble + dots. ONLY on an explicit
        // false; nil (unknown / older extension) leaves live state untouched.
        if data?["isStreaming"]?.boolValue == false {
            session.reconcileBusyState(isStreaming: false)
        }
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
