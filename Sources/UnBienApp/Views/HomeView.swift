import SwiftUI
import UnBienCore

/// Home: relays with their live sessions, aggregated. Re-invocable add-relay
/// and pair actions (DESIGN §6, §12).
struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var showAddRelay = false
    @State private var pairingRelay: RelayConfig?
    @State private var showSettings = false
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
            SettingsView().environmentObject(model)
        }
        .sheet(isPresented: $showAddRelay) {
            AddRelaySheet().environmentObject(model)
        }
        .sheet(item: $pairingRelay) { relay in
            PairSheet(relay: relay).environmentObject(model)
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
                    if sessions.isEmpty {
                        Text("No live sessions — pair a machine or start Pi with remote-pi.")
                            .font(.footnote).foregroundStyle(theme.secondaryText)
                    } else {
                        ForEach(sessions) { session in
                            NavigationLink(value: session) {
                                SessionRow(session: session)
                            }
                        }
                    }
                    Button {
                        pairingRelay = relay
                    } label: {
                        Label("Pair a machine", systemImage: "qrcode.viewfinder")
                    }
                    Button(role: .destructive) {
                        model.removeRelay(id: relay.id)
                    } label: {
                        Label("Remove relay", systemImage: "trash")
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
