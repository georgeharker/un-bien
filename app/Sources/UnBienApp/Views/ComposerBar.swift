import Combine
import SwiftUI
import UnBienCore

// The message input bar, split out of TranscriptView.swift (its 1000-line cap).

/// The NARROW, encapsulated slice the composer subscribes to — never the whole
/// AppModel. Exposes only the low-frequency chrome (turn state, lock, prefill) +
/// the send actions, so streaming content deltas can't re-render the input.
/// Design 01M20M1RQ8.
@MainActor
protocol ComposerChrome: ObservableObject {
    var turnActive: Bool { get }
    var ended: Bool { get }
    var demo: Bool { get }
    var prefill: String? { get }
    func consumePrefill()
    func send(_ text: String)
    func queue(_ text: String)
    func cancel()
}

/// AppModel-backed ComposerChrome for one session. It ABSORBS AppModel's general
/// churn — sinks objectWillChange, recomputes its four derived values (coalesced
/// to one pass per runloop), and republishes ONLY when one actually changes — so
/// the composer re-renders on turn/lock/prefill transitions, never on a streaming
/// delta (turnActive/ended derive from transcripts[sid], which republishes per
/// delta). Design 01M20M1RQ8.
@MainActor
final class SessionComposerChrome: ComposerChrome {
    @Published private(set) var turnActive = false
    @Published private(set) var ended = false
    @Published private(set) var demo = false
    @Published private(set) var prefill: String?

    private unowned let model: AppModel
    private let session: LiveSession
    private var cancellable: AnyCancellable?
    private var pending = false

    init(model: AppModel, session: LiveSession) {
        self.model = model
        self.session = session
        recompute()
        cancellable = model.objectWillChange.sink { [weak self] _ in
            self?.scheduleRecompute()
        }
    }

    /// objectWillChange fires BEFORE the mutation, so recompute on the next tick
    /// (post-change), coalescing a burst of deltas into a single cheap pass.
    private func scheduleRecompute() {
        guard !pending else { return }
        pending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            pending = false
            recompute()
        }
    }

    private func recompute() {
        let ta = model.activeTurnID(for: session) != nil
        let en = model.hasEnded(session)
        let dm = model.isDemo(session)
        let pf = model.composerPrefill[session.id]
        if ta != turnActive { turnActive = ta }
        if en != ended { ended = en }
        if dm != demo { demo = dm }
        if pf != prefill { prefill = pf }
    }

    func consumePrefill() { model.composerPrefill[session.id] = nil }
    func send(_ text: String) { Task { await model.sendMessage(text, to: session) } }
    func queue(_ text: String) { Task { await model.queueMessage(text, to: session) } }
    func cancel() { Task { await model.cancel(session) } }
}

/// The message input bar. Subscribes to an encapsulated `ComposerChrome`, not the
/// whole AppModel, and is `.equatable()` on the session id so the transcript's
/// per-delta body re-render diff-skips it — the focused TextField re-renders only
/// on a real chrome change (design 01M20M1RQ8). `draft` stays local so keystrokes
/// re-render only this bar.
struct ComposerBar<Chrome: ComposerChrome>: View, Equatable {
    let sessionID: String
    @ObservedObject var chrome: Chrome
    var onSent: () -> Void = {}
    @Environment(\.appTheme) private var theme
    @Environment(\.typography) private var typography
    @State private var draft = ""

    nonisolated static func == (l: ComposerBar, r: ComposerBar) -> Bool {
        l.sessionID == r.sessionID
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var locked: Bool { chrome.ended || chrome.demo }

    var body: some View {
        HStack(spacing: 8) {
            if chrome.turnActive {
                Button(role: .destructive) {
                    chrome.cancel()
                } label: {
                    Image(systemName: "stop.circle.fill").font(.title2)
                }
            }
            MessageComposer(text: $draft,
                            placeholder: chrome.ended ? "Session ended"
                                         : chrome.demo ? "Demo transcript — read-only" : "Message",
                            font: typography.monoPlatformFont(size: typography.bodySize),
                            onSend: send)
                .padding(.horizontal, 6)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
                // Branch From Here prefill: the selected message lands in the
                // composer (mirrors the TUI's /tree select-and-resubmit).
                // Consume-on-change (cleared → no-op).
                .onChange(of: chrome.prefill) { _, prefill in
                    if let prefill, !prefill.isEmpty {
                        draft = prefill
                        chrome.consumePrefill()
                    }
                }
                .disabled(locked)
            Button {
                guard !trimmed.isEmpty else { return }
                let text = trimmed
                draft = ""
                onSent()
                chrome.queue(text)
            } label: {
                Image(systemName: "tray.and.arrow.down").font(.title3)
            }
            .disabled(trimmed.isEmpty || locked)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(trimmed.isEmpty || locked)
        }
        .padding(10)
        .background(theme.background)
    }

    private func send() {
        let text = trimmed
        guard !text.isEmpty else { return }
        draft = ""
        onSent()
        chrome.send(text)
    }
}
