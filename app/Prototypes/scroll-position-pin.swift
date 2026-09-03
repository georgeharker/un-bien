// ScrollPosition INTERACTIVE Harness — the sentinel auto-bind pattern
// with real user input (drag/trackpad) and live readout.
//
// Run: swiftc -o /tmp/sh-interactive scroll-position-interactive.swift -framework SwiftUI -framework AppKit && /tmp/sh-interactive
//
// The harness:
//   - Binds scrollPosition to the sentinel (fixed id) with .bottom anchor
//   - On each content change while pinned: nil → sentinel re-trigger (the
//     working pattern from v6)
//   - You can drag/trackpad freely — the binding updates (two-way) and
//     the log shows every change
//   - "Add row" / "Add 10 rows" buttons trigger growth while you watch
//   - "Toggle pin" arms/disarms
//   - "Simulate user scroll" sets binding to a mid-transcript row
//   - Live status bar: binding, distance, phase, pin state
//
// Key things to observe:
//   1. While pinned + adding rows: does the view stay at bottom?
//   2. While pinned + you drag up: does the binding update? Does the pin disengage?
//   3. While you drag back down to bottom: does the binding re-read sentinel?
//   4. Does the auto-bind fight you while you're dragging?

import SwiftUI
import os
import AppKit

let log = os.Logger(subsystem: "scroll-harness-interactive", category: "test")

struct HarnessRow: Identifiable, Hashable {
    let id: String
    let text: String
}

struct InteractiveHarnessView: View {
    @State private var rows: [HarnessRow] = (0..<20).map { HarnessRow(id: "row-\($0)", text: "Row \($0)") }
    let sentinelID = "sentinel"
    @State private var scrollAnchor: String? = nil
    @State private var distanceFromBottom: Double = -1
    @State private var phaseCount: Int = 0
    @State private var isPinned: Bool = false
    @State private var autoRepinOnBottom: Bool = true   // NEW: re-arm when user settles at bottom
    @State private var nextRowNum: Int = 20

    var body: some View {
        VStack(spacing: 0) {
            // Status bar
            HStack(spacing: 12) {
                Text("binding: \(scrollAnchor ?? "nil")")
                    .font(.system(size: 11, design: .monospaced))
                    .frame(width: 100, alignment: .leading)
                Text("d: \(Int(distanceFromBottom))")
                    .font(.system(size: 11, design: .monospaced))
                    .frame(width: 60, alignment: .leading)
                Text("pin: \(isPinned ? "ON" : "OFF")")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(isPinned ? .green : .red)
                    .frame(width: 50, alignment: .leading)
                Text("phases: \(phaseCount)")
                    .font(.system(size: 11, design: .monospaced))
                    .frame(width: 60, alignment: .leading)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.gray.opacity(0.1))

            // Controls
            HStack(spacing: 8) {
                Button("+1 row") { addRows(1) }
                    .buttonStyle(.bordered)
                Button("+10 rows") { addRows(10) }
                    .buttonStyle(.bordered)
                Button("Toggle pin") { togglePin() }
                    .buttonStyle(.borderedProminent)
                Button("Simulate user scroll") { simulateUserScroll() }
                    .buttonStyle(.bordered)
                Toggle("Auto re-pin", isOn: $autoRepinOnBottom)
                    .font(.system(size: 11))
                    .toggleStyle(.checkbox)
                    .onChange(of: autoRepinOnBottom) { _, enabled in
                        // When the toggle turns ON, immediately check: am I
                        // at the sentinel right now? If so, prime the pin.
                        if enabled, !isPinned, scrollAnchor == sentinelID {
                            addLog("[TOGGLE RE-PIN] already at sentinel — arming")
                            isPinned = true
                        }
                        if !enabled, isPinned {
                            // When the toggle turns OFF, release the pin too
                            // (it was only armed by the auto path)
                            addLog("[TOGGLE] auto re-pin off — releasing")
                            isPinned = false
                            scrollAnchor = nil
                        }
                    }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            // The scroll view
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(rows) { row in
                        Text(row.text)
                            .font(.system(size: 14, weight: .medium, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(
                                row.text.contains("sentinel")
                                    ? Color.red.opacity(0.1)
                                    : Color.blue.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 6)
                            )
                    }
                    // Sentinel — fixed id, always last
                    Text("⟨sentinel⟩")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                        .id(sentinelID)
                }
                .padding()
                .scrollTargetLayout()
            }
            .scrollPosition(id: $scrollAnchor, anchor: .bottom)
            .onScrollGeometryChange(for: Double.self) { geo in
                geo.contentSize.height - geo.visibleRect.maxY
            } action: { _, d in
                distanceFromBottom = d
            }
            .onScrollPhaseChange { old, new in
                if new != .idle {
                    phaseCount += 1
                    addLog("[phase] \(old) → \(new)")
                }
                if new == .idle {
                    addLog("[phase] idle — binding=\(scrollAnchor ?? "nil") d=\(Int(distanceFromBottom))")
                    // AUTO RE-PIN: on scroll settle, if the binding reads the
                    // sentinel, the user is at the bottom — re-arm the pin.
                    if autoRepinOnBottom, !isPinned, scrollAnchor == sentinelID {
                        addLog("[AUTO RE-PIN] settled at sentinel — arming")
                        isPinned = true
                    }
                }
            }
            .onChange(of: scrollAnchor) { old, new in
                addLog("[BINDING] \(old ?? "nil") → \(new ?? "nil")")

                // USER INTENT DETECTION:
                // Our auto-bind only ever sets sentinel. If the binding
                // reads something else, the user scrolled there.
                if isPinned, new != sentinelID, new != nil {
                    addLog("[USER INTENT] binding moved to \(new ?? "?") — disarming")
                    isPinned = false
                    // Don't set scrollAnchor = nil — let the user's position stand
                }
            }
            // AUTO-BIND: on content change while pinned, re-trigger the sentinel
            .onChange(of: rows.count) { _, _ in
                guard isPinned else { return }
                retriggerSentinel()
            }
        }
        .frame(width: 500, height: 700)
        .background(.gray.opacity(0.05))
        .onAppear {
            addLog("=== INTERACTIVE HARNESS READY ===")
            addLog("Pin is OFF. Toggle to arm. Drag to scroll.")
        }
    }

    // MARK: - Actions

    func addRows(_ count: Int) {
        for _ in 0..<count {
            let label = nextRowNum % 5 == 0 ? "milestone" : "data"
            rows.append(HarnessRow(id: "row-\(nextRowNum)", text: "Row \(nextRowNum) [\(label)]"))
            nextRowNum += 1
        }
        addLog("[action] added \(count) rows (total: \(rows.count))")
    }

    func togglePin() {
        if isPinned {
            isPinned = false
            scrollAnchor = nil
            addLog("[action] pin OFF — released")
        } else {
            isPinned = true
            scrollAnchor = sentinelID
            addLog("[action] pin ON — bound to sentinel")
        }
    }

    func simulateUserScroll() {
        // Programmatically scroll to a mid-transcript row
        // This tests: does the binding update to that row? Does the
        // user-intent detection fire?
        let targetID = "row-5"
        addLog("[action] simulate user scroll to \(targetID)")
        scrollAnchor = targetID
    }

    func retriggerSentinel() {
        // The working pattern: nil → sentinel (two binding changes)
        scrollAnchor = nil
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 16_000_000)  // 1 frame
            scrollAnchor = sentinelID
        }
    }

    /// Harness log — os_log only (readable via Console / `log stream
    /// --predicate 'subsystem == "scroll-harness-interactive"'`).
    func addLog(_ msg: String) {
        log.info("\(msg, privacy: .public)")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let contentView = InteractiveHarnessView()
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 500, height: 700),
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered, defer: false
)
window.contentView = NSHostingView(rootView: contentView)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
