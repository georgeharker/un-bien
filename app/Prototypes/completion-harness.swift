// COMPLETION HARNESS — mocks the REAL transcript machinery: husk rows,
// a window driver (registry + near set + identity anchor + window math),
// the scrollPosition binding rules, and the message lifecycle:
//   birth (pending row) → grow (streaming deltas) → complete (RE-KEY:
//   positional id → entry id, husk destroyed/reborn with fresh state).
//
// The question the scroll-position prototype could NOT answer:
//   Q1: Does the last row blank when it completes (id re-key → husk rebirth)?
//   Q2: What are the offsets doing — registry total vs RENDERED total vs
//       window center — before/after re-key, and after a far-row growth
//       (the divergence)?
//   Q3: Does the tail-anchored window keep the reborn husk near?
//
// Run: swiftc -o /tmp/shc completion-harness.swift -framework SwiftUI -framework AppKit && /tmp/shc

import SwiftUI
import os
import Combine
import AppKit

let log = Logger(subsystem: "completion-harness", category: "test")
func hlog(_ msg: String) {
    print(msg)
    log.info("\(msg, privacy: .public)")
}

// MARK: - Mini driver (faithful to TranscriptWindowDriver's anchor semantics)

@MainActor
final class MiniDriver: ObservableObject {
    nonisolated init() {}

    let flips = PassthroughSubject<(on: Set<Int>, off: Set<Int>), Never>()
    var order: [String] = []
    var heights: [String: Double] = [:]     // the REGISTRY (arithmetic coords)
    var near: Set<Int> = []
    var anchor: Anchor = .none
    var scrollY: Double?
    var viewportHeight: Double?
    var dirty = false
    let pages = 2.0, spacing = 8.0, fallback = 44.0

    enum Anchor: Equatable { case none, tail, row(String) }

    func update(anchorID: String) { anchor = .row(anchorID); dirty = true; recompute() }
    func updateTailAnchor() { anchor = .tail; dirty = true; recompute() }

    func sync(order new: [String]) {
        guard new != order else { return }
        order = new
        dirty = true
        recompute()
    }

    func record(id: String, height: Double) {
        guard height > 0, heights[id] != height else { return }
        heights[id] = height
        dirty = true
    }

    /// Faithful windowRangeAroundIndex: center always included; expand while
    /// budget lasts. Unmeasured rows count as `fallback` (over-inclusive).
    func window(center: Int) -> Range<Int> {
        guard !order.isEmpty, let vh = viewportHeight, vh > 0 else { return 0..<0 }
        let c = min(max(center, 0), order.count - 1)
        var last = c
        var budget = (1 + pages) * vh
        var i = c
        while i < order.count {
            let h = (heights[order[i]] ?? fallback) + spacing
            if i > c, budget < h { break }
            budget -= h
            last = i
            i += 1
        }
        var first = c
        var up = pages * vh
        i = c - 1
        while i >= 0 {
            let h = (heights[order[i]] ?? fallback) + spacing
            if up < h { break }
            up -= h
            first = i
            i -= 1
        }
        return first..<last + 1
    }

    func recompute() {
        guard viewportHeight != nil else { return }
        // Harness simplification: dirty-driven for BOTH paths (the real driver
        // keeps a geometric pre-anchor fallback; the canned sequence binds
        // the sentinel immediately, so it never engages here).
        guard dirty else { return }
        dirty = false
        let w: Range<Int>
        switch anchor {
        case .tail: w = window(center: order.count - 1)
        case .row(let id):
            if let c = order.firstIndex(of: id) { w = window(center: c) }
            else { return }                          // vanished: keep last window
        case .none: return
        }
        let newNear = Set(w)
        let on = newNear.subtracting(near)
        let off = near.subtracting(newNear)
        near = newNear
        if !on.isEmpty || !off.isEmpty { flips.send((on: on, off: off)) }
    }

    /// The bounds-cache SEED (persistence tier): pre-fill the registry —
    /// with whatever heights, including STALE ones (the divergence source).
    func seedHeights(_ seeded: [String: Double]) {
        for (id, h) in seeded where h > 0 { heights[id] = h }
        dirty = true
        recompute()
    }

    var registryTotal: Double {
        order.reduce(0) { $0 + (heights[$1] ?? fallback) + spacing }
    }
}

// MARK: - Rows

struct Msg: Identifiable {
    var id: String           // positional ("a1") or entry ("assistant:e1")
    var text: String
    var renderedHeight: Double   // the RENDERED truth (self-sized when near)
}

// MARK: - Husk (faithful: @State isNear + measuredHeight, registry claim)

struct Husk: View {
    let msg: Msg
    let index: Int
    @ObservedObject var driver: MiniDriver
    @State private var isNear: Bool
    @State private var measuredHeight: Double?

    init(msg: Msg, index: Int, driver: MiniDriver) {
        self.msg = msg
        self.index = index
        self.driver = driver
        _isNear = State(initialValue: driver.near.contains(index))
    }

    var body: some View {
        Group {
            if isNear {
                Text(msg.text)
                    .font(.system(size: 13, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    .background(
                        GeometryReader { geo in
                            Color.clear.onAppear { record(geo.size.height) }
                                .onChange(of: geo.size.height) { _, h in record(h) }
                        })
            } else {
                // Far husk: claims measuredHeight ?? REGISTRY ?? fallback.
                Color.clear
                    .frame(height: measuredHeight
                            ?? driver.heights[msg.id]
                            ?? driver.fallback)
                    .background(Color.red.opacity(0.18), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(Text("HUSK").font(.system(size: 8)).foregroundStyle(.red))
            }
        }
        .onReceive(driver.flips) { flip in
            if flip.on.contains(index) { isNear = true }
            else if flip.off.contains(index) { isNear = false }
        }
    }

    private func record(_ h: Double) {
        measuredHeight = h
        driver.record(id: msg.id, height: h)
    }
}

// MARK: - Harness view

struct CompletionHarnessView: View {
    @StateObject private var driver = MiniDriver()
    @State private var msgs: [Msg] = (0..<40).map {
        Msg(id: "a\($0)", text: "Row \($0) — \($0 % 3 == 0 ? "tall\nmulti\nline\ntext\nhere" : "short")", renderedHeight: 0)
    }
    @State private var nextSeq = 40
    @State private var entrySeq = 0
    let sentinelID = "sentinel"
    @State private var scrollAnchor: String? = nil
    @State private var renderedTotal: Double = 0   // RENDERED truth from geometry
    @State private var results: [String] = []

    var body: some View {
        VStack(spacing: 0) {
            // OFFSETS READOUT — the whole point: registry vs rendered vs window.
            HStack(spacing: 10) {
                Text("reg \(Int(driver.registryTotal))")
                    .foregroundStyle(abs(driver.registryTotal - renderedTotal) > 60 ? .red : .green)
                Text("ren \(Int(renderedTotal))")
                Text("near \(driver.near.count)")
                Text("anchor \(anchorLabel)")
                Spacer()
            }
            .font(.system(size: 10, design: .monospaced))
            .padding(6).background(Color.gray.opacity(0.12))

            HStack(spacing: 8) {
                Button("+1 row") { birth() }
                Button("Grow last") { growLast() }
                Button("Complete last (re-key)") { completeLast() }
                Button("Bind sentinel") { bindSentinel() }
                Spacer()
            }
            .padding(6)

            ScrollView {
                VStack(spacing: 8) {
                    ForEach(Array(msgs.enumerated()), id: \.element.id) { pair in
                        Husk(msg: pair.element, index: pair.offset, driver: driver)
                    }
                    Text("⟨sentinel⟩").id(sentinelID).padding(.vertical, 4)
                }
                .padding()
                .scrollTargetLayout()
            }
            .scrollPosition(id: $scrollAnchor, anchor: .bottom)
            .onScrollGeometryChange(for: Double.self) { geo in
                geo.contentSize.height
            } action: { _, total in
                renderedTotal = total
            }
            .onChange(of: scrollAnchor) { old, new in
                hlog("binding \(old ?? "nil") → \(new ?? "nil")")
                // The app's rule: nil KEEPS the anchor (bindBottom hop).
                if let new {
                    if new == sentinelID { driver.updateTailAnchor() }
                    else { driver.update(anchorID: new) }
                }
            }
        }
        .frame(width: 480, height: 720)
        .task { await runTest() }
    }

    private var anchorLabel: String {
        switch driver.anchor {
        case .none: return "none"
        case .tail: return "tail"
        case .row(let id): return "row:\(id.suffix(6))"
        }
    }

    // MARK: lifecycle events (faithful to the app's)

    func birth() {
        msgs.append(Msg(id: "a\(nextSeq)", text: "Row \(nextSeq) (pending)", renderedHeight: 0))
        nextSeq += 1
        driver.sync(order: msgs.map(\.id))
    }

    /// Streaming delta: the last row's text grows. (Near rows re-measure via
    /// the probe; the registry follows.)
    func growLast() {
        guard !msgs.isEmpty else { return }
        msgs[msgs.count - 1].text += "\n+ more streamed content"
        driver.sync(order: msgs.map(\.id))
    }

    /// message_end → delta get_entries → RE-KEY: the pending row's positional
    /// id becomes the entry id. The husk is DESTROYED and REBORN (ForEach
    /// identity), @State lost, registry height carried by the migration.
    func completeLast() {
        guard !msgs.isEmpty else { return }
        entrySeq += 1
        let oldID = msgs[msgs.count - 1].id
        let newID = "assistant:e\(entrySeq)"
        // Registry migration (the driver's re-key path).
        if let h = driver.heights[oldID] { driver.heights[newID] = h }
        driver.heights[oldID] = nil
        msgs[msgs.count - 1].id = newID
        driver.sync(order: msgs.map(\.id))
        hlog("RE-KEY \(oldID) → \(newID) (husk reborn)")
    }

    func bindSentinel() {
        scrollAnchor = sentinelID
    }

    // MARK: automated sequence

    func runTest() async {
        hlog("=== COMPLETION HARNESS ===")
        try? await Task.sleep(nanoseconds: 600_000_000)
        driver.viewportHeight = 620

        hlog("--- S0: SEED the registry with STALE heights (half real) ---")
        // The bounds-cache persistence tier, seeded wrong on purpose: every
        // row's registry height = 40 while the rendered rows are ~60-120 —
        // the local/global divergence in its purest form.
        var stale: [String: Double] = [:]
        for m in msgs { stale[m.id] = 40 }
        driver.seedHeights(stale)
        try? await Task.sleep(nanoseconds: 400_000_000)
        hlog("S0 seeded: \(statusLine()) (expect reg << ren — divergence planted)")
        results.append("S0 stale seed: \(statusLine())")

        hlog("--- S1: bind sentinel, birth 2 rows, grow ×3 ---")
        bindSentinel()
        try? await Task.sleep(nanoseconds: 400_000_000)
        birth(); try? await Task.sleep(nanoseconds: 200_000_000)
        birth(); try? await Task.sleep(nanoseconds: 200_000_000)
        for _ in 0..<3 { growLast(); try? await Task.sleep(nanoseconds: 150_000_000) }
        let beforeKey = statusLine()
        hlog("S1 before re-key: \(beforeKey)")
        results.append("S1 offsets: \(beforeKey)")

        hlog("--- S2: COMPLETE last (re-key) — does it blank? ---")
        let lastBefore = msgs.last!.id
        completeLast()
        try? await Task.sleep(nanoseconds: 600_000_000)
        let afterKey = statusLine()
        let lastIdx = msgs.count - 1
        let stillNear = driver.near.contains(lastIdx)
        hlog("S2 after re-key: \(afterKey) — last row near: \(stillNear)")
        results.append("S2 re-key: near=\(stillNear) \(afterKey) \(stillNear ? "(renders — NO blank)" : "(BLANK)")")

        hlog("--- S3: complete SECOND row back-to-back ---")
        completeLast()
        try? await Task.sleep(nanoseconds: 500_000_000)
        let s3 = statusLine()
        let near3 = driver.near.contains(msgs.count - 1)
        results.append("S3 back-to-back re-key: near=\(near3) \(s3)")

        hlog("=== RESULTS ===")
        for r in results { hlog(r) }
        hlog("=== DONE — drive it by hand: grow while scrolled up (divergence), re-key, watch reg vs ren ===")
    }

    func statusLine() -> String {
        "reg=\(Int(driver.registryTotal)) ren=\(Int(renderedTotal)) near=\(driver.near.count) anchor=\(anchorLabel) N=\(msgs.count)"
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 480, height: 720),
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered, defer: false
)
window.contentView = NSHostingView(rootView: CompletionHarnessView())
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
