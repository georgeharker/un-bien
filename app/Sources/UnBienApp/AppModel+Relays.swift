import Foundation
import os
import SwiftUI
import UnBienCore

private let log = Logger(subsystem: "un-bien", category: "relay")

// Relay + daemon control split out of AppModel.swift (its 1000-line cap):
// relay add/remove/edit, connect + event loop + reconnect backoff, rooms
// refresh, and the idle-machine (presence daemon) caps/launch control.
// Stored state (connections / reconnect timers / open sessions) stays on
// AppModel; this extension only drives it.

extension AppModel {
    // MARK: - Relays

    public func addRelay(name: String, url: String) async {
        // The first REAL relay turns demo mode off (default-off once a relay
        // exists; re-enable any time from Settings).
        if demoMode { setDemoMode(false) }
        let relay = RelayConfig(name: name, url: url)
        mesh.addRelay(relay)
        await connect(relay)
    }

    public func removeRelay(id: UUID) {
        reconnectTasks[id]?.cancel()
        reconnectTasks[id] = nil
        reconnectAttempts[id] = nil
        connections[id] = nil
        relayHealth[id] = nil
        sessions = sessions.filter { $0.value.relayID != id }
        mesh.removeRelay(id: id)
    }

    /// Edit a relay's name/URL, then reconnect on the (possibly new) endpoint.
    /// Tears down the old connection first so a URL change takes effect.
    public func updateRelay(id: UUID, name: String, url: String) async {
        mesh.updateRelay(id: id, name: name, url: url)
        reconnectTasks[id]?.cancel()
        reconnectTasks[id] = nil
        reconnectAttempts[id] = nil
        connections[id] = nil
        relayHealth[id] = nil
        if let relay = mesh.config.relays.first(where: { $0.id == id }) {
            await connect(relay)
        }
    }

    func connectAll() async {
        // The demo relay is in-memory fixture playback — never a socket.
        for relay in mesh.config.relays where relay.id != Self.demoRelayID {
            await connect(relay)
        }
    }

    /// Home drag-to-refresh: re-request the rooms snapshot on every connected
    /// relay so a session whose `room_announced` push was missed still
    /// surfaces. The `.rooms` reconcile logs how many it recovered.
    func refreshRooms() async {
        for relay in mesh.config.relays {
            guard let connection = connections[relay.id] else { continue }
            let peers = mesh.config.machines(onRelay: relay.id).map(\.epk)
            try? await connection.refreshRooms(peers: peers)
        }
    }

    private func connect(_ relay: RelayConfig) async {
        // Insecure-transport notice (plan 01M14ZS3): plaintext ws:// relays are
        // user-specified — fine on localhost/Tailscale, risky elsewhere. One
        // warning per relay per app-run (not per reconnect).
        // Tailscale-only transports skip the warning: a `*.ts.net` MagicDNS
        // host resolves ONLY inside the tailnet, and 100.64.0.0/10 is the
        // Tailscale CGNAT range — both are private by construction.
        // Scheme + host via URLComponents — no replace-and-split string math
        // (the port-blind parse bug came from exactly that): the stored URL's
        // host and port are separate accessors, so the decisions below see
        // only the host.
        let parsed = URLComponents(string: relay.url)
        if let scheme = parsed?.scheme?.lowercased(), scheme == "ws" || scheme == "http",
           insecureRelayWarned.insert(relay.id).inserted {
            let host = (parsed?.host ?? "").lowercased()
            // NOTE: this block must NEVER `return` — it only selects whether a
            // notice is pushed. An early return here silently SKIPPED THE
            // CONNECTION for every private transport (the .ts.net skip was
            // disconnecting cascade entirely — "nothing shows in app at all").
            if host.isEmpty {
                // Unparseable/unknown transport — err on the side of warning.
                pushTransientNotice(
                    message: "Relay '\(relay.name)' is not TLS-encrypted — could not parse its URL.",
                    level: "warning")
            } else {
                let isPrivateTransport =
                    privateTransportSuffixes.contains(where: host.hasSuffix)
                    || isPrivateIPv4(host)
                    || !host.contains(".") || host == "localhost" || host == "127.0.0.1"
                if !isPrivateTransport {
                    pushTransientNotice(
                        message: "Relay '\(relay.name)' is not TLS-encrypted — fine on Tailscale/LAN, avoid on public networks.",
                        level: "warning")
                }
            }
        }
        guard let owner, let url = relay.webSocketURL else { return }
        reconnectTasks[relay.id]?.cancel()
        reconnectTasks[relay.id] = nil
        // SUPERSDE any previous connection/loop (run 2026-09-18: "every
        // chunk repeats"): two racing connect() paths (stream-end reconnect
        // × ping-heal × bootstrap) could leave TWO authenticated, subscribed
        // sockets live for the same relay — both event loops received the
        // same room frames → every delta folded TWICE. Now: the previous
        // connection is closed explicitly, its loop's stream ends, and the
        // loop's teardown guard (below) refuses to act for a superseded
        // connection. The generation token makes staleness decidable.
        connectionGeneration[relay.id, default: 0] += 1
        let generation = connectionGeneration[relay.id]!
        if let old = connections[relay.id] {
            connections[relay.id] = nil
            Task { await old.close() }
        }
        relayHealth[relay.id] = .connecting
        let channel = URLSessionWebSocketChannel(url: url)
        let connection = RelayConnection(channel: channel, identity: owner)
        do {
            try await connection.authenticate()
            let peers = mesh.config.machines(onRelay: relay.id).map(\.epk)
            try await connection.subscribe(peers: peers)
            // A newer connect() won while we authenticated — abandon this
        // connection (it would otherwise resurrect as a second live loop).
            guard connectionGeneration[relay.id] == generation else {
                Task { await connection.close() }
                return
            }
            connections[relay.id] = connection
            relayHealth[relay.id] = .online
            reconnectAttempts[relay.id] = 0
            startEventLoop(relayID: relay.id, connection: connection, generation: generation)
            // Recover every open session on this relay after a (re)connect: the
            // transcript (get_entries) + panels (session_sync). Idempotent, so a
            // first connect where nothing is open yet is a no-op.
            for session in openSessions.values where session.relayID == relay.id {
                await requestReconstruction(session, connection: connection)
            }
        } catch {
            relayHealth[relay.id] = .failed(String(describing: error))
            scheduleReconnect(relay)
        }
    }

    private func startEventLoop(relayID: UUID, connection: RelayConnection, generation: Int) {
        Task { @MainActor in
            let stream = await connection.events()
            for await frame in stream {
                handle(frame: frame, relayID: relayID)
            }
            // Stream ended = socket dropped. SUPERSEDED loops (a newer
            // connect() replaced this connection) must NOT tear down state
            // or schedule a reconnect — that would kill the LIVE connection's
            // registration and spawn duplicate loops (the doubling root
            // cause, run 2026-09-18).
            guard connectionGeneration[relayID] == generation else { return }
            guard relayHealth[relayID] != nil,
                  let relay = mesh.config.relays.first(where: { $0.id == relayID }) else { return }
            relayHealth[relayID] = .offline
            connections[relayID] = nil
            scheduleReconnect(relay)
        }
    }

    /// FOREGROUND HEAL (iOS silent socket death): backgrounding the app
    /// kills its WebSockets WITHOUT ending the receive stream — the event
    /// loop never notices, `relayHealth` stays `.online`, no reconnect
    /// fires, and an in-flight get_entries walk orphans ("backfill timed
    /// out", blank rows — run 2026-09-17). On scenePhase .active, PING every
    /// online relay: a failed/timed-out ping tears the connection down and
    /// schedules a reconnect (whose `connect` re-runs reconstruction for
    /// every open session — the walk completes from the cursor).
    public func healConnectionsOnForeground() {
        for (relayID, connection) in connections {
            guard relayHealth[relayID] == .online,
                  let relay = mesh.config.relays.first(where: { $0.id == relayID }) else { continue }
            Task { @MainActor [weak self] in
                do {
                    try await connection.ping(timeout: 5)
                } catch {
                    guard let self else { return }
                    log.notice("foreground heal: relay ping failed — reconnecting (\(relay.name, privacy: .public))")
                    await connection.close()
                    self.relayHealth[relayID] = .offline
                    self.connections[relayID] = nil
                    self.scheduleReconnect(relay)
                    return
                }
                // Ping SUCCEEDED — the socket survived, but a backgrounded app
                // can still have MISSED live frames without the socket dying,
                // leaving the open transcript stale until the user re-enters the
                // view. Backfill every OPEN session on this relay so it heals on
                // reactivation, matching a reconnect (get_entries `since: leafId`
                // — idempotent; session_sync re-pulls panels + name).
                //
                // INCLUDING mid-stream sessions (activeTurnID != nil), on purpose:
                // the worst case is we dropped mid-stream and NEVER got the
                // message_end — then the streamed bubble stays partial AND
                // activeTurnID is stuck "running" forever (the busy state is
                // driven off activeTurnID). A delta get_entries mid-turn is
                // routine here (it's exactly the delta walk fired on every real
                // message_end), so it can't corrupt a genuinely-live stream, and
                // for a dropped-end turn it pulls the AUTHORITATIVE completed
                // entry that replaces the streamed fragments.
                guard let self else { return }
                for session in self.openSessions.values where session.relayID == relayID {
                    // ONE backfill at a time (user 2026-09-04). If a walk is
                    // already IN FLIGHT for this session, do NOT kick a second:
                    // two concurrent walks share the key-based paging state, and
                    // the repeated-leaf breaker trips and marks the session
                    // backfilled PREMATURELY (incomplete) — the "fg race". A
                    // walk that got DROPPED/stalled is detected + retried from
                    // the cursor by the walk watchdog (scheduleWalkWatchdog),
                    // which is the authoritative drop-recovery; a dead socket is
                    // already handled by the ping-FAIL reconnect branch above.
                    // So here we only START a fresh backfill when none is
                    // running.
                    // Skip only a LIVE walk (a page arrived recently). A walk
                    // orphaned while backgrounded leaves activeWalks set but
                    // never pages again; its watchdog's 30s clock only advances
                    // in foreground (and may not survive the transition), so
                    // deferring strands the backfill until relaunch. Supersede a
                    // STALE walk: requestReconstruction assigns a NEW walkID, so
                    // the old walk's stragglers are non-current (walkID-gated)
                    // and its watchdog stands down on the id mismatch.
                    if let last = self.walkLastActivity[session.id],
                       Date().timeIntervalSince(last) < 15 { continue }
                    await self.requestReconstruction(session, connection: connection)
                }
            }
        }
    }

    /// Retry a relay with exponential backoff (1s→…→30s), replacing any
    /// pending timer for it. `bootstrap`/`connect` reset the attempt counter.
    private func scheduleReconnect(_ relay: RelayConfig) {
        let attempt = reconnectAttempts[relay.id] ?? 0
        reconnectAttempts[relay.id] = attempt + 1
        let delay = min(Self.reconnectBaseDelay * pow(2, Double(attempt)), Self.reconnectMaxDelay)
        reconnectTasks[relay.id]?.cancel()
        reconnectTasks[relay.id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self,
                  self.mesh.config.relays.contains(where: { $0.id == relay.id }) else { return }
            await self.connect(relay)
        }
    }

    // MARK: - Idle-machine (presence daemon) control

    /// The MACHINE-caps store key: relay + canonical epk. Daemon caps are a
    /// MACHINE property, NOT associated with a room (design 01M1813Q) — the
    /// control room is only the transport address used to reach the daemon.
    func machineCapsKey(relayID: UUID, epk: String) -> String {
        "\(relayID.uuidString):\(Base64.canonicalKey(epk) ?? epk)"
    }

    /// Daemon/machine caps for a paired machine, if we've pulled them.
    public func daemonPresence(for machine: PairedMachine) -> DaemonPresence? {
        daemonPresence[machineCapsKey(relayID: machine.relayID, epk: machine.epk)]
    }

    /// True when the machine's presence daemon advertised `cap` (e.g.
    /// `remote_launch`). Gates the idle-machine launch affordance.
    public func daemonSupports(_ cap: String, machine: PairedMachine) -> Bool {
        daemonPresence(for: machine)?.supports(cap) ?? false
    }

    /// Same caps store, for a FEDERATED machine: the store is keyed by
    /// (relay, epk) — the routing identity is all a machine ever is — so a
    /// federated peer's presence lands in the SAME slots.
    public func daemonPresence(federated fm: FederatedMachine) -> DaemonPresence? {
        daemonPresence[machineCapsKey(relayID: fm.relayID, epk: fm.epk)]
    }

    public func daemonSupports(_ cap: String, federated fm: FederatedMachine) -> Bool {
        // Caps come from the federated rooms themselves (no reply route for
        // app clients — see federatedMachineCaps on AppModel).
        federatedMachineCaps[fm.epk]?.contains(cap) ?? false
    }

    /// Federated machines known via one relay's peer list (display order).
    public func federatedMachines(onRelay relayID: UUID) -> [FederatedMachine] {
        federatedMachines.filter { $0.relayID == relayID }
    }

    /// Pull a machine's daemon caps: derive its control room and send a
    /// `presence_status` request there (design 01M1813Q). The daemon, if up,
    /// replies with { caps, hostname, backend } into the `daemonPresence` store.
    public func requestDaemonStatus(machine: PairedMachine) async {
        await requestDaemonStatus(relayID: machine.relayID, epk: machine.epk)
    }

    /// Same poll for a FEDERATED machine — same derived control room, same
    /// envelope; the local relay routes it to the peer relay that owns it.
    public func requestDaemonStatus(relayID: UUID, epk: String) async {
        guard let connection = connections[relayID],
              let room = Base64.deriveControlRoom(epk: epk) else { return }
        try? await connection.send(.presenceStatus(id: UUID().uuidString),
                                   toPeer: epk, room: room)
    }

    /// Launch a session on an IDLE machine (no live session needed): send
    /// `session_launch` to the machine's control room, where the presence daemon
    /// spawns it. The new session then appears via the normal room-announce
    /// discovery. The machine's `launch.backend` config decides the backend.
    ///
    /// `resume` relaunches a STORED pi session (from `listMachineSessions`)
    /// instead of starting fresh — the daemon passes `--session <path>` to pi.
    /// Either way the daemon spawns pi with `UNBIEN_LAUNCH_REQ = <request id>`
    /// and the extension echoes it in room_meta, so upsertSession can match the
    /// announcing room to THIS request and auto-open the chat (pending-
    /// MachineLaunches). Returns the request id (nil = not sent — no
    /// connection / no control room). Old daemons ignore the id and the launch
    /// still surfaces via plain discovery after the 60s backstop expires.
    @discardableResult
    public func launchOnMachine(cwd: String?, name: String?,
                                resume: String? = nil,
                                machine: PairedMachine) async -> String? {
        await launchOnMachine(cwd: cwd, name: name, resume: resume,
                              relayID: machine.relayID, epk: machine.epk)
    }

    /// The (relayID, epk) core the paired/federated overloads share — routing
    /// is all a machine ever is, and both resolve to these two facts.
    @discardableResult
    public func launchOnMachine(cwd: String?, name: String?, resume: String? = nil,
                                relayID: UUID, epk: String) async -> String? {
        guard let connection = connections[relayID],
              let room = Base64.deriveControlRoom(epk: epk) else { return nil }
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedResume = resume?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rid = UUID().uuidString
        pendingMachineLaunches[rid] = PendingMachineLaunch(
            machineKey: machineCapsKey(relayID: relayID, epk: epk),
            launchReq: rid)
        // Backstop: a launch that never comes live (daemon died mid-spawn,
        // spawn failed after the gate) must not hijack a LATER announce's
        // auto-open. Expire quietly — the session still surfaces via plain
        // discovery when/if it does announce.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            _ = self?.pendingMachineLaunches.removeValue(forKey: rid)
        }
        try? await connection.send(
            .sessionLaunch(id: rid, mode: nil,
                           cwd: (trimmedCwd?.isEmpty ?? true) ? nil : trimmedCwd,
                           name: (trimmedName?.isEmpty ?? true) ? nil : trimmedName,
                           resume: (trimmedResume?.isEmpty ?? true) ? nil : trimmedResume),
            toPeer: epk, room: room)
        return rid
    }

    /// List a machine's STORED pi sessions (resume flow): send `sessions_list`
    /// to its presence daemon's control room and await the correlated
    /// `sessions_list_result` (parked under the request id, resumed from
    /// handleUbFrame — same request/reply shape as `sendAwaitingReply`). A
    /// daemon `error` frame (unknown_peer / permission_denied / list_failed —
    /// none carry in_reply_to) fails the wait for THAT machine, so refusals
    /// surface as `.refused` instead of reading as "nothing stored". The
    /// returned listing distinguishes empty / refused / timeout — the sheet
    /// renders each truthfully (a pre-`session_resume` daemon never gets here:
    /// the affordance is cap-gated upstream).
    public func listMachineSessions(machine: PairedMachine,
                                    filter: String? = nil) async -> MachineSessionListing {
        await listMachineSessions(relayID: machine.relayID, epk: machine.epk, filter: filter)
    }

    /// The (relayID, epk) core, shared with FEDERATED machines — a listing is
    /// a machine question, so any known-routing machine answers the same
    /// (the local relay outer-forwards to the peer relay that owns it).
    public func listMachineSessions(relayID: UUID, epk: String,
                                    filter: String? = nil) async -> MachineSessionListing {
        guard let connection = connections[relayID],
              let room = Base64.deriveControlRoom(epk: epk) else {
            return .refused(code: nil, message: "machine not connected")
        }
        let rid = UUID().uuidString
        let peer = epk
        let reply: JSONValue? = await withCheckedContinuation { continuation in
            pendingSessionLists[rid] = (continuation, peer)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if let parked = self?.pendingSessionLists.removeValue(forKey: rid) {
                    parked.continuation.resume(returning: nil)
                }
            }
            Task { @MainActor [weak self] in
                do {
                    try await connection.send(
                        .sessionsList(id: rid, scope: "all", cwd: nil, filter: filter),
                        toPeer: peer, room: room)
                } catch {
                    if let parked = self?.pendingSessionLists.removeValue(forKey: rid) {
                        parked.continuation.resume(returning: nil)
                    }
                }
            }
        }
        // Timeout (or send failure): no reply landed.
        guard let reply else { return .timeout }
        // The daemon's error frame (unknown_peer / permission_denied /
        // list_failed) — resumed via the peer-error path in handleUbFrame.
        if reply["type"]?.stringValue == "error" {
            return .refused(code: reply["code"]?.stringValue,
                            message: reply["message"]?.stringValue)
        }
        guard let sessions = reply["sessions"]?.arrayValue else { return .timeout }
        return .listed(sessions.compactMap { s in
            guard let path = s["path"]?.stringValue,
                  let id = s["id"]?.stringValue else { return nil }
            return StoredMachineSession(
                path: path,
                id: id,
                name: s["name"]?.stringValue,
                summary: s["summary"]?.stringValue ?? "",
                cwd: s["cwd"]?.stringValue ?? "",
                modified: s["modified"]?.stringValue ?? "",
                messageCount: s["messageCount"]?.intValue ?? 0)
        })
    }

    // MARK: - Fork / clone / branch (carved from AppModel.swift — line cap)

    /// Fork from a conversation item (pre-release 2026-09-18). ctx.fork exists
    /// ONLY on the command context — so the app sends the STRUCTURED
    /// `session_fork` frame (ub plane) and the extension self-dispatches its
    /// registered `/unbien fork` command to reach a command ctx (the slash
    /// bootstrap is an extension implementation detail, not the app's job).
    /// Downstream is the verified switch machinery: session_shutdown broadcast
    /// → session_start{reason:"fork"} → the new session's room announces → a
    /// NEW tile appears with the forked history. Demo: no connection → no-op.
    func forkFromEntry(_ session: LiveSession, entryID: String) async {
        guard let connection = connections[session.relayID] else { return }
        let rid = UUID().uuidString
        // Remember the request so the extension's `forked_from_req` echo (on the
        // new session's first sync) auto-navigates us to the new tile.
        pendingForkReqs.insert(rid)
        // position "at": fork AT the tapped entry (keep up to and including it,
        // continue in a new session). pi's default "before" REQUIRES a user
        // message and THROWS on any other entry — but "Fork From Here" is offered
        // on assistant rows too, so "before" silently failed there (no new
        // session, no auto-nav). "at" is valid on any entry and matches the
        // "from here" intent.
        try? await connection.send(
            .sessionFork(id: rid, entryID: entryID, position: "at"),
            toPeer: session.peerEPK, room: session.roomID)
    }

    /// Clone a WHOLE session from the Home view (pi's `/clone`): fork AT the
    /// session's current leaf — a duplicate that continues from the current
    /// point in its own new session. Sources the leaf from the reducer's last
    /// known cursor; no-op if we don't have one yet (nothing to clone from).
    func cloneSession(_ session: LiveSession) async {
        guard !isDemo(session) else { return }
        guard let connection = connections[session.relayID] else { return }
        guard let leaf = envelopeReducers[session.id]?.leafId, !leaf.isEmpty else { return }
        let rid = UUID().uuidString
        pendingForkReqs.insert(rid)
        try? await connection.send(
            .sessionFork(id: rid, entryID: leaf, position: "at"),
            toPeer: session.peerEPK, room: session.roomID)
    }

    /// Branch from a conversation item — IN PLACE (AgentSession.navigateTree:
    /// same session file, the leaf moves; /tree semantics). The extension
    /// pushes the NEW leaf on the session_info channel the moment the
    /// navigate commits — race-free (a refetch from here could round-trip
    /// before the leaf moves) — and the app re-derives from that beacon. The
    /// composer prefills with the row's text (what navigateTree would hand
    /// back as editorText — sourced locally).
    func branchFromEntry(_ session: LiveSession, entryID: String, prefill: String?) async {
        guard let connection = connections[session.relayID] else { return }
        let rid = UUID().uuidString
        try? await connection.send(
            .sessionNavigate(id: rid, entryID: entryID),
            toPeer: session.peerEPK, room: session.roomID)
        if let prefill, !prefill.isEmpty {
            composerPrefill[session.id] = prefill
        }
    }
}

// MARK: - Room upsert (carved from AppModel+Inbound.swift — line cap): the
// single funnel every room listing / announce flows through, plus the launch
// auto-open matcher (resume flow). State stays on AppModel; this extension
// only routes it.
extension AppModel {
    func upsertSession(relayID: UUID, peer: String, room: RoomInfo) {
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
                                  parentRoomID: room.parent, subagentID: room.subagentID,
                                  startedAt: room.startedAt)
        session.peerRelay = room.peerRelay
        // Manual dismissal (plan 01M18X3B): an ended chat the user removed
        // stays hidden — a snapshot re-listing or re-announce is the room
        // LINGERING at the relay, not liveness. Only proof of life (a fresh
        // `ub hello`) or a genuine roomEnded clears the pin.
        if dismissedSessions[session.id] != nil { return }
        // Carry a known status across re-announce (reconnect/relaunch replays
        // room_announced); the pull below refreshes it.
        let isNewRoom = sessions[session.id] == nil
        session.status = sessions[session.id]?.status
        sessions[session.id] = session
        // Seed caps from the room announce (design 01M1SJDZ): the ub hello only
        // arrives on ATTACH, so pre-attach (Home) this is how End Chat learns
        // remote_terminate for a session you haven't opened. Seed-if-absent
        // only — the hello stays authoritative once attached. (is_daemon /
        // control rooms already returned above, so room.caps here is a session
        // cap set.)
        if capabilities[session.id] == nil, let caps = room.caps, !caps.isEmpty {
            capabilities[session.id] = Set(caps)
        }
        // FORK AUTO-NAV pull: a fork/clone is pending and a NEW room just
        // appeared — it may be the fork-born session. session_sync normally
        // fires only on openSession (view appear), which won't happen until the
        // user opens it, so proactively sync here to pull `forked_from_req` and
        // trigger the pop-to-root navigation without the user tapping in.
        if isNewRoom, !pendingForkReqs.isEmpty, let connection = connections[relayID] {
            let peerEPK = session.peerEPK
            let roomID = session.roomID
            Task { try? await connection.send(.sessionSync(id: UUID().uuidString, limit: nil),
                                              toPeer: peerEPK, room: roomID) }
        }
        // LAUNCH AUTO-NAV (resume flow): a machine-level launch/resume WE
        // requested and a NEW room on that machine just announced. The daemon
        // spawned pi with UNBIEN_LAUNCH_REQ = <our request id> and the
        // extension echoed it in room_meta (launchReq), so the match is
        // deterministic for BOTH new launches and resumes — no "which room is
        // it" race. Consumed once; the 60s backstop in launchOnMachine
        // expires a launch that never came live. Old daemons (no echo): the
        // pending entry times out quietly and the session still surfaces via
        // plain discovery — today's behavior.
        if isNewRoom, !pendingMachineLaunches.isEmpty {
            let mkey = machineCapsKey(relayID: relayID, epk: peer)
            if let reqID = room.launchReq,
               let pending = pendingMachineLaunches[reqID],
               pending.machineKey == mkey {
                pendingMachineLaunches[reqID] = nil
                // Append-on-top navigation (we launched from Home root), then
                // FULL reconstruction like the fork path: the announce alone
                // carries no transcript, so open the session now — openSession
                // is idempotent alongside TranscriptView's own .task.
                pendingSessionNav = session
                Task { await openSession(session) }
            }
        }
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

    /// Resolve a relay (peer, roomID) ROUTING tuple to the pi-sessionId state key
    /// (LiveSession.id) — for control frames keyed by roomID.
    func sessionKey(relayID: UUID, peer: String, roomID: String) -> String? {
        sessions.values.first {
            $0.relayID == relayID && $0.peerEPK == peer && $0.roomID == roomID
        }?.id
    }

    // MARK: - Transient notices (slash-command feedback; carved from AppModel.swift)

    /// Push a machine's transient notice: SHORT => auto-dismissing toast
    /// (capped at 3, 6s expiry — ephemeral signals, never records); LONG
    /// (multi-line command reports) => the output sheet — a 3-line 6-second
    /// toast is a truncated loss for a 20-line install summary.
    public func pushTransientNotice(message: String, level: String) {
        let notice = TransientNotice(message: message, level: level)
        let lineCount = message.split(separator: "\n", omittingEmptySubsequences: false).count
        if lineCount > 8 || message.count > 600 {
            outputSheet = notice
            return
        }
        withAnimation { transientNotifies.append(notice) }
        if transientNotifies.count > 3 {
            transientNotifies.removeFirst(transientNotifies.count - 3)
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            withAnimation {
                self?.transientNotifies.removeAll { $0.id == notice.id }
            }
        }
    }
}

/// Transports whose PLAINTEXT is private by NETWORK CONSTRUCTION: only
/// resolvable/reachable inside their mesh or LAN. A single-label host has
/// no public DNS; `.ts.net` is Tailscale MagicDNS; RFC1918/CGNAT ranges
/// are covered by isPrivateIPv4. EXTENSION POINT: user-suggested (2026-10)
/// — other tailnet/MagicDNS-style domains belong here; when a config file
/// for the app lands, drive this suffix set from it rather than changing
/// the literal.
private let privateTransportSuffixes: Set<String> = [".ts.net"]

/// True when `host` is a private-network address: Tailscale CGNAT
/// (100.64.0.0/10), RFC1918 private space (10/8, 172.16/12, 192.168/16).
/// Those IPs exist only inside private networks, so plaintext transport to
/// them is not a public expose.
private func isPrivateIPv4(_ host: String) -> Bool {
    let parts = ipv4Parts(host)
    guard parts.count == 4 else { return false }
    let (a, b) = (parts[0], parts[1])
    if a == 100 { return b >= 64 && b <= 127 } // Tailscale CGNAT
    if a == 10 { return true }                // RFC1918 10/8
    if a == 192, b == 168 { return true }     // RFC1918 192.168/16
    if a == 172 { return b >= 16 && b <= 31 } // RFC1918 172.16/12
    return false
}

private func ipv4Parts(_ host: String) -> [Int] {
    host.split(separator: ".").compactMap { Int($0) }
}


// Folding-surface helpers relocated from AppModel+Inbound.swift (line cap) —
// touch only non-private AppModel state, so an extension is safe.
extension AppModel {
    /// Surface a non-modal informational notice in a session's transcript.
    /// Used for extension_ui WARNING notifies (actionable - answer rejected /
    /// bridge TTL expired - but never sheet-worthy). Folds through the reducer
    /// so the row persists in its session like any other notice.
    func appendSessionNotice(key: String, code: String, message: String) {
        guard !message.isEmpty else { return }
        var reducer = envelopeReducers[key] ?? EnvelopeReducer()
        reducer.setHideReasoning(!showThinking)
        reducer.appendNotice(code: code, message: message)
        commitFold(key, reducer)
    }

    /// Retract a session's ended state (banner + input lock): the session was
    /// RESUMED - its room re-advertised and/or a fresh extension instance
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

// MARK: - message_end append-lag sync watch
extension AppModel {
    /// A sync-triggered walk terminalled with NO leaf advance past its
    /// baseline: the announced entry was not in the machine's log at fetch
    /// time (append lags message_end; no post-append hook exists). Re-issue
    /// the delta walk once the flush should have landed — bounded, so a
    /// genuinely dead fetch reverts to today's behavior. Clears on advance.
    func syncRetryIfLagging(key: String) {
        guard let baseline = syncWatch[key] else { return }
        if envelopeReducers[key]?.leafId != baseline {
            syncWatch[key] = nil
            syncRetries[key] = nil
            return
        }
        let n = syncRetries[key] ?? 0
        if n >= 2 {
            log.error("sync append-lag: entry still unfetched after \(n, privacy: .public) retries key=\(String(key.suffix(12)), privacy: .public)")
            syncWatch[key] = nil
            syncRetries[key] = nil
            return
        }
        syncRetries[key] = n + 1
        guard let s = sessions[key] else { return }
        log.notice("sync append-lag: re-walking in 400ms key=\(String(key.suffix(12)), privacy: .public) attempt=\(n + 1, privacy: .public)")
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, let s2 = self.sessions[key],
                  let conn = self.connections[s2.relayID] else { return }
            self.startDeltaWalk(s2, connection: conn, since: baseline)
        }
    }
}
