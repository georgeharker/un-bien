import SwiftUI
import UnBienCore

/// One piece of a tool card's RESULT section, in draw order. The card renders
/// these and the height estimator sums them, from the same list, so the two
/// cannot disagree about what a result shows (tool faces stage 3, design
/// 01M77YDWSZFD6WCYVFT3Z73SWJ).
enum ToolResultPart: Equatable, Sendable {
    /// A 9pt section label ("OUTPUT", "ERROR", "CALLS").
    case label(String)
    /// A one-line 9pt secondary row: a truncation / limit notice, a
    /// confirmation, a harness diagnostic.
    case notice(String)
    /// Plain mono text (shell output, search lines, tool text), unhighlighted.
    case mono(String)
    /// Plain mono text in the error color.
    case error(String)
    /// Highlighted code (a read file, codemode output); `face` keys its cache
    /// slot under the card.
    case code(String, lang: String?, face: String)
    /// A diff in the output (e.g. `git diff`); draws its own "DIFF" label.
    case diff([JSONValue], face: String)
    /// A Preview card's "N more lines" row: tapping it shows the result in full.
    case more(Int)
}

extension ToolCardView {
    /// Whether `card` draws its Preview result: its start state is Preview
    /// (Settings → Tool results) and the user hasn't asked for all of it.
    /// Shared by the card, the production estimate and prewarm, and the tests.
    static func startsPreviewing(_ card: ToolCard, policy: ToolDisplayPolicy, store: CardUIState) -> Bool {
        policy.disclosure(for: card) == .preview && !store.showsAll(card.toolCallID)
    }

    /// The result section for `card`: its resolved face (ToolFaceResolver),
    /// laid out as parts. The call's input (diff / command / script / content)
    /// is drawn above it and is not part of this list. `preview` shortens the
    /// main text to the tool's ToolPreview lines and adds a `.more` row.
    nonisolated static func resultParts(for card: ToolCard, preview: Bool = false) -> [ToolResultPart] {
        let parts = fullResultParts(for: card)
        return preview ? previewParts(parts, tool: card.tool) : parts
    }

    /// `parts` as a Preview card draws them: the main text (the last plain or
    /// highlighted part) cut to the tool's preview lines, with a `.more` row
    /// after it. Highlighted text takes its own cache slot (face "preview").
    /// Errors and diffs show whole.
    nonisolated static func previewParts(_ parts: [ToolResultPart], tool: String) -> [ToolResultPart] {
        let mainIndex = parts.lastIndex { part in
            switch part {
            case .mono, .code: return true
            default: return false
            }
        }
        guard let index = mainIndex else { return parts }
        let preview = ToolPreview.forTool(tool)
        var parts = parts
        switch parts[index] {
        case .mono(let text):
            let cut = preview.cut(text)
            guard cut.hidden > 0 else { return parts }
            parts[index] = .mono(cut.text)
            parts.insert(.more(cut.hidden), at: index + 1)
        case .code(let text, let lang, _):
            let cut = preview.cut(text)
            guard cut.hidden > 0 else { return parts }
            parts[index] = .code(cut.text, lang: lang, face: "preview")
            parts.insert(.more(cut.hidden), at: index + 1)
        default:
            break
        }
        return parts
    }

    nonisolated private static func fullResultParts(for card: ToolCard) -> [ToolResultPart] {
        let view = ToolFaceResolver.resolve(card)
        var parts: [ToolResultPart] = []
        switch view.face {
        case .pending:
            break
        case .terminal(let text, let notices, let diff):
            if let hunks = diff?["hunks"]?.arrayValue, !hunks.isEmpty {
                parts.append(.diff(hunks, face: "diff-out"))
            } else if !text.isEmpty {
                parts += [.label("output"), .mono(text)]
            }
            parts += notices.map(ToolResultPart.notice)
        case .file(let text, let lang, let notices):
            if !text.isEmpty { parts.append(.code(text, lang: lang, face: "output")) }
            parts += notices.map(ToolResultPart.notice)
        case .diff(_, let confirmation):
            // The diff itself is the input section (hunks(for:) reads the
            // record's patch first); the result is the success line.
            if let confirmation { parts.append(.notice(confirmation)) }
        case .confirmation(let line):
            if !line.isEmpty { parts.append(.notice(line)) }
        case .lines(let text, let notices):
            if !text.isEmpty { parts += [.label("output"), .mono(text)] }
            parts += notices.map(ToolResultPart.notice)
        case .script(let calls, let output):
            if !calls.isEmpty { parts += [.label("calls"), .mono(scriptCallLines(calls))] }
            if !output.isEmpty { parts += [.label("output"), .code(output, lang: nil, face: "output")] }
        case .error(let text):
            parts += [.label("error"), .error(text.isEmpty ? "The call failed." : text)]
        case .text(let text):
            if !text.isEmpty { parts += [.label("output"), .mono(text)] }
        }
        // Harness diagnostics as notice rows; a failed call's error lines are
        // already in its error text.
        let failed = card.state == .failed
        parts += view.diagnostics
            .filter { !(failed && ToolFaceResolver.errorMessage($0) != nil) }
            .map { .notice(ToolFaceResolver.noticeText($0)) }
        return parts
    }

    /// The cached renders the result section draws (highlighted code, output
    /// diffs), built EXACTLY as resultView builds them — same budget
    /// truncation and identity as `codeView` — so a warm hits the slot the
    /// card reads. Shared by the prewarm resolver and the height tests.
    static func resultProducers(for card: ToolCard, theme: AppTheme, typography: Typography,
                                themeID: ThemeID, preview: Bool = false) -> [any AttributedTextProducer] {
        resultParts(for: card, preview: preview).compactMap { part -> (any AttributedTextProducer)? in
            switch part {
            case .code(let text, let lang, let face):
                let truncated = text.count > toolBudget
                return HighlightProducer(
                    code: truncated ? String(text.prefix(toolBudget)) : text,
                    language: lang, style: theme.codeHighlightStyle,
                    font: typography.monoPlatformFont(),
                    identity: "\(card.toolCallID)\u{1}@\(face)" + (truncated ? "" : "-all"))
            case .diff(let hunks, let face):
                return DiffProducer(toolCallID: card.toolCallID, themeID: "\(themeID)", face: face,
                                    hunks: hunks, add: theme.success, remove: theme.error,
                                    context: theme.secondaryText)
            case .label, .notice, .mono, .error, .more:
                return nil
            }
        }
    }

    /// codemode's nested calls, one per line: status, name, args, duration.
    nonisolated static func scriptCallLines(_ calls: [ScriptCall]) -> String {
        calls.map { call in
            let mark: String
            switch call.status {
            case "ok": mark = "\u{2713}"
            case "error": mark = "\u{2717}"
            case "cancelled": mark = "\u{2298}"
            default: mark = "\u{2026}"
            }
            var line = "\(mark) \(call.name)"
            if !call.args.isEmpty { line += " \(call.args)" }
            if let ms = call.durationMs { line += ms < 1000 ? " \(ms)ms" : String(format: " %.1fs", Double(ms) / 1000) }
            if let error = call.error { line += "\n    \(error)" }
            return line
        }.joined(separator: "\n")
    }

    /// The parts grouped for drawing: a label travels with the part after it
    /// (one tight section, like `labeled`), every other part stands alone.
    nonisolated static func resultSections(_ parts: [ToolResultPart]) -> [[ToolResultPart]] {
        var sections: [[ToolResultPart]] = []
        var pendingLabel: ToolResultPart?
        for part in parts {
            if case .label = part {
                if let label = pendingLabel { sections.append([label]) }
                pendingLabel = part
            } else if let label = pendingLabel {
                sections.append([label, part])
                pendingLabel = nil
            } else {
                sections.append([part])
            }
        }
        if let label = pendingLabel { sections.append([label]) }
        return sections
    }

    /// Draw the result parts (same budget and producers as the input side).
    @ViewBuilder func resultView(_ parts: [ToolResultPart]) -> some View {
        ForEach(Array(Self.resultSections(parts).enumerated()), id: \.offset) { _, section in
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(section.enumerated()), id: \.offset) { _, part in
                    resultPartView(part)
                }
            }
        }
    }

    @ViewBuilder private func resultPartView(_ part: ToolResultPart) -> some View {
            switch part {
            case .label(let text):
                // Section-label row — natural height ≈ TranscriptMetrics
                // .toolCardSectionLabelHeight (ESTIMATE-ONLY constant).
                Text(text.uppercased()).font(.system(size: 9, weight: .bold))
                    .foregroundStyle(theme.secondaryText)
            case .notice(let text):
                // One row at the section-label height: never wraps.
                Text(text).font(.system(size: 9)).foregroundStyle(theme.secondaryText)
                    .lineLimit(1).truncationMode(.middle)
            case .mono(let text):
                BudgetedContent(text: text, budget: toolBudget) { budgeted in
                    Text(budgeted).foregroundStyle(theme.text).textSelection(.enabled)
                }
            case .error(let text):
                BudgetedContent(text: text, budget: toolBudget) { budgeted in
                    Text(budgeted).foregroundStyle(theme.error).textSelection(.enabled)
                }
            case .code(let text, let lang, let face):
                codeView(text, lang: lang, identity: "\(card.toolCallID)\u{1}@\(face)")
            case .diff(let hunks, let face):
                diffView(hunks, face: face)
            case .more(let hidden):
                // Drawn like BudgetedContent's SHOW ALL row (the estimator
                // counts both as one mono line).
                Button {
                    previewing = false
                } label: {
                    Label(hidden == 1 ? "1 more line" : "\(hidden) more lines", systemImage: "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.tint)
                }
                .buttonStyle(.borderless)
                .padding(.top, 2)
            }
    }
}
