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

        // Main: a purpose-built fixture (design 01M1CGET…) — a realistic
        // coding turn: thinking, streamed narration, an Edit card with real
        // diff hunks (envelope aux), a test run, and a markdown summary. The
        // raw smoke-test capture it replaced read as confusing ("reply with
        // exactly hello world", aimless follow-up turns).
        let main = LiveSession(relayID: Self.demoRelayID, peerEPK: "demo-peer",
                               roomID: "demo-room-main", sessionID: "demo-session-main",
                               name: "Agent turn", cwd: "~/demo", model: "claude-opus-4-8",
                               parentSessionID: nil, parentRoomID: nil, subagentID: nil)
        if Self.streamDemoReplayEnabled() {
            // The demo streams its fixture LIVE — frame by frame with delays,
            // through the real reducer — so it reads as a real coding turn
            // (text growing in place, busy indicator, bottom-follow tracking)
            // instead of an instantly-complete transcript. The interactive
            // ask surfaces AFTER the turn settles plus a short beat (below).
            streamDemoFixture("demo-main", into: main) { [weak self] in
                self?.loadDemoAsk(into: main)
            }
        } else {
            // Escape hatch (explicit `defaults write unbien.demo.stream-replay
            // -bool false`): the original instant-fold demo, ask up front.
            foldDemoFixture("demo-main", into: main)
            loadDemoAsk(into: main)
        }
        sessions[main.id] = main
        // Headless-harness auto-open (scroll diagnosis in the simulator): when
        // the flag is EXPLICITLY true, auto-open a session so the harness needs
        // no UI tap. Target defaults to the main session;
        // `unbien.demo.auto-open-session` = "stress" opens the stress session
        // (defined below — hence the late id lookup at fire time).
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "unbien.demo.stream-replay") {
            let target = UserDefaults.standard.string(forKey: "unbien.demo.auto-open-session") ?? "main"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                let wanted = self.sessions.values.first {
                    (target == "stress") == ($0.roomID == "demo-room-stress")
                }
                if let wanted { self.pendingSessionNav = wanted }
            }
        }
        #endif

        // Child: the subagent-run fixture, nested under the main session so
        // Home shows the subagent-parenting surface.
        let child = LiveSession(relayID: Self.demoRelayID, peerEPK: "demo-peer",
                                roomID: "demo-room-subagent", sessionID: "demo-session-subagent",
                                name: "Subagent", cwd: "~/demo", model: "claude-opus-4-8",
                                parentSessionID: main.sessionID, parentRoomID: main.roomID,
                                subagentID: "demo-subagent-1")
        foldDemoFixture("demo-subagent-run", into: child)
        sessions[child.id] = child

        #if DEBUG
        // Headless-harness stress session (scroll/materialization diagnosis
        // only — the shipped demo stays svelte): a long, wildly varied-height
        // transcript (one-liners → 100-line code blocks) streamed FAST (~30ms
        // per frame) so a ~45-second real-time replay finishes in ~20s. Keyed
        // on the same explicitly-set flag as the other harness bits.
        if UserDefaults.standard.bool(forKey: "unbien.demo.stream-replay") {
            let stress = LiveSession(relayID: Self.demoRelayID, peerEPK: "demo-peer",
                                     roomID: "demo-room-stress", sessionID: "demo-session-stress",
                                     name: "Stress", cwd: "~/demo", model: "claude-opus-4-8",
                                     parentSessionID: nil, parentRoomID: nil, subagentID: nil)
            streamDemoFixture("demo-stress", into: stress, frameDelayNs: 30_000_000)
            sessions[stress.id] = stress
        }
        #endif

        // Cosmetic: the demo relay has no socket, but its Home header should
        // not render as a failed connection — the demo IS present, in memory.
        relayHealth[Self.demoRelayID] = .online
    }

    /// Replay a fixture's frames into the LIVE reducer with per-frame delays,
    /// so the demo transcript grows in place exactly like a real streaming
    /// turn (liveArrivals ticks, the last row mutates, the busy indicator
    /// shows, bottom-follow tracks). `onSettled` fires one beat after the last
    /// frame — the demo uses it to surface the interactive ask as the finale,
    /// AFTER the reviewer has watched the turn stream in.
    private func streamDemoFixture(_ resource: String, into session: LiveSession,
                                   frameDelayNs: UInt64 = 300_000_000,
                                   onSettled: (() -> Void)? = nil) {
        let reducer = EnvelopeReducer()
        envelopeReducers[session.id] = reducer
        transcripts[session.id] = reducer.session
        backfilledSessions.insert(session.id)
        let frames = Self.demoFixtures(resource)
        Task { @MainActor in
            for frame in frames {
                try? await Task.sleep(nanoseconds: frameDelayNs)
                guard self.sessions[session.id] != nil else { return } // demo unloaded
                // Mutate the STORED reducer (value semantics: a captured local
                // copy would drift from envelopeReducers) and publish its
                // session snapshot so liveArrivals ticks per frame.
                self.envelopeReducers[session.id]?.apply([frame])
                if let live = self.envelopeReducers[session.id] {
                    self.transcripts[session.id] = live.session
                }
            }
            // One beat after the turn settles — the ask lands as the finale.
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard self.sessions[session.id] != nil else { return }
            onSettled?()
        }
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


    /// Whether the demo STREAMS its fixture (default) or instant-folds it
    /// (escape hatch). Default ON — the streamed demo reads as a real coding
    /// turn (App Review / first impressions); an explicit
    /// `defaults write unbien.demo.stream-replay -bool false` restores the
    /// original instant-fold behavior.
    static func streamDemoReplayEnabled() -> Bool {
        UserDefaults.standard.object(forKey: "unbien.demo.stream-replay") as? Bool ?? true
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
