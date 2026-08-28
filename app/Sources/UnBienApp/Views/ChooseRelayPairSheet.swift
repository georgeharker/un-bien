import SwiftUI
import UnBienCore

/// Relay chooser for a pairing invite that arrived via the `unbien://` deep link
/// (system Camera or an external open). The QR carries no relay (DESIGN: `r`
/// dropped), so the user picks which configured relay to pair against — or adds
/// one first. Dismiss to cancel.
struct ChooseRelayPairSheet: View {
    let invite: PairingInvite
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var deviceName = defaultPairingDeviceName
    @State private var status: Status = .idle
    @State private var showAddRelay = false
    @State private var selectedRelayID: UUID?

    enum Status: Equatable {
        case idle, pairing, paired(String), error(String)
    }

    private var isPairing: Bool {
        if case .pairing = status { return true }
        return false
    }

    private var relays: [RelayConfig] { model.mesh.config.relays }

    /// The relay this machine (by `epk`) was last paired on, if any — used to
    /// preselect the likely target. The QR itself carries no relay.
    private var knownRelayID: UUID? {
        model.mesh.config.machines.first { $0.epk == invite.epk }?.relayID
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Pairing", value: invite.sessionName ?? "a machine")
                    TextField("This device's name", text: $deviceName)
                        #if os(iOS)
                        .textInputAutocapitalization(.words)
                        #endif
                }

                if model.mesh.config.relays.isEmpty {
                    Section {
                        Text("No relays yet. Add the relay this machine is on, "
                             + "then pair.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Add relay") { showAddRelay = true }
                    }
                } else {
                    Section("Choose relay") {
                        ForEach(relays) { relay in
                            Button {
                                selectedRelayID = relay.id
                            } label: {
                                HStack {
                                    Label(relay.name,
                                          systemImage: "antenna.radiowaves.left.and.right")
                                    if relay.id == knownRelayID {
                                        Text("last paired here")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if relay.id == selectedRelayID {
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(isPairing)
                        }
                    }
                }

                statusView
            }
            .navigationTitle("Pair a machine")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair") { pair() }
                        .disabled(selectedRelayID == nil || isPairing)
                }
            }
            .sheet(isPresented: $showAddRelay) {
                AddRelaySheet().environmentObject(model)
            }
            .onAppear {
                if selectedRelayID == nil {
                    selectedRelayID = knownRelayID ?? (relays.count == 1 ? relays.first?.id : nil)
                }
            }
        }
    }

    @ViewBuilder
    private var statusView: some View {
        switch status {
        case .idle:
            EmptyView()
        case .pairing:
            Label("Pairing…", systemImage: "hourglass")
        case let .paired(host):
            Label("Paired with \(host)", systemImage: "checkmark.seal.fill")
                .foregroundStyle(.green)
        case let .error(message):
            Label(message, systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
        }
    }

    private func pair() {
        guard let relay = relays.first(where: { $0.id == selectedRelayID }) else { return }
        status = .pairing
        Task {
            do {
                try await model.pair(relay: relay, invite: invite, deviceName: deviceName)
                status = .paired(invite.sessionName ?? "machine")
                try? await Task.sleep(nanoseconds: 700_000_000)
                dismiss()
            } catch {
                status = .error(pairFailureMessage(error))
            }
        }
    }
}
