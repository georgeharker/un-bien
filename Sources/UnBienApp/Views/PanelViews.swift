import SwiftUI
import UnBienCore

/// Default SF Symbol for a panel key when the wire doesn't name one.
func panelSymbol(_ panel: PanelState) -> String {
    if let icon = panel.icon, !icon.isEmpty { return icon }
    switch panel.key {
    case "plan": return "checklist"
    case "subagents", "agents": return "person.2.badge.gearshape"
    default: return "square.grid.2x2"
    }
}

/// Hosts a panel by key — plan gets the wave/dep renderer; others fall back to
/// a generic list/JSON view.
struct PanelHostView: View {
    let panel: PanelState
    private let theme = AppTheme.tokyoNight

    var body: some View {
        NavigationStack {
            Group {
                switch panel.key {
                case "plan": PlanPanelView(items: PlanModel.items(from: panel.data))
                default: GenericPanelView(data: panel.data)
                }
            }
            .navigationTitle(panel.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
    }
}

/// Plan mirror: wave-ordered items with status icons, kind badges, and
/// blocked/dep indicators (mirrors pi-plan's render).
struct PlanPanelView: View {
    let items: [PlanItem]
    private let theme = AppTheme.tokyoNight

    private var rows: [PlanRow] { PlanModel.waveOrder(items) }

    var body: some View {
        List {
            if !summary.isEmpty {
                Section { Text(summary).font(.caption).foregroundStyle(theme.secondaryText) }
            }
            ForEach(rows) { row in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: statusIcon(row))
                        .foregroundStyle(statusColor(row))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.item.name)
                            .foregroundStyle(row.actionable ? theme.text : theme.secondaryText)
                            .fontWeight(row.actionable ? .semibold : .regular)
                        HStack(spacing: 6) {
                            if row.item.kind != "plan" {
                                Text(row.item.kind).font(.caption2)
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(theme.surface, in: Capsule())
                                    .foregroundStyle(theme.secondaryText)
                            }
                            if row.blockedCount > 0 {
                                Label("\(row.blockedCount)", systemImage: "hourglass")
                                    .font(.caption2).foregroundStyle(theme.secondaryText)
                            }
                            if row.circular {
                                Label("cycle", systemImage: "arrow.triangle.2.circlepath")
                                    .font(.caption2).foregroundStyle(theme.error)
                            }
                            if row.item.tainted == true {
                                Label("tainted", systemImage: "exclamationmark.triangle")
                                    .font(.caption2).foregroundStyle(theme.error)
                            }
                        }
                    }
                }
            }
        }
    }

    private var summary: String {
        var ready = 0, active = 0, blocked = 0, done = 0
        for row in rows {
            if row.item.status == "done" { done += 1 }
            else if row.item.status == "in_progress" || row.item.status == "in-progress" { active += 1 }
            else if row.actionable { ready += 1 }
            else if row.blockedCount > 0 { blocked += 1 }
        }
        var parts: [String] = []
        if ready > 0 { parts.append("\(ready) ready") }
        if active > 0 { parts.append("\(active) active") }
        if blocked > 0 { parts.append("\(blocked) blocked") }
        if done > 0 { parts.append("\(done) done") }
        return parts.joined(separator: " · ")
    }

    private func statusIcon(_ row: PlanRow) -> String {
        switch row.item.status {
        case "done": return "checkmark.circle.fill"
        case "in_progress", "in-progress": return "play.circle.fill"
        default: return row.actionable ? "circle" : "circle.dotted"
        }
    }

    private func statusColor(_ row: PlanRow) -> Color {
        switch row.item.status {
        case "done": return theme.success
        case "in_progress", "in-progress": return theme.accent
        default: return row.actionable ? theme.accent : theme.secondaryText
        }
    }
}

/// Fallback for panels without a bespoke renderer (e.g. subagents) — pretty JSON.
struct GenericPanelView: View {
    let data: JSONValue
    private let theme = AppTheme.tokyoNight

    var body: some View {
        ScrollView {
            Text(pretty)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(theme.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
    }

    private var pretty: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
        if let bytes = try? encoder.encode(data), let string = String(data: bytes, encoding: .utf8) {
            return string
        }
        return ""
    }
}
