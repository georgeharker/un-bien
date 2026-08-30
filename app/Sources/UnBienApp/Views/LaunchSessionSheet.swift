import SwiftUI
import UnBienCore

/// What a launch sheet targets: an existing session's machine (carrier room) or
/// an IDLE machine reached via its presence-daemon control room (regime 2).
enum LaunchTarget: Identifiable {
    case session(LiveSession)
    case machine(PairedMachine)

    var id: String {
        switch self {
        case let .session(s): return "session:\(s.id)"
        case let .machine(m): return "machine:\(m.id)"
        }
    }
}

/// Start a new pi session on a paired machine (`session_launch`). Shown only
/// when `remote_launch` is advertised — by a live session's hello (carrier
/// room) or an idle machine's presence daemon (control room). The launched
/// session appears in the list via the normal room-announce discovery.
struct LaunchSessionSheet: View {
    let target: LaunchTarget
    @EnvironmentObject var model: AppModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var cwd = ""
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(subtitle)
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
                        Task { await launch() }
                        dismiss()
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 320)
        #endif
    }

    private var subtitle: String {
        if case let .machine(m) = target, let backend = model.daemonPresence(for: m)?.backend {
            return "Starts a new pi session on this machine using \(backend)."
        }
        return "Starts a new pi session on this machine using its configured backend (tmux or herdr). Set the backend in the machine's un-bien settings."
    }

    private func launch() async {
        switch target {
        case let .session(s):
            await model.launchSession(cwd: cwd, name: name, session: s)
        case let .machine(m):
            await model.launchOnMachine(cwd: cwd, name: name, machine: m)
        }
    }
}
