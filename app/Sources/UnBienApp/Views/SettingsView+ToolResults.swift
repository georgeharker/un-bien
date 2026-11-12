import SwiftUI
import UnBienCore

// Settings → Tool results: how each kind of tool card starts (open, preview,
// closed), and whether failed calls always open. A tap on a card still opens
// or closes it, and that is remembered per card.
extension SettingsView {
    var toolResultsSection: some View {
        Section {
            ForEach(ToolCategory.allCases, id: \.self) { category in
                Picker(Self.title(category), selection: disclosureBinding(category)) {
                    ForEach(ToolDisclosure.allCases, id: \.self) { disclosure in
                        Text(Self.title(disclosure)).tag(disclosure)
                    }
                }
            }
            Toggle("Always open failed calls", isOn: $model.toolDisplayPolicy.expandFailed)
        } header: {
            Text("Tool results")
        } footer: {
            Text("How each kind of tool card starts. Tap a card to open or close it.")
        }
    }

    private func disclosureBinding(_ category: ToolCategory) -> Binding<ToolDisclosure> {
        Binding(get: { model.toolDisplayPolicy[category] },
                set: { model.toolDisplayPolicy[category] = $0 })
    }

    static func title(_ category: ToolCategory) -> String {
        switch category {
        case .shell: return "Shell"
        case .reads: return "File reads"
        case .edits: return "Edits"
        case .writes: return "Writes"
        case .searches: return "Searches"
        case .codemode: return "Code mode"
        case .mcp: return "MCP"
        case .agents: return "Agents"
        case .web: return "Web"
        case .other: return "Other tools"
        }
    }

    static func title(_ disclosure: ToolDisclosure) -> String {
        switch disclosure {
        case .expanded: return "Open"
        case .preview: return "Preview"
        case .collapsed: return "Closed"
        }
    }
}
