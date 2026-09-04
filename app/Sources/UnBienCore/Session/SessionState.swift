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
    /// bottom reader — each phantom follow re-binds the bottom sentinel
    /// (the "…" lock). The anti-yank guarantee for
    /// replayed history is the VIEW's gates (pin policy + restore-wait),
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
    /// Row id → items index (id-scheme v2: rows keyed by their pi ENTRY id once
    /// known; pendings by seq synthetic). Maintained by `append`/`rekeyRow`;
    /// rows are append-only today so entries never go stale.
    private var rowIndex: [String: Int] = [:]
    /// Content identity (`identify`) → row id, for EVERY user/assistant row —
    /// BOTH the matcher's index (an entry re-keys its already-born row in
    /// place, never a twin) AND the duplicate-delivery guard (a live frame for
    /// an already-born message — pre-walk pending or walk-born entry row — is a
    /// redelivery, not a new message; this is what lets buffered live frames
    /// REPLAY after a full walk without duplicating walk-born rows). Cards
    /// (toolCallId-keyed) never register. A fetch that never lands leaves
    /// pendings here for the next successful delta/backfill — the matcher
    /// assumes ordering, not promptness.
    private var identifyIndex: [String: String] = [:]
    /// PENDING row ids (live-settled, awaiting their entry id). With the open
    /// streaming rows they define the LIVE TAIL — every tail row is NEWER than
    /// every unfolded entry (a pending's entry settles after everything before
    /// it), so a fresh entry birth must INSERT BEFORE the tail: arrival order
    /// never defines position, the log does (user report 2026-09-17: an older
    /// gap entry appended after a newer pending → inverted order).
    private var pendingRowIDs: Set<String> = []
    // STAGE 0 — branch-aware fold (design 01M1FTV2, user 2026-09-18): the
    // entry log is a TREE — append-order storage of every entry ever written,
    // INCLUDING abandoned branches. The linear transcript is a DERIVED view:
    // the parentId chain from the ACTIVE LEAF. Pull (cache load + walk pages)
    // accumulates entries and NOTHING renders until the BACKWALK
    // (derivePath); thereafter the path changes ONLY via a trusted leaf
    // beacon (walk terminal / cache meta / a completing refetch page — fires
    // every turn end), which re-derives on mismatch (the leaf MOVED — TUI
    // edit-resubmit or /tree). Live frames are untouched: they render via the
    // live plane and re-key when their entry arrives (existing machinery) —
    // the gate only ever withholds ENTRY-BORN rows.
    /// id → parentId for EVERY folded entry (retention: branch data for the
    /// future branch UI + local re-derivation on leaf moves). Root entries
    /// index with "" (pi's first entry has no parent).
    private var entryParent: [String: String] = [:]
    /// id → payload for every folded entry. Memory trade (the full log in
    /// RAM — the same order as the rendered rows it replaces): re-derivation
    /// replays from here with no refetch. A later optimization may evict
    /// off-path payloads and re-pull from the entry cache on leaf moves.
    private var entriesById: [String: JSONValue] = [:]
    /// The active path's ids, root→leaf order (the backwalk's chain
    /// reversed). nil until the first beacon — nothing renders before it.
    private var pathOrder: [String]?
    private var pathIds: Set<String> = []
    /// Path entries already birthed (cursor into pathOrder).
    private var renderedPathCount = 0
    /// Last trusted ACTIVE leaf. A beacon leafId differing from this = the
    /// path moved → derivePath re-derives + replays.
    private var activeLeafId: String?
    /// A leaf move awaiting its branch marker (appended after the replay —
    /// see derivePath / renderPendingPathEntries).
    private var pendingBranchNoticeLeaf: String?
    /// A beacon that arrived MID-TURN (run 2026-09-18: "stream ended without
    /// finish" — the reset raced the in-flight bubble). The re-path is DEFERRED
    /// to the settle point (agent_settled / shutdown), preserving the replay
    /// invariant: nothing ever disturbs live-stream continuation state. The
    /// settle's own fold indexes the finished turn's entries first, so the
    /// deferred replay includes the turn's full text.
    private var pendingRepathLeaf: String?

    /// Apply a deferred re-path at a SETTLE point (no turn in flight — the
    /// reset is safe). No-op when no beacon parked.
    private mutating func applyPendingRepath() {
        guard let leaf = pendingRepathLeaf else { return }
        pendingRepathLeaf = nil
        derivePath(from: leaf)
        renderPendingPathEntries()
    }
    private var userSeq = 0    // live user-row synthetics (u1, u2, …)
    private var compactionSeq = 0
    private var reasoningSeq = 0
    private var noticeSeq = 0
    /// LAST message_update frame applied — FULL-FRAME delta dedup (run
    /// 2026-09-18): a redelivered frame is byte-identical including its
    /// usage metrics; a real event's usage.output increments, so identical
    /// frames are redeliveries and distinct frames are real. See the
    /// message_update case in applyRPC.
    private var lastMessageUpdateFrame: JSONValue?
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

    /// FULL-WALK RESET (ordering fix): a since==nil get_entries walk is the
    /// AUTHORITATIVE history in log order. Live rows that folded into a fresh
    /// reducer BEFORE the walk (app relaunch mid-conversation) strand at the
    /// TOP of `items` — without a reset the walk appends the older history
    /// AFTER them and the newest exchange sits above everything. Resetting
    /// first re-births every settled row from its entry, in order — the live
    /// rows' messages are all persisted by walk time (the message_end cadence
    /// guarantees it). Residual edge: a stream IN FLIGHT during the walk has
    /// no entry yet and re-strands until the next full walk. KEPT: ended /
    /// sessionStartedAt (session-level), liveArrivals (view counter),
    /// activeTurnID (cancel targeting).
    public mutating func resetTranscript() {
        items.removeAll()
        appendedIDs.removeAll()
        rowIndex.removeAll()
        identifyIndex.removeAll()
        pendingRowIDs.removeAll()
        toolIndex.removeAll()
        openAssistantIndex = nil
        openReasoningIndex = nil
        userSeq = 0
        assistantSeq = 0
        reasoningSeq = 0
    }

    /// Append a one-off informational notice row. Used by the APP-side routing
    /// of extension_ui `notify` frames (AppModel+Inbound): a warning notify is
    /// actionable (answer rejected / bridge TTL expired) but must not own a
    /// modal — it lands inline in the transcript instead.
    public mutating func appendNotice(code: String, message: String) {
        // CONTENT-KEYED DEDUP: notices have no entry-log anchoring (live-only
        // ephemera by design), so a re-delivered warning after relaunch would
        // otherwise DUPLICATE at the tail — historical warns clustering below
        // the normal messages (run 2026-09-17: "warning messages still drift
        // to below"). Identical (code, message) already present ⇒ skip.
        if items.contains(where: { if case let .notice(existing) = $0 {
            existing.code == code && existing.message == message
        } else { false } }) {
            #if DEBUG
            // The re-delivery source is identifiable from the code+message —
            // logged so a relaunch capture shows exactly which warns re-fire.
            print("[notice] dedup-skip \(code): \(message)")
            #endif
            return
        }
        noticeSeq += 1
        if append(.notice(NoticeItem(id: "ext\(noticeSeq)", code: code, message: message))) {
            liveArrivals += 1
        }
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
        rowIndex[item.id] = items.count - 1
        return true
    }

    /// The LIVE TAIL's start index: the first pending row, or the open
    /// streaming bubble/reasoning block, whichever is earliest. Fast path when
    /// no tail exists (mid-walk: everything buffered/reset → boundary == end).
    private func liveTailStartIndex() -> Int {
        if pendingRowIDs.isEmpty, openAssistantIndex == nil, openReasoningIndex == nil {
            return items.count
        }
        var idx = items.count
        if let o = openAssistantIndex { idx = min(idx, o) }
        if let r = openReasoningIndex { idx = min(idx, r) }
        if !pendingRowIDs.isEmpty {
            for (i, item) in items.enumerated() where pendingRowIDs.contains(item.id) {
                if i < idx { idx = i }
                if idx == 0 { break }
            }
        }
        return idx
    }

    /// Insert an ENTRY-born row at the log-order boundary: after every folded
    /// entry, BEFORE any pending/live row — an older entry must never land
    /// after a newer pending (arrival-order correction). Unlike `append`, this
    /// does NOT close the open streaming bubble (history inserting above the
    /// tail must not settle it). O(n) reindex; only entry births take this path.
    private mutating func insertBeforeLiveTail(_ item: TranscriptItem) -> Bool {
        guard appendedIDs.insert(item.id).inserted else { return false }
        let at = liveTailStartIndex()
        items.insert(item, at: at)
        if at < items.count - 1 {
            rowIndex = rowIndex.mapValues { $0 >= at ? $0 + 1 : $0 }
            toolIndex = toolIndex.mapValues { $0 >= at ? $0 + 1 : $0 }
            if let o = openAssistantIndex, o >= at { openAssistantIndex = o + 1 }
            if let r = openReasoningIndex, r >= at { openReasoningIndex = r + 1 }
        }
        rowIndex[item.id] = at
        return true
    }

    /// Mark any currently-open streaming block (assistant text or reasoning)
    /// as settled and forget it, so the next inserted row starts fresh.
    private mutating func closeOpenAssistant() {
        // Inert during a replay walk (see isReplayingEntries).
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

    /// get_state reconcile (design 01M1NFAE): peer not streaming + local open stream/turn = missed terminal events; finalize bubble (dots stop) + clear activeTurnID; content rides get_entries.
    public mutating func reconcileBusyState(isStreaming: Bool) {
        guard !isStreaming, activeTurnID != nil || openAssistantIndex != nil
            || openReasoningIndex != nil else { return }
        closeOpenAssistant()
        activeTurnID = nil
    }

    private mutating func appendReasoning(inReplyTo: String, delta: String) {
        if let index = openReasoningIndex, case var .reasoning(block) = items[index] {
            block.text += delta
            block.streaming = true
            items[index] = .reasoning(block)
        } else {
            reasoningSeq += 1
            _ = append(.reasoning(ReasoningBlock(id: "\(reasoningSeq)", text: delta, streaming: true)))
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
            _ = append(.assistant(AssistantBubble(id: "a\(assistantSeq)", inReplyTo: inReplyTo,
                                              text: delta, streaming: true)))
            openAssistantIndex = items.count - 1
        }
        activeTurnID = inReplyTo
    }

    /// Open (or idempotently re-open) a tool card. Returns true only when a
    /// NEW card was inserted — a re-open of a known card is a re-sync no-op
    /// and must not count as a visible arrival.
    @discardableResult
    private mutating func openToolCard(toolCallID: String, tool: String, args: [String: JSONValue],
                                        fromEntry: Bool = false) -> Bool {
        if let index = toolIndex[toolCallID] { // idempotent re-open (re-sync)
            // PRESERVE accumulated state (run 2026-09-18 — the "never see
            // the sidecar even live" ROOT CAUSE): an entry replay's rebirth
            // (the message_end refetch folds seconds after the live frame;
            // every get_entries fold does the same) used to REPLACE the card
            // wholesale — stripping the live-attached aux.hunks, the result,
            // and the output classification. Identity is stable for a
            // toolCallId; only args refresh (the re-sync intent — a sync may
            // carry richer args). hunks/result/output/state survive.
            if case var .tool(card) = items[index] {
                card.args = args
                items[index] = .tool(card)
            }
            return false
        }
        // Entry-synthesized cards ride their message's log position (insert
        // before the live tail, right after the message that just birthed
        // there); LIVE cards belong to the streaming turn (append at the end).
        let inserted = fromEntry
            ? insertBeforeLiveTail(.tool(ToolCard(toolCallID: toolCallID, tool: tool, args: args)))
            : append(.tool(ToolCard(toolCallID: toolCallID, tool: tool, args: args)))
        toolIndex[toolCallID] = rowIndex["tool:\(toolCallID)"] ?? items.count - 1
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
    private mutating func appendCompaction(summary: String, tokensBefore: Int,
                                            entryID: String? = nil) -> Bool {
        // Entry-born markers key on the entry id (replay dedup — a replayed
        // live marker used to DUPLICATE the row); live ones keep the seq id.
        if entryID == nil { compactionSeq += 1 }
        let id = entryID ?? "\(compactionSeq)"
        // Entry-born markers ride the log position (before the live tail);
        // live ones append (a "now" event).
        if let entryID {
            return insertBeforeLiveTail(.compaction(CompactionMarker(id: id, summary: summary,
                                                                     tokensBefore: tokensBefore)))
        }
        return append(.compaction(CompactionMarker(id: id, summary: summary,
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
            // `entryId` rides only frames SYNTHESIZED by applyEntries (fresh
            // births from the entry log); live frames carry none — a live
            // settle leaves the row PENDING (id-scheme v2).
            if applyRPCMessageEnd(frame["message"], entryID: frame["entryId"]?.stringValue) {
                liveArrivals += 1
            }
        case "message_update":
            // FULL-FRAME DEDUP (user, 2026-09-18 — pi docs: message_update
            // carries usage metrics): a REAL repeated-word event increments
            // usage.output → its frame DIFFERS from the previous one →
            // applies; a REDELIVERY is byte-identical including usage →
            // skipped. The earlier (kind, contentIndex, delta) inner-event key
            // could drop a genuine repeated word; the whole frame cannot.
            // Mirrors message_end's identify guard for the delta plane (the
            // transport's "never redelivers" assumption broke under
            // overlapping reconnects — run 2026-09-18 "every chunk repeats").
            if let last = lastMessageUpdateFrame, last == frame {
                return   // redelivery — no fold, no arrival bump
            }
            lastMessageUpdateFrame = frame
            if applyRPCDelta(frame["assistantMessageEvent"]) { liveArrivals += 1 }
        case "tool_execution_start":
            if openToolCard(toolCallID: frame["toolCallId"]?.stringValue ?? "",
                           tool: frame["toolName"]?.stringValue ?? "",
                           args: frame["args"]?.objectValue ?? [:],
                           fromEntry: frame["fromEntry"]?.boolValue ?? false) {
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
                                    tokensBefore: result["tokensBefore"]?.intValue ?? 0,
                                    entryID: frame["entryId"]?.stringValue) {
                    liveArrivals += 1
                }
            }
        case "agent_settled":
            if let turn = rpcTurn, activeTurnID == turn { activeTurnID = nil }
            closeOpenAssistant()
            applyPendingRepath()
        case "session_shutdown":
            ended = true
            activeTurnID = nil
            closeOpenAssistant()
            applyPendingRepath()
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

    /// Fold one settled message (id-scheme v2: the pi ENTRY id IS the row id
    /// wherever one exists). `entryID` is present only on frames synthesized by
    /// `applyEntries` (fresh births from the entry log) — such rows are born
    /// durable and anchorable. LIVE settles (no entry id) birth PENDING rows
    /// (seq synthetic, registered in `identifyIndex`) that the
    /// message_end-triggered delta re-keys in place via the matcher.
    /// Returns true only on a VISIBLE mutation (drives the liveArrivals bump).
    private mutating func applyRPCMessageEnd(_ message: JSONValue?, entryID: String? = nil) -> Bool {
        guard let role = message?["role"]?.stringValue else { return false }
        let turn = rpcTurn ?? "t0"
        // Duplicate LIVE delivery guard (v1's identify dedup, kept as defense):
        // a live message_end for a message already born — a live pending OR a
        // walk-born entry row (the full-walk buffer REPLAY case) — is a
        // redelivery, not a new message. The relay never redelivers, but a
        // stray duplicate or a replayed buffer must not double-render.
        // Entry-born frames (entryID) bypass: the MATCH LOOP owns those.
        if entryID == nil, role == "user" || role == "assistant",
           identifyIndex[Self.identify(message)] != nil {
            return false
        }
        switch role {
        case "user":
            let text = message?["content"]?.joinedText() ?? ""
            let images = Self.imagesFromContent(message?["content"])
            if let entryID {
                let rowID = "user:\(entryID)"
                let inserted = insertBeforeLiveTail(.user(UserBubble(id: entryID, text: text, images: images,
                                                                    replayStable: true)))
                if inserted { identifyIndex[Self.identify(message)] = rowID }
                return inserted
            }
            // LIVE birth: pending seq synthetic until the delta lands the id.
            userSeq += 1
            let synthetic = "u\(userSeq)"
            identifyIndex[Self.identify(message)] = "user:\(synthetic)"
            pendingRowIDs.insert("user:\(synthetic)")
            return append(.user(UserBubble(id: synthetic, text: text, images: images,
                                           replayStable: false)))
        case "assistant":
            if message?["stopReason"]?.stringValue == "error" {
                // Forward a failed turn as a notice (mirrors the fork's `error`).
                // BOTH paths key the row id on the message's content identity —
                // insertBeforeLiveTail's appendedIDs guard then dedups a LIVE
                // error against its later ENTRY replay (and vice versa), the
                // same collision-based dedup as before this change.
                // ENTRY-BORN (replayed) errors ride the log position —
                // inserted BEFORE the live tail, like every message birth and
                // compaction marker — instead of appending at the very end:
                // appending floated historical errors (out-of-credit etc.)
                // below the live tail whenever a reconnect's delta walk folded
                // them with live rows present (run 2026-09-17: "warnings drift
                // to below the normal messages"). LIVE errors append (a "now"
                // event belongs at the tail).
                let text = message?["errorMessage"]?.stringValue ?? "Provider error"
                let errorID = "err\(Self.identify(message))\(Self.stableHash(text))"
                if entryID != nil {
                    return insertBeforeLiveTail(.notice(NoticeItem(id: errorID, code: "provider_error",
                                                                   message: text)))
                }
                noticeSeq += 1
                return append(.notice(NoticeItem(id: errorID, code: "provider_error",
                                                 message: text)))
            } else {
                let images = Self.imagesFromContent(message?["content"])
                if openAssistantIndex != nil, !isReplayingEntries {
                    // LIVE settle: KEEP the positional id — the row is PENDING;
                    // the entry id arrives with the message_end-triggered delta
                    // and the matcher re-keys it (never a twin). Finalize without
                    // clobbering delta-built interleaving; keep activeTurnID
                    // (turn isn't done until agent_settled). During a replay walk
                    // this branch is OFF: a replayed settled message is NOT the
                    // open live bubble — append it directly instead.
                    if let rowID = settleOpenAssistant(images: images) {
                        identifyIndex[Self.identify(message)] = rowID
                        pendingRowIDs.insert(rowID)
                    }
                    closeOpenAssistant()
                    return true // settle is visible (streaming→false, images attach)
                } else {
                    // Replay/fresh birth: the ENTRY id when present (durable,
                    // anchorable); the identify fallback exists only for id-less
                    // entries (defensive — pi entries always carry ids) and
                    // registers as PENDING so a later id-carrying replay re-keys it.
                    let text = message?["content"]?.joinedText() ?? ""
                    guard !text.isEmpty || !images.isEmpty else { return false }
                    let key = Self.identify(message)
                    let bubbleID = entryID ?? "\(key)-a"
                    let rowID = "assistant:\(bubbleID)"
                    let inserted = entryID != nil
                        ? insertBeforeLiveTail(.assistant(AssistantBubble(id: bubbleID, inReplyTo: turn,
                                                                         text: text, streaming: false,
                                                                         usage: nil, images: images,
                                                                         replayStable: true)))
                        : append(.assistant(AssistantBubble(id: bubbleID, inReplyTo: turn,
                                                            text: text, streaming: false,
                                                            usage: nil, images: images,
                                                            replayStable: false)))
                    if inserted {
                        identifyIndex[key] = rowID
                        if entryID == nil { pendingRowIDs.insert(rowID) }
                    }
                    return inserted
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
    /// DELTA DEDUP (run 2026-09-18: "every chunk repeats" in the live
    /// stream): the wire's delta events carry NO id, and the design assumed
    /// "the relay never redelivers" — but duplicate delivery (reconnect /
    /// subscription paths) doubled every chunk, and the doubled pending text
    /// then failed the identify match at completion → duplicate births (the
    /// whole double-words family). Content dedup: an EXACT immediate repeat
    /// (same kind + same delta string) is a redelivery — real consecutive
    /// deltas are distinct by construction (each carries new content). This
    /// mirrors message_end's identify guard for the delta plane.
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
    /// rpc) into the transcript (id-scheme v2: the pi ENTRY id IS the row id).
    /// Each message entry runs the MATCH LOOP: a live-built PENDING row for the
    /// same message (matched by content identity — the only bridge between the
    /// id-less live frame and the id-carrying entry) is RE-KEYD in place to the
    /// entry id; a miss births the row WITH the durable id (fresh backfill).
    /// Tool cards are reconstructed from `toolCall` content on fresh births
    /// (matched rows opened them live; idempotent re-open would no-op). Applied
    /// to the LIVE reducer — not a reset — so it merges idempotently (replayed
    /// entry ids dedup via `appendedIDs`).
    public mutating func applyEntries(_ entries: [JSONValue], leafId: String? = nil) {
        // STAGE 0 (see the state block): index + retain EVERYTHING (the
        /// abandoned branches stay in entryParent/entriesById — the cache and
        /// the future branch UI keep the full tree); render only the derived
        /// active path. `leafId` is the ACTIVE-LEAF BEACON when trusted —
        /// cache loads carry it; wire folds trust it per the completing-page
        /// rule in EnvelopeReducer.applyRpc (a partial page's leafId is just
        /// the resume cursor — deriving from it would build a partial path).
        isReplayingEntries = true
        defer { isReplayingEntries = false }
        for entry in entries {
            guard let id = entry["id"]?.stringValue else { continue }
            entriesById[id] = entry
            entryParent[id] = entry["parentId"]?.stringValue ?? ""
        }
        if let beacon = leafId, beacon != activeLeafId, entriesById[beacon] != nil {
            derivePath(from: beacon)
        }
        renderPendingPathEntries()
    }

    /// The BACKWALK: from the active leaf, walk parentId links rootward; the
    /// reversed chain is the active path in render order. An unchanged path
    /// no-ops (beacon repeated). A CHANGED path after rendering began resets
    /// the rows and replays from the retained entries — the old path's rows
    /// go, the new path renders (the user-visible correctness fix for TUI
    /// edit-resubmit / /tree).
    private mutating func derivePath(from leaf: String) {
        // MID-TURN DEFERRAL: a re-path RESETS + replays the rows — never while
        // a turn is streaming (the open bubble is live-stream continuation
        // state the replay machinery exists to protect; resetting under it
        // fragments the bubble and truncates streamed text). Park the beacon;
        // the settle point applies it.
        if activeTurnID != nil || openAssistantIndex != nil || openReasoningIndex != nil {
            pendingRepathLeaf = leaf
            activeLeafId = leaf
            return
        }
        var chain: [String] = []
        var seen = Set<String>()
        var cursor = leaf
        while !cursor.isEmpty, seen.insert(cursor).inserted,
              let parent = entryParent[cursor] {
            chain.append(cursor)
            if parent.isEmpty { break }
            cursor = parent
        }
        activeLeafId = leaf
        let newOrder = Array(chain.reversed())
        guard Set(newOrder) != pathIds else { return }
        let firstDerivation = pathOrder == nil
        let oldOrder = pathOrder ?? []
        pathOrder = newOrder
        pathIds = Set(newOrder)
        // A forward EXTENSION (old path is a prefix of the new) is a normal turn
        // advancing the leaf, NOT a branch (fresh pi starts leaf==nil). Only a
        // real DIVERGENCE (rendered entries abandoned: edit-resubmit / /tree /
        // branch) marks the move; resetTranscript stays unconditional (it also
        // reconciles live-plane rows with the entry tree every turn end).
        let isExtension = newOrder.count >= oldOrder.count
            && Array(newOrder.prefix(oldOrder.count)) == oldOrder
        if !firstDerivation {
            resetTranscript()
            if !isExtension { pendingBranchNoticeLeaf = leaf }
        }
        renderedPathCount = 0
    }

    /// Birth rows for path entries not yet rendered, in path order. This is
    /// the whole membership gate: an entry not on the derived path is
    /// retained silently (an abandoned branch — data only, no row).
    private mutating func renderPendingPathEntries() {
        guard let order = pathOrder, renderedPathCount < order.count else { return }
        for id in order[renderedPathCount...] {
            renderedPathCount += 1
            guard let entry = entriesById[id] else { continue }
            birthEntry(entry)
        }
        // The branch marker lands AFTER the replayed rows — at the branch
        // point, where the tail vanished. Notices are not entries: a later
        // re-path's reset clears them, and the fresh move appends its own.
        if let leaf = pendingBranchNoticeLeaf {
            pendingBranchNoticeLeaf = nil
            appendNotice(
                code: "branch",
                message: "Branched at …\(String(leaf.suffix(6))) — the earlier "
                    + "continuation is preserved on its own branch")
        }
    }

    /// Birth ONE entry's rows — the pre-Stage-0 fold body, verbatim: compaction
    /// markers, user/assistant messages (identify match → in-place re-key;
    /// miss → durable birth + tool-card reconstruction), toolResults.
    private mutating func birthEntry(_ entry: JSONValue) {
        switch entry["type"]?.stringValue {
        case "compaction":
            // Entry-born markers key on the entry id (dedup — a replayed
            // live marker used to duplicate the row).
            applyRPC(.object(["type": .string("compaction_end"),
                              "result": .object(["summary": entry["summary"] ?? .string(""),
                                                 "tokensBefore": entry["tokensBefore"] ?? .number(0)]),
                              "entryId": entry["id"] ?? .null]))
        case "message":
            guard let msg = entry["message"] else { return }
            switch msg["role"]?.stringValue {
            case "user", "assistant":
                let entryID = entry["id"]?.stringValue
                let key = Self.identify(msg)
                if let existingRowID = identifyIndex[key], let entryID {
                    // MATCH: this entry IS an already-born row (a live
                    // pending or a prior entry birth) — re-key it to the
                    // durable id. Never append: the content is already on
                    // screen. (A batched delta re-keys several at once; a
                    // same-id re-key no-ops via the appendedIDs guard.)
                    if let newRowID = rekeyRow(rowID: existingRowID, toEntryID: entryID) {
                        identifyIndex[key] = newRowID
                    }
                } else {
                    // Fresh birth FROM the entry (backfill / no live row):
                    // born durable + anchorable. The id-less fallback is
                    // defensive only — pi entries always carry ids.
                    applyRPC(.object(["type": .string("message_end"), "message": msg,
                                      "entryId": entry["id"] ?? .null]))
                    // Reconstruct tool cards from the assistant's toolCall blocks
                    // (the live stream opens them via separate tool_execution_start
                    // frames; here they ride the message content).
                    if msg["role"]?.stringValue == "assistant", let content = msg["content"]?.arrayValue {
                        for block in content where block["type"]?.stringValue == "toolCall" {
                            applyRPC(.object(["type": .string("tool_execution_start"),
                                              "toolCallId": block["id"] ?? .string(""),
                                              "toolName": block["name"] ?? .string(""),
                                              "args": block["arguments"] ?? .object([:]),
                                              "fromEntry": .bool(true)]))
                        }
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

    /// Settle the open (delta-built) assistant bubble at message_end: attach
    /// settled images, stop streaming — and KEEP its positional id (id-scheme
    /// v2: the row is PENDING; `pendingByIdentify` maps the matcher to it and
    /// `rekeyRow` swaps in the pi entry id when the delta lands). Returns the
    /// settled row's id (for the pending registration), nil if no open bubble.
    @discardableResult
    private mutating func settleOpenAssistant(images: [WireImage]) -> String? {
        guard let index = openAssistantIndex, case let .assistant(old) = items[index] else { return nil }
        items[index] = .assistant(AssistantBubble(id: old.id, inReplyTo: old.inReplyTo,
                                                  text: old.text, streaming: false,
                                                  usage: old.usage,
                                                  images: images.isEmpty ? old.images : images,
                                                  replayStable: false))
        return items[index].id
    }

    /// Re-key a PENDING live row to its real pi ENTRY id (id-scheme v2: the
    /// entry id IS the row id) — the matcher found it by content identity when
    /// the entries replay landed. Keeps content/position; swaps identity so
    /// anchors, the bounds registry, and future replays all key on the durable
    /// id. The view sees remove-husk + insert-husk: a near row re-measures via
    /// its probe; a far row falls back until revisited. No bump — no new content.
    private mutating func rekeyRow(rowID: String, toEntryID entryID: String) -> String? {
        guard let index = rowIndex[rowID] else { return nil }
        switch items[index] {
        case let .user(old):
            let newRowID = "user:\(entryID)"
            guard !appendedIDs.contains(newRowID) else { return nil }
            appendedIDs.remove(rowID)
            rowIndex.removeValue(forKey: rowID)
            pendingRowIDs.remove(rowID)
            items[index] = .user(UserBubble(id: entryID, text: old.text,
                                            images: old.images, replayStable: true))
            appendedIDs.insert(newRowID)
            rowIndex[newRowID] = index
            return newRowID
        case let .assistant(old):
            let newRowID = "assistant:\(entryID)"
            guard !appendedIDs.contains(newRowID) else { return nil }
            appendedIDs.remove(rowID)
            rowIndex.removeValue(forKey: rowID)
            pendingRowIDs.remove(rowID)
            items[index] = .assistant(AssistantBubble(id: entryID, inReplyTo: old.inReplyTo,
                                                      text: old.text, streaming: old.streaming,
                                                      usage: old.usage, images: old.images,
                                                      replayStable: true))
            appendedIDs.insert(newRowID)
            rowIndex[newRowID] = index
            return newRowID
        default:
            return nil
        }
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
