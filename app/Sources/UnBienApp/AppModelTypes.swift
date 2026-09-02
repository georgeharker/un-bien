import Foundation
import UnBienCore

// The small top-level VALUE types AppModel.swift declared before the class,
// split out of AppModel.swift (its 1000-line cap). Pure relocation — no
// semantic change; all remain public (UnBienApp's API surface).

public enum RelayHealth: Equatable, Sendable {
    case connecting, online, offline
    case failed(String)
}

/// A live session (Pi room) discovered on a relay via control frames.
public struct LiveSession: Identifiable, Equatable, Hashable, Sendable {
    public let relayID: UUID
    public let peerEPK: String
    /// Relay room id — mesh/relay ROUTING only (addressing frames to this
    /// session). NOT the identity.
    public let roomID: String
    /// The pi sessionId — the session IDENTITY (wire identity). All per-session
    /// state keys on this, never on roomID.
    public let sessionID: String
    public var name: String
    public var cwd: String?
    public var model: String?
    /// Parent pi sessionId when this is a subagent child (from room_meta); the
    /// app nests + associates by this pi id.
    public var parentSessionID: String?
    /// Supplementary relay metadata — kept, but NOT logic keys.
    public var parentRoomID: String?
    public var subagentID: String?
    /// Subagent lifecycle status (done/failed/in_progress/pending), PULLED over
    /// this session's own connection via `get_session_info` (design 01M18PCM) —
    /// not room_meta. nil until the pull answers.
    public var status: String? = nil

    /// Identity = pi sessionId, NOT the routing roomId.
    public var id: String { "\(relayID.uuidString):\(peerEPK):\(sessionID)" }
    public var isSubagent: Bool { parentSessionID != nil }

    /// A subagent whose PULLED lifecycle status (get_session_info, design
    /// 01M18PCM) is terminal: it finished (or failed) — nothing more will
    /// happen in it, but its room lingers at the relay by design (keeper), so
    /// the app treats it as removable clutter, not a live chat. nil status
    /// (pull not answered yet) is NOT terminal.
    public var isTerminalSubagent: Bool {
        guard isSubagent, let status else { return false }
        return ["done", "completed", "failed", "error", "aborted", "stopped"]
            .contains(status)
    }
}

/// Ask-reconciliation window (robustness backstop for dropped dismissal
/// notifies). Opened when a `session_sync` is sent (`requestReconstruction`);
/// collects every interactive extension_ui ask id that arrives before the
/// matching `session_sync_end`; at the terminator a stored prompt whose flow
/// wasn't replayed is stale (the bridge replays its FULL activeFlows set on
/// every sync — absence = resolved/expired) and is retired. Internal to
/// AppModel's routing (AppModel.swift owns the map; AppModel+Inbound drives it).
struct AskSyncWindow: Equatable, Sendable {
    /// A session_sync was sent and its terminator hasn't landed yet.
    var inFlight = false
    /// Ask request ids seen (replayed or live) since the sync was sent.
    var replayedAskIDs: Set<String> = []
}

/// Daemon/machine status pulled via a `presence_status` request (design
/// 01M1813Q) — an idle machine's launch capabilities + configured backend,
/// kept SEPARATE from per-session `capabilities` (there is no session here).
public struct DaemonPresence: Equatable, Sendable {
    public var caps: Set<String>
    public var hostname: String?
    public var backend: String?
    public init(caps: Set<String>, hostname: String?, backend: String?) {
        self.caps = caps
        self.hostname = hostname
        self.backend = backend
    }
    public func supports(_ cap: String) -> Bool { caps.contains(cap) }
}

/// A named side-panel (plan, subagents, …) mirrored from a cooperating event
/// source, surfaced as a top-bar item that badges when it changes.
public struct PanelState: Identifiable, Equatable, Sendable {
    public let key: String
    public var title: String
    public var icon: String?
    public var data: JSONValue
    /// True since the last update; cleared when the user opens the panel.
    public var changed: Bool
    public var id: String { key }
}

/// A pairing invite that arrived via the `unbien://` URL scheme (system Camera
/// or an external link) and is awaiting a relay choice. The QR carries no relay
/// (DESIGN: `r` dropped), so the deep-link flow must pick one.
public struct PendingPairing: Identifiable {
    public let id = UUID()
    public let invite: PairingInvite
    public init(invite: PairingInvite) { self.invite = invite }
}
