import Foundation

/// App → Pi control surface (DESIGN §4). Carried base64-encoded inside a
/// ``RoutedEnvelope`` `ct` field. Discriminated by `type`.
public enum ClientMessage: Equatable, Sendable {
    case pairRequest(id: String, token: String, deviceName: String)
    case userMessage(id: String, text: String, images: [WireImage]?, streamingBehavior: String?)
    case approveTool(id: String, toolCallID: String, decision: ToolDecision)
    case cancel(id: String, targetID: String)
    case ping(id: String)
    /// un-bien reconstruction TRIGGER — asks the fork to re-send its NON-rpc
    /// display state (panels + pending extension_ui). The transcript is NOT
    /// carried here; it's the app's own `get_entries` rpc (design 01M15FMQ).
    case sessionSync(id: String, limit: Int?)
    /// Native pi `get_entries` rpc — the transcript source. The fork answers
    /// with `{entries, leafId}`; the app reduces the raw entries itself
    /// (`SessionState.applyEntries`). `since` = the last leafId cursor for a
    /// delta fetch; nil = full log.
    case getEntries(id: String, since: String?)
    case sessionNew(id: String)
    case sessionCompact(id: String)
    case modelSet(id: String, provider: String, modelID: String)
    case thinkingSet(id: String, level: ThinkingLevel)
    case listModels(id: String)
    /// un-bien remote launch: spawn a NEW pi session on the paired machine
    /// (owner-key + config gated; shown only when the `remote_launch` cap is
    /// advertised). `mode` is optional and normally omitted — the machine's
    /// `launch.backend` config decides the backend (tmux | herdr; rpc is a
    /// fast-follow).
    case sessionLaunch(id: String, mode: String?, cwd: String?, name: String?)
    /// Daemon caps PULL (design 01M1813Q): ask a machine's presence daemon for
    /// its capabilities. Answered ONLY by the presence daemon with a
    /// `presence_status` response { caps, hostname, backend }.
    case presenceStatus(id: String)
    /// Session-info PULL: ask a session for its own info (subagent lifecycle
    /// status for now). Answered by the extension from pi's tracked state, so it
    /// survives app relaunch; re-issued on reconnect / room re-announce.
    case getSessionInfo(id: String)
    /// Response to an `extension_ui_request` (select/confirm/input/editor).
    case extensionUiResponse(ExtensionUiResponse)
    /// Native pi `clear_queue` rpc — drop the steering/follow-up queue. Used by
    /// the queued-chip X: pi has no per-item delete, so the app clears the whole
    /// queue then reissues the survivors (design: delete-queued = clear+reissue).
    /// Native pi `clear_queue` rpc — drop the steering/follow-up queue. Used by
    /// the queued-chip X: pi has no per-item delete, so the app clears the whole
    /// queue then reissues the survivors (design: delete-queued = clear+reissue).
    case clearQueue(id: String)
    /// Native pi `set_session_name` rpc — remote rename (pre-release
    /// 2026-09-18). Rides the rpc plane VERBATIM (pi's own verb name, so no
    /// RelayConnection mapping needed); the reply is pi's standard response,
    /// and the extension's session_info_changed forward confirms the new
    /// name live (optimistic update + revert on failure/timeout app-side).
    case setSessionName(id: String, name: String)
    /// un-bien app-driven terminate (plan [lifecycle][send]): kill the session
    /// THIS room serves. Root room: graceful host shutdown (pi fires
    /// session_shutdown → app marks ended → process exits → relay
    /// room_ended → row purges). Child room: stop serving + tombstone.
    /// Config-gated on the fork (`allow_remote_terminate`); the app confirms
    /// (red trash + dialog) and gates on the `remote_terminate` cap.
    case terminate(id: String, reason: String?)
    /// un-bien close_child_room: ask a PARENT session to permanently close
    /// one of its child rooms (the app's Remove on a done subagent — the room
    /// otherwise lingers at the relay by design). Fork tombstones + disposes;
    /// room_ended purges the app row.
    case closeChildRoom(id: String, roomID: String)

    public enum ToolDecision: String, Codable, Sendable {
        case allow, deny
    }

    /// The `type` discriminator as it appears on the wire.
    public var typeTag: String {
        switch self {
        case .pairRequest: return "pair_request"
        case .userMessage: return "user_message"
        case .approveTool: return "approve_tool"
        case .cancel: return "cancel"
        case .ping: return "ping"
        case .sessionSync: return "session_sync"
        case .getEntries: return "get_entries"
        case .sessionNew: return "session_new"
        case .sessionCompact: return "session_compact"
        case .modelSet: return "model_set"
        case .thinkingSet: return "thinking_set"
        case .listModels: return "list_models"
        case .sessionLaunch: return "session_launch"
        case .presenceStatus: return "presence_status"
        case .getSessionInfo: return "get_session_info"
        case .terminate: return "terminate"
        case .closeChildRoom: return "close_child_room"
        case .setSessionName: return "set_session_name"
        case .extensionUiResponse: return "extension_ui_response"
        case .clearQueue: return "clear_queue"
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
