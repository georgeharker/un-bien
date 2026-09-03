import Foundation
import os
import UnBienCore

// Inbound routing split out of AppModel.swift (its 1000-line cap): the
// per-relay frame handlers ({rpc|evt} routed envelopes + control frames), the
// session upsert/keying helpers, and the rpc-command RESPONSE router + panel
// decode path. All act on the per-session state AppModel owns, keyed by the
// pi-sessionId composite key.

private let log = Logger(subsystem: "un-bien", category: "relay")

extension AppModel {
    /// Resume a continuation parked under this response's request id (the
    /// reply half of `sendAwaitingReply`). Called for EVERY rpc response BEFORE
    /// `handleRpcResponse` — correlation is by id, side effects by command.
    func resumeAwaitedReply(_ rpc: JSONValue) {
        if let replyID = rpc["id"]?.stringValue,
           let parked = pendingRpcReplies.removeValue(forKey: replyID) {
            parked.resume(returning: rpc)
        }
    }

    /// Await ONE rpc command response (request/reply correlation, plan
    /// 01M1A39Y4G): park a continuation under `reqID`, send, and resume when the
    /// matching `{type:"response", id}` frame lands in handle(frame:) — or on
    /// timeout / send failure, so a dead session can't leak the continuation.
    /// Returns the FULL response frame (nil when no reply landed) — callers
    /// check `success` themselves. AppModel is @MainActor, so the map + both
    /// resume paths are race-free (whichever removeValue wins, the other no-ops).
    func sendAwaitingReply(_ message: ClientMessage, reqID: String,
                           to session: LiveSession, over connection: RelayConnection,
                           timeout: TimeInterval = 5) async -> JSONValue? {
        await withCheckedContinuation { continuation in
            pendingRpcReplies[reqID] = continuation
            // Timeout backstop: a dropped/dead session never answers.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                if let parked = self?.pendingRpcReplies.removeValue(forKey: reqID) {
                    parked.resume(returning: nil)
                }
            }
            Task { @MainActor [weak self] in
                do {
                    try await connection.send(message, toPeer: session.peerEPK,
                                               room: session.roomID)
                } catch {
                    if let parked = self?.pendingRpcReplies.removeValue(forKey: reqID) {
                        parked.resume(returning: nil)
                    }
                }
            }
        }
    }

    /// App-side effects of an rpc command RESPONSE envelope
    /// (`{type:"response", command, id, success, data?, error?}`). One place per
    /// command, so adding a future response handler is a single case — responses
    /// used to be handled ad-hoc (or not at all, which is why the model picker
    /// went silently empty when `list_models` became `get_available_models`).
    /// Failures LOG the extension's error text instead of vanishing — a
    /// `set_model` "not in registry" rejection is now visible, not just ignored.
    func handleRpcResponse(_ rpc: JSONValue, key: String) {
        let command = rpc["command"]?.stringValue ?? ""
        guard rpc["success"]?.boolValue ?? false else {
            let detail = rpc["error"]?.stringValue ?? "?"
            log.error("rpc response \(command, privacy: .public) failed: \(detail, privacy: .public)")
            return
        }
        switch command {
        case "get_available_models":
            // data: { models: [WireModel], current?: WireModel }. Synthesize the
            // stock models_list frame (same JSON shapes) and reuse its decoder so
            // the roster decode stays single-sourced with the retired stock path.
            var frame: [String: JSONValue] = [
                "type": .string("models_list"),
                "in_reply_to": .string(rpc["id"]?.stringValue ?? ""),
                "models": rpc["data"]?["models"] ?? .array([]),
            ]
            if let current = rpc["data"]?["current"] { frame["current"] = current }
            if let data = try? JSONEncoder().encode(JSONValue.object(frame)),
               let line = String(data: data, encoding: .utf8),
               let decoded = try? Codec.decodeServer(line),
               case let .modelsList(_, models, current) = decoded {
                availableModels[key] = models
                if let current { currentModel[key] = current }
                let curName = current?.name ?? "nil"
                log.notice("models reply key=\(String(key.suffix(12)), privacy: .public) n=\(models.count, privacy: .public) cur=\(curName, privacy: .public)")
            } else {
                log.notice("models reply DECODE FAILED key=\(String(key.suffix(12)), privacy: .public)")
            }
        case "set_model":
            // data: the newly-set model (WireModel) — authoritative, replaces the
            // optimistic pick setModel(_:session:) made before sending.
            if let data = rpc["data"],
               let encoded = try? JSONEncoder().encode(data),
               let model = try? JSONDecoder().decode(WireModel.self, from: encoded) {
                currentModel[key] = model
                log.notice("set_model reply key=\(String(key.suffix(12)), privacy: .public) \(model.provider, privacy: .public)/\(model.id, privacy: .public)")
            }
        default:
            break // transcript-relevant responses are the reducer's; unknown commands are forward-compat no-ops
        }
    }

    // Only reached from the envelope PANEL path: {evt channel:"panel"} decodes
    // to a stock `panel_update` frame and routes here. All other stock session
    // frames are gone from the fork (E1–E7), so no general receive fallback.
    func route(_ message: ServerMessage, relayID: UUID, peer: String, sessionID: String) {
        let key = "\(relayID.uuidString):\(peer):\(sessionID)"
        switch message {
        case let .panelUpdate(panelKey, title, icon, data):
            let wasOpen = panels[key]?[panelKey]?.changed == false && openPanel == "\(key):\(panelKey)"
            var forSession = panels[key] ?? [:]
            forSession[panelKey] = PanelState(key: panelKey, title: title, icon: icon,
                                              data: data, changed: !wasOpen)
            panels[key] = forSession
            // Subagents panel rows carry each child's live status (meta.sessionId)
            // — fold it into the child LiveSessions so the HOME status chip
            // updates live. The session_info pull only fires on room announce /
            // reconnect, so without this the chip sticks on running until then.
            if panelKey == "subagents" {
                var updates: [String: String] = [:]  // LiveSession key -> status
                for item in data["items"]?.arrayValue ?? [] {
                    guard let sid = item["meta"]?["sessionId"]?.stringValue,
                          let status = item["status"]?.stringValue else { continue }
                    for (k, s) in sessions
                    where s.sessionID == sid && s.relayID == relayID && s.peerEPK == peer {
                        updates[k] = status
                    }
                }
                for (k, status) in updates {
                    sessions[k]?.status = status
                }
            }
        default:
            break
        }
    }

    // MARK: - Inbound

    func handle(frame: InboundFrame, relayID: UUID) {
        switch frame {
        case let .routed(envelope):
            handleRouted(envelope, relayID: relayID)
        case let .control(event):
            handle(control: event, relayID: relayID)
        }
    }

    /// Envelope route ({rpc|evt}): a fork advertising `rpc_envelope`
    /// carries the transcript as pi rpc frames inside `ct`. Discriminate
    /// by SHAPE — a stock ServerMessage decodes to an EnvelopeMessage with
    /// both fields nil. The reducer owns the transcript for this key;
    /// stock session-content is suppressed in `route`.
    /// A streamed delta: rpc `message_update` frames only — everything else
    /// (message_end, tool events, asks, errors…) is a barrier.
    private func isStreamDelta(_ env: EnvelopeMessage) -> Bool {
        env.rpc?["type"]?.stringValue == "message_update"
    }

    /// A get_entries response page WITH entries (the walk's non-terminal
    /// pages). Coalesced with stream deltas — same fold semantics, one
    /// publish per flush. A TERMINAL page (empty entries / nil leaf) is NOT
    /// coalescable: it must act as the barrier that flushes every pending
    /// page before endWalk replays buffered live frames.
    private func isBackfillPage(_ env: EnvelopeMessage) -> Bool {
        guard env.rpc?["type"]?.stringValue == "response",
              env.rpc?["command"]?.stringValue == "get_entries",
              env.rpc?["success"]?.boolValue == true else { return false }
        return !(env.rpc?["data"]?["entries"]?.arrayValue ?? []).isEmpty
    }

    /// ~15fps fold cadence — fast enough that text arrival looks continuous,
    /// slow enough to cut re-parse/publish work 3-4×. (The stored state lives
    /// on AppModel — extensions can't hold stored properties.)

    private func scheduleFoldFlush() {
        guard !foldFlushScheduled else { return }
        foldFlushScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.foldFlushNanos)
            guard let self else { return }
            self.foldFlushScheduled = false
            self.flushAllFoldFrames()
        }
    }

    /// Flush one session's pending frames — ONE reducer fetch, N applies,
    /// ONE publish (the batch lands as a single transcripts update).
    private func flushFoldFrames(for key: String) {
        guard let pending = pendingFoldFrames.removeValue(forKey: key),
              !pending.isEmpty else { return }
        var reducer = envelopeReducers[key] ?? EnvelopeReducer()
        reducer.setHideReasoning(!showThinking)
        for frame in pending {
            reducer.apply(frame.env)
        }
        envelopeReducers[key] = reducer
        transcripts[key] = reducer.session
    }

    private func flushAllFoldFrames() {
        for key in Array(pendingFoldFrames.keys) {
            flushFoldFrames(for: key)
        }
    }

    private func handleRouted(_ envelope: RoutedEnvelope, relayID: UUID) {
        guard let env = try? envelope.decodeEnvelope() else { return }
        // Key per-session state on the pi sessionId (wire identity); the
        // outer room is mesh/relay ROUTING only.
        let key = "\(relayID.uuidString):\(envelope.peer):\(env.sessionId ?? envelope.room)"
        if env.type == "ub", let ub = env.ub {
            handleUbFrame(ub: ub, key: key, relayID: relayID, peer: envelope.peer,
                          sid: env.sessionId ?? "nil")
        } else if env.rpc != nil || env.evt != nil {
            handleEnvelopeContent(env: env, key: key, envelope: envelope, relayID: relayID)
        }
    }

    /// The un-bien control plane (`{type:"ub"}` frames), dispatched on the
    /// inner `ub.type`.
    private func handleUbFrame(ub: JSONValue, key: String, relayID: UUID,
                               peer: String, sid: String) {
        if ub["type"]?.stringValue == "hello" {
            handleUbHello(ub: ub, key: key, sid: sid)
            return
        }
        // Daemon caps PULL response (design 01M1813Q): a DAEMON-SPECIFIC
        // {type:"presence_status", caps, hostname, backend} frame. Store
        // machine/daemon status SEPARATELY from per-session capabilities
        // (this describes an idle machine, not a session) — do NOT fold
        // it into the transcript reducer. Keyed by the control-room key.
        if ub["type"]?.stringValue == "presence_status" {
            let caps = ub["caps"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            // MACHINE-caps entry: key by the MACHINE (relay + canonical
            // epk), NOT the control room. The room is only transport.
            let mkey = machineCapsKey(relayID: relayID, epk: peer)
            daemonPresence[mkey] = DaemonPresence(
                caps: Set(caps),
                hostname: ub["hostname"]?.stringValue,
                backend: ub["backend"]?.stringValue)
            return
        }
        // Response to a `get_session_info` PULL: a subagent reporting its
        // own lifecycle status over its connection (design 01M18PCM). Set
        // it on the child LiveSession, keyed by the child's pi sessionId,
        // so the home-row checkmark reads it WITHOUT the parent's panel.
        if ub["type"]?.stringValue == "session_info" {
            if var s = sessions[key] {
                s.status = ub["status"]?.stringValue
                sessions[key] = s
            }
            return
        }
        // Other un-bien-plane frames (the session_sync_end terminator):
        // fold via the reducer as a frame — its inner `.type` drives
        // applyRPC, exactly like an rpc-plane frame.
        var reducer = envelopeReducers[key] ?? EnvelopeReducer()
        reducer.setHideReasoning(!showThinking)
        reducer.apply(EnvelopeMessage(rpc: ub))
        envelopeReducers[key] = reducer
        transcripts[key] = reducer.session
        // Ask-reconciliation backstop (AskSyncWindow): the sync
        // reply replays the bridge's FULL activeFlows set to the
        // sender ahead of this terminator, so a stored prompt whose
        // flow wasn't replayed is stale — its resolution happened
        // while the dismissal notify was dropped. Retire it. Fail-open:
        // no window in flight (sync never sent / terminator dropped)
        // keeps the prompt; the next open or reconnect retries.
        if ub["type"]?.stringValue == "session_sync_end",
           let window = askSyncWindows.removeValue(forKey: key),
           let prompt = prompts[key],
           !window.replayedAskIDs.contains(prompt.id) {
            prompts[key] = nil
            log.notice("ask reconcile: stale prompt retired key=\(String(key.suffix(12)), privacy: .public) flow=\(String(prompt.id.suffix(8)), privacy: .public)")
        }
        return
    }

    /// `ub hello`: capability handshake + session identity, and PROOF OF
    /// LIFE — a dismissed ended chat resurrects here (plan 01M18X3B).
    private func handleUbHello(ub: JSONValue, key: String, sid: String) {
        // Envelope-native capability handshake: learn caps here (not just
        // from stock session_history) so the {rpc|evt} route + stock
        // suppression turn on before any session content arrives.
        // {type:"ub", ub:{type:"hello", caps, sessionId}} frame the APP
        // acts on (learn caps + session identity).
        // Last NON-EMPTY wins: re-hellos (session_sync/attach, N clients)
        // carry the pi's current caps; a legit change is still a
        // non-empty set. But an empty/degraded hello must NOT clobber a
        // good set — that silently gates off thinking/models/panels.
        let caps = ub["caps"]?.arrayValue?.compactMap { $0.stringValue }
        log.notice("ub hello: key=\(String(key.suffix(12)), privacy: .public) sid=\(sid, privacy: .public) caps=\(caps?.count ?? -1, privacy: .public)")
        if let caps, !caps.isEmpty {
            capabilities[key] = Set(caps)
        } else if capabilities[key] == nil {
            capabilities[key] = []
        }
        // The key IS the pi sessionId now, so a replaced session is
        // simply a NEW key with fresh state — no reset needed here.
        if envelopeReducers[key] == nil { envelopeReducers[key] = EnvelopeReducer() }
        // Manual dismissal (plan 01M18X3B): a hello is PROOF OF
        // LIFE from this session's (fresh) instance — if the user
        // had removed the ended row, resurrect it. Clear the pin
        // and re-sync the relay snapshot so the row (with fresh
        // room meta) comes back instead of waiting for the next
        // connect/refresh.
        if dismissedSessions.removeValue(forKey: key) != nil {
            log.notice("resurrecting dismissed chat on hello key=\(String(key.suffix(12)), privacy: .public)")
            Task { await refreshRooms() }
        }
        markResumed(key: key)
    }

    /// {rpc|evt} content: fold the transcript via the reducer, then the
    /// app-side side effects the reducer can't see (panels, asks,
    /// responses, queue chips).
    private func handleEnvelopeContent(env: EnvelopeMessage, key: String,
                                       envelope: RoutedEnvelope, relayID: UUID) {
        // LIVE DELTA COALESCER (perf, run 2026-09-18: "streamed content seems
        // choppier … keeps cpu busy"): streamed `message_update` frames arrive
        // at token-batch rate (10-40/s), and each fold re-parses the ENTIRE
        // streaming message (MarkdownUI parse is O(full text)) + publishes
        // transcripts — the streaming chop + CPU burn, while scroll stayed
        // fast (settled rows never re-parse). Consecutive deltas coalesce:
        // fold at most once per flush window (~15/s — 3-4× less work, text
        // lands in slightly larger chunks, no semantic change). ORDER is
        // sacred: any NON-delta frame is a BARRIER — pending deltas flush
        // first (in arrival order), then the barrier folds; the reducer never
        // sees out-of-order frames. The walk buffer (below) takes precedence:
        // during a full walk everything already defers to the terminal replay,
        // and the replayed deltas pass back through here and coalesce too.
        if isStreamDelta(env), fullWalkInFlight[key] == nil {
            pendingFoldFrames[key, default: []].append(
                (env: env, envelope: envelope, relayID: relayID))
            scheduleFoldFlush()
            return
        }
        // BACKFILL PAGE COALESCER (perf #2, device repro 2026-09-18: per-page
        // publish → window recompute → attach/detach flap — visible rows
        // cycling blank/render/blank during slow walks): non-terminal walk
        // pages fold into the SAME arrival-ordered buffer as stream deltas —
        // one flush, N applies, ONE publish. The PAGING side effects (next
        // page request, cache append, stall alive-signal, repeated-leaf
        // breaker) run IMMEDIATELY via handleRpcResponses — they don't depend
        // on the fold, and the walk must keep moving at network speed.
        if isBackfillPage(env) {
            pendingFoldFrames[key, default: []].append(
                (env: env, envelope: envelope, relayID: relayID))
            scheduleFoldFlush()
            handleRpcResponses(env: env, key: key, envelope: envelope, relayID: relayID)
            return
        }
        flushFoldFrames(for: key)   // barrier: order-preserving flush first

        var reducer = envelopeReducers[key] ?? EnvelopeReducer()
        reducer.setHideReasoning(!showThinking)
        // Full-walk BUFFERING (ordering fix): while a full walk pages in, live
        // frames must NOT fold — they would interleave BETWEEN the walk's
        // pages. Buffer everything except RESPONSES (the walk's own pages +
        // command replies); the terminal page replays them through this same
        // path. The flag + buffer clear BEFORE replay, so it can't re-buffer.
        if env.rpc?["type"]?.stringValue != "response", fullWalkInFlight[key] != nil {
            liveFrameBuffer[key, default: []].append((env: env, envelope: envelope, relayID: relayID))
            envelopeReducers[key] = reducer
            transcripts[key] = reducer.session
            return
        }
        reducer.apply(env)
        envelopeReducers[key] = reducer
        transcripts[key] = reducer.session
        // A shut-down session's pending ask is dead by construction
        // (the bridge is disposed and pi-ask emits no `completed` for
        // disposed flows) — drop the modal so a stale ask can't pop
        // on the next open (or across a resume, before pi-ask's
        // re-open lands).
        if reducer.session.ended { prompts[key] = nil }
        // Panels are envelope-only: {evt channel:"panel"} carries a
        // panel_update; decode it with the stock decoder and route it
        // into the panel store (reuses PanelState + the panel UI).
        if let evt = env.evt, evt.channel == "panel",
           let pdata = try? JSONEncoder().encode(evt.data),
           let pline = String(data: pdata, encoding: .utf8),
           let pmsg = try? Codec.decodeServer(pline) {
            route(pmsg, relayID: relayID, peer: envelope.peer,
                  sessionID: env.sessionId ?? envelope.room)
        }
        handleExtensionUi(env: env, key: key)
        handleRpcResponses(env: env, key: key, envelope: envelope, relayID: relayID)
        handleUserMessageEnd(env: env, key: key)
        handleEntryIDSync(env: env, key: key, envelope: envelope, relayID: relayID)
    }

    /// extension_ui asks (the ask sheet + notify dismissal contract).
    private func handleExtensionUi(env: EnvelopeMessage, key: String) {
        // extension_ui is envelope-only: the {rpc} extension_ui_request
        // frame is the same JSON as the stock ServerMessage, so reuse
        // the stock decoder to surface it in the existing prompt UI.
        // pi-ask dismissal contract (extension_ui_bridge): a `notify`
        // whose id matches the open interactive request means "that
        // flow resolved — dismiss it" (e.g. answered on the desktop
        // TUI). It used to REPLACE the prompt, so an already-resolved
        // ask re-presented a sheet ("Clarification resolved.") the
        // next time the transcript was opened. Routing now:
        //   warning notify  → inline transcript notice (actionable:
        //                    answer rejected / bridge TTL expired);
        //                    any open ask STAYS open as the retry
        //                    surface — never clobbered, never a modal.
        //   notify, id matches our open ask → dismiss the sheet.
        //   notify, no match → drop (a pure resolution ack, e.g.
        //                    completed after we answered ourselves —
        //                    nothing to dismiss, a row would be noise).
        if let rpc = env.rpc, rpc["type"]?.stringValue == "extension_ui_request",
           let data = try? JSONEncoder().encode(rpc),
           let line = String(data: data, encoding: .utf8),
           let decoded = try? Codec.decodeServer(line),
           case let .extensionUiRequest(request) = decoded {
            if request.method == .notify {
                if request.notifyType == "warning" {
                    appendSessionNotice(key: key, code: "ask_warning",
                                        message: request.message ?? request.title ?? "")
                } else if prompts[key]?.id == request.id {
                    prompts[key] = nil
                }
            } else {
                prompts[key] = request
                // Ask-reconciliation window: collect this ask id —
                // replayed (session_sync) or live — so the
                // session_sync_end handler can tell a still-pending
                // flow from a stale one.
                if askSyncWindows[key] != nil {
                    askSyncWindows[key]?.replayedAskIDs.insert(request.id)
                }
            }
        }
    }

    /// rpc RESPONSE plane (general): correlation + per-command side effects.
    private func handleRpcResponses(env: EnvelopeMessage, key: String,
                                    envelope: RoutedEnvelope, relayID: UUID) {
        guard let rpc = env.rpc, rpc["type"]?.stringValue == "response" else { return }
        resumeAwaitedReply(rpc) // request/reply correlation, by id
        handleRpcResponse(rpc, key: key) // side effects, by command
        handleGetEntriesPaging(rpc: rpc, key: key, envelope: envelope, relayID: relayID)
    }

    /// get_entries backfill PAGING walk (design 01M1BANZ).
    private func handleGetEntriesPaging(rpc: JSONValue, key: String,
                                       envelope: RoutedEnvelope, relayID: UUID) {
        // get_entries backfill PAGING (design 01M1BANZ): the
        // reply is ONE budget-bounded page of a possibly
        // multi-MB entry log. The frame stays pi-faithful
        // ({entries, leafId}, no extra fields) — the loop is
        // implied by pi's own since-cursor semantics: keep
        // fetching with the page's leafId until an empty page
        // (or an error / nil leaf). Folding is idempotent
        // (identify dedup), so pages + live frames interleave
        // freely. The terminal page also marks the session
        // backfilled so TranscriptView's scroll-restore can stop
        // WAITING for the remembered row (paged-backfill ×
        // restore interaction, designs 01M1BANZ + 01M1B9F6).
        if let page = rpc["data"],
           rpc["command"]?.stringValue == "get_entries",
           rpc["success"]?.boolValue == true {
            if let entries = page["entries"]?.arrayValue, !entries.isEmpty,
               let leaf = page["leafId"]?.stringValue,
               let conn = connections[relayID] {
                // REPEATED-LEAF circuit breaker: a non-empty page whose leaf
                // did not advance past the previous one means the paging loop
                // is spinning — it would never terminate (spinner forever,
                // live frames buffered behind the walk). Treat as terminal.
                if lastWalkLeaf[key] == leaf {
                    log.error("get_entries page leaf REPEATED (no advance) key=\(String(key.suffix(12)), privacy: .public) leaf=\(String(leaf.suffix(8)), privacy: .public) — paging loop broken, treating as terminal")
                    endWalk(key: key)
                    backfilledSessions.insert(key)
                    return
                }
                lastWalkLeaf[key] = leaf
                // NOTE: no backfilledSessions.remove here. The walk START
                // (requestReconstruction) owns the remove; the terminal/error
                // page owns the insert. A per-page remove meant (a) every
                // message_end delta refetch — a get_entries round trip on each
                // turn end — BLIPPED the title spinner on→off per round trip,
                // and (b) a straggler page from a superseded walk (reconnect
                // re-issued mid-flight) arriving after its terminal re-armed
                // the spinner with no walk left to complete it — stuck ON.
                walkLastActivity[key] = Date() // the watchdog's alive-signal
                // CACHE APPEND (design 01M1M4N8RZZANDX6NWY7FCSBT5, append 5):
                /// EVERY get_entries response funnels here — walk pages AND
                /// message_end refetch entries (the authoritative log versions
                /// that replace the streamed fragments + the out-of-band
                /// compaction/model entries) — so the cache tracks the LIVE
                /// frontier. Fire-and-forget: the store's overlap guard skips
                /// stragglers and re-walk pages.
                if !isDemoKey(key) {
                    let page = entries
                    let room = envelope.room
                    Task { await entryCache.append(key: key, roomID: room,
                                                   entries: page, leafId: leaf) }
                }
                let peer = envelope.peer, room = envelope.room
                let n = entries.count
                let leafTail = String(leaf.suffix(8))
                let keyTail = String(key.suffix(12))
                log.notice("get_entries page key=\(keyTail, privacy: .public) n=\(n, privacy: .public) leaf=\(leafTail, privacy: .public) — fetching next page")
                Task { try? await conn.send(.getEntries(id: UUID().uuidString, since: leaf),
                                             toPeer: peer, room: room) }
            } else {
                // Terminal page (empty entries / nil leaf): the
                // walk is over — the transcript is complete.
                backfilledSessions.insert(key)
                endWalk(key: key)
            }
        } else if rpc["command"]?.stringValue == "get_entries" {
            // Error response: the walk can't continue — mark
            // complete so a waiting restore doesn't hang forever.
            backfilledSessions.insert(key)
            endWalk(key: key)
        }
    }

    /// Queue chip resolution on user message_end (design 01M158S7).
    private func handleUserMessageEnd(env: EnvelopeMessage, key: String) {
        // Queue display is APP-OWNED. pi never delivers queue_update
        // to extensions — it's routed only to the host subscribe stream,
        // never to pi.on / the ExtensionAPI (which exposes just
        // hasPendingMessages():Bool, no queue text) — so the fork can't
        // send us a queue snapshot. Instead: an optimistic pending chip
        // on Queue submit, RESOLVED when the MODEL consumes the message.
        // The model "saw the post" when pi dequeues + runs it, which
        // surfaces as a user message_end here; correlate by TEXT only
        // (timestamp / send-id don't persist) and clear that chip. The
        // queueMessage timeout is the backstop. Design 01M158S7.
        if let rpc = env.rpc, rpc["type"]?.stringValue == "message_end",
           rpc["message"]?["role"]?.stringValue == "user" {
            let text = rpc["message"]?["content"]?.joinedText() ?? ""
            if !text.isEmpty {
                let norm = text.trimmingCharacters(in: .whitespacesAndNewlines)
                // ONE consumption clears ONE pending chip. If the same
                // text was queued twice, each run clears the FIRST
                // (oldest / FIFO — pi delivers in order) match, not all
                // identical-in-flight copies.
                if let idx = queued[key]?.firstIndex(where: {
                    $0.pending && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == norm
                }) {
                    queued[key]?.remove(at: idx)
                }
            }
        }
    }

    /// entryID acquisition (id-scheme v2): a live `message_end` means pi has
    /// (or is one synchronous beat from) persisting that message as an entry —
    /// the wire round trip IS the lag, so a delta `get_entries` issued here
    /// always sees it. The entries fold through applyEntries' MATCH LOOP: live
    /// PENDING rows re-key to their durable entry ids (never twins). toolResult
    /// settles skip it (cards are toolCallId-keyed, never pending).
    private func handleEntryIDSync(env: EnvelopeMessage, key: String,
                                   envelope: RoutedEnvelope, relayID: UUID) {
        guard env.rpc?["type"]?.stringValue == "message_end",
              let role = env.rpc?["message"]?["role"]?.stringValue,
              role == "user" || role == "assistant",
              let since = envelopeReducers[key]?.leafId,
              let conn = connections[relayID] else { return }
        Task { try? await conn.send(.getEntries(id: UUID().uuidString, since: since),
                                     toPeer: envelope.peer, room: envelope.room) }
    }

    /// End the active-walk bookkeeping (terminal / error / give-up / loop
    /// break): clears the watchdog lifecycle + the loop-breaker cursor. The
    /// live-buffer replay only applies to FULL walks (delta walks never
    /// buffered); replayLiveBuffer no-ops when the flag is clear.
    func endWalk(key: String) {
        activeWalks[key] = nil
        lastWalkLeaf[key] = nil
        walkLastActivity.removeValue(forKey: key)
        replayLiveBuffer(key: key)
    }

    /// Unbuffer + fold the live frames held during a full walk (terminal page,
    /// walk error, or a stale walk superseded). Flag + buffer clear FIRST so
    /// the replay can't re-buffer. Frames replay through the normal fold path —
    /// messages the walk already birthed are skipped by the reducer's
    /// duplicate-delivery guard (identifyIndex); messages that settled after
    /// the walk's last page birth as pendings (appended at the tail — correct,
    /// they are the newest) and re-key on the next delta.
    func replayLiveBuffer(key: String) {
        guard fullWalkInFlight[key] != nil else { return }
        fullWalkInFlight.removeValue(forKey: key)
        // Drop the dead walk's alive-signal too: a stale timestamp makes the
        // NEXT walk's watchdog treat the first 30s as "alive" — delaying its
        // stall handling (and give-up cleanup) by a full window.
        walkLastActivity.removeValue(forKey: key)
        let frames = liveFrameBuffer.removeValue(forKey: key) ?? []
        for frame in frames {
            handleEnvelopeContent(env: frame.env, key: key,
                                  envelope: frame.envelope, relayID: frame.relayID)
        }
    }

    /// Surface a non-modal informational notice in a session's transcript.
    /// Used for extension_ui WARNING notifies (actionable — answer rejected /
    /// bridge TTL expired — but never sheet-worthy). Folds through the reducer
    /// so the row persists in its session like any other notice.
    func appendSessionNotice(key: String, code: String, message: String) {
        guard !message.isEmpty else { return }
        var reducer = envelopeReducers[key] ?? EnvelopeReducer()
        reducer.setHideReasoning(!showThinking)
        reducer.appendNotice(code: code, message: message)
        envelopeReducers[key] = reducer
        transcripts[key] = reducer.session
    }

    /// Retract a session's ended state (banner + input lock): the session was
    /// RESUMED — its room re-advertised and/or a fresh extension instance
    /// greeted over the re-joined room. Clears BOTH stores: the next envelope
    /// fold overwrites `transcripts[key]` from the reducer's own copy, so
    /// clearing only the transcript copy would resurrect the flag one frame
    /// later. No-op (and no spurious @Published churn) when not ended.
    func markResumed(key: String) {
        guard transcripts[key]?.ended == true else { return }
        transcripts[key]?.markResumed()
        envelopeReducers[key]?.markResumed()
        log.notice("session resumed: ended banner retracted key=\(String(key.suffix(12)), privacy: .public)")
    }

    private func handle(control event: RelayControlIn, relayID: UUID) {
        switch event {
        case let .rooms(peer, rooms):
            // Authoritative per-peer snapshot (rooms_check on subscribe): RECONCILE,
            // don't just add. Drop any session for this (relay, peer) whose room
            // isn't in the snapshot — it ended while we were disconnected/backgrounded
            // (missed roomEnded); add-only left those as ghosts ("old chats in the
            // mix"). Then upsert the live ones. Scoped to this peer, so other
            // machines' sessions are untouched. See design 01M18AK9.
            // Sessions are keyed by pi sessionId now, so match the snapshot on the
            // LiveSession.roomID FIELD (routing) — NOT by parsing the key (which is
            // the sessionId). Parsing the key would treat every sessionId as an
            // unknown room and purge all live sessions.
            let liveRoomIDs = Set(rooms.map(\.roomID))
            // Observability: rooms in the snapshot we didn't already have live
            // are room_announced pushes we missed — on first connect this is the
            // initial load, on a manual refresh a non-zero count means a push
            // was dropped.
            let knownRoomIDs = Set(sessions.values
                .filter { $0.relayID == relayID && $0.peerEPK == peer }
                .map(\.roomID))
            let recovered = liveRoomIDs.subtracting(knownRoomIDs).count
            if recovered > 0 {
                log.info("rooms_check recovered \(recovered, privacy: .public) not-live room(s) for peer \(String(peer.prefix(8)), privacy: .public) (initial load or missed room_announced)")
            }
            for (key, session) in sessions
            where session.relayID == relayID && session.peerEPK == peer
            && !liveRoomIDs.contains(session.roomID) {
                sessions[key] = nil
                forgetSession(key: key)
            }
            // DISK reconcile (design 01M1M4N8RZZANDX6NWY7FCSBT5, retention
            /// append 3): trash orphaned entry-cache files for rooms that
            /// ended while the app was dead — the in-memory purge above can't
            /// see them (a dead room never materializes as a session, so
            /// forgetSession never fires for it). No room set from a peer →
            /// no signal → its files stay (never false-purge an offline peer).
            Task { await entryCache.reconcile(relayID: relayID.uuidString, peer: peer,
                                              liveRoomIDs: liveRoomIDs) }
            for room in rooms { upsertSession(relayID: relayID, peer: peer, room: room) }
        case let .roomAnnounced(peer, room):
            upsertSession(relayID: relayID, peer: peer, room: room)
        case let .roomEnded(peer, roomID, _):
            if let k = sessionKey(relayID: relayID, peer: peer, roomID: roomID) {
                sessions[k] = nil
                forgetSession(key: k)
            }
            // Also un-pin any DISMISSED session on this routing tuple (plan
            // 01M18X3B): the room truly ended, so a later same-session-id
            // announce is a real resume, not the lingering snapshot.
            for (k, s) in dismissedSessions
            where s.relayID == relayID && s.peerEPK == peer && s.roomID == roomID {
                dismissedSessions[k] = nil
            }
        case let .roomMetaUpdated(peer, roomID, model, parent, parentSessionID):
            if let k = sessionKey(relayID: relayID, peer: peer, roomID: roomID),
               var session = sessions[k] {
                let wasSubagent = session.isSubagent
                if let model { session.model = model }
                // Last-info-wins parentage (present-only, never clears): a
                // LATE-advertised parent (in-process subagent, after attach)
                // re-nests the child. Reassigning sessions[k] re-derives
                // HomeView's top/kids grouping so the row moves in the hierarchy.
                if let parentSessionID { session.parentSessionID = parentSessionID }
                if let parent { session.parentRoomID = parent }
                sessions[k] = session
                // Newly a subagent -> pull its lifecycle status (mirror upsert).
                if !wasSubagent, session.isSubagent,
                   let connection = connections[relayID] {
                    let peerEPK = session.peerEPK
                    let rid = session.roomID
                    Task {
                        try? await connection.send(
                            .getSessionInfo(id: UUID().uuidString),
                            toPeer: peerEPK, room: rid)
                    }
                }
            }
        default:
            break
        }
    }

    private func upsertSession(relayID: UUID, peer: String, room: RoomInfo) {
        // The presence daemon's control room is not a chat session: it carries the
        // `is_daemon` cap, its roomId is the control-room derivation, and it has no
        // pi sessionId (a real session's wire identity).
        if room.caps?.contains("is_daemon") == true { return }
        if let control = Base64.deriveControlRoom(epk: peer), room.roomID == control { return }
        guard let sessionID = room.sessionID else { return }
        var session = LiveSession(relayID: relayID, peerEPK: peer, roomID: room.roomID,
                                  sessionID: sessionID,
                                  name: room.name, cwd: room.cwd, model: nil,
                                  parentSessionID: room.parentSessionID,
                                  parentRoomID: room.parent, subagentID: room.subagentID)
        // Manual dismissal (plan 01M18X3B): an ended chat the user removed
        // stays hidden — a snapshot re-listing or re-announce is the room
        // LINGERING at the relay, not liveness. Only proof of life (a fresh
        // `ub hello`) or a genuine roomEnded clears the pin.
        if dismissedSessions[session.id] != nil { return }
        // Carry a known status across re-announce (reconnect/relaunch replays
        // room_announced); the pull below refreshes it.
        session.status = sessions[session.id]?.status
        sessions[session.id] = session
        // A re-advertised room means the session is live again — the resume
        // flow: the OUTGOING extension instance broadcast session_shutdown
        // (banner up), then the fresh instance re-joined the SAME room under
        // the durable session id. Covers room_announced pushes AND rooms_check
        // recovery on (re)connect. An actually-dead session's room is torn
        // down, so it never re-advertises — no false retraction.
        markResumed(key: session.id)
        // PULL the subagent's lifecycle status over its OWN connection, re-issued
        // on every announce so it survives app relaunch (design 01M18PCM). The
        // send itself is what makes the child room attach + answer.
        if session.isSubagent, let connection = connections[relayID] {
            let peerEPK = session.peerEPK
            let roomID = session.roomID
            Task { try? await connection.send(.getSessionInfo(id: UUID().uuidString),
                                              toPeer: peerEPK, room: roomID) }
        }
    }

    /// The child subagent session for a subagents-panel record id, on the same
    /// machine as `parent`. nil until that subagent's room is announced.
    public func subagentSession(sessionID: String, under parent: LiveSession) -> LiveSession? {
        sessions.values.first {
            $0.sessionID == sessionID
                && $0.relayID == parent.relayID
                && $0.peerEPK == parent.peerEPK
        }
    }

    /// Resolve a relay (peer, roomID) ROUTING tuple to the pi-sessionId state key
    /// (LiveSession.id) — for control frames keyed by roomID.
    private func sessionKey(relayID: UUID, peer: String, roomID: String) -> String? {
        sessions.values.first {
            $0.relayID == relayID && $0.peerEPK == peer && $0.roomID == roomID
        }?.id
    }
}

// probe
