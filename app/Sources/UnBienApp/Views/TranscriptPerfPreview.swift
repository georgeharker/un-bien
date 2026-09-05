import SwiftUI
import UnBienCore

#if DEBUG
/// Scroll-perf harness: a large synthetic transcript rendered exactly as the
/// live view (TranscriptRow + .equatable() in a LazyVStack), so scroll can be
/// profiled in Xcode / the simulator BEFORE the protocol data-feed exists.
/// (Extracted from TranscriptView.swift — that file crossed the swiftlint
/// file_length error threshold at 1000 lines.)
private struct TranscriptPerfPreview: View {
    private let theme = ThemeID.tokyoNight.theme
    private let typography = Typography()
    private let items: [TranscriptItem]

    init() {
        items = (0..<400).map { index in
            switch index % 4 {
            case 0:
                return .user(UserBubble(id: "u\(index)", text: "Question \(index): how do I do the thing?"))
            case 1:
                return .assistant(AssistantBubble(
                    id: "a\(index)", inReplyTo: "u\(index - 1)",
                    text: "Answer \(index): some **markdown** plus code.\n\n```swift\nlet value = \(index)\nprint(value)\n```\n",
                    streaming: false))
            case 2:
                return .tool(ToolCard(
                    toolCallID: "t\(index)", tool: "bash",
                    args: ["command": .string("echo \(index)")],
                    result: .string("output line \(index)"), state: .ok))
            default:
                return .reasoning(ReasoningBlock(id: "r\(index)", text: "Considering approach \(index)\u{2026}", streaming: false))
            }
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(items) { item in
                    TranscriptRow(item: item, themeID: .tokyoNight, theme: theme,
                                  typography: typography, expandRich: true, hideInputRich: true)
                        .equatable()
                        .environmentObject(CardUIState())
                        .id(item.id)
                }
            }
            .padding()
        }
        .background(theme.background)
    }
}

#Preview("Transcript scroll perf") { TranscriptPerfPreview() }
#endif
