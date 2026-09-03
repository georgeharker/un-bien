import Foundation
import os
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

    /// Pull a machine's daemon caps: derive its control room and send a
    /// `presence_status` request there (design 01M1813Q). The daemon, if up,
    /// replies with { caps, hostname, backend } into the `daemonPresence` store.
    public func requestDaemonStatus(machine: PairedMachine) async {
        guard let connection = connections[machine.relayID],
              let room = Base64.deriveControlRoom(epk: machine.epk) else { return }
        try? await connection.send(.presenceStatus(id: UUID().uuidString),
                                   toPeer: machine.epk, room: room)
    }

    /// Launch a session on an IDLE machine (no live session needed): send
    /// `session_launch` to the machine's control room, where the presence daemon
    /// spawns it. The new session then appears via the normal room-announce
    /// discovery. The machine's `launch.backend` config decides the backend.
    public func launchOnMachine(cwd: String?, name: String?, machine: PairedMachine) async {
        guard let connection = connections[machine.relayID],
              let room = Base64.deriveControlRoom(epk: machine.epk) else { return }
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        try? await connection.send(
            .sessionLaunch(id: UUID().uuidString, mode: nil,
                           cwd: (trimmedCwd?.isEmpty ?? true) ? nil : trimmedCwd,
                           name: (trimmedName?.isEmpty ?? true) ? nil : trimmedName),
            toPeer: machine.epk, room: room)
    }
}
