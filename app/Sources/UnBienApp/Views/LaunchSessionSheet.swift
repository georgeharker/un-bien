import SwiftUI
import UnBienCore

/// What a launch sheet targets: a paired machine, reached via its
/// presence-daemon control room (regime 2). MACHINE-level ONLY (user UX
/// decision 2026-08-31) — per-session launch chips are gone; the daemon is
/// the single launch surface.
enum LaunchTarget: Identifiable {
    case machine(PairedMachine)

    var id: String {
        switch self {
        case let .machine(m): return "machine:\(m.id)"
        }
    }
}

/// Start a new pi session on a paired machine (`session_launch` over its
/// presence-daemon control room). Shown when the machine's daemon advertises
/// `remote_launch`. The launched session appears in the list via the normal
/// room-announce discovery.
struct LaunchSessionSheet: View {
    let target: LaunchTarget
    @EnvironmentObject var model: AppModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var cwd = ""
    @State private var name = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                // Plain description text — NOT a Form cell. In a grouped Form a
                // `Section { Text }` renders as a rounded cell that looks just
                // like the editable fields below it (reads as an input). This
                // is a caption, so it lives above the Form.
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.top)
            Form {
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
            }
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
        #if os(iOS)
        // Contain the controls — a full-height sheet leaves an odd blank below
        // the two fields. A fitted height with .large as a drag-out valve if the
        // caption wraps.
        .presentationDetents([.height(340), .large])
        #endif
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
        if case let .machine(m) = target {
            await model.launchOnMachine(cwd: cwd, name: name, machine: m)
        }
    }
}
