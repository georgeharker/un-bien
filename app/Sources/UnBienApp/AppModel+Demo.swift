import Foundation
import UnBienCore

// App Store reviewability demo mode (design 01M1CGETFGASAN7YT17MT0FV2A /
// plan 01M1CGF33J48JRF56ZAS07GZ16): canned sessions replayed from RECORDED
// envelope-stream fixtures, folded through the REAL EnvelopeReducer/applyRPC
// path — nothing is rendered that isn't the real reduction. Deliberately
// READ-ONLY (composer disabled, demo banner) and firewalled from real state:
// the demo relay is transient (never persisted), demo session ids are
// namespaced, and scroll-memory writes are skipped. Exists so the binary is
// never an empty shell for an App Review reviewer (Guideline 2.1) — and
// doubles as try-before-you-host for prospective users.

extension AppModel {
    /// Fixture replay: fold a bundled JSONL envelope stream through a fresh
    /// reducer and store it as this session's transcript. Each line is either a
    /// full {rpc|evt} EnvelopeMessage or a bare rpc frame (wrapped, mirroring
    /// the extension-side wire).
    private func foldDemoFixture(_ resource: String, into session: LiveSession) {
        var reducer = EnvelopeReducer()
        reducer.apply(Self.demoFixtures(resource))
        envelopeReducers[session.id] = reducer
        transcripts[session.id] = reducer.session
        // The scroll-restore waiter treats a session as complete once its
        // backfill walk ends; a demo session never walks (no connection), so
        // mark it complete up front or the once-per-lifetime restore hangs.
        backfilledSessions.insert(session.id)
    }

    /// The canned ask (interactive surface without simulating a reply): decoded
    /// through the SAME stock Codec path Inbound uses, so the sheet is the real
    /// RichAskFlowView. Answering it is a no-op (no connection to send on) —
    /// the prompt just clears.
    private func loadDemoAsk(into session: LiveSession) {
        guard let line = Self.demoFixtures("demo-ask").first,
              let rpc = line.rpc,
              let data = try? JSONEncoder().encode(rpc),
              let decoded = try? Codec.decodeServer(String(data: data, encoding: .utf8) ?? ""),
              case let .extensionUiRequest(request) = decoded else { return }
        prompts[session.id] = request
    }

    /// Load the demo mesh: a transient relay + two sessions (a full agent turn,
    /// and a nested subagent run). Idempotent.
    public func loadDemoSessions() {
        guard !mesh.config.relays.contains(where: { $0.id == Self.demoRelayID }) else { return }
        mesh.addTransientRelay(RelayConfig(id: Self.demoRelayID, name: "Demo", url: "demo://local"))

        // Main: the message-turn fixture (streamed text, thinking, tool cards,
        // notifies) — the richest single transcript.
        let main = LiveSession(relayID: Self.demoRelayID, peerEPK: "demo-peer",
                               roomID: "demo-room-main", sessionID: "demo-session-main",
                               name: "Agent turn", cwd: "~/demo", model: "claude-opus-4-8",
                               parentSessionID: nil, parentRoomID: nil, subagentID: nil)
        foldDemoFixture("demo-message-turn", into: main)
        sessions[main.id] = main
        loadDemoAsk(into: main)

        // Child: the subagent-run fixture, nested under the main session so
        // Home shows the subagent-parenting surface.
        let child = LiveSession(relayID: Self.demoRelayID, peerEPK: "demo-peer",
                                roomID: "demo-room-subagent", sessionID: "demo-session-subagent",
                                name: "Subagent", cwd: "~/demo", model: "claude-opus-4-8",
                                parentSessionID: main.sessionID, parentRoomID: main.roomID,
                                subagentID: "demo-subagent-1")
        foldDemoFixture("demo-subagent-run", into: child)
        sessions[child.id] = child

        // Cosmetic: the demo relay has no socket, but its Home header should
        // not render as a failed connection — the demo IS present, in memory.
        relayHealth[Self.demoRelayID] = .online
    }

    /// Tear the demo mesh down (toggle off). Only touches demo-namespaced state.
    public func unloadDemoSessions() {
        guard mesh.config.relays.contains(where: { $0.id == Self.demoRelayID }) else { return }
        let prefix = "\(Self.demoRelayID.uuidString):"
        for key in sessions.keys where key.hasPrefix(prefix) {
            sessions[key] = nil
            transcripts[key] = nil
            prompts[key] = nil
            envelopeReducers[key] = nil
            backfilledSessions.remove(key)
        }
        mesh.removeTransientRelay(id: Self.demoRelayID)
        relayHealth[Self.demoRelayID] = nil
    }

    /// Settings entry point: flip demo mode and load/unload the demo mesh.
    public func setDemoMode(_ on: Bool) {
        guard demoMode != on else { return }
        demoMode = on
        if on { loadDemoSessions() } else { unloadDemoSessions() }
    }

    /// True when this session belongs to the demo mesh (read-only surfaces).
    public func isDemo(_ session: LiveSession) -> Bool {
        session.relayID == Self.demoRelayID
    }

    /// Load one bundled demo fixture as envelope messages. Discriminate by
    /// SHAPE (mirrors the wire): a line carrying an `rpc`/`evt`/`ub` key is a
    /// real envelope; anything else is a BARE rpc frame (top-level `type`) and
    /// wraps as `{rpc}`. NB: trying `EnvelopeMessage` first is a trap — all its
    /// fields are optional, so EVERY object decodes as an all-empty envelope
    /// and the frame silently no-ops in `apply` (observed: the message-turn
    /// fixture rendered an empty transcript while the {rpc}-wrapped subagent
    /// fixture worked).
    static func demoFixtures(_ resource: String) -> [EnvelopeMessage] {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "jsonl"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { line -> EnvelopeMessage? in
            let data = Data(line.utf8)
            guard let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
            if value["rpc"] != nil || value["evt"] != nil || value["ub"] != nil {
                return try? JSONDecoder().decode(EnvelopeMessage.self, from: data)
            }
            return EnvelopeMessage(rpc: value)
        }
    }
}
