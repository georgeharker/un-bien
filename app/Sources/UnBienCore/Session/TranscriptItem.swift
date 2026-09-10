import Foundation

/// ROW-id creation — the ONE source of the role-prefix format. The row id is
/// the transcript's join key (height registry, window driver order/near sets,
/// flip inboxes, scroll anchors, pending/rekey bookkeeping, debug traces),
/// and several sites must RECONSTRUCT it from a bubble/entry id — inline
/// `"\(role):\(id)"` formatting anywhere else can drift out of sync with
/// `TranscriptItem.id`. Every construction routes through here.
public enum RowID {
    public static func user(_ bubbleID: String) -> String { "user:\(bubbleID)" }
    public static func assistant(_ bubbleID: String) -> String { "assistant:\(bubbleID)" }
    public static func reasoning(_ blockID: String) -> String { "reasoning:\(blockID)" }
    public static func tool(_ toolCallID: String) -> String { "tool:\(toolCallID)" }
    public static func compaction(_ markerID: String) -> String { "compaction:\(markerID)" }
    public static func notice(_ noticeID: String) -> String { "notice:\(noticeID)" }
}

/// Synthetic-id MINTS — the ONLY place placeholder ids are created (design
/// 01M2435 for the UUID live-row synthetics; the seq-based ones are ephemeral
/// notice/demo rows never keyed in the render caches). No inline id formatting
/// anywhere else — the same single-source discipline as `RowID` (role-prefixed
/// ROW ids) and the cache key builders. Lives beside `RowID` so this file is
/// the session's complete id-format vocabulary.
public enum SyntheticID {
    /// Live-row placeholders — globally unique per row; the `a-`/`u-`/`r-`
    /// prefix marks the synthetic id-space (a pi entry id is bare hex; the
    /// dash is the tell).
    public static func assistant() -> String { "a-\(UUID().uuidString)" }
    public static func user() -> String { "u-\(UUID().uuidString)" }
    public static func reasoning() -> String { "r-\(UUID().uuidString)" }
    /// Ephemeral notice ids (kind prefix + per-reducer seq; never cached).
    public static func notice(_ kind: String, seq: Int) -> String { "\(kind)\(seq)" }
    /// Entry-identity error notice (dedups a live error against its replay).
    public static func error(identify: String, hash: String) -> String { "err\(identify)\(hash)" }
    /// Live-born compaction marker (no pi entry id yet).
    public static func compaction(seq: Int) -> String { "\(seq)" }
    /// DEMO transcripts only — deterministic per turn so demo previews and
    /// tests stay stable across runs (NOT the live synthetic scheme).
    public static func demoUser(_ turn: Int) -> String { "u\(turn)" }
    public static func demoAssistant(_ turn: Int) -> String { "a\(turn)" }
}

/// One rendered row in a session transcript. The reducer (``SessionState``)
/// produces an ordered list of these from history replay + the live stream.
public enum TranscriptItem: Equatable, Sendable, Identifiable {
    case user(UserBubble)
    case reasoning(ReasoningBlock)
    case assistant(AssistantBubble)
    case tool(ToolCard)
    case compaction(CompactionMarker)
    case notice(NoticeItem)

    public var id: String {
        switch self {
        case let .user(bubble): return RowID.user(bubble.id)
        case let .reasoning(block): return RowID.reasoning(block.id)
        case let .assistant(bubble): return RowID.assistant(bubble.id)
        case let .tool(card): return RowID.tool(card.toolCallID)
        case let .compaction(marker): return RowID.compaction(marker.id)
        case let .notice(notice): return RowID.notice(notice.id)
        }
    }

    /// The id consumers may PERSIST for position anchoring (scroll memory,
    /// design 01M1B9F6). nil on rows whose ids are not replay-stable:
    /// streaming/positional assistant bubbles and PENDING live rows (seq
    /// synthetics awaiting their pi entry id — id-scheme v2: the entry id IS
    /// the row id, so stability is a fact of the id, not a flag), live-only
    /// reasoning segments, and ephemeral notices. NEVER persist a raw `id` for
    /// anchoring — only `anchorID`.
    public var anchorID: String? {
        switch self {
        case let .user(bubble): return bubble.replayStable ? id : nil
        case .tool, .compaction: return id
        case let .assistant(bubble): return bubble.replayStable ? id : nil
        case .reasoning, .notice: return nil
        }
    }
}

/// A system notice surfaced in the transcript — e.g. an `error` from the Pi
/// such as `unknown_peer` ("Peer not paired — re-scan QR").
public struct NoticeItem: Equatable, Sendable {
    public let id: String
    public let code: String
    public let message: String
    public init(id: String, code: String, message: String) {
        self.id = id
        self.code = code
        self.message = message
    }
}

public struct UserBubble: Equatable, Sendable {
    public let id: String
    public var text: String
    public var images: [WireImage]
    /// True when `id` is a durable pi ENTRY id (anchorable — id-scheme v2: the
    /// entry id IS the row id). False while PENDING: a live-born seq synthetic
    /// (`u{n}`) awaiting the message_end-triggered delta that re-keys it.
    public var replayStable: Bool
    public init(id: String, text: String, images: [WireImage] = [],
                replayStable: Bool = true) {
        self.id = id
        self.text = text
        self.images = images
        self.replayStable = replayStable
    }
}

/// A streamed model-reasoning (thinking) block — un-bien fork extension
/// (`agent_reasoning`). Rendered collapsed by default. `id` distinguishes
/// multiple reasoning segments within one turn.
public struct ReasoningBlock: Equatable, Sendable {
    public let id: String
    public var text: String
    public var streaming: Bool
    public init(id: String, text: String, streaming: Bool) {
        self.id = id
        self.text = text
        self.streaming = streaming
    }
}

public struct AssistantBubble: Equatable, Sendable {
    /// Stable per-segment identity. A single turn can open SEVERAL assistant
    /// bubbles (text → tool card → more text), so keying a row on `inReplyTo`
    /// alone collides and makes `LazyVStack` drop rows on scroll. This id is
    /// unique per bubble; `inReplyTo` stays the turn key the reducer matches on.
    public let id: String
    public let inReplyTo: String
    public var text: String
    /// True while `agent_chunk`s are still arriving (before `agent_done`).
    public var streaming: Bool
    /// Whether this row's id is REPLAY-STABLE — derived from the message's own
    /// identity (`identify`), so a get_entries/session_sync replay of the same
    /// message resolves to the same id. True only for bubbles built (or
    /// re-keyed) at `message_end`; delta-built bubbles carry positional ids
    /// re-keyed at settle (design 01M1B9F6). Note `streaming == false` alone
    /// does NOT imply this: a bubble interrupted by a tool card is closed
    /// (streaming=false) but keeps its positional id.
    public var replayStable: Bool
    public var usage: Usage?
    /// Agent-emitted inline graphics (plots/diagrams), rendered in the bubble.
    /// Arrive on the settling `agent_message` (live + history), keeping images
    /// in the conversation flow rather than a separate row.
    public var images: [WireImage]
    public init(id: String, inReplyTo: String, text: String, streaming: Bool,
                usage: Usage? = nil, images: [WireImage] = [], replayStable: Bool = false) {
        self.id = id
        self.inReplyTo = inReplyTo
        self.text = text
        self.streaming = streaming
        self.replayStable = replayStable
        self.usage = usage
        self.images = images
    }
}

public struct ToolCard: Equatable, Sendable {
    public enum State: Equatable, Sendable { case running, ok, failed }
    public let toolCallID: String
    public let tool: String
    public var args: [String: JSONValue]
    public var result: JSONValue?
    public var error: String?
    public var state: State
    /// Images returned in the tool result (screenshots/plots), rendered on the card.
    public var images: [WireImage]
    /// Raw Edit-diff `hunks` array from the envelope `aux` sidecar; when present,
    /// the card renders a diff instead of raw args JSON.
    public var hunks: [JSONValue]?
    /// Classified tool OUTPUT container from the envelope `aux.output`: the
    /// versioned multi-block shape `{ v:1, blocks:[{kind,...}], truncated? }`.
    /// The card renders each block whose `kind` it knows (diff, code) in order
    /// and skips the rest; an empty/all-unknown list → raw `result` JSON fallback.
    public var output: JSONValue?
    public init(toolCallID: String, tool: String, args: [String: JSONValue],
                result: JSONValue? = nil, error: String? = nil, state: State = .running,
                images: [WireImage] = [], hunks: [JSONValue]? = nil, output: JSONValue? = nil) {
        self.toolCallID = toolCallID
        self.tool = tool
        self.args = args
        self.result = result
        self.error = error
        self.state = state
        self.images = images
        self.hunks = hunks
        self.output = output
    }
}

public struct CompactionMarker: Equatable, Sendable {
    public let id: String
    public let summary: String
    public let tokensBefore: Int
    public init(id: String, summary: String, tokensBefore: Int) {
        self.id = id
        self.summary = summary
        self.tokensBefore = tokensBefore
    }
}

extension Array where Element == TranscriptItem {
    /// Nearest replay-stable anchor id at-or-above `index` (design 01M1B9F6).
    /// Scroll-memory capture calls this with the bottom-most VISIBLE row's
    /// index; a transient row (streaming/positional bubble, reasoning, notice)
    /// walks UP to the nearest persistable row. nil when nothing at-or-above
    /// is stable or `index` is out of range.
    public func stableAnchor(atOrAbove index: Int) -> String? {
        guard index >= 0, index < count else { return nil }
        for i in stride(from: index, through: 0, by: -1) {
            if let anchor = self[i].anchorID { return anchor }
        }
        return nil
    }
}
