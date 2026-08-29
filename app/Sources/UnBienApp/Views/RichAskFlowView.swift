import SwiftUI
import UnBienCore

/// Renders pi-ask's rich clarification flow (multi-question, single/multi/
/// preview, freeform, notes) and submits one structured `AskResponseEnrichment`
/// (DESIGN §4). Falls back to ``ExtensionUIPromptView`` when a prompt carries
/// no `ask` envelope.
struct RichAskFlowView: View {
    let flow: AskEnrichment
    let requestID: String
    let onRespond: (ExtensionUiResponse) -> Void

    @State private var selected: [String: Set<String>] = [:]
    @State private var customText: [String: String] = [:]
    @State private var notes: [String: String] = [:]
    @Environment(\.appTheme) private var theme

    var body: some View {
        NavigationStack {
            Form {
                ForEach(flow.questions) { question in
                    Section {
                        ForEach(question.options) { option in
                            optionRow(question: question, option: option)
                        }
                        if freeformSelected(question) {
                            TextField("Your answer", text: bindingCustom(question.id), axis: .vertical)
                        }
                        TextField("Add a note (optional)", text: bindingNote(question.id))
                            .font(.caption)
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(question.prompt).font(.callout.weight(.semibold))
                                .foregroundStyle(theme.text)
                            Text(hint(for: question)).font(.caption2).foregroundStyle(theme.secondaryText)
                        }
                    } footer: {
                        previewFooter(question)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(flow.title ?? "Questions")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        onRespond(.rich(id: requestID, enrichment: .cancel(flowID: flow.flowID)))
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit", action: submit).disabled(!canSubmit)
                }
            }
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private func optionRow(question: AskQuestion, option: AskOption) -> some View {
        let isSelected = selected[question.id]?.contains(option.value) ?? false
        Button {
            toggle(question: question, value: option.value)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol(question: question, selected: isSelected))
                    .foregroundStyle(isSelected ? theme.accent : theme.secondaryText)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).foregroundStyle(theme.text)
                    if let description = option.description {
                        Text(description).font(.caption).foregroundStyle(theme.secondaryText)
                    }
                }
                Spacer()
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func previewFooter(_ question: AskQuestion) -> some View {
        if question.effectiveType == .preview,
           let value = selected[question.id]?.first,
           let preview = question.options.first(where: { $0.value == value })?.preview {
            Text(preview).font(.system(.caption, design: .monospaced))
                .foregroundStyle(theme.secondaryText)
        }
    }

    // MARK: - State

    private func toggle(question: AskQuestion, value: String) {
        var set = selected[question.id] ?? []
        if question.effectiveType == .multi {
            if set.contains(value) { set.remove(value) } else { set.insert(value) }
        } else {
            set = [value]
        }
        selected[question.id] = set
    }

    private func freeformSelected(_ question: AskQuestion) -> Bool {
        guard let chosen = selected[question.id] else { return false }
        return question.options.contains { $0.freeform == true && chosen.contains($0.value) }
    }

    private func symbol(question: AskQuestion, selected: Bool) -> String {
        if question.effectiveType == .multi {
            return selected ? "checkmark.square.fill" : "square"
        }
        return selected ? "largecircle.fill.circle" : "circle"
    }

    private func hint(for question: AskQuestion) -> String {
        let base: String
        switch question.effectiveType {
        case .single, .preview: base = "Choose one"
        case .multi: base = "Choose any"
        }
        return question.required ? "\(base) · required" : base
    }

    private var canSubmit: Bool {
        flow.questions.allSatisfy { question in
            guard question.required else { return true }
            return !(selected[question.id]?.isEmpty ?? true)
        }
    }

    private func submit() {
        var answers: [String: AskAnswer] = [:]
        for question in flow.questions {
            let values = Array(selected[question.id] ?? [])
            let custom = customText[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines)
            let note = notes[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines)
            if values.isEmpty && (custom?.isEmpty ?? true) && (note?.isEmpty ?? true) { continue }
            answers[question.id] = AskAnswer(
                values: values.isEmpty ? nil : values,
                customText: (custom?.isEmpty ?? true) ? nil : custom,
                note: (note?.isEmpty ?? true) ? nil : note)
        }
        onRespond(.rich(id: requestID,
                        enrichment: .answer(flowID: flow.flowID, answers: answers)))
    }

    private func bindingCustom(_ id: String) -> Binding<String> {
        Binding(get: { customText[id] ?? "" }, set: { customText[id] = $0 })
    }

    private func bindingNote(_ id: String) -> Binding<String> {
        Binding(get: { notes[id] ?? "" }, set: { notes[id] = $0 })
    }
}
