import Foundation
import os
import UnBienCore

private let log = Logger(subsystem: "un-bien", category: "walk")

// The get_entries PAGING WALK lifecycle, carved from AppModel+Inbound.swift
// (line cap): page folding + the repeated-leaf breaker + walk termination +
// the live-frame buffer replay. State stays on AppModel; this extension only
// drives it. Design refs: 01M1BANZ (paging), 01M1M4N8RZZANDX6NWY7FCSBT5
// (cache append), 01M2435 (delta walks page to terminal + derive).
extension AppModel {
    /// get_entries backfill PAGING walk (design 01M1BANZ).
    func handleGetEntriesPaging(rpc: JSONValue, key: String,
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
        guard rpc["command"]?.stringValue == "get_entries" else { return }
        // Which paging CHAIN is this a page of? The current walk keeps
        // activeWalks[key] == its id across pages (next-page reuses the id);
        // a superseded/stale walk's straggler no longer matches. Every
        // message_end sync is a delta WALK now, so a non-match is always a
        // straggler. Only the CURRENT walk drives walk bookkeeping
        // (breaker→terminal, backfilled, endWalk); others fold idempotently
        // on their OWN id and never corrupt the walk's cursor. This is the
        // walkID tidy-up over design 01M1NKAT.
        let pagingID = rpc["id"]?.stringValue ?? ""
        let isCurrentWalk = !pagingID.isEmpty && activeWalks[key] == pagingID
        if !isCurrentWalk {
            RenderActivity.getEntriesStraggler += 1
        }
        if let page = rpc["data"], rpc["success"]?.boolValue == true {
            if let entries = page["entries"]?.arrayValue, !entries.isEmpty,
               let leaf = page["leafId"]?.stringValue,
               let conn = connections[relayID] {
                // ACTIVE chip clear on backfill: a pending steer/followUp chip is
                // normally cleared by the LIVE user message_end (the consumption
                // signal). If that frame was missed (backgrounded), the message
                // returns only here, entry-born — so correlate this page's user
                // entries by text and clear matching chips, instead of leaving
                // them to the 5-min backstop (they "time out" rather than
                // actively disappear). Design 01M158S7 + missed-events reconcile.
                for entry in entries where entry["message"]?["role"]?.stringValue == "user" {
                    clearPendingChip(key: key, userText: entry["message"]?["content"]?.joinedText() ?? "")
                }
                // REPEATED-LEAF circuit breaker: a non-empty page whose leaf
                // did not advance past the previous one means the paging loop
                // is spinning — it would never terminate (spinner forever,
                // live frames buffered behind the walk). Treat as terminal.
                if pagingLeaf[pagingID] == leaf {
                    pagingLeaf[pagingID] = nil
                    if isCurrentWalk {
                        let keyTail = String(key.suffix(12))
                        let leafTail = String(leaf.suffix(8))
                        log.error("get_entries page leaf REPEATED (no advance) key=\(keyTail, privacy: .public) leaf=\(leafTail, privacy: .public) — paging loop broken, treating as terminal")
                        // DERIVE ANYWAY — the breaker is a bookkeeping-only
                        // terminal otherwise: the spun page folded index-only
                        // (non-empty ⇒ no beacon ⇒ no derive), so the rendered
                        // path stays STALE and everything the walk fetched but
                        // hadn't rendered stays invisible forever (the
                        // missing-post-tool-prose failure: fetched + indexed,
                        // never rendered). Fold an EMPTY terminal page carrying
                        // the spun leaf — on-chain it derives + heals; a
                        // not-yet-indexed leaf defers safely (defer-trunc holds
                        // it for the next fold). The SAME guarantee the normal
                        // empty terminal already gives, applied to the walk's
                        // other exit.
                        var reducer = envelopeReducers[key] ?? EnvelopeReducer()
                        reducer.setHideReasoning(!showThinking)
                        reducer.apply(EnvelopeMessage(rpc: .object([
                            "type": .string("response"),
                            "command": .string("get_entries"),
                            "success": .bool(true),
                            "data": .object(["entries": .array([]),
                                             "leafId": .string(leaf)]),
                        ])))
                        commitFold(key, reducer)
                        backfilledSessions.insert(key)
                        endWalk(key: key)
                    }
                    return
                }
                pagingLeaf[pagingID] = leaf
                // NOTE: no backfilledSessions.remove here. The walk START
                // (requestReconstruction) owns the remove; the terminal/error
                // page owns the insert. A per-page remove meant (a) every
                // message_end delta walk — a get_entries round trip on each
                // turn end — BLIPPED the title spinner on→off per round trip,
                // and (b) a straggler page from a superseded walk (reconnect
                // re-issued mid-flight) arriving after its terminal re-armed
                // the spinner with no walk left to complete it — stuck ON.
                if isCurrentWalk { walkLastActivity[key] = Date() } // watchdog alive-signal
                // CACHE APPEND (design 01M1M4N8RZZANDX6NWY7FCSBT5, append 5):
                /// EVERY get_entries response funnels here — walk pages AND
                /// message_end delta-walk entries (the authoritative log versions
                /// that replace the streamed fragments + the out-of-band
                /// compaction/model entries) — so the cache tracks the LIVE
                /// frontier. Fire-and-forget: the store's overlap guard skips
                /// stragglers and re-walk pages.
                if !isDemoKey(key) {
                    let page = entries
                    let room = envelope.room
                    Task {
                        await entryCache.append(
                            key: key, roomID: room, entries: page,
                            leafId: leaf,
                            foldedLeaf: entries.last?["id"]?.stringValue
                        )
                    }
                }
                // Folded-frontier advance (design: log-cursor split): the fetch
                // origin moves only over entries this walk FOLDED — never an
                // empty terminal page's machine-reported tail, which can sit
                // ahead of held content after a lost-reply window.
                if isCurrentWalk, let tail = entries.last?["id"]?.stringValue {
                    foldedFrontier[key] = tail
                }
                let peer = envelope.peer, room = envelope.room
                let n = entries.count
                let leafTail = String(leaf.suffix(8))
                let keyTail = String(key.suffix(12))
                log.notice("get_entries page key=\(keyTail, privacy: .public) n=\(n, privacy: .public) leaf=\(leafTail, privacy: .public) — fetching next page")
                // ONLY the current walk pages on (keeping its id). A
                // superseded/duplicate walk (reconnect storm) folds its page
                // (via handleRpcResponse) but must NOT
                // keep paging — else concurrent chains re-fetch the SAME leaf
                // forever (observed: 3 chains spinning on one leaf after
                // repeated reconnects, so the walk never advanced to the tail).
                if isCurrentWalk {
                    Task { try? await conn.send(.getEntries(id: pagingID, since: leaf),
                                                 toPeer: peer, room: room) }
                }
            } else {
                // Terminal page (empty / nil leaf): THIS chain is done. Only
                // the current walk marks the session backfilled + clears the
                // walk lifecycle (a delta/straggler just stops).
                pagingLeaf[pagingID] = nil
                if isCurrentWalk {
                    RenderActivity.walkTerminals += 1
                    log.notice("WALK terminal key=\(String(key.suffix(12)), privacy: .public) — backfilled")
                    backfilledSessions.insert(key)
                    endWalk(key: key)
                }
            }
        } else {
            // Error response: end this chain; the current walk unblocks a
            // waiting restore so it can't hang forever.
            pagingLeaf[pagingID] = nil
            if isCurrentWalk {
                backfilledSessions.insert(key)
                endWalk(key: key)
            }
        }
    }

    /// Queue chip resolution on user message_end (design 01M158S7).

    /// End the active-walk bookkeeping (terminal / error / give-up / loop
    /// break): clears the watchdog lifecycle + the loop-breaker cursor. The
    /// live-buffer replay only applies to FULL walks (delta walks never
    /// buffered); replayLiveBuffer no-ops when the flag is clear.
    func endWalk(key: String) {
        if let walkID = activeWalks[key] { pagingLeaf[walkID] = nil }
        activeWalks[key] = nil
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
}
