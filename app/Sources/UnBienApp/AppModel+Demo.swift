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
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "unbien.demo.stream-replay") {
            // TEMPORARY debug harness (scroll-follow diagnosis): fold the
            // fixture LIVE, frame by frame with delays, through the real
            // reducer — bumps liveArrivals per delta exactly like a real
            // streaming turn. Off by default; normal demo folds instantly.
            // Also auto-opens the session (hands-off diagnosis: no UI tap
            // needed from the harness driving the simulator).
            streamDemoFixture("demo-main", into: main)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if self.sessions[main.id] != nil { self.pendingSessionNav = main }
            }
        } else {
            foldDemoFixture("demo-main", into: main)
        }
        sessions[main.id] = main
        if !UserDefaults.standard.bool(forKey: "unbien.demo.stream-replay") {
            loadDemoAsk(into: main)
        }
        #else
        foldDemoFixture("demo-main", into: main)
        sessions[main.id] = main
        loadDemoAsk(into: main)
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

        // Cosmetic: the demo relay has no socket, but its Home header should
        // not render as a failed connection — the demo IS present, in memory.
        relayHealth[Self.demoRelayID] = .online
    }

    #if DEBUG
    /// TEMPORARY debug harness (see loadDemoSessions): replay a fixture's
    /// frames into the LIVE reducer with per-frame delays, so the transcript
    /// grows in place exactly like a real streaming turn (liveArrivals ticks,
    /// the last row mutates, the busy indicator shows). Used for local
    /// scroll-follow diagnosis (simulator screenshots); remove when the
    /// scroll redesign settles.
    private func streamDemoFixture(_ resource: String, into session: LiveSession) {
        var reducer = EnvelopeReducer()
        envelopeReducers[session.id] = reducer
        transcripts[session.id] = reducer.session
        backfilledSessions.insert(session.id)
        let frames = Self.demoFixtures(resource)
        Task { @MainActor in
            for frame in frames {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard self.sessions[session.id] != nil else { return } // demo unloaded
                // Mutate the STORED reducer (value semantics: a captured `var`
                // copy would drift from envelopeReducers) and publish its
                // session snapshot so liveArrivals ticks per frame.
                self.envelopeReducers[session.id]?.apply([frame])
                if let live = self.envelopeReducers[session.id] {
                    reducer = live
                    self.transcripts[session.id] = live.session
                }
            }
        }
        _ = reducer
    }
    #endif

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
