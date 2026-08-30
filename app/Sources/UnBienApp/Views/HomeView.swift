import SwiftUI
import UnBienCore

/// Home: relays with their live sessions, aggregated. Re-invocable add-relay
/// and pair actions (DESIGN §6, §12).
struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var fonts: FontLibrary
    @State private var showAddRelay = false
    @State private var pairingRelay: RelayConfig?
    @State private var settingsRelay: RelayConfig?
    @State private var showSettings = false
    @State private var launchTarget: LaunchTarget?
    @Environment(\.appTheme) private var theme

    var body: some View {
        NavigationStack {
            Group {
                if model.mesh.config.relays.isEmpty {
                    emptyState
                } else {
                    relayList
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    Button { showAddRelay = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .tint(theme.accent)
        .sheet(isPresented: $showSettings) {
            SettingsView().environmentObject(model).environmentObject(fonts)
        }
        .sheet(isPresented: $showAddRelay) {
            AddRelaySheet().environmentObject(model)
        }
        .sheet(item: $settingsRelay) { relay in
            RelaySettingsSheet(relay: relay).environmentObject(model)
        }
        .sheet(item: $pairingRelay) { relay in
            PairSheet(relay: relay).environmentObject(model)
        }
        // Launch a NEW session from Home. For a live session, remote_launch is a
        // room-scoped cap gated on that row's session (its room is a valid
        // carrier). For an IDLE machine (regime 2), the presence daemon answers
        // presence_status with its caps and the launch rides the control room.
        .sheet(item: $launchTarget) { target in
            LaunchSessionSheet(target: target).environmentObject(model)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No relays yet", systemImage: "antenna.radiowaves.left.and.right")
        } description: {
            Text("Add a relay to discover your machines' sessions.")
        } actions: {
            Button("Add relay") { showAddRelay = true }.buttonStyle(.borderedProminent)
        }
    }

    private var relayList: some View {
        List {
            ForEach(model.mesh.config.relays) { relay in
                Section {
                    let sessions = model.sessions(onRelay: relay.id)
                    // TEMP (user request): surface a machine-level daemon launch
                    // for EVERY paired machine, not only session-less ones, so a
                    // new session can be launched via the daemon even when the
                    // machine already has sessions running.
                    let launchMachines = model.mesh.config.machines(onRelay: relay.id)
                    if sessions.isEmpty && launchMachines.isEmpty {
                        Text("No live sessions — pair a machine or start Pi with un-bien.")
                            .font(.footnote).foregroundStyle(theme.secondaryText)
                    } else {
                        ForEach(sessions) { session in
                            NavigationLink(value: session) {
                                HStack {
                                    SessionRow(session: session)
                                    // A NEW-conversation launch on THIS machine.
                                    // remote_launch is a room-scoped cap and this
                                    // row's room is a valid carrier; borderless so
                                    // the tap doesn't trigger row navigation.
                                    if model.supports("remote_launch", session: session) {
                                        Spacer(minLength: 8)
                                        Button {
                                            launchTarget = .session(session)
                                        } label: {
                                            Image(systemName: "plus.circle")
                                                .imageScale(.large)
                                        }
                                        .buttonStyle(.borderless)
                                        .tint(theme.accent)
                                        .accessibilityLabel("New conversation on this machine")
                                    }
                                }
                            }
                        }
                        // Machine-level daemon launch (regime 2). TEMP: shown for
                        // every paired machine (not just idle) so it's reachable
                        // with sessions running. Pull the daemon's caps on appear;
                        // when it advertises remote_launch, launch via the control
                        // room.
                        ForEach(launchMachines) { machine in
                            HStack {
                                IdleMachineRow(machine: machine)
                                Spacer(minLength: 8)
                                if model.daemonSupports("remote_launch", machine: machine) {
                                    Button {
                                        launchTarget = .machine(machine)
                                    } label: {
                                        Image(systemName: "plus.circle").imageScale(.large)
                                    }
                                    .buttonStyle(.borderless)
                                    .tint(theme.accent)
                                    .accessibilityLabel("Launch a session on this idle machine")
                                } else {
                                    Image(systemName: "moon.zzz")
                                        .foregroundStyle(.tertiary)
                                        .accessibilityLabel("Idle — daemon status unknown")
                                }
                            }
                            .task {
                                // The daemon may start AFTER this row appears, so
                                // re-request until it answers (or the row scrolls
                                // away — .task auto-cancels). Stops once caps land.
                                while !Task.isCancelled,
                                      model.daemonPresence(for: machine) == nil {
                                    await model.requestDaemonStatus(machine: machine)
                                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                                }
                            }
                        }
                    }
                    Button {
                        pairingRelay = relay
                    } label: {
                        Label("Pair a machine", systemImage: "qrcode.viewfinder")
                    }
                    // Relay config (edit URL/name + remove) lives one level in,
                    // in the settings sheet — keeps the row calm and the
                    // destructive delete off the row.
                    Button {
                        settingsRelay = relay
                    } label: {
                        Label("Relay settings", systemImage: "gearshape")
                    }
                } header: {
                    RelayHeader(relay: relay, health: model.relayHealth[relay.id] ?? .offline)
                }
            }
        }
        .navigationDestination(for: LiveSession.self) { session in
            TranscriptView(session: session).environmentObject(model)
        }
    }
}

private struct RelayHeader: View {
    let relay: RelayConfig
    let health: RelayHealth

    var body: some View {
        HStack {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(relay.name)
            Spacer()
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var color: Color {
        switch health {
        case .online: return .green
        case .connecting: return .yellow
        case .offline: return .gray
        case .failed: return .red
        }
    }

    private var label: String {
        switch health {
        case .online: return "online"
        case .connecting: return "connecting…"
        case .offline: return "offline"
        case .failed: return "error"
        }
    }
}

private struct SessionRow: View {
    let session: LiveSession

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(session.name).font(.body)
            if let cwd = session.cwd {
                Text(cwd).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if let model = session.model {
                Text(model).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

/// A paired machine with no live session — its presence daemon (if up) answers
/// presence_status with launch caps + backend, shown here as the subtitle.
private struct IdleMachineRow: View {
    @EnvironmentObject var model: AppModel
    let machine: PairedMachine

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(machine.nickname ?? machine.hostname ?? "Machine").font(.body)
            Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private var subtitle: String {
        guard let d = model.daemonPresence(for: machine) else {
            return "checking for daemon…"
        }
        let host = d.hostname ?? machine.hostname
        let backend = d.backend.map { " · \($0)" } ?? ""
        return (host ?? "online") + backend
    }
}
