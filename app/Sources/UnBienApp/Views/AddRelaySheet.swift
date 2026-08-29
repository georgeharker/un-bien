import SwiftUI

/// Re-invocable relay setup — add another relay at any time (DESIGN §6).
struct AddRelaySheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""

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
                    Text("The relay routes between your phone and your machines. "
                         + "You can add more than one.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Add relay")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let trimmed = url.trimmingCharacters(in: .whitespaces)
                        let label = name.isEmpty ? trimmed : name
                        Task { await model.addRelay(name: label, url: trimmed) }
                        dismiss()
                    }
                    .disabled(url.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
