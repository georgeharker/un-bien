// PERF HARNESS (L3) — duplicated from completion-harness.swift (L2) and
// modified. Proves the pre-submission perf tranche IN ISOLATION before app
// integration, per the layered-prototype methodology (L1 pin → L2 machinery
// → L3 perf):
//
//   P1 WIDTH-CLASSED HEIGHTS: two slots per row (compact/regular). Rotation
//      becomes a SELECT (the other slot's heights are already there) instead
//      of an invalidate-everything. reg(a) vs reg(b) in the readout.
//   P2 HYSTERESIS WINDOW: attach at `attachPages`, keep until beyond
//      `detachPages` — edge rows stop flapping during measurement cascades.
//      The on/off EVENT COUNT is the proof metric (compare with hysteresis
//      off).
//   P3 RECOMPUTE COALESCING: records mark dirty; the recompute commits once
//      per tick instead of per record. Flip count is the proof metric.
//   P4 ROTATION SELECT: rotate → class 1 (unmeasured → fallback, divergence
//      visible), measure a bit, rotate BACK → class 0 heights INSTANT (the
//      win: no invalidate, no re-measure cascade).
//
// Run: swiftc -o /tmp/shp perf-harness.swift -framework SwiftUI -framework AppKit && stdbuf -oL /tmp/shp

import SwiftUI
import os
import Combine
import AppKit

let log = Logger(subsystem: "perf-harness", category: "test")
func hlog(_ msg: String) {
    print(msg)
    log.info("\(msg, privacy: .public)")
}

// MARK: - L3 mini driver: two-slot heights + hysteresis + coalescing

@MainActor
final class MiniDriver: ObservableObject {
    nonisolated init() {}

    let flips = PassthroughSubject<(on: Set<Int>, off: Set<Int>), Never>()
    var order: [String] = []
    /// HEIGHTS AS A FUNCTION OF WIDTH (user 2026-09-18: "it's not two"):
    /// per row, sampled at the widths actually observed — rotation is just
    /// two far-apart samples; Mac's continuous resizes add more. Lookup takes
    /// the NEAREST sampled width within a tolerance, else the flat fallback.
    /// Bucket widths (40pt) so float noise and micro-resizes don't spawn
    /// entries. Memory: a few floats per row.
    var heights: [String: [Double: Double]] = [:]
    var near: Set<Int> = []
    var anchor: Anchor = .none
    var viewportHeight: Double?
    var currentWidth: Double = 480          // the width AT which rows measure
    var dirty = false
    let spacing = 8.0, fallback = 44.0
    static let widthBucket: Double = 40
    static let widthTolerance: Double = 100
    /// HYSTERESIS: attach within `attachPages` of the anchor, keep until
    /// beyond `detachPages`.
    var attachPages = 2.0
    var detachPages = 3.0
    var hysteresisEnabled = true

    /// Proof metrics: flip event counts (the flap the user SAW).
    var flipOnCount = 0
    var flipOffCount = 0

    enum Anchor: Equatable { case none, tail, row(String) }

    // MARK: height sampling

    func record(id: String, height: Double) {
        guard height > 0 else { return }
        let key = Self.bucket(currentWidth)
        var samples = heights[id] ?? [:]
        if samples[key] == height { return }
        samples[key] = height
        heights[id] = samples
        markDirty()                        // P3: mark, don't recompute yet
    }

    static func bucket(_ w: Double) -> Double {
        (w / widthBucket).rounded() * widthBucket
    }

    /// The height for the NEAREST sampled width (within tolerance), else the
    /// flat fallback. Rotation = a far sample that's exact; a nearby Mac
    /// resize = a close approximation that converges on measure.
    func knownHeight(for id: String) -> Double? {
        guard let samples = heights[id], !samples.isEmpty else { return nil }
        let w = Self.bucket(currentWidth)
        let nearest = samples.min { abs($0.key - w) < abs($1.key - w) }
        guard let nearest, abs(nearest.key - w) <= Self.widthTolerance else { return nil }
        return nearest.value
    }

    // MARK: anchors + order

    func update(anchorID: String) { anchor = .row(anchorID); dirty = true; commit() }
    func updateTailAnchor() { anchor = .tail; dirty = true; commit() }

    func sync(order new: [String]) {
        guard new != order else { return }
        // re-key migration across BOTH slots.
        if new.count == order.count {
            for (i, newID) in new.enumerated() where newID != order[i] {
                if let h = heights.removeValue(forKey: order[i]) { heights[newID] = h }
            }
        }
        order = new
        dirty = true
        commit()
    }

    /// P3 COALESCING: one commit per tick — the cascade's records all land
    /// in a single recompute + flip batch instead of N.
    private var tickScheduled = false
    func markDirty() {
        dirty = true
        guard !tickScheduled else { return }
        tickScheduled = true
        Task { @MainActor in
            tickScheduled = false
            commit()
        }
    }

    /// Resize to an arbitrary width — the store SELECTs nearest samples; no
    /// invalidate, no re-measure cascade for previously-seen widths.
    func resize(to width: Double) {
        currentWidth = width
        dirty = true
        commit()
    }

    // MARK: window math (hysteresis)

    private func window(center: Int, pages: Double) -> Range<Int> {
        guard !order.isEmpty, let vh = viewportHeight, vh > 0 else { return 0..<0 }
        let c = min(max(center, 0), order.count - 1)
        // INTERSECTION semantics — mirrors the app fix (run 2026-09-18):
        // include rows whose TOP is inside the budget; straddlers kept.
        var last = c
        var budget = (1 + pages) * vh
        var i = c
        while i < order.count {
            if i > c, budget <= 0 { break }
            budget -= (knownHeight(for: order[i]) ?? fallback) + spacing
            last = i
            i += 1
        }
        var first = c
        var up = pages * vh
        i = c - 1
        while i >= 0 {
            if up <= 0 { break }
            up -= (knownHeight(for: order[i]) ?? fallback) + spacing
            first = i
            i -= 1
        }
        return first..<last + 1
    }

    private func commit() {
        guard viewportHeight != nil, dirty else { return }
        dirty = false
        let center: Int
        switch anchor {
        case .tail: center = order.count - 1
        case .row(let id):
            guard let c = order.firstIndex(of: id) else { return }
            center = c
        case .none: return
        }
        // P2 HYSTERESIS: the ATTACH window, UNION the rows still inside the
        // (wider) DETACH window — a row that just attached cannot flap out
        // until it passes the wider band.
        var newNear = Set(window(center: center, pages: attachPages))
        if hysteresisEnabled {
            let keep = window(center: center, pages: detachPages)
            newNear.formUnion(keep)
        }
        let on = newNear.subtracting(near)
        let off = near.subtracting(newNear)
        near = newNear
        if !on.isEmpty || !off.isEmpty {
            flipOnCount += on.count
            flipOffCount += off.count
            flips.send((on: on, off: off))
        }
    }

    var registryTotal: Double {
        order.reduce(0) { $0 + (knownHeight(for: $1) ?? fallback) + spacing }
    }
    /// Distinct sampled widths across the store (the function's samples).
    var sampledWidths: [Double] {
        var keys: Set<Double> = []
        for samples in heights.values { for w in samples.keys { keys.insert(w) } }
        return keys.sorted()
    }
    var measuredCount: Int { heights.values.filter { !$0.isEmpty }.count }
}

// MARK: - Rows + Husk (same shape as L2; far claim reads the SLOTTED store)

struct Msg: Identifiable {
    var id: String
    var text: String
}

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
                Color.clear
                    .frame(height: measuredHeight
                            ?? driver.knownHeight(for: msg.id)
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

struct PerfHarnessView: View {
    @StateObject private var driver = MiniDriver()
    @State private var msgs: [Msg] = (0..<40).map {
        Msg(id: "a\($0)", text: $0 % 3 == 0 ? "Row \($0) tall\nmulti\nline\ntext" : "Row \($0)")
    }
    let sentinelID = "sentinel"
    @State private var scrollAnchor: String? = nil
    @State private var renderedTotal: Double = 0
    @State private var results: [String] = []
    @State private var containerWidth: CGFloat = 480

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("reg \(Int(driver.registryTotal))")
                    .foregroundStyle(abs(driver.registryTotal - renderedTotal) > 60 ? .red : .green)
                Text("ren \(Int(renderedTotal))")
                Text("near \(driver.near.count)")
                Text("meas \(driver.measuredCount)@\(driver.sampledWidths.map(Int.init).sorted().map(String.init).joined(separator: ","))")
                Text("flips +\(driver.flipOnCount)/-\(driver.flipOffCount)")
                Spacer()
            }
            .font(.system(size: 9, design: .monospaced))
            .padding(5).background(Color.gray.opacity(0.12))

            HStack(spacing: 8) {
                Button("Bind sentinel") { scrollAnchor = sentinelID }
                Button("Rotate") {
                    let next: Double = containerWidth == 480 ? 760 : (containerWidth == 760 ? 600 : 480)
                    driver.resize(to: next)
                    containerWidth = next
                }
                Toggle("Hyst", isOn: Binding(
                    get: { driver.hysteresisEnabled },
                    set: { driver.hysteresisEnabled = $0; driver.markDirty() }))
                    .font(.system(size: 10))
                Spacer()
            }
            .padding(5)

            ScrollView {
                VStack(spacing: 8) {
                    // Body-time order sync — the app's transcriptStack does
                    // this every body (let _ = windowDriver.sync(order: ids));
                    // without it the harness driver never sees the initial
                    // order and the whole sequence no-ops.
                    let _ = driver.sync(order: msgs.map(\.id))
                    ForEach(Array(msgs.enumerated()), id: \.element.id) { pair in
                        Husk(msg: pair.element, index: pair.offset, driver: driver)
                    }
                    Text("⟨sentinel⟩").id(sentinelID).padding(.vertical, 4)
                }
                .padding()
                .scrollTargetLayout()
            }
            .scrollPosition(id: $scrollAnchor, anchor: .bottom)
            .onScrollGeometryChange(for: Double.self) { geo in geo.contentSize.height }
                action: { _, total in renderedTotal = total }
            .onChange(of: scrollAnchor) { old, new in
                hlog("binding \(old ?? "nil") → \(new ?? "nil")")
                if let new {
                    if new == sentinelID { driver.updateTailAnchor() }
                    else { driver.update(anchorID: new) }
                }
            }
        }
        .frame(width: containerWidth, height: 700)
        .animation(.default, value: containerWidth)   // rotation is animated
        .task { await runTest() }
    }

    // MARK: canned sequence — the P1-P4 proofs

    func runTest() async {
        hlog("=== PERF HARNESS (L3) ===")
        try? await Task.sleep(nanoseconds: 600_000_000)
        driver.viewportHeight = 600

        hlog("--- P1/P2 setup: bind sentinel, measure at 480 ---")
        scrollAnchor = sentinelID
        try? await Task.sleep(nanoseconds: 800_000_000)
        hlog("480 measured: \(driver.measuredCount) rows @ \(driver.sampledWidths) | \(status())")
        results.append("P1 setup: measured \(driver.measuredCount) rows @ \(driver.sampledWidths) near=\(driver.near.count)")

        hlog("--- P2: hysteresis OFF vs ON — flip counts after a churn burst ---")
        driver.hysteresisEnabled = false
        driver.flipOnCount = 0; driver.flipOffCount = 0
        churn()
        try? await Task.sleep(nanoseconds: 700_000_000)
        let offFlips = (driver.flipOnCount, driver.flipOffCount)
        driver.hysteresisEnabled = true
        driver.flipOnCount = 0; driver.flipOffCount = 0
        churn()
        try? await Task.sleep(nanoseconds: 700_000_000)
        let onFlips = (driver.flipOnCount, driver.flipOffCount)
        hlog("P2 flips — hyst OFF: +\(offFlips.0)/-\(offFlips.1)  hyst ON: +\(onFlips.0)/-\(onFlips.1)")
        results.append("P2 hysteresis: OFF +\(offFlips.0)/-\(offFlips.1) vs ON +\(onFlips.0)/-\(onFlips.1)")

        hlog("--- P4: RESIZE to 760 (unmeasured width → nearest-sample fallback) ---")
        driver.resize(to: 760); containerWidth = 760
        try? await Task.sleep(nanoseconds: 800_000_000)
        hlog("760: \(status()) samples=\(driver.sampledWidths)")
        results.append("P4 resize-out: samples=\(driver.sampledWidths) reg=\(Int(driver.registryTotal)) ren=\(Int(renderedTotal))")

        hlog("--- P4b: measure a bit at 760 ---")
        try? await Task.sleep(nanoseconds: 600_000_000)

        hlog("--- P4c: RESIZE to 600 (intermediate — NEAREST-SAMPLE approximation) ---")
        driver.resize(to: 600); containerWidth = 600
        try? await Task.sleep(nanoseconds: 500_000_000)
        hlog("600: \(status()) samples=\(driver.sampledWidths) — nearest sample serves, converges on measure")
        results.append("P4 intermediate: samples=\(driver.sampledWidths) reg=\(Int(driver.registryTotal)) ren=\(Int(renderedTotal))")

        hlog("--- P4d: RESIZE BACK to 480 — heights INSTANT (SELECT, not INVALIDATE) ---")
        driver.resize(to: 480); containerWidth = 480
        try? await Task.sleep(nanoseconds: 400_000_000)
        hlog("back to 480: \(status()) — no re-measure cascade expected (480 samples retained)")
        results.append("P4 resize-back: samples=\(driver.sampledWidths) reg=\(Int(driver.registryTotal)) ren=\(Int(renderedTotal)) (retained = SELECT not INVALIDATE)")

        hlog("=== RESULTS ===")
        for r in results { hlog(r) }
        hlog("=== DONE — hand-drive: rotate repeatedly, watch reg vs ren + flip counts ===")
    }

    /// Simulate a measurement-cascade churn: mark every near row's height
    /// slightly different (as if re-measuring after growth) — the driver's
    /// coalescing batches the recomputes; flip counts show the flap.
    private func churn() {
        for i in driver.near {
            guard i < msgs.count else { continue }
            let id = msgs[i].id
            let base = driver.knownHeight(for: id) ?? 60
            driver.record(id: id, height: base * 0.96)
        }
    }

    func status() -> String {
        "reg=\(Int(driver.registryTotal)) ren=\(Int(renderedTotal)) near=\(driver.near.count) w\(Int(driver.currentWidth)) flips +\(driver.flipOnCount)/-\(driver.flipOffCount)"
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 480, height: 700),
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered, defer: false
)
window.contentView = NSHostingView(rootView: PerfHarnessView())
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
