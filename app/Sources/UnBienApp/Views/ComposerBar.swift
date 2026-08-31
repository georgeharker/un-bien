import SwiftUI
import UnBienCore

// The message input bar, split out of TranscriptView.swift (its 1000-line
// cap). Internal (not private) — TranscriptView (another file, same module)
// embeds it as the transcript's composer.

/// The message input bar. Owns its own `draft` so keystrokes re-render only
/// this small bar — not the whole transcript, whose `body` recomputes `items`
/// and diffs the entire message list on every evaluation.
struct ComposerBar: View {
    let session: LiveSession
    var onSent: () -> Void = {}
    @EnvironmentObject private var model: AppModel
    @Environment(\.appTheme) private var theme
    @Environment(\.typography) private var typography
    @State private var draft = ""

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var ended: Bool { model.hasEnded(session) }

    var body: some View {
        HStack(spacing: 8) {
            if model.activeTurnID(for: session) != nil {
                Button(role: .destructive) {
                    Task { await model.cancel(session) }
                } label: {
                    Image(systemName: "stop.circle.fill").font(.title2)
                }
            }
            MessageComposer(text: $draft, placeholder: ended ? "Session ended" : "Message",
                            font: typography.monoPlatformFont(size: typography.bodySize),
                            onSend: send)
                .padding(.horizontal, 6)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
                .disabled(ended)
            Button {
                guard !trimmed.isEmpty else { return }
                let text = trimmed
                draft = ""
                onSent()
                Task { await model.queueMessage(text, to: session) }
            } label: {
                Image(systemName: "tray.and.arrow.down").font(.title3)
            }
            .disabled(trimmed.isEmpty || ended)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(trimmed.isEmpty || ended)
        }
        .padding(10)
        .background(theme.background)
    }

    private func send() {
        let text = trimmed
        guard !text.isEmpty else { return }
        draft = ""
        onSent()
        Task { await model.sendMessage(text, to: session) }
    }
}
