// L4 SPIKE: SwiftStreamingMarkdown (candidate) vs MarkdownUI (control) on the
// app's REAL workload shapes — the adoption-gate measurements.
//
//   G1/G2 STREAMING + FIRST RENDER, SEQUENTIAL SOLO RUNS: one engine visible
//      at a time (wall-time attributes honestly — the first attempt ran both
//      panes simultaneously and the numbers were meaningless; also its
//      "height proxy" appended heights into a times array and its "first
//      render" timed sleep durations. Fixed.). Each engine streams the corpus
//      at the app's ~15fps coalescer cadence; per-emission wall time, height-
//      change counts (incremental vs full re-layout signal), and the FIRST
//      emission doubles as the cold-render measurement.
//   G3 THEME MAPPING: Tokyo Night through MarkdownRenderConfig — visual.
//
// Corpus: embedded slice of the actual transcript shapes. Deterministic.
//
// Run: cd app/Prototypes/streaming-markdown-spike && swift run

import SwiftUI
import os
import AppKit
import SwiftStreamingMarkdown
import MarkdownUI

let log = Logger(subsystem: "sm-spike", category: "test")
func slog(_ msg: String) {
    print(msg)
    log.info("\(msg, privacy: .public)")
}

// MARK: - Corpus (the transcript's real shapes)

let corpusParagraphs: [String] = [
    "The **windowed layout** renders every row as a `husk` — identity plus a claimed frame, permanent in the\n    hierarchy — whose content subtree attaches only inside the geometric page-window. Cycling out *freezes* to the last\n    measured height.",
    "The scrollPosition binding is phase-free: setting it is a command, the user scrolling updates it — the readout IS their position. See [the design note](https://example.com/design) for the local-vs-global coordinate rule.",
    "Id scheme v2 made the pi entry id **the row id** — live births are seq synthetics re-keyed in place on the `message_end` delta (adoption, not replacement). Boundary insertion enforces log order.",
    "Entry-born provider errors ride the log position — inserted before the live tail like every message birth — instead of appending at the very end.",
]

let corpusCode = """
```swift
struct HuskRow: View {
    let item: TranscriptItem
    let index: Int
    let driver: TranscriptWindowDriver

    @State private var isNear: Bool
    @State private var measuredHeight: Double?

    var body: some View {
        Group {
            if isNear {
                TranscriptRow(item: item)
                    .background(heightProbe)
            } else {
                Color.clear
                    .frame(height: measuredHeight ?? driver.fallbackHeight)
            }
        }
        .onReceive(driver.flips) { flip in
            if flip.on.contains(index) { isNear = true }
            else if flip.off.contains(index) { isNear = false }
        }
    }
}
```
"""

let corpusLists = """
The fix ladder, cheapest first:

1. Tune frequency — threshold batches flips coarser
2. Lean far-husks — drop the ghost-tint background
3. Slice + spacers — render only the window slice

The checklist:

- [x] Selection quality
- [ ] Highlighter bridge
- [ ] 1500-row document
"""

let corpusTable = """
| Concern | Old (scrollTo stack) | New (binding) |
|---|---|---|
| Follow an arrival | echo + attribution + linger | two binding sets |
| Detect user scroll | probe attribution, phases | binding reads non-sentinel |
| Re-arm at bottom | 40/48pt geometry bands | idle + binding==sentinel |
"""

let corpusQuote = """
> The registry IS what the husks render — seeded/migrated heights must drive
> the rendered frames, or the two coordinate systems diverge.
"""

let fullDocument = (corpusParagraphs + [corpusCode, corpusLists, corpusTable, corpusQuote])
    .joined(separator: "\n\n")

/// LARGE REGIME (run 2, user 2026-09-18: "re-run on Mac larger"): the corpus
/// ×10 ≈ 25KB — the app's budget-max streaming row. MDUI's per-delta cost is
/// O(total text) (full re-parse); SSM's is O(delta) (incremental). At 2.5KB
/// both sat at the 66ms measurement floor; this is the scale where they
/// should separate on the Mac — and the iPhone run is the decisive one.
let bigDocument: String = {
    let unit = fullDocument
    return (0..<10).map { idx -> String in
        "## Section \(idx + 1)\n\n" + unit
    }.joined(separator: "\n\n")
}()

var corpusChunks: [String] {
    let words = bigDocument.split(separator: " ")
    var out: [String] = []
    var acc: [String] = []
    for word in words {
        acc.append(String(word))
        if acc.count % 40 == 0 { out.append(acc.joined(separator: " ")) }
        // bigger chunks: ~10/s at 66ms would be 660 frames; keep the run bounded
    }
    out.append(acc.joined(separator: " "))
    return out
}

// MARK: - Streaming source (SSM's model: full snapshots)

final class SpikeSource: StreamedMarkdownSource, ObservableObject {
    private var continuation: AsyncStream<String>.Continuation?
    var text: AsyncStream<String> {
        AsyncStream { cont in self.continuation = cont }
    }
    func emit(_ snapshot: String) { continuation?.yield(snapshot) }
    func finish() { continuation?.finish() }
}

// MARK: - The harness view

enum SpikePhase: Equatable {
    case idle
    case ssmSolo(index: Int)          // streaming into SSM only
    case mduiSolo(index: Int)         // streaming into MDUI only
    case sideBySide                   // visual/theme comparison, static full doc
    case done
}

struct SpikeView: View {
    @State private var phase: SpikePhase = .idle
    @State private var ssmText = ""          // feeds the SSM source emitter
    @State private var controlText = ""      // MDUI text
    @StateObject private var source = SpikeSource()

    // Honest metrics: height-CHANGE counts (layout work proxy) per engine.
    @State private var ssmHeightChanges = 0
    @State private var mduiHeightChanges = 0
    @State private var results: [String] = []

    var body: some View {
        VStack(spacing: 0) {
            header
            HStack(spacing: 1) {
                // ONLY the active engine is in the hierarchy — sequential
                // solo runs make wall-time attributable.
                switch phase {
                case .ssmSolo:
                    ssmPane
                case .mduiSolo:
                    mduiPane
                case .sideBySide, .done, .idle:
                    ssmPane
                    mduiPane
                }
            }
        }
        .frame(minWidth: 900, minHeight: 640)
        .task { await runSpike() }
    }

    private var header: some View {
        let label: String
        switch phase {
        case .idle: label = "warming"
        case .ssmSolo(let idx): label = "G1 SSM solo \(idx)/\(corpusChunks.count)"
        case .mduiSolo(let idx): label = "G1 MDUI solo \(idx)/\(corpusChunks.count)"
        case .sideBySide: label = "G3 side-by-side (theme + visual)"
        case .done: label = "done"
        }
        return HStack(spacing: 10) {
            Text(label)
            Text("hΔ SSM=\(ssmHeightChanges) MDUI=\(mduiHeightChanges)")
            Spacer()
        }
        .font(.system(size: 10, design: .monospaced))
        .padding(6)
        .background(Color.gray.opacity(0.12))
    }

    // MARK: panes (height probes count LAYOUT work, not fake times)

    private var ssmPane: some View {
        ScrollView {
            StreamedMarkdownView(source: source, config: spikeConfig)
                .padding(10)
                .background(heightProbe { ssmHeightChanges += 1 })
        }
        .frame(maxWidth: .infinity)
        .overlay(Text("SSM").font(.caption2).foregroundStyle(.blue).padding(4), alignment: .topLeading)
    }

    private var mduiPane: some View {
        ScrollView {
            Markdown(controlText)
                .padding(10)
                .background(heightProbe { mduiHeightChanges += 1 })
        }
        .frame(maxWidth: .infinity)
        .overlay(Text("MDUI").font(.caption2).foregroundStyle(.orange).padding(4), alignment: .topLeading)
    }

    private func heightProbe(onChange: @escaping () -> Void) -> some View {
        GeometryReader { geo in
            Color.clear.onChange(of: geo.size.height) { _, _ in onChange() }
        }
    }

    // MARK: the run

    private func runSpike() async {
        try? await Task.sleep(nanoseconds: 500_000_000)

        // --- SSM solo pass ---
        var ssmTimings: [Double] = []
        for idx in corpusChunks.indices {
            phase = .ssmSolo(index: idx)
            let snapshot = corpusChunks[0...idx].joined(separator: " ")
            let startNanos = DispatchTime.now().uptimeNanoseconds
            ssmText = snapshot
            source.emit(snapshot)
            // One cadence beat: sleep 66ms (the coalescer window); the engine
            // renders within it. Measured wall = emit → post-beat.
            try? await Task.sleep(nanoseconds: 66_000_000)
            ssmTimings.append(Double(DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000)
        }
        source.finish()
        report("SSM", ssmTimings)

        // Reset for the control pass.
        ssmText = ""
        controlText = ""
        try? await Task.sleep(nanoseconds: 400_000_000)

        // --- MDUI solo pass ---
        var mduiTimings: [Double] = []
        for idx in corpusChunks.indices {
            phase = .mduiSolo(index: idx)
            let snapshot = corpusChunks[0...idx].joined(separator: " ")
            let startNanos = DispatchTime.now().uptimeNanoseconds
            controlText = snapshot
            try? await Task.sleep(nanoseconds: 66_000_000)
            mduiTimings.append(Double(DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000)
        }
        report("MDUI", mduiTimings)

        // --- G3: side-by-side static, full doc, for theme/visual inspection ---
        ssmText = bigDocument
        source.emit(bigDocument)
        controlText = bigDocument
        phase = .sideBySide

        slog("=== SPIKE RESULTS ===")
        for line in results { slog(line) }
        slog("=== G3: compare panes visually (Tokyo Night paragraph mapping on SSM left) ===")
        slog("=== Window stays open — close it to end. ===")
        // Keep the app alive for inspection; the user closes the window.
        while true { try? await Task.sleep(nanoseconds: 1_000_000_000) }
    }

    private func report(_ name: String, _ timings: [Double]) {
        guard !timings.isEmpty else { return }
        let first = timings[0]
        let avg = timings.reduce(0, +) / Double(timings.count)
        let worst = timings.max() ?? 0
        let over60fps = timings.filter { $0 > 16.7 }.count
        slog("\(name): first=\(Int(first))ms avg=\(String(format: "%.1f", avg))ms worst=\(Int(worst))ms "
            + "over=\(over60fps)/\(timings.count) hΔ=\(name == "SSM" ? ssmHeightChanges : mduiHeightChanges)")
        results.append("\(name): first=\(Int(first))ms avg=\(String(format: "%.1f", avg))ms "
            + "worst=\(Int(worst))ms over=\(over60fps)/\(timings.count) "
            + "hΔ=\(name == "SSM" ? ssmHeightChanges : mduiHeightChanges)")
    }
}

/// G3: Tokyo Night mapped through MarkdownRenderConfig.
var spikeConfig: MarkdownRenderConfig {
    let fgColor = Color(red: 0x75 / 255, green: 0x7a / 255, blue: 0xf5 / 255)
    let base = MarkdownRenderConfig.defaultParagraphStyle
    return MarkdownRenderConfig.default
        .withParagraphStyle(value: MarkdownRenderConfig.MarkdownTextStyle(
            textFonts: base.textFonts, textColor: fgColor))
}

// MARK: - App bootstrap

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 940, height: 660),
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered, defer: false
)
window.contentView = NSHostingView(rootView: SpikeView())
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
