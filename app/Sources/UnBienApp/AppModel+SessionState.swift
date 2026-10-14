import Foundation
import os
import UnBienCore

private let log = Logger(subsystem: "un-bien", category: "relay")

// Folding-surface helpers (carved from AppModel+Inbound.swift — line cap).
// Touch only non-private AppModel state; an extension file is safe.
extension AppModel {
    /// Surface a non-modal informational notice in a session's transcript.
    /// Used for extension_ui WARNING notifies (actionable — answer rejected /
    /// bridge TTL expired — but never sheet-worthy). Folds through the reducer
    /// so the row persists in its session like any other notice.
    func appendSessionNotice(key: String, code: String, message: String) {
        guard !message.isEmpty else { return }
        var reducer = envelopeReducers[key] ?? EnvelopeReducer()
        reducer.setHideReasoning(!showThinking)
        reducer.appendNotice(code: code, message: message)
        commitFold(key, reducer)
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

}
