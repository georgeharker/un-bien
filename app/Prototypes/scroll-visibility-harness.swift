// Scroll VISIBILITY harness — onScrollVisibilityChange on a large NON-LAZY
// stack (the un-bien transcript layout shape). Questions:
//   Q1: Does visibility fire for rows visible at ATTACH (initial state), before
//       any scroll? (If not, we need a bootstrap for the near set.)
//   Q2: Event volume + correctness during a programmatic fast jump
//       (scrollPosition binding to a far row — the restore case).
//   Q3: Do detached rows re-fire on re-entry (hysteresis-free re-attach)?
//   Q4: Any gross per-frame cost with N=1000 (recompute-equivalent timing)?
//
// Run: swiftc -o /tmp/shv scroll-visibility-harness.swift -framework SwiftUI -framework AppKit && /tmp/shv

import SwiftUI
import os
import AppKit

let log = Logger(subsystem: "scroll-visibility-harness", category: "test")
func hlog(_ msg: String) {
    print(msg)
    log.info("\(msg, privacy: .public)")
}

struct Row: Identifiable, Hashable {
    let id: String
    let text: String
}

struct VisibilityHarnessView: View {
    @State private var rows: [Row] = (0..<1000).map { Row(id: "row-\($0)", text: "Row \($0)") }
    let sentinelID = "sentinel"
    @State private var scrollAnchor: String? = nil
    @State private var visibleIDs: Set<String> = []
    @State private var attachCount = 0
    @State private var detachCount = 0
    @State private var testResults: [String] = []
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("visible: \(visibleIDs.count)")
                    .font(.system(size: 11, design: .monospaced))
                Text("on: \(attachCount)  off: \(detachCount)")
                    .font(.system(size: 11, design: .monospaced))
                Text("binding: \(scrollAnchor ?? "nil")")
                    .font(.system(size: 11, design: .monospaced))
                Spacer()
            }
            .padding(8)
            .background(Color.gray.opacity(0.1))

            ScrollView {
                VStack(spacing: 8) {
                    ForEach(rows) { row in
                        Text(row.text)
                            .font(.system(size: 14, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Color.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                            .onScrollVisibilityChange(threshold: 0) { visible in
                                // Q1/Q3: track the visible set + counters.
                                if visible {
                                    visibleIDs.insert(row.id)
                                    attachCount += 1
                                } else {
                                    visibleIDs.remove(row.id)
                                    detachCount += 1
                                }
                            }
                    }
                    Text("⟨sentinel⟩")
                        .id(sentinelID)
                        .padding(.vertical, 4)
                }
                .padding()
                .scrollTargetLayout()
            }
            .scrollPosition(id: $scrollAnchor, anchor: .bottom)
        }
        .frame(width: 480, height: 700)
        .task { await runTest() }
    }

    func runTest() async {
        hlog("=== VISIBILITY HARNESS (N=\(rows.count)) ===")
        try? await Task.sleep(nanoseconds: 500_000_000)

        // Q1: initial visibility coverage before ANY scrolling.
        hlog("--- Q1: initial state (no scroll yet) ---")
        hlog("Q1: visible at attach: \(visibleIDs.count) rows (expect ~ viewport worth, e.g. 20-30)")
        testResults.append("Q1 initial-fire: \(visibleIDs.count > 0 ? "YES (\(visibleIDs.count))" : "NO (0)")")
        try? await Task.sleep(nanoseconds: 500_000_000)

        // Q2: programmatic far jump (the restore case) — count events + measure.
        hlog("--- Q2: binding jump to row-500 ---")
        attachCount = 0
        detachCount = 0
        let t0 = DispatchTime.now().uptimeNanoseconds
        scrollAnchor = "row-500"
        try? await Task.sleep(nanoseconds: 800_000_000)
        let dtMs = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
        let minVis = visibleIDs.map { Int($0.replacingOccurrences(of: "row-", with: "")) ?? -1 }.min() ?? -1
        let maxVis = visibleIDs.map { Int($0.replacingOccurrences(of: "row-", with: "")) ?? -1 }.max() ?? -1
        hlog("Q2: after jump — visible=\(visibleIDs.count) on=\(attachCount) off=\(detachCount) range=[\(minVis),\(maxVis)] in \(Int(dtMs))ms")
        testResults.append("Q2 jump events: on=\(attachCount) off=\(detachCount) settle=\(Int(dtMs))ms range=[\(minVis),\(maxVis)] (expect centered ~500)")

        // Q2b: rapid successive jumps (streaming-ish churn).
        hlog("--- Q2b: rapid jumps row-700 → row-300 → row-900 ---")
        attachCount = 0
        detachCount = 0
        scrollAnchor = "row-700"
        try? await Task.sleep(nanoseconds: 250_000_000)
        scrollAnchor = "row-300"
        try? await Task.sleep(nanoseconds: 250_000_000)
        scrollAnchor = "row-900"
        try? await Task.sleep(nanoseconds: 500_000_000)
        let min2 = visibleIDs.map { Int($0.replacingOccurrences(of: "row-", with: "")) ?? -1 }.min() ?? -1
        let max2 = visibleIDs.map { Int($0.replacingOccurrences(of: "row-", with: "")) ?? -1 }.max() ?? -1
        hlog("Q2b: visible=\(visibleIDs.count) on=\(attachCount) off=\(detachCount) range=[\(min2),\(max2)] (expect centered ~900)")
        testResults.append("Q2b rapid: visible=\(visibleIDs.count) range=[\(min2),\(max2)]")

        // Q3: re-entry — jump back to a previously visited region.
        hlog("--- Q3: re-entry to row-500 ---")
        attachCount = 0
        detachCount = 0
        scrollAnchor = "row-500"
        try? await Task.sleep(nanoseconds: 500_000_000)
        testResults.append("Q3 re-entry fires: on=\(attachCount) (expect >0 = re-attach works)")

        // Q4: sentinel bind (bottom) — the pinned case.
        hlog("--- Q4: bind sentinel (bottom) ---")
        scrollAnchor = sentinelID
        try? await Task.sleep(nanoseconds: 500_000_000)
        let min4 = visibleIDs.map { Int($0.replacingOccurrences(of: "row-", with: "")) ?? -1 }.min() ?? -1
        hlog("Q4: visible=\(visibleIDs.count) lowest=\(min4) (expect ~980+ = tail covered)")
        testResults.append("Q4 sentinel: visible=\(visibleIDs.count) lowest=\(min4)")

        hlog("=== RESULTS ===")
        for r in testResults { hlog(r) }
        hlog("=== DONE (drag around the window to sanity-check by hand) ===")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 480, height: 700),
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered, defer: false
)
window.contentView = NSHostingView(rootView: VisibilityHarnessView())
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
