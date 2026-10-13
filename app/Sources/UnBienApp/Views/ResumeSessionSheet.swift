import SwiftUI
import UnBienCore

/// Which machine a resume sheet targets: a locally-paired machine or one
/// known through RELAY-TO-RELAY FEDERATION. Both resolve to the same routing
/// facts (relay + epk) — the listing/launch plumbing is identical.
enum ResumeTarget: Identifiable {
    case machine(PairedMachine)
    case federated(FederatedMachine)

    var id: String {
        switch self {
        case let .machine(m): return "resume:machine:\(m.id)"
        case let .federated(f): return "resume:federated:\(f.id)"
        }
    }
}

/// Pick a STORED pi session on a machine and relaunch it (`session_launch`
/// with `resume`). Opened from the machine row's long-press menu — the
/// machine-level counterpart of the launch chip (user UX decision
/// 2026-08-31). Lists via the daemon's `sessions_list` (pi's public
/// SessionManager, global scope, recency-sorted daemon-side), with the CLI's
/// type-to-filter semantics plus a sort picker. Picking a row launches it;
/// the resumed chat auto-opens via the UNBIEN_LAUNCH_REQ echo (upsertSession
/// matcher) — falling back to plain discovery on old daemons.
struct ResumeSessionSheet: View {
    let target: ResumeTarget
    @EnvironmentObject var model: AppModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    /// Both target shapes resolve to the same routing facts; the sheet body is
    /// deliberately target-agnostic beyond these two values.
    private var relayID: UUID {
        switch target {
        case let .machine(m): return m.relayID
        case let .federated(f): return f.relayID
        }
    }
    private var epk: String {
        switch target {
        case let .machine(m): return m.epk
        case let .federated(f): return f.epk
        }
    }
    /// Remote machines get the same federated adornment language as Home.
    private var pageTitle: String {
        switch target {
        case .machine: return "Resume session"
        case let .federated(f): return "Resume · \(f.name) (remote)"
        }
    }

    @State private var sessions: [StoredMachineSession] = []
    @State private var loadState: LoadState = .loading
    @State private var filterText = ""
    /// Sort key for the list. Recency is the daemon's native order (and the
    /// CLI's); name/messages are client-side re-sorts.
    @State private var sort: SortKey = .recency

    enum LoadState: Equatable { case loading, loaded, empty, failed(String) }
    enum SortKey: String, CaseIterable, Identifiable {
        case recency, name, messages
        var id: String { rawValue }
        var label: String {
            switch self {
            case .recency: return "Recent"
            case .name: return "Name"
            case .messages: return "Messages"
            }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch loadState {
                case .loading:
                    ProgressView("Listing stored sessions…")
                case .empty:
                    ContentUnavailableView(
                        "No stored sessions",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Sessions pi has saved on this machine appear here."))
                case .failed(let message):
                    ContentUnavailableView(
                        "Couldn't list sessions",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message))
                case .loaded:
                    sessionList
                }
            }
            .navigationTitle(pageTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Picker("Sort", selection: $sort) {
                            ForEach(SortKey.allCases) { key in
                                Text(key.label).tag(key)
                            }
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down")
                    }
                    .disabled(loadState != .loaded)
                }
            }
            .searchable(text: $filterText, prompt: "Filter sessions")
            .task { await load() }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 420)
        #endif
    }

    /// Filter over WHAT a person can see (name/summary/cwd — the CLI's
    /// substring semantics), then sort by the picked key.
    private var visible: [StoredMachineSession] {
        let needle = filterText.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = needle.isEmpty ? sessions : sessions.filter { s in
            "\(s.displayName) \(s.summary) \(s.cwd)".lowercased().contains(needle)
        }
        switch sort {
        case .recency:
            return filtered // daemon already sorts modified-descending
        case .name:
            return filtered.sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
        case .messages:
            return filtered.sorted { $0.messageCount > $1.messageCount }
        }
    }

    private var sessionList: some View {
        List {
            ForEach(visible) { s in
                Button {
                    Task { await resume(s) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(s.displayName)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(theme.text)
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            Text(Self.relTime(s.modified))
                            Text("·").foregroundStyle(theme.secondaryText)
                            Text("\(s.messageCount) msgs")
                            Text("·").foregroundStyle(theme.secondaryText)
                            // Global scope shows cwd per row — the
                            // disambiguator (same as the CLI picker).
                            Text(s.cwd)
                        }
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                        .lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
    }

    private func load() async {
        loadState = .loading
        switch await model.listMachineSessions(relayID: relayID, epk: epk) {
        case .listed(let listed):
            sessions = listed
            loadState = listed.isEmpty ? .empty : .loaded
        case .refused(let code, let message):
            // Truthful failure, not a lying "no sessions": the daemon
            // answered with its error frame (unknown_peer / permission_denied
            // / list_failed).
            let detail = [code, message].compactMap { $0 }.joined(separator: " — ")
            loadState = .failed(detail.isEmpty ? "the machine refused the listing." : detail)
        case .timeout:
            // The `session_resume` cap gate makes this rare — the daemon
            // advertised the cap, then died or stalled before answering.
            loadState = .failed(
                "no reply from the machine — is its launcher daemon still running?")
        }
    }

    private func resume(_ s: StoredMachineSession) async {
        dismiss()
        await model.launchOnMachine(cwd: s.cwd, name: nil, resume: s.path,
                                    relayID: relayID, epk: epk)
    }

    /// Compact relative-time label, mirroring the CLI picker's granularity.
    static func relTime(_ iso: String) -> String {
        guard let t = ISO8601DateFormatter().date(from: iso) else { return iso }
        let m = max(0, Int(Date().timeIntervalSince(t) / 60))
        if m < 1 { return "just now" }
        if m < 60 { return "\(m)m ago" }
        if m < 24 * 60 { return "\(m / 60)h ago" }
        return "\(m / (24 * 60))d ago"
    }
}
