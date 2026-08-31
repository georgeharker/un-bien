import Foundation
import UnBienCore

// Queued-message logic split out of AppModel.swift (its 1000-line cap):
// submitting/steering into pi's NATIVE queue, the queued-chip delete flow
// (clear_queue + authoritative reissue, plan 01M1A39Y4G), and the optimistic
// pending chips. State (queued / connections / pendingRpcReplies) stays on
// AppModel; this extension only drives it.

extension AppModel {
    // MARK: - Queued messages

    public func queueMessage(_ text: String, to session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        // Busy -> followUp QUEUES until the turn ends; show a BLUE pending chip.
        // Idle -> runs fresh (bubble is the feedback). Same trick as steer, just a
        // different color + it clears later (after the turn vs mid-turn).
        if activeTurnID(for: session) != nil {
            insertPendingChip(text, session: session, kind: "followUp")
        }
        // pi's native queue: a `prompt` with `followUp` behavior queues while the
        // turn streams (fresh turn when idle).
        try? await connection.send(
            .userMessage(id: UUID().uuidString, text: text, images: nil, streamingBehavior: "followUp"),
            toPeer: session.peerEPK, room: session.roomID)
    }

    /// Delete one queued chip. pi has no per-item queue removal, so the only
    /// primitive is `clear_queue` (drops the whole steering/follow-up queue and
    /// returns its text). We clear pi's queue, then reissue the SURVIVORS in
    /// order — each with its original verb — so the net effect is "the queue
    /// minus that message" (see pi.dev/docs/latest/rpc#clear-queue). The
    /// AUTHORITATIVE survivor list is pi's clear_queue response (plan
    /// 01M1A39Y4G); the optimistic chip list is only the fallback when the reply
    /// times out (dead session / relay drop). Sends are sequential on one
    /// connection, so pi sees clear BEFORE the reissued prompts.
    public func deleteQueued(_ item: QueuedMessageItem, from session: LiveSession) async {
        guard let connection = connections[session.relayID] else { return }
        let optimistic = (queued[session.id] ?? []).filter { $0.id != item.id }
        queued[session.id] = optimistic  // optimistically drop the tapped chip
        let reqID = UUID().uuidString
        let reply = await sendAwaitingReply(.clearQueue(id: reqID), reqID: reqID,
                                            to: session, over: connection)
        var steering: [String]
        var followUp: [String]
        if let data = reply?["data"], reply?["success"]?.boolValue == true {
            steering = data["steering"]?.arrayValue?.compactMap(\.stringValue) ?? []
            followUp = data["followUp"]?.arrayValue?.compactMap(\.stringValue) ?? []
            // clear_queue returns TEXT only (no ids): drop the tapped item from
            // its kind bucket by FIRST text occurrence (duplicates survive — only
            // the queued copy the user tapped is meant to go).
            if item.kind == "steer" {
                if let i = steering.firstIndex(of: item.text) { steering.remove(at: i) }
            } else {
                if let i = followUp.firstIndex(of: item.text) { followUp.remove(at: i) }
            }
        } else {
            steering = optimistic.filter { $0.kind == "steer" }.map(\.text)
            followUp = optimistic.filter { $0.kind != "steer" }.map(\.text)
        }
        for text in steering {
            try? await connection.send(
                .userMessage(id: UUID().uuidString, text: text, images: nil, streamingBehavior: "steer"),
                toPeer: session.peerEPK, room: session.roomID)
        }
        for text in followUp {
            try? await connection.send(
                .userMessage(id: UUID().uuidString, text: text, images: nil, streamingBehavior: "followUp"),
                toPeer: session.peerEPK, room: session.roomID)
        }
    }

    /// Insert an OPTIMISTIC pending chip for a message submitted WHILE BUSY. Both
    /// steer (grey, interrupts mid-turn) and followUp (blue, after the turn) sit in
    /// a pi queue until the model consumes them, so show the text instead of
    /// letting it vanish from the composer. Cleared by consumption (user
    /// message_end, text-correlated in handle()); a long backstop timer drops a
    /// never-consumed chip (design 01M158S7).
    func insertPendingChip(_ text: String, session: LiveSession, kind: String) {
        let tempID = "pending-\(UUID().uuidString)"
        var forSession = queued[session.id] ?? []
        forSession.append(QueuedMessageItem(id: tempID, text: text, editable: false,
                                            createdAt: Int(Date().timeIntervalSince1970 * 1000),
                                            pending: true, kind: kind))
        queued[session.id] = forSession
        let sid = session.id
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.queuedChipGraceNanos)
            self?.queued[sid]?.removeAll { $0.id == tempID && $0.pending }
        }
    }
}
