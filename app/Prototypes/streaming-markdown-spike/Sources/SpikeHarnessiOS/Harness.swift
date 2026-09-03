// iOS spike: same A/B harness as the macOS main.swift, with ON-SCREEN
// results (no console on device). Run each engine solo at the 25KB regime,
// report first/avg/worst/over-budget/height-changes on a card you can
// screenshot. Also a visual side-by-side pane for theme inspection.

import SwiftUI
import SwiftStreamingMarkdown
import MarkdownUI

// MARK: - Corpus (identical to the macOS harness)

let corpusParagraphs: [String] = [
    "The **windowed layout** renders every row as a `husk` — identity plus a claimed frame, permanent in the\n"
        + "    hierarchy — whose content subtree attaches only inside the geometric page-window. Cycling out *freezes* to the\n"
        + "    last measured height.",
    "The scrollPosition binding is phase-free: setting it is a command, the user scrolling updates it — the readout IS\n"
        + "    their position. See [the design note](https://example.com/design) for the local-vs-global coordinate rule.",
    "Id scheme v2 made the pi entry id **the row id** — live births are seq synthetics re-keyed in place on the\n"
        + "    `message_end` delta (adoption, not replacement). Boundary insertion enforces log order.",
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

let unitDocument = (corpusParagraphs + [corpusCode, corpusLists, corpusTable, corpusQuote])
    .joined(separator: "\n\n")

let bigDocument: String = {
    (0..<10).map { "## Section \($0 + 1)\n\n" + unitDocument }
        .joined(separator: "\n\n")
}()

var corpusChunks: [String] {
    let words = bigDocument.split(separator: " ")
    var out: [String] = []
    var acc: [String] = []
    for word in words {
        acc.append(String(word))
        if acc.count % 40 == 0 { out.append(acc.joined(separator: " ")) }
    }
    out.append(acc.joined(separator: " "))
    return out
}

// MARK: - Source + results model

final class SpikeSource: StreamedMarkdownSource, ObservableObject {
    private var continuation: AsyncStream<String>.Continuation?
    var text: AsyncStream<String> {
        AsyncStream { cont in self.continuation = cont }
    }
    func emit(_ snapshot: String) { continuation?.yield(snapshot) }
    func finish() { continuation?.finish() }
}

struct EngineResult: Identifiable {
    let id: String            // "SSM" / "MDUI"
    let first: Double
    let avg: Double
    let worst: Double
    let overBudget: Int
    let total: Int
    let heightChanges: Int
    let wallSeconds: Double
}

// MARK: - The iOS harness view

enum SpikePhase: Equatable {
    case idle, running(String, Int), finished, visual
}

struct SpikeView: View {
    @State private var phase: SpikePhase = .idle
    @State private var controlText = ""
    @StateObject private var source = SpikeSource()
    @State private var results: [EngineResult] = []
    @State private var ssmHeightChanges = 0
    @State private var mduiHeightChanges = 0
    @State private var lastPaneHeight: CGFloat = 0
    @State private var runCount = 0

    var body: some View {
        VStack(spacing: 8) {
            statusHeader
            if isVisual {
                visualPanes
            } else if let engine = liveEngine {
                // The engine being timed MUST render on screen while its
                // snapshots stream in, or the timings measure nothing.
                livePane(engine)
            } else if results.isEmpty {
                Spacer()
                Text("Runs the 25KB streaming A/B\n(SSM solo, then MDUI solo,\n~74 snapshots each at 66ms cadence).\nTakes a few minutes — watch the progress line.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Spacer()
            }
            if !results.isEmpty { resultsCard }
        }
        .padding(12)
        .task { if runCount == 0 { await runSpike() } }
    }

    /// The engine currently being benchmarked — nil unless mid-run.
    private var liveEngine: String? {
        if case .running(let engine, _) = phase { return engine }
        return nil
    }

    private var isVisual: Bool {
        if case .visual = phase { return true }
        return false
    }

    private var statusHeader: some View {
        let label: String
        switch phase {
        case .idle: label = "idle"
        case .running(let engine, let idx): label = "\(engine) solo — snapshot \(idx)/\(corpusChunks.count)"
        case .finished: label = "done — results below"
        case .visual: label = "visual / theme comparison"
        }
        return HStack {
            Text(label).font(.system(size: 12, design: .monospaced))
            Spacer()
            Button("Re-run") { Task { await runSpike() } }
                .font(.caption)
            Button("Visual") { phase = .visual; controlText = bigDocument; source.emit(bigDocument) }
                .font(.caption)
        }
    }

    private var resultsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("25KB streaming — per-snapshot ms (lower is better)")
                .font(.caption.weight(.semibold))
            ForEach(results) { result in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(result.id).font(.system(size: 13, weight: .bold, design: .monospaced))
                            .foregroundStyle(result.id == "SSM" ? .blue : .orange)
                        Spacer()
                        Text("wall \(String(format: "%.1f", result.wallSeconds))s")
                            .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                    Text("first \(Int(result.first))ms   avg \(String(format: "%.0f", result.avg))ms   worst \(Int(result.worst))ms")
                        .font(.system(size: 12, design: .monospaced))
                    Text("frames >16.7ms: \(result.overBudget)/\(result.total)   layout passes: \(result.heightChanges)")
                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                }
                .padding(8)
                .background(Color.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            }
            Text("Mac reference: SSM avg 520ms worst 5.0s | MDUI avg 1719ms worst 9.7s")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(10)
        .background(Color.gray.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }

    /// Fixed-height live pane: only the SOLO engine is in the hierarchy, so
    /// per-snapshot wall ms attributes to it honestly.
    private func livePane(_ engine: String) -> some View {
        ScrollView {
            Group {
                if engine == "SSM" {
                    StreamedMarkdownView(source: source, config: spikeConfig).padding(8)
                } else {
                    Markdown(controlText).padding(8)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { newHeight in
                if newHeight != lastPaneHeight {
                    lastPaneHeight = newHeight
                    if engine == "SSM" { ssmHeightChanges += 1 } else { mduiHeightChanges += 1 }
                }
            }
        }
        .frame(height: 300)
        .overlay(Text(engine == "SSM" ? "SSM (live)" : "MDUI (live)")
            .font(.caption2).foregroundStyle(engine == "SSM" ? .blue : .orange).padding(4),
            alignment: .topLeading)
        .background(Color.gray.opacity(0.08))
    }

    private var visualPanes: some View {
        HStack(spacing: 1) {
            ScrollView {
                StreamedMarkdownView(source: source, config: spikeConfig).padding(8)
            }
            .overlay(Text("SSM").font(.caption2).foregroundStyle(.blue).padding(4), alignment: .topLeading)
            ScrollView {
                Markdown(controlText).padding(8)
            }
            .overlay(Text("MDUI").font(.caption2).foregroundStyle(.orange).padding(4), alignment: .topLeading)
        }
        .background(Color.gray.opacity(0.08))
    }

    // MARK: run

    private func runSpike() async {
        runCount += 1
        results = []
        ssmHeightChanges = 0
        mduiHeightChanges = 0
        phase = .idle
        try? await Task.sleep(nanoseconds: 500_000_000)

        lastPaneHeight = 0
        let ssmTimings = await soloRun(engine: "SSM") { snapshot in
            source.emit(snapshot)
        }
        source.finish()
        results.append(makeResult("SSM", ssmTimings, ssmHeightChanges))
        phase = .finished
        try? await Task.sleep(nanoseconds: 300_000_000)

        controlText = ""
        lastPaneHeight = 0
        try? await Task.sleep(nanoseconds: 400_000_000)
        let mduiTimings = await soloRun(engine: "MDUI") { snapshot in
            controlText = snapshot
        }
        results.append(makeResult("MDUI", mduiTimings, mduiHeightChanges))
        phase = .finished
    }

    /// One solo pass: only ONE engine in the hierarchy (wall-time attributes
    /// honestly). Returns per-snapshot wall ms.
    private func soloRun(engine: String, emit: @escaping (String) -> Void) async -> [Double] {
        var timings: [Double] = []
        for idx in corpusChunks.indices {
            phase = .running(engine, idx)
            let snapshot = corpusChunks[0...idx].joined(separator: " ")
            let startNanos = DispatchTime.now().uptimeNanoseconds
            emit(snapshot)
            try? await Task.sleep(nanoseconds: 66_000_000)
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000
            timings.append(elapsed)
            // Unbuffered trace: survives even if the process is killed mid-run.
            FileHandle.standardError.write("SNAP \(engine) \(idx)/\(corpusChunks.count) \(Int(elapsed))ms\n".data(using: .utf8)!)
        }
        return timings
    }

    private func makeResult(_ name: String, _ timings: [Double], _ hChanges: Int) -> EngineResult {
        EngineResult(
            id: name,
            first: timings.first ?? 0,
            avg: timings.isEmpty ? 0 : timings.reduce(0, +) / Double(timings.count),
            worst: timings.max() ?? 0,
            overBudget: timings.filter { $0 > 16.7 }.count,
            total: timings.count,
            heightChanges: hChanges,
            wallSeconds: timings.reduce(0, +) / 1000)
    }
}

var spikeConfig: MarkdownRenderConfig {
    let fgColor = Color(red: 0x75 / 255, green: 0x7a / 255, blue: 0xf5 / 255)
    let base = MarkdownRenderConfig.defaultParagraphStyle
    return MarkdownRenderConfig.default
        .withParagraphStyle(value: MarkdownRenderConfig.MarkdownTextStyle(
            textFonts: base.textFonts, textColor: fgColor))
}

@main
struct SpikeApp: App {
    var body: some Scene {
        WindowGroup { SpikeView() }
    }
}
