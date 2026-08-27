import SwiftUI

/// A multiline chat composer where **Return sends** and **Shift+Return inserts
/// a newline**. Plain SwiftUI `TextField` can't distinguish the modifier, so we
/// wrap the platform text view and intercept the key. Grows with content up to
/// `maxHeight`, then scrolls.
struct MessageComposer: View {
    @Binding var text: String
    var placeholder: String = "Message"
    var maxHeight: CGFloat = 120
    /// Optional composer font (e.g. the chosen mono font). nil = system body.
    var font: PlatformFont?
    var onSend: () -> Void

    @State private var height: CGFloat = 36

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .allowsHitTesting(false)
            }
            ComposerTextView(text: $text, height: $height, maxHeight: maxHeight,
                             font: font, onSend: onSend)
                .frame(height: min(max(height, 36), maxHeight))
        }
    }
}

#if os(iOS)
import UIKit

private final class KeyingTextView: UITextView {
    var onSend: (() -> Void)?

    override var keyCommands: [UIKeyCommand]? {
        let send = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(sendAction))
        let newline = UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(newlineAction))
        if #available(iOS 15.0, *) { send.wantsPriorityOverSystemBehavior = true }
        return [send, newline]
    }

    @objc private func sendAction() { onSend?() }
    @objc private func newlineAction() { insertText("\n") }
}

private struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let maxHeight: CGFloat
    let font: UIFont?
    let onSend: () -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = KeyingTextView()
        view.onSend = onSend
        view.delegate = context.coordinator
        view.font = font ?? .preferredFont(forTextStyle: .body)
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 8, left: 2, bottom: 8, right: 2)
        view.isScrollEnabled = true
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        (view as? KeyingTextView)?.onSend = onSend
        let wanted = font ?? .preferredFont(forTextStyle: .body)
        if view.font != wanted { view.font = wanted }
        recalcHeight(view)
    }

    private func recalcHeight(_ view: UITextView) {
        let size = view.sizeThatFits(CGSize(width: view.bounds.width, height: .greatestFiniteMagnitude))
        // Only publish a real change — updating @State every render loops/janks.
        guard abs(height - size.height) > 0.5 else { return }
        DispatchQueue.main.async { height = size.height }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        let parent: ComposerTextView
        init(_ parent: ComposerTextView) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            let size = textView.sizeThatFits(
                CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude))
            parent.height = size.height
        }
    }
}
#elseif os(macOS)
import AppKit

private final class KeyingTextView: NSTextView {
    var onSend: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        // keyCode 36 = Return, 76 = keypad Enter.
        if event.keyCode == 36 || event.keyCode == 76 {
            if event.modifierFlags.contains(.shift) {
                super.keyDown(with: event) // Shift+Return → newline
            } else {
                onSend?()
            }
            return
        }
        super.keyDown(with: event)
    }
}

private struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let maxHeight: CGFloat
    let font: NSFont?
    let onSend: () -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let textView = KeyingTextView()
        textView.onSend = onSend
        textView.delegate = context.coordinator
        textView.font = font ?? .preferredFont(forTextStyle: .body)
        textView.drawsBackground = false
        textView.isRichText = false
        textView.textContainerInset = NSSize(width: 2, height: 8)
        textView.autoresizingMask = [.width]

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? KeyingTextView else { return }
        if textView.string != text { textView.string = text }
        textView.onSend = onSend
        let wanted = font ?? .preferredFont(forTextStyle: .body)
        if textView.font != wanted { textView.font = wanted }
        recalcHeight(textView)
    }

    private func recalcHeight(_ textView: NSTextView) {
        guard let container = textView.textContainer, let manager = textView.layoutManager else { return }
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container).height + 16
        guard abs(height - used) > 0.5 else { return }
        DispatchQueue.main.async { height = used }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        let parent: ComposerTextView
        init(_ parent: ComposerTextView) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}
#endif
