import Foundation

/// Reduces a session's `session_history` replay + live `ServerMessage` stream
/// into an ordered transcript (DESIGN §4 reducer rules):
/// - `tool_request` opens a card keyed by `tool_call_id`; the later
///   `tool_result` with the same id fills it.
/// - `agent_chunk` deltas append to the in-flight assistant bubble keyed by
///   `in_reply_to` until `agent_done`; `agent_message` is a settled bubble.
///
/// Not thread-safe by itself; drive it from a single actor/`@MainActor` owner.
public struct SessionState: Equatable, Sendable {
    public private(set) var items: [TranscriptItem] = []
    /// Ids already appended. A re-applied replay/history item (same id) must not
    /// create a duplicate — SwiftUI `ForEach` requires unique ids, and a dupe
    /// gives "undefined results" (wrong/dropped/duplicated bubbles).
    private var appendedIDs: Set<String> = []
    public private(set) var sessionStartedAt: Int?

    /// `in_reply_to` of the turn currently streaming (chunks or reasoning),
    /// or `nil` when idle. This is the `target_id` a `cancel` should carry.
    public private(set) var activeTurnID: String?

    /// VISIBLE-arrival version for transcript bottom-following (scroll
    /// design): bumped ONLY when a reader-visible mutation happened — a row
    /// was inserted (appendNotice, replay included), streaming text grew, a
    /// tool card was opened/filled, or a bubble settled. NOT bumped for
    /// invisible arrivals: thinking deltas while thinking is hidden
    /// (`hideReasoning`), toolcall lifecycle events, toolResult `message_end`s
    /// (no row — the card fills via its own frame), dedup no-op replays, and
    /// idempotent card re-opens. "The turn is running" is not "something was
    /// output": phantom bumps during a quiet thinking phase would pin a
    /// bottom reader — each phantom follow re-pins the bottom sentinel inside
    /// the 150 ms unpin debounce (the "…" lock). The anti-yank guarantee for
    /// replayed history is the VIEW's gates (atBottom pin + restore-wait),
    /// not this counter. Int-based: `.onChange(of:)` needs Equatable.
    public private(set) var liveArrivals: Int = 0

    /// Thinking-visibility pref (app-threaded; see EnvelopeReducer
    /// .setHideReasoning): when true, reasoning deltas still fold (the pref
    /// can flip back mid-session) but do NOT bump `liveArrivals` — a hidden
    /// row is not new output and must not pin the reader to the bottom.
    public var hideReasoning: Bool = false

    /// Set once the paired pi session has shut down (`rpc:session_shutdown`).
    /// The UI shows a "session ended" banner and refuses further input.
    /// RETRACTABLE: a pi session can be RESUMED — the fresh extension instance
    /// re-joins the same room under the durable session id — so a live
    /// `turn_start` (see applyRPC) or an explicit `markResumed()` (room
    /// re-advertise / hello) clears it and the banner drops.
    public private(set) var ended: Bool = false

    /// Index of each addressable item so updates are O(1).
    /// Index of the assistant bubble currently accepting streamed chunks. A
    /// tool card (or any inserted row) closes it, so post-tool text starts a
    /// NEW bubble below the card — preserving mid-turn interleaving.
    private var openAssistantIndex: Int?
    /// Index of the reasoning block currently accepting `agent_reasoning`
    /// deltas. Closed by the following text/tool row, like the assistant tail.
    private var openReasoningIndex: Int?
    private var toolIndex: [String: Int] = [:]       // toolCallID → items index
    private var compactionSeq = 0
    private var reasoningSeq = 0
    private var noticeSeq = 0
    private var assistantSeq = 0
    // rpc-envelope reduction state
    private var rpcTurn: String?
    private var rpcTurnSeq = 0
    /// True while `applyEntries` is folding REPLAYED history (get_entries
    /// refetch). A replay must never disturb live-stream continuation state:
    /// replayed rows append BELOW an in-flight streaming bubble, so the walk
    /// neither CLOSES the open bubble (else the next live delta mints a NEW
    /// bubble — the "text arrives as sentence-fragment bubbles" corruption
    /// after a reconnect mid-stream) nor RE-KEYS it (a replayed settled
    /// message_end must not steal the live bubble's identity via reid).
    private var isReplayingEntries = false

    public init() {}

    /// Retract the ended state: the session was resumed (its room re-advertised
    /// and/or a fresh extension instance greeted). Drops the banner and
    /// re-enables the composer. Live turns also clear it (see `turn_start`).
    public mutating func markResumed() {
        ended = false
    }

    /// Append a one-off informational notice row. Used by the APP-side routing
    /// of extension_ui `notify` frames (AppModel+Inbound): a warning notify is
    /// actionable (answer rejected / bridge TTL expired) but must not own a
    /// modal — it lands inline in the transcript instead.
    public mutating func appendNotice(code: String, message: String) {
        noticeSeq += 1
        append(.notice(NoticeItem(id: "ext\(noticeSeq)", code: code, message: message)))
        liveArrivals += 1
    }

    /// Usage from the most recent assistant turn that reported it (for a status
    /// line). `agent_done`/`agent_message` carry per-turn token counts.
    public var latestUsage: Usage? {
        for item in items.reversed() {
            if case let .assistant(bubble) = item, let usage = bubble.usage { return usage }
        }
        return nil
    }

    /// The last context-compaction marker, if the session has compacted.
    public var lastCompaction: CompactionMarker? {
        for item in items.reversed() {
            if case let .compaction(marker) = item { return marker }
        }
        return nil
    }

    // MARK: - Mutators

    /// Append a non-chunk row. Closes the open streaming bubble first, so the
    /// next chunk starts a new bubble AFTER this row (mid-turn interleaving).
    /// Returns false on a dedup no-op (id already present — replayed frame).
    private mutating func append(_ item: TranscriptItem) -> Bool {
        guard appendedIDs.insert(item.id).inserted else { return false }
        closeOpenAssistant()
        items.append(item)
        return true
    }

    /// Mark any currently-open streaming block (assistant text or reasoning)
    /// as settled and forget it, so the next inserted row starts fresh.
    private mutating func closeOpenAssistant() {
        // Inert during a replay walk: history folding must not settle the
        // in-flight live bubble (see isReplayingEntries).
        if isReplayingEntries { return }
        if let index = openAssistantIndex, case var .assistant(bubble) = items[index] {
            bubble.streaming = false
            items[index] = .assistant(bubble)
        }
        if let index = openReasoningIndex, case var .reasoning(block) = items[index] {
            block.streaming = false
            items[index] = .reasoning(block)
        }
        openAssistantIndex = nil
        openReasoningIndex = nil
    }

    private mutating func appendReasoning(inReplyTo: String, delta: String) {
        if let index = openReasoningIndex, case var .reasoning(block) = items[index] {
            block.text += delta
            block.streaming = true
            items[index] = .reasoning(block)
        } else {
            reasoningSeq += 1
            append(.reasoning(ReasoningBlock(id: "\(reasoningSeq)", text: delta, streaming: true)))
            openReasoningIndex = items.count - 1
        }
        activeTurnID = inReplyTo
    }

    private mutating func appendChunk(inReplyTo: String, delta: String) {
        if let index = openAssistantIndex, case var .assistant(bubble) = items[index],
           bubble.inReplyTo == inReplyTo {
            bubble.text += delta
            bubble.streaming = true
            items[index] = .assistant(bubble)
        } else {
            assistantSeq += 1
            append(.assistant(AssistantBubble(id: "a\(assistantSeq)", inReplyTo: inReplyTo,
                                              text: delta, streaming: true)))
            openAssistantIndex = items.count - 1
        }
        activeTurnID = inReplyTo
    }

    /// Open (or idempotently re-open) a tool card. Returns true only when a
    /// NEW card was inserted — a re-open of a known card is a re-sync no-op
    /// and must not count as a visible arrival.
    @discardableResult
    private mutating func openToolCard(toolCallID: String, tool: String, args: [String: JSONValue]) -> Bool {
        if let index = toolIndex[toolCallID] { // idempotent re-open (re-sync)
            items[index] = .tool(ToolCard(toolCallID: toolCallID, tool: tool, args: args))
            return false
        }
        let inserted = append(.tool(ToolCard(toolCallID: toolCallID, tool: tool, args: args)))
        toolIndex[toolCallID] = items.count - 1
        return inserted
    }

    /// Attach pre-rendered Edit-diff `hunks` (from the envelope `aux` sidecar) to
    /// an already-opened tool card. No-op if the card isn't found yet.
    public mutating func attachToolHunks(toolCallID: String, hunks: [JSONValue]) {
        guard let index = toolIndex[toolCallID], case var .tool(card) = items[index] else { return }
        card.hunks = hunks
        items[index] = .tool(card)
    }

    /// Write a partial result onto an open card. Returns true only when a
    /// visible write happened (card exists AND a partial arrived).
    @discardableResult
    private mutating func updateToolCard(toolCallID: String, partial: JSONValue?) -> Bool {
        guard let index = toolIndex[toolCallID], case var .tool(card) = items[index] else { return false }
        guard let partial else { return false }
        card.result = partial
        items[index] = .tool(card)
        return true
    }

    /// Fill an open card with its settled result. Returns true only when the
    /// card exists (an unknown-id fill is a replay straggler, not output).
    @discardableResult
    private mutating func fillToolCard(toolCallID: String, result: JSONValue?, error: String?,
                                       images: [WireImage] = []) -> Bool {
        guard let index = toolIndex[toolCallID], case var .tool(card) = items[index] else { return false }
        card.result = result
        card.error = error
        card.state = error == nil ? .ok : .failed
        if !images.isEmpty { card.images = images }
        // OUTPUT classification is APP-SIDE (design 01M177AF): classify the
        // persisted result here so a get_entries replay (which synthesizes
        // tool_execution_end → this same path) is enriched identically to live.
        card.output = ToolOutputClassifier.classify(tool: card.tool, result: result,
                                                    args: .object(card.args))
        items[index] = .tool(card)
        return true
    }

    @discardableResult
    private mutating func appendCompaction(summary: String, tokensBefore: Int) -> Bool {
        compactionSeq += 1
        return append(.compaction(CompactionMarker(id: "\(compactionSeq)", summary: summary,
                                                   tokensBefore: tokensBefore)))
    }

    // MARK: - RPC (rpc-envelope) reduction

    /// Fold one verbatim pi rpc frame into the transcript — the rpc-envelope
    /// path, mirroring the stock `apply`. Streaming deltas build in-flight
    /// bubbles; `message_end` is authoritative; `tool_execution_*` drive cards.
    /// Panels (`subagents:*`/`plan:*`) are the {evt} plane and are NOT handled
    /// here — see `EnvelopeReducer`.
    public mutating func applyRPC(_ frame: JSONValue) {
        guard let type = frame["type"]?.stringValue else { return }
        switch type {
        case "turn_start":
            // A LIVE turn means the session is running again (resumed):
            // retract the ended banner. `turn_start` is live-ONLY — a
            // get_entries / session_sync replay never synthesizes it
            // (applyEntries emits just message_end / tool_execution_* /
            // compaction_end) — so backfilling an ENDED session's history
            // can't false-clear the flag.
            ended = false
            rpcTurnSeq += 1
            rpcTurn = "t\(rpcTurnSeq)"
            activeTurnID = rpcTurn
        case "turn_end":
            closeOpenAssistant()
        case "message_end":
            if applyRPCMessageEnd(frame["message"]) { liveArrivals += 1 }
        case "message_update":
            if applyRPCDelta(frame["assistantMessageEvent"]) { liveArrivals += 1 }
        case "tool_execution_start":
            if openToolCard(toolCallID: frame["toolCallId"]?.stringValue ?? "",
                           tool: frame["toolName"]?.stringValue ?? "",
                           args: frame["args"]?.objectValue ?? [:]) {
                liveArrivals += 1
            }
        case "tool_execution_update":
            if updateToolCard(toolCallID: frame["toolCallId"]?.stringValue ?? "",
                              partial: frame["partialResult"]) {
                liveArrivals += 1
            }
        case "tool_execution_end":
            let isError = frame["isError"]?.boolValue ?? false
            if fillToolCard(toolCallID: frame["toolCallId"]?.stringValue ?? "",
                           result: frame["result"], error: isError ? "error" : nil,
                           images: Self.imagesFromToolResult(frame["result"])) {
                liveArrivals += 1
            }
        case "compaction_end":
            if let result = frame["result"], result != .null {
                if appendCompaction(summary: result["summary"]?.stringValue ?? "",
                                    tokensBefore: result["tokensBefore"]?.intValue ?? 0) {
                    liveArrivals += 1
                }
            }
        case "agent_settled":
            if let turn = rpcTurn, activeTurnID == turn { activeTurnID = nil }
            closeOpenAssistant()
        case "session_shutdown":
            ended = true
            activeTurnID = nil
            closeOpenAssistant()
        case "session_sync_end":
            // Envelope-native terminator for a session_sync replay: carries the
            // session clock (stock bundled it on `session_history`). `truncated`
            // rides along but, as in the stock path, the reducer doesn't consume it.
            if let started = frame["session_started_at"]?.intValue, started > 0 {
                sessionStartedAt = started
            }
        case "action_ok":
            break  // command succeeded — no visible surface (silent)
        case "action_error":
            // A failed app command (session_new/compact/model_set/…) surfaces as
            // a transcript notice, reusing the provider-error notice mechanism.
            noticeSeq += 1
            let action = frame["action"]?.stringValue ?? "action"
            let err = frame["error"]?.stringValue ?? "failed"
            if append(.notice(NoticeItem(id: "act\(noticeSeq)", code: "action_error",
                                         message: "\(action) failed: \(err)"))) {
                liveArrivals += 1
            }
        case "error":
            // Enveloped error reply (e.g. malformed models.json on list_models):
            // same notice surface as a provider error.
            noticeSeq += 1
            if append(.notice(NoticeItem(id: "n\(noticeSeq)", code: frame["code"]?.stringValue ?? "error",
                                         message: frame["message"]?.stringValue ?? ""))) {
                liveArrivals += 1
            }
        default:
            break
        }
    }

    /// Fold one settled message. Returns true only when a VISIBLE mutation
    /// happened (row inserted, or the streaming bubble settled/re-keyed) —
    /// drives the liveArrivals bump. toolResult / display:false custom → false.
    private mutating func applyRPCMessageEnd(_ message: JSONValue?) -> Bool {
        guard let role = message?["role"]?.stringValue else { return false }
        let turn = rpcTurn ?? "t0"
        switch role {
        case "user":
            // Stable, message-intrinsic id (identify): a later session_sync replay
            // of the same user message resolves to the same id and dedups via
            // appendedIDs. Pi messages carry no id — see design 01M15FMQ.
            return append(.user(UserBubble(id: Self.identify(message),
                                           text: message?["content"]?.joinedText() ?? "",
                                           images: Self.imagesFromContent(message?["content"]))))
        case "assistant":
            if message?["stopReason"]?.stringValue == "error" {
                // Forward a failed turn as a notice (mirrors the fork's `error`).
                return append(.notice(NoticeItem(id: "err\(Self.identify(message))", code: "provider_error",
                                                 message: message?["errorMessage"]?.stringValue ?? "Provider error")))
            } else {
                // Re-key the delta-built bubble to its stable {identify}-a id at
                // settle so a session_sync replay of the same message dedups; on
                // replay (no deltas) build it directly with the same id. Inline
                // graphics settle here (the live stream is text deltas only).
                let bubbleID = "\(Self.identify(message))-a"
                let images = Self.imagesFromContent(message?["content"])
                if openAssistantIndex != nil, !isReplayingEntries {
                    // Finalize WITHOUT clobbering delta-built interleaving; keep
                    // activeTurnID (turn isn't done until agent_settled). During a
                    // replay walk this branch is OFF: a replayed settled message
                    // is NOT the open live bubble — append it directly instead of
                    // stealing the live bubble's identity.
                    reidOpenAssistant(to: bubbleID, images: images)
                    closeOpenAssistant()
                    return true // settle is visible (streaming→false, images attach)
                } else {
                    let text = message?["content"]?.joinedText() ?? ""
                    guard !text.isEmpty || !images.isEmpty else { return false }
                    return append(.assistant(AssistantBubble(id: bubbleID, inReplyTo: turn,
                                                             text: text, streaming: false,
                                                             usage: nil, images: images,
                                                             replayStable: true)))
                }
            }
        case "custom":
            // un-bien's own bookkeeping (mesh name assignment, relay state,
            // extension auto-update) rides custom-role messages flagged
            // display:false ON THE WIRE precisely so clients don't surface
            // them — honor it. They used to render as noise notice rows in
            // live sessions AND the fixture-replayed demo ("Mesh name:
            // tmp.XXXXXX" et al). Absent/true still renders (other
            // extensions' display-intended custom messages).
            if message?["display"]?.boolValue == false { return false }
            noticeSeq += 1
            return append(.notice(NoticeItem(id: "custom\(noticeSeq)", code: "custom",
                                             message: message?["content"]?.joinedText() ?? "")))
        default:
            return false  // toolResult is rendered via tool_execution_*, not as a row
        }
    }

    /// Fold one streaming delta. Returns true only when a VISIBLE mutation
    /// happened — text growth always; a reasoning row only when reasoning is
    /// shown (`hideReasoning`); toolcall_* / *_start / *_end never (no row).
    /// Drives the liveArrivals bump: a hidden thinking stream is NOT output,
    /// else a quiet thinking phase pins a bottom reader (the "…" lock).
    private mutating func applyRPCDelta(_ event: JSONValue?) -> Bool {
        guard let type = event?["type"]?.stringValue else { return false }
        let turn = rpcTurn ?? "t0"
        switch type {
        case "text_delta":
            appendChunk(inReplyTo: turn, delta: event?["delta"]?.stringValue ?? "")
            return true
        case "thinking_delta":
            // ALWAYS fold (the pref can flip back mid-session) — visibility only
            // decides whether it counts as an arrival.
            appendReasoning(inReplyTo: turn, delta: event?["delta"]?.stringValue ?? "")
            return !hideReasoning
        default:
            return false  // *_start/_end + toolcall_*: bubbles open lazily; cards via tool_execution_*
        }
    }

    /// Reduce a batch of raw pi session ENTRIES (from the native `get_entries`
    /// rpc) into the transcript. Each message entry is fed through the SAME
    /// identify-based `message_end`/`tool_execution_*` path the live stream
    /// uses, so a get_entries (re)fetch DEDUPS against live frames instead of
    /// duplicating (design 01M15FMQ). Tool cards are reconstructed from
    /// `toolCall` content + `toolResult` entries (keyed by toolCallId). Applied
    /// to the LIVE reducer — not a reset — so it merges idempotently.
    public mutating func applyEntries(_ entries: [JSONValue]) {
        // Guard the walk: replayed history must not disturb live-stream state
        // (see isReplayingEntries). Cleared even on early exit via defer.
        isReplayingEntries = true
        defer { isReplayingEntries = false }
        for entry in entries {
            switch entry["type"]?.stringValue {
            case "compaction":
                applyRPC(.object(["type": .string("compaction_end"),
                                  "result": .object(["summary": entry["summary"] ?? .string(""),
                                                     "tokensBefore": entry["tokensBefore"] ?? .number(0)])]))
            case "message":
                guard let msg = entry["message"] else { continue }
                switch msg["role"]?.stringValue {
                case "user", "assistant":
                    applyRPC(.object(["type": .string("message_end"), "message": msg]))
                    // Reconstruct tool cards from the assistant's toolCall blocks
                    // (the live stream opens them via separate tool_execution_start
                    // frames; here they ride the message content).
                    if msg["role"]?.stringValue == "assistant", let content = msg["content"]?.arrayValue {
                        for block in content where block["type"]?.stringValue == "toolCall" {
                            applyRPC(.object(["type": .string("tool_execution_start"),
                                              "toolCallId": block["id"] ?? .string(""),
                                              "toolName": block["name"] ?? .string(""),
                                              "args": block["arguments"] ?? .object([:])]))
                        }
                    }
                case "toolResult":
                    applyRPC(.object(["type": .string("tool_execution_end"),
                                      "toolCallId": msg["toolCallId"] ?? .string(""),
                                      "result": msg["content"] ?? .null,
                                      "isError": msg["isError"] ?? .bool(false)]))
                default:
                    break
                }
            default:
                break  // model_change / thinking_level_change / label / ... : not transcript rows
            }
        }
    }

    private mutating func updateToolCard(toolCallID: String, partial: JSONValue?) {
        guard let index = toolIndex[toolCallID], case var .tool(card) = items[index] else { return }
        if let partial { card.result = partial }
        items[index] = .tool(card)
    }

    /// Attach settled inline images to the open assistant bubble (message_end).
    private mutating func attachImages(_ images: [WireImage]) {
        guard let index = openAssistantIndex, case var .assistant(bubble) = items[index] else { return }
        bubble.images = images
        items[index] = .assistant(bubble)
    }

    /// Re-key the open (delta-built) assistant bubble to its stable `identify`
    /// id at message_end, so a later session_sync replay of the same message
    /// dedups via `appendedIDs`. Keeps the streamed text (authoritative for the
    /// live bubble) and attaches settled images.
    private mutating func reidOpenAssistant(to bubbleID: String, images: [WireImage]) {
        guard let index = openAssistantIndex, case let .assistant(old) = items[index] else { return }
        appendedIDs.remove(items[index].id)
        items[index] = .assistant(AssistantBubble(id: bubbleID, inReplyTo: old.inReplyTo,
                                                  text: old.text, streaming: false,
                                                  usage: old.usage,
                                                  images: images.isEmpty ? old.images : images,
                                                  replayStable: true))
        appendedIDs.insert(items[index].id)
    }

    /// A stable, message-INTRINSIC identity derived from the pi message's own
    /// fields — identical on the live `message_end` and on a `session_sync`
    /// replay of the same message, so re-sync dedups instead of duplicating
    /// (pi messages carry no id; see design 01M15FMQ). Prefer the provider
    /// `responseId` when present; otherwise a deterministic hash of
    /// role+timestamp+model+content (timestamp disambiguates same-content
    /// messages; ts is non-unique, but content makes collisions negligible).
    static func identify(_ message: JSONValue?) -> String {
        if let rid = message?["responseId"]?.stringValue, !rid.isEmpty { return "r\(rid)" }
        let role = message?["role"]?.stringValue ?? "?"
        let ts = message?["timestamp"]?.intValue ?? 0
        let model = message?["model"]?.stringValue ?? ""
        let sig = contentSignature(message?["content"])
        return "m\(stableHash("\(role)|\(ts)|\(model)|\(sig)"))"
    }

    /// Canonical, order-preserving signature of a message `content` (array or a
    /// bare user string). Includes tool-call ids so tool-only messages don't
    /// collide on empty text. Must be deterministic across app launches, so it
    /// avoids Swift's per-process `Hasher`.
    static func contentSignature(_ content: JSONValue?) -> String {
        guard let blocks = content?.arrayValue else { return content?.stringValue ?? "" }
        return blocks.map { block in
            switch block["type"]?.stringValue ?? "" {
            case "text": return "t:" + (block["text"]?.stringValue ?? "")
            case "thinking": return "k:" + (block["thinking"]?.stringValue ?? "")
            case "toolCall": return "c:" + (block["id"]?.stringValue ?? "") + ":" + (block["name"]?.stringValue ?? "")
            case "image": return "i:" + (block["mimeType"]?.stringValue ?? "")
            case let other: return other
            }
        }.joined(separator: "\n")
    }

    /// Deterministic FNV-1a over UTF-8, base-36 — stable across processes
    /// (unlike `Hasher`), so `identify` matches on a relaunched app's re-sync.
    static func stableHash(_ s: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in s.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 36)
    }

    /// Image blocks (`{type:"image", data, mimeType}`) from a message `content`
    /// array — mirrors the fork's `_imagesFromContent`.
    static func imagesFromContent(_ content: JSONValue?) -> [WireImage] {
        guard let blocks = content?.arrayValue else { return [] }
        return blocks.compactMap { block in
            guard block["type"]?.stringValue == "image",
                  let data = block["data"]?.stringValue,
                  let mime = block["mimeType"]?.stringValue else { return nil }
            return WireImage(data: data, mime: mime)
        }
    }

    /// Images from a `tool_execution_end` result — the live result is a wrapper
    /// `{content:[...], details}`; unwrap `content` (mirrors `_imagesFromToolResult`).
    static func imagesFromToolResult(_ value: JSONValue?) -> [WireImage] {
        if value?.arrayValue != nil { return imagesFromContent(value) }
        if let content = value?["content"] { return imagesFromContent(content) }
        return []
    }

}

#if DEBUG
public extension SessionState {
    /// A large synthetic transcript for render/scroll profiling WITHOUT a live
    /// data feed — built via the real mutators (same file, so `append` is in
    /// scope). Each turn adds a user bubble, an assistant bubble (markdown +
    /// code), and a tool card.
    static func demo(turns: Int = 140) -> SessionState {
        var state = SessionState()
        for turn in 0..<turns {
            _ = state.append(.user(UserBubble(id: "u\(turn)",
                text: "Question \(turn): explain the thing in some detail.")))
            _ = state.append(.assistant(AssistantBubble(
                id: "a\(turn)", inReplyTo: "u\(turn)",
                text: "Answer \(turn): some **markdown** with a list\n\n- one\n- two\n\nand code:\n\n```swift\nlet value = \(turn)\nprint(value)\n```\n",
                streaming: false)))
            _ = state.append(.tool(ToolCard(
                toolCallID: "t\(turn)", tool: "bash",
                args: ["command": .string("echo \(turn)")],
                result: .string("output line \(turn)"), state: .ok)))
        }
        return state
    }
}
#endif
