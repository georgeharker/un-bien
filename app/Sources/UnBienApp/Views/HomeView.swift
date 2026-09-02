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
    @AppStorage("hideLaunchChipUntilDaemonUp") private var hideChipUntilDaemonUp = false
    /// Parents whose subagent children are folded away in the Home list. A parent
    /// is EXPANDED unless listed here, so children show by default.
    @State private var collapsed: Set<String> = []
    /// The session row currently under the pointer (macOS/iPad-trackpad
    /// hover), driving the Mail-pattern trailing trash on ENDED rows. See
    /// `sessionRow` — the guarded clear avoids the enter-B/exit-A race when
    /// moving the pointer directly between rows.
    @State private var hoverSessionID: String?
    /// Terminate confirm (plan [lifecycle][send]): the LIVE row whose RED
    /// trash was tapped, pending confirmation. The dialog guards the kill —
    /// a root-terminate exits the host process (the user's own Ctrl-C,
    /// fired remotely).
    @State private var killTarget: LiveSession?
    /// Nav stack path, so a subagents-panel tap (from a sheet over a pushed
    /// TranscriptView) can push the child session onto THIS stack.
    @State private var path = NavigationPath()
    @Environment(\.appTheme) private var theme

    var body: some View {
        NavigationStack(path: $path) {
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
                    // Explicit refresh: macOS has no pull-to-refresh gesture, so
                    // .refreshable (iOS pull) is invisible there. Button + ⌘R give
                    // a real affordance on every platform.
                    Button { Task { await model.refreshRooms() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .keyboardShortcut("r", modifiers: .command)
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    Button { showAddRelay = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .tint(theme.accent)
        // A subagents-panel tap sets this on the model; push it here (the panel
        // lives in a sheet and can't push the stack itself).
        .onChange(of: model.pendingSessionNav) { _, next in
            if let next {
                path.append(next)
                model.pendingSessionNav = nil
            }
        }
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
        // Launch a NEW session from Home — MACHINE-level only (user UX
        // decision 2026-08-31): the affordance is the machine row's chip, gated
        // on that machine's presence daemon (regime 2 control room). A machine
        // without the daemon offers no launch.
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
                    // The daemon/machine LAUNCH CHIP for each paired machine (the
                    // machine + its sessions are never hidden by this — only the
                    // launch chip). "Hide launch chip until daemon is up" drops the
                    // chips whose daemon hasn't answered yet, for a clean list.
                    let launchMachines = model.mesh.config.machines(onRelay: relay.id)
                    let visibleMachines = launchMachines.filter {
                        model.daemonPresence(for: $0) != nil || !hideChipUntilDaemonUp
                    }
                    if sessions.isEmpty && visibleMachines.isEmpty {
                        Text("No live sessions — pair a machine or start Pi with un-bien.")
                            .font(.footnote).foregroundStyle(theme.secondaryText)
                    } else {
                        // Top-level sessions, with subagent children nested under
                        // their parent (a distinct session each — the row just
                        // navigates to it). Nesting is behind a preference.
                        let top = sessions.filter { !$0.isSubagent }
                        let topIDs = Set(top.map(\.sessionID))
                        let kids: [String: [LiveSession]] = model.showSubagentsOnHome
                            ? Dictionary(grouping: sessions.filter(\.isSubagent),
                                         by: { $0.parentSessionID ?? "" })
                            : [:]
                        ForEach(top) { session in
                            let children = kids[session.sessionID] ?? []
                            sessionRow(session, hasChildren: !children.isEmpty)
                            if !children.isEmpty, !collapsed.contains(session.id) {
                                ForEach(children) { child in
                                    sessionRow(child, indented: true)
                                }
                            }
                        }
                        // Defensive: a subagent whose parent isn't listed here
                        // still appears (flat) when the toggle is on, never lost.
                        if model.showSubagentsOnHome {
                            let orphans = sessions.filter {
                                $0.isSubagent && !topIDs.contains($0.parentSessionID ?? "")
                            }
                            ForEach(orphans) { sessionRow($0) }
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
                    // destructive delete off the row. Neither button applies to
                    // the transient DEMO relay (nothing to pair against; removal
                    // is the Settings toggle's job).
                    if relay.id != AppModel.demoRelayID {
                        Button {
                            settingsRelay = relay
                        } label: {
                            Label("Relay settings", systemImage: "gearshape")
                        }
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
        // Drag-to-refresh: re-issue rooms_check on every connected relay so a
        // session whose room_announced push was missed still surfaces.
        .refreshable { await model.refreshRooms() }
        // Terminate confirm (plan [lifecycle][send]): ONE dialog at the List
        // level, keyed on killTarget — a per-row dialog inside List rows
        // fights the row gestures and duplicates N times. Presented by the
        // red hover trash (macOS), "End Chat…" (context menu, both
        // platforms), and the iOS swipe action on live rows.
        .confirmationDialog(
            killTarget.map { "End “\($0.name)”?" } ?? "",
            isPresented: Binding(
                get: { killTarget != nil },
                set: { if !$0 { killTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("End Chat", role: .destructive) {
                if let target = killTarget { model.terminate(target) }
                killTarget = nil
            }
            Button("Cancel", role: .cancel) { killTarget = nil }
        } message: {
            Text("This sends quit to the session on the machine. Its process exits and the chat leaves this list.")
        }
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

    /// One session row as a nav link (pushes its own TranscriptView). A parent
    /// with subagent children gets a fold-out chevron; a child is indented under
    /// it. Each row — parent or child — navigates to its own distinct session.
    @ViewBuilder
    private func sessionRow(_ session: LiveSession,
                           indented: Bool = false,
                           hasChildren: Bool = false) -> some View {
        NavigationLink(value: session) {
            HStack {
                // Leading slot (fixed width so rows align): a fold-out chevron on
                // a parent, a child marker on a nested row, else empty.
                if hasChildren {
                    Button {
                        toggleFold(session.id)
                    } label: {
                        Image(systemName: collapsed.contains(session.id)
                              ? "chevron.right" : "chevron.down")
                            .imageScale(.small)
                            .foregroundStyle(theme.secondaryText)
                            .frame(width: 16)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(collapsed.contains(session.id)
                                        ? "Show subagents" : "Hide subagents")
                } else if indented {
                    Image(systemName: "arrow.turn.down.right")
                        .imageScale(.small)
                        .foregroundStyle(theme.secondaryText)
                        .frame(width: 16)
                } else {
                    // Reserve the slot on childless top-level rows too — without
                    // this, a fold-out row's chevron shifts its title 16pt right
                    // of its siblings, which reads as nesting under the row above
                    // (real children always carry the ↳ marker on top of it).
                    Color.clear.frame(width: 16)
                }
                SessionRow(session: session)
                // A pending extension_ui ask for this session: the ask sheet only
                // presents INSIDE the open transcript, so without a row-level
                // affordance an ask that fires while the user is elsewhere in
                // the app is invisible (and if they answer on the machine, the
                // dismissal notify clears it silently — it never appears at
                // all). Badge the row so a waiting ask is discoverable from Home.
                if model.prompts[session.id] != nil {
                    Image(systemName: "questionmark.bubble.fill")
                        .imageScale(.medium)
                        .foregroundStyle(theme.accent)
                        .accessibilityLabel("This session is asking a question")
                }
                // Subagent lifecycle status as a glyph (done ✓ / failed / running),
                // pulled onto the child session via get_session_info (design 01M18PCM).
                if session.isSubagent, let status = session.status {
                    Image(systemName: subagentStatusIcon(status))
                        .imageScale(.medium)
                        .foregroundStyle(subagentStatusColor(status))
                        .accessibilityLabel("Subagent status: \(status)")
                }
                // Row remove/terminate (plan 01M18X3B + [lifecycle][send]).
                // macOS-only hover trash (user: don't register hover on iOS —
                // it's dead weight on touch and can only fight the scroll/
                // swipe recognizers; iOS surfaces are swipe + context menu).
                // ONE trash, TWO behaviors (user UX directive 2026-09-01):
                //   removable (ended / terminal subagent) -> quiet remove
                //     (secondaryText);
                //   LIVE + `remote_terminate` cap -> RED trash, tap asks for
                //     confirmation, then sends the terminate command (older
                //     forks without the cap show nothing).
                // Pinned to the TRAILING edge (user ask 2026-09-01): without
                // the spacer it sits right after the text, which crowds
                // mid-row and varies with the title. The slot is reserved
                // whenever either applies (opacity, not presence) so the row
                // doesn't reflow on hover.
                #if os(macOS)
                Spacer(minLength: 8)
                if model.isRemovable(session) {
                    hoverTrash(session, systemName: "trash",
                               color: theme.secondaryText, a11y: "Remove from list") {
                        model.removeEndedSession(session)
                    }
                } else if model.supports("remote_terminate", session: session) {
                    // LIVE row with a terminate-capable fork: RED kill trash —
                    // the tap asks before killing (root-terminate exits the
                    // host process; the user's own Ctrl-C, fired remotely).
                    hoverTrash(session, systemName: "trash.fill",
                               color: theme.error, a11y: "End this chat") {
                        killTarget = session
                    }
                }
                #endif
                // NOTE: no per-session launch chip — launch is MACHINE-level
                // only (user UX decision 2026-08-31): the affordance lives on
                // the machine row, gated on its presence daemon.
            }
            .padding(.leading, indented ? 16 : 0)
#if os(macOS)
            // Whole-ROW hover tracking (drives the trailing trash above):
            // attached to the row CONTENT, not the NavigationLink — macOS
            // doesn't reliably deliver onHover to NavigationLink rows in a
            // List, while the label HStack spans the row and does. Guarded
            // clear: SwiftUI can fire the next row's enter BEFORE this
            // row's exit, and an unguarded `= nil` would kill the fresh
            // hover. macOS only: on iOS this would fight the scroll/swipe
            // recognizers (user: don't register hover on iOS).
            .onHover { over in
                if over {
                    hoverSessionID = session.id
                } else if hoverSessionID == session.id {
                    hoverSessionID = nil
                }
            }
#endif
        }
        // Manual dismiss (plan 01M18X3B) + terminate ([lifecycle][send]).
        // Offered on a REMOVABLE row (watched-end / terminal subagent) as a
        // quiet remove, or on a LIVE row with a terminate-capable fork as
        // "End Chat…" (killTarget -> confirm dialog at the List level).
        // Never on a live row without the cap — a local hide would vanish a
        // running chat. Reappears only if the session proves live again
        // (fresh `ub hello` → resurrection in AppModel).
        // NOTE: swipe BEFORE contextMenu — on iOS the menu's long-press
        // recognizer otherwise wins over the horizontal drag and the swipe
        // reads as scrolling (user report 2026-09-01).
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if model.isRemovable(session) {
                Button(role: .destructive) {
                    model.removeEndedSession(session)
                } label: {
                    Label("Remove", systemImage: "trash")
                }
            } else if model.supports("remote_terminate", session: session) {
                // Kill needs an explicit tap (no full-swipe on a kill).
                Button(role: .destructive) {
                    killTarget = session
                } label: {
                    Label("End Chat…", systemImage: "trash.fill")
                }
            }
        }
        .contextMenu {
            if model.isRemovable(session) {
                Button(role: .destructive) {
                    model.removeEndedSession(session)
                } label: {
                    Label("Remove from List", systemImage: "trash")
                }
            } else if model.supports("remote_terminate", session: session) {
                Button(role: .destructive) {
                    killTarget = session
                } label: {
                    Label("End Chat…", systemImage: "trash.fill")
                }
            }
        }
    }

    /// The macOS hover-reveal trash (one helper, two variants — kills the
    /// jscpd duplicate the two inline buttons tripped): identical
    /// slot/fade/hit-target mechanics, differing glyph + color + action.
    /// Quiet remove (secondaryText) vs kill (red — caller routes through the
    /// List-level confirm dialog before terminating).
    private func hoverTrash(_ session: LiveSession, systemName: String,
                            color: Color, a11y: String,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .imageScale(.small)
                .foregroundStyle(color)
                // Roomier symmetric slot: air between the row text and the
                // can, a larger hit target, and an explicit frame keeps the
                // glyph centered — the borderless button's own content insets
                // otherwise sit it slightly off the row's optical center.
                .frame(width: 26, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)  // else the tap navigates too
        .opacity(hoverSessionID == session.id ? 1 : 0)
        .animation(.easeIn(duration: 0.12).delay(0.05),
                   value: hoverSessionID == session.id)
        .accessibilityLabel(a11y)
    }

    private func toggleFold(_ id: String) {
        if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
    }

    private func subagentStatusIcon(_ status: String) -> String {
        switch status {
        case "done", "completed": return "checkmark.circle.fill"
        case "failed", "error", "aborted", "stopped": return "xmark.octagon.fill"
        case "in_progress", "in-progress", "running", "started": return "gearshape.2.fill"
        case "steered": return "arrow.triangle.branch"
        case "compacted": return "arrow.triangle.merge"
        case "queued", "created": return "clock"
        default: return "clock"
        }
    }

    private func subagentStatusColor(_ status: String) -> Color {
        switch status {
        case "done", "completed": return theme.success
        case "failed", "error", "aborted", "stopped": return theme.error
        case "in_progress", "in-progress", "running", "started", "steered", "compacted": return theme.accent
        default: return theme.secondaryText
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
