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
    @AppStorage("hideMachinesWithoutDaemon") private var hideDaemonlessMachines = false
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
                    // A machine-level launch for every paired machine (not just
                    // idle ones). "Hide machines without a daemon" drops the ones
                    // whose daemon hasn't answered, for a clean list.
                    let launchMachines = model.mesh.config.machines(onRelay: relay.id)
                    let visibleMachines = launchMachines.filter {
                        model.daemonPresence(for: $0) != nil || !hideDaemonlessMachines
                    }
                    if sessions.isEmpty && visibleMachines.isEmpty {
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
                        // Machine-level launch (regime 2): its OWN row, styled
                        // distinctly from sessions (icon-led). Hidden when no
                        // daemon has answered if the setting is on. Polling runs
                        // list-level (see .task below) so a HIDDEN machine is still
                        // probed — else hide-until-up would never un-hide.
                        ForEach(visibleMachines) { machine in
                            MachineLaunchRow(machine: machine) {
                                launchTarget = .machine(machine)
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
        // Poll the presence daemon for EVERY paired machine, driven at the LIST
        // level (the machine entries), NOT per row — a machine hidden by "hide
        // machines without a daemon" has no row and no row .task, so row-driven
        // polling would never confirm its daemon and it'd stay hidden forever.
        .task { await pollDaemons() }
    }

    /// Probe each paired machine's presence daemon until it answers, regardless
    /// of row visibility. Stops probing a machine once its caps land; keeps
    /// sweeping the ones still unknown (daemon not up yet).
    private func pollDaemons() async {
        while !Task.isCancelled {
            for relay in model.mesh.config.relays {
                for machine in model.mesh.config.machines(onRelay: relay.id)
                where model.daemonPresence(for: machine) == nil {
                    await model.requestDaemonStatus(machine: machine)
                }
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
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

/// A paired machine's MACHINE-LEVEL launch — its own row, styled distinctly from
/// a session row (icon-led, muted). Pulls the presence daemon's caps on appear;
/// shows a "searching" spinner until the daemon answers, then a launch button
/// when it advertises `remote_launch`.
private struct MachineLaunchRow: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.appTheme) private var theme
    let machine: PairedMachine
    let onLaunch: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "desktopcomputer")
                .font(.title3)
                .foregroundStyle(theme.secondaryText)
            VStack(alignment: .leading, spacing: 2) {
                Text(machine.nickname ?? machine.hostname ?? "Machine")
                    .font(.subheadline.weight(.medium))
                Text(subtitle).font(.caption)
                    .foregroundStyle(theme.secondaryText).lineLimit(1)
            }
            Spacer(minLength: 8)
            if model.daemonSupports("remote_launch", machine: machine) {
                Button(action: onLaunch) {
                    Image(systemName: "plus.circle.fill").imageScale(.large)
                }
                .buttonStyle(.borderless)
                .tint(theme.accent)
                .accessibilityLabel("Launch a session on this machine")
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        guard let d = model.daemonPresence(for: machine) else { return "searching for daemon…" }
        let backend = d.backend.map { " · \($0)" } ?? ""
        return "ready to launch" + backend
    }
}
