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
                case "subagents", "agents":
                    SubagentsPanelView(items: PlanModel.agentItems(from: panel.data))
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
    private var sections: [PlanModel.WaveSection] { PlanModel.waveSections(items) }

    var body: some View {
        List {
            if !summary.isEmpty {
                Section { Text(summary).font(.caption).foregroundStyle(theme.secondaryText) }
            }
            ForEach(sections) { section in
                Section(section.title) {
                    ForEach(section.rows) { row in
                        planRow(row)
                            .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                            .listRowBackground(Color.clear)
                    }
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
    }

    @ViewBuilder
    private func planRow(_ row: PlanRow) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: statusIcon(row))
                .foregroundStyle(statusColor(row))
                .font(.body)
            VStack(alignment: .leading, spacing: 4) {
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
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(cardTint(row), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(row.actionable ? theme.accent.opacity(0.5) : Color.clear, lineWidth: 1)
        )
    }

    /// A subtle status tint so cards read at a glance without shouting.
    private func cardTint(_ row: PlanRow) -> Color {
        if row.circular { return theme.error.opacity(0.12) }
        switch row.item.status {
        case "done": return theme.surface.opacity(0.5)
        case "in_progress", "in-progress": return theme.accent.opacity(0.12)
        default: return theme.surface
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

/// Subagents panel: one card per agent — status glyph, name, type badge, and
/// elapsed/started time. Mirrors pi-plan's Agents group (chronological).
struct SubagentsPanelView: View {
    let items: [PlanItem]
    private let theme = AppTheme.tokyoNight

    var body: some View {
        if items.isEmpty {
            ContentUnavailableView("No subagents", systemImage: "person.2")
        } else {
            List {
                if !summary.isEmpty {
                    Section { Text(summary).font(.caption).foregroundStyle(theme.secondaryText) }
                }
                Section {
                    ForEach(items) { item in
                        card(item)
                            .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                            .listRowBackground(Color.clear)
                    }
                }
            }
            #if os(iOS)
            .listStyle(.insetGrouped)
            #endif
        }
    }

    private var summary: String {
        var running = 0, done = 0, failed = 0
        for item in items {
            switch item.status {
            case "in_progress", "in-progress": running += 1
            case "done": done += 1
            case "failed": failed += 1
            default: break
            }
        }
        var parts: [String] = []
        if running > 0 { parts.append("\(running) running") }
        if done > 0 { parts.append("\(done) done") }
        if failed > 0 { parts.append("\(failed) failed") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func card(_ item: PlanItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon(item.status))
                .foregroundStyle(color(item.status))
                .font(.body)
                .symbolEffect(.pulse, isActive: item.status == "in_progress" || item.status == "in-progress")
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).foregroundStyle(theme.text).fontWeight(.medium)
                HStack(spacing: 6) {
                    if let type = item.agentType {
                        Text(type).font(.caption2)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(theme.surface, in: Capsule())
                            .foregroundStyle(theme.toolAccent)
                    }
                    if let started = startedText(item) {
                        Label(started, systemImage: "clock")
                            .font(.caption2).foregroundStyle(theme.secondaryText)
                    }
                    Text(statusLabel(item.status)).font(.caption2)
                        .foregroundStyle(color(item.status))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(tint(item.status), in: RoundedRectangle(cornerRadius: 12))
    }

    private func startedText(_ item: PlanItem) -> String? {
        guard let ms = item.startedAt, ms > 0 else { return nil }
        let date = Date(timeIntervalSince1970: ms / 1000)
        return date.formatted(date: .omitted, time: .shortened)
    }

    private func statusLabel(_ status: String?) -> String {
        switch status {
        case "in_progress", "in-progress": return "running"
        case "done": return "done"
        case "failed": return "failed"
        default: return status ?? "pending"
        }
    }

    private func icon(_ status: String?) -> String {
        switch status {
        case "done": return "checkmark.circle.fill"
        case "failed": return "xmark.octagon.fill"
        case "in_progress", "in-progress": return "gearshape.2.fill"
        default: return "clock"
        }
    }

    private func color(_ status: String?) -> Color {
        switch status {
        case "done": return theme.success
        case "failed": return theme.error
        case "in_progress", "in-progress": return theme.accent
        default: return theme.secondaryText
        }
    }

    private func tint(_ status: String?) -> Color {
        switch status {
        case "failed": return theme.error.opacity(0.12)
        case "in_progress", "in-progress": return theme.accent.opacity(0.12)
        case "done": return theme.surface.opacity(0.5)
        default: return theme.surface
        }
    }
}

/// Fallback for panels without a bespoke renderer (e.g. unknown keys) — pretty JSON.
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
