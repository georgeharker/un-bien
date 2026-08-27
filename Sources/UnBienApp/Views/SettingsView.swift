import SwiftUI
import UnBienCore

/// Preferences: live theme picker, transcript options, connection/relay
/// management, and Owner-key sync (DESIGN §11, §12).
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var showAddRelay = false

    var body: some View {
        NavigationStack {
            Form {
                appearanceSection
                transcriptSection
                relaysSection
                syncSection
                identitySection
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showAddRelay) {
                AddRelaySheet().environmentObject(model)
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, idealWidth: 520, minHeight: 520, idealHeight: 640)
        #endif
    }

    private var appearanceSection: some View {
        Section("Appearance") {
            Picker("Theme", selection: $model.themeID) {
                ForEach(ThemeID.allCases) { id in
                    HStack(spacing: 8) {
                        swatch(id.theme)
                        Text(id.displayName)
                    }
                    .tag(id)
                }
            }
        }
    }

    private func swatch(_ palette: AppTheme) -> some View {
        HStack(spacing: 2) {
            ForEach([palette.background, palette.accent, palette.toolAccent, palette.success], id: \.self) { color in
                Rectangle().fill(color).frame(width: 10, height: 14)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(theme.secondaryText.opacity(0.4)))
    }

    private var transcriptSection: some View {
        Section("Transcript") {
            Toggle("Show thinking", isOn: $model.showThinking)
        }
    }

    private var relaysSection: some View {
        Section("Relays") {
            if model.mesh.config.relays.isEmpty {
                Text("No relays added.").foregroundStyle(theme.secondaryText)
            }
            ForEach(model.mesh.config.relays) { relay in
                HStack {
                    Circle().fill(healthColor(model.relayHealth[relay.id] ?? .offline))
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(relay.name)
                        Text(relay.url).font(.caption2).foregroundStyle(theme.secondaryText).lineLimit(1)
                    }
                    Spacer()
                    Button(role: .destructive) {
                        model.removeRelay(id: relay.id)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                }
            }
            Button {
                showAddRelay = true
            } label: {
                Label("Add relay", systemImage: "plus")
            }
        }
    }

    private var syncSection: some View {
        Section {
            Toggle("Sync Owner key via iCloud", isOn: $model.syncsToICloud)
        } header: {
            Text("Sync")
        } footer: {
            Text("The Owner key lives in the iOS Keychain. iCloud sync shares it across your devices.")
        }
    }

    private var identitySection: some View {
        Section("Identity") {
            LabeledContent("Owner key", value: model.needsOnboarding ? "Not set" : "Active")
        }
    }

    private func healthColor(_ health: RelayHealth) -> Color {
        switch health {
        case .online: return .green
        case .connecting: return .yellow
        case .offline: return .gray
        case .failed: return .red
        }
    }
}
