import SwiftUI
import UnBienCore

/// Start a new pi session on the paired machine (`session_launch`). Shown only
/// when the pi advertised the `remote_launch` capability. The launched session
/// appears in the list via the normal room-announce discovery.
struct LaunchSessionSheet: View {
    let session: LiveSession
    @EnvironmentObject var model: AppModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var cwd = ""
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Starts a new pi session on this machine using its configured backend (tmux or herdr). Set the backend in the machine's un-bien settings.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Folder") {
                    TextField("Working directory (defaults to session cwd)", text: $cwd)
                        .textFieldStyle(.plain)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #endif
                }
                Section("Name") {
                    TextField("Session name (optional)", text: $name)
                        .textFieldStyle(.plain)
                        #if os(iOS)
                        .autocorrectionDisabled()
                        #endif
                }
            }
            .formStyle(.grouped)
            .navigationTitle("New conversation")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Launch") {
                        Task { await model.launchSession(cwd: cwd, name: name, session: session) }
                        dismiss()
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 320)
        #endif
    }
}
