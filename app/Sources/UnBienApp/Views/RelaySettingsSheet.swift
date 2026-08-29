import SwiftUI
import UnBienCore

/// Per-relay settings: edit the relay's name/URL, and (one level in, off the
/// row) remove it. Reached from the "Relay settings" gear next to Pair on the
/// home screen. Pairing stays inline on the row; edit + delete live here.
struct RelaySettingsSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let relay: RelayConfig
    @State private var name: String
    @State private var url: String
    @State private var confirmDelete = false

    init(relay: RelayConfig) {
        self.relay = relay
        _name = State(initialValue: relay.name)
        _url = State(initialValue: relay.url)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Relay") {
                    TextField("Name (e.g. Home)", text: $name)
                    TextField("URL (wss://… or https://…)", text: $url)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #endif
                }
                Section {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Label("Remove relay", systemImage: "trash")
                            .foregroundStyle(.red)
                    }
                } footer: {
                    Text("Removing a relay also drops the machines paired on it.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Relay settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmed = url.trimmingCharacters(in: .whitespaces)
                        let label = name.isEmpty ? trimmed : name
                        Task { await model.updateRelay(id: relay.id, name: label, url: trimmed) }
                        dismiss()
                    }
                    .disabled(url.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .confirmationDialog("Remove this relay?", isPresented: $confirmDelete,
                                titleVisibility: .visible) {
                Button("Remove relay", role: .destructive) {
                    model.removeRelay(id: relay.id)
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, idealWidth: 460, minHeight: 300)
        #endif
    }
}
