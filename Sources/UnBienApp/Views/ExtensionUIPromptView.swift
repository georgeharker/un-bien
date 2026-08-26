import SwiftUI
import UnBienCore

/// Renders a pending `extension_ui_request` (ask_user via pi-ask) as a native
/// prompt and returns the `extension_ui_response` (DESIGN §4). Covers
/// select / confirm / input / editor / notify. `notify` is one-way (OK only).
struct ExtensionUIPromptView: View {
    let request: ExtensionUiRequest
    let onRespond: (ExtensionUiResponse) -> Void
    let onCancel: () -> Void

    @State private var textValue = ""
    private let theme = AppTheme.tokyoNight

    var body: some View {
        NavigationStack {
            Form {
                if let title = request.title, !title.isEmpty {
                    Section { Text(title).font(.headline) }
                }
                content
            }
            .navigationTitle(navTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                if request.method != .notify {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            onRespond(ExtensionUiResponse(id: request.id, cancelled: true))
                        }
                    }
                }
            }
            .onAppear { textValue = request.prefill ?? "" }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch request.method {
        case .select:
            Section {
                ForEach(request.options ?? [], id: \.self) { option in
                    Button(option) {
                        onRespond(ExtensionUiResponse(id: request.id, value: option))
                    }
                }
            }
        case .confirm:
            Section {
                if let message = request.message { Text(message) }
                HStack {
                    Button("No", role: .cancel) {
                        onRespond(ExtensionUiResponse(id: request.id, confirmed: false))
                    }
                    Spacer()
                    Button("Yes") {
                        onRespond(ExtensionUiResponse(id: request.id, confirmed: true))
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        case .input:
            Section {
                TextField(request.placeholder ?? "Enter a value", text: $textValue, axis: .vertical)
                submit
            }
        case .editor:
            Section {
                TextEditor(text: $textValue).frame(minHeight: 160)
                submit
            }
        case .notify:
            Section {
                if let message = request.message { Text(message) }
                Button("OK") { onCancel() }.buttonStyle(.borderedProminent)
            }
        }
    }

    private var submit: some View {
        Button("Submit") {
            onRespond(ExtensionUiResponse(id: request.id, value: textValue))
        }
        .buttonStyle(.borderedProminent)
        .disabled(textValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var navTitle: String {
        switch request.method {
        case .select: return "Choose"
        case .confirm: return "Confirm"
        case .input: return "Input"
        case .editor: return "Edit"
        case .notify: return "Notice"
        }
    }
}
