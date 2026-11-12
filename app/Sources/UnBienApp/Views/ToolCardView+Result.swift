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
}

extension ToolCardView {
    /// The result section for `card`: its resolved face (ToolFaceResolver),
    /// laid out as parts. The call's input (diff / command / script / content)
    /// is drawn above it and is not part of this list.
    nonisolated static func resultParts(for card: ToolCard) -> [ToolResultPart] {
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
        parts += view.diagnostics.map(ToolResultPart.notice)
        return parts
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

    /// Draw the result parts (same budget and producers as the input side).
    @ViewBuilder func resultView(_ parts: [ToolResultPart]) -> some View {
        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
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
            }
        }
    }
}
