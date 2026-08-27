import SwiftUI
import UniformTypeIdentifiers
import UnBienCore

/// Preferences: live theme picker, transcript options, connection/relay
/// management, and Owner-key sync (DESIGN §11, §12).
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var fonts: FontLibrary
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var showFontImporter = false
    @State private var fontError: String?
    @State private var fontPreview = "AaBbCc 0O1lI {}[]() => Meslo \u{2713}"

    var body: some View {
        NavigationStack {
            Form {
                appearanceSection
                typographySection
                transcriptSection
                syncSection
                identitySection
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 540, idealWidth: 580, minHeight: 540, idealHeight: 680)
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

    private var typographySection: some View {
        Section {
            HStack {
                Text("Text size")
                Slider(value: $model.textScale, in: 0.8...1.8, step: 0.05)
                Text(String(format: "%.0f%%", model.textScale * 100))
                    .font(.caption).monospacedDigit().foregroundStyle(theme.secondaryText)
            }
            Picker("Mono font", selection: $model.monoFontName) {
                Text("System Mono").tag(String?.none)
                ForEach(fonts.installedFamilies, id: \.self) { family in
                    Text(family).tag(String?.some(family))
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Preview").font(.caption).foregroundStyle(theme.secondaryText)
                TextField("Type to preview the font", text: $fontPreview, axis: .vertical)
                    .font(previewFont)
                    .textFieldStyle(.plain)
                    .lineLimit(1...3)
            }
            Button {
                showFontImporter = true
            } label: {
                Label("Import font…", systemImage: "square.and.arrow.down")
            }
            if let fontError {
                Text(fontError).font(.caption).foregroundStyle(theme.error)
            }
            Link(destination: URL(string: "https://www.nerdfonts.com/font-downloads")!) {
                Label("Get Meslo Nerd Font", systemImage: "arrow.up.right.square")
            }
        } header: {
            Text("Typography")
        } footer: {
            Text("Import a .ttf/.otf (e.g. MesloLGS NF) to use it for code and the composer.")
        }
        .fileImporter(isPresented: $showFontImporter,
                      allowedContentTypes: Self.fontContentTypes,
                      allowsMultipleSelection: true) { result in
            handleFontImport(result)
        }
    }

    /// `.font` covers ttf/otf, but include the concrete types so nothing is
    /// greyed out in the Files browser regardless of how a file is tagged.
    private static let fontContentTypes: [UTType] = [
        .font,
        UTType(filenameExtension: "ttf") ?? .font,
        UTType(filenameExtension: "otf") ?? .font,
    ]

    private func handleFontImport(_ result: Result<[URL], Error>) {
        fontError = nil
        do {
            let urls = try result.get()
            var firstAdded: String?
            for url in urls {
                let added = try fonts.importFont(from: url)
                if firstAdded == nil { firstAdded = added.first }
            }
            if let firstAdded { model.monoFontName = firstAdded }
        } catch {
            fontError = "Import failed: \(error.localizedDescription)"
        }
    }

    private var transcriptSection: some View {
        Section("Transcript") {
            Toggle("Show thinking", isOn: $model.showThinking)
        }
    }

    /// The mono font at the current scale, for the live preview box.
    private var previewFont: Font {
        let size = 14 * model.textScale
        if let name = model.monoFontName, !name.isEmpty { return .custom(name, fixedSize: size) }
        return .system(size: size, design: .monospaced)
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
}
