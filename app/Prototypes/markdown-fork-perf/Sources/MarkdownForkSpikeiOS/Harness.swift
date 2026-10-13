// MarkdownUI fork spike (design 01M1TAQY): A/B the LIVE MarkdownUI render vs
// the ENTITY path under a SUPER-FAST SCROLL at a LARGE load.
//
// Strategy (user, 2026-09-05): prep (parse + prose styling) is BACKGROUND by
// design, so it never touches the scroll frame — we do NOT replicate un-bien's
// husk windowing here. Entities are produced OFF-MAIN up front (the warmed
// steady state bg prep gives us); the fling then measures only the on-frame
// RENDER cost: MarkdownUI parse+layout on the main thread vs the entity path's
// pre-baked Text. Bubbles are DISTINCT (per-message header) so nothing shares a
// warm cache. If the delta is compelling at scale, implement in the real app
// (husks already there) and measure the true thing there.
//
//   cd app/Prototypes/markdown-fork-perf && xcodegen generate --spec ios-project.yml

import SwiftUI
import MarkdownUI
import QuartzCore

// MARK: - Corpus: a CHUNKY unit, DISTINCT per bubble, many bubbles

let unitDocument = """
# Release Notes

Some **bold** text, a bit of *emphasis*, and `inline code` in a paragraph that \
deliberately runs on for a while so the layout engine has real wrapped text to \
measure across several lines of prose.

## Details

Another paragraph with a [link](https://example.com) and more prose. Lorem ipsum \
dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut \
labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation.

```swift
func greet(_ name: String) -> String {
    return "Hello, \\(name)!"
}
```

| Column A | Column B | Column C |
|----------|:--------:|---------:|
| alpha    | beta     | gamma    |
| one      | two      | three    |

- first bullet point with some length to it
- second bullet point
- third bullet point

1. first numbered item
2. second numbered item
3. third numbered item

- [ ] an unchecked task
- [x] a completed task

> A blockquote to round out the shapes with a little more prose to render.

A final closing paragraph so the bubble has real body to render.
"""

// unit x4 = a big message; distinct per bubble so nothing shares a warm cache.
private let chunk = Array(repeating: unitDocument, count: 4).joined(separator: "\n\n")
private let proseStyle = MarkdownProseStyle(baseSize: 16, textColor: .primary, linkColor: .blue)
private let bubbleCount = 200

func docFor(_ index: Int) -> String { "# Message \(index)\n\n" + chunk }

// MARK: - Frame sampler (real per-frame intervals during the fling)

final class FrameSampler {
    struct Report { let avg: Double; let worst: Double; let over: Int; let total: Int }

    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private(set) var intervals: [Double] = []

    func start() {
        intervals = []
        last = 0
        let display = CADisplayLink(target: self, selector: #selector(tick))
        display.add(to: .main, forMode: .common)
        link = display
    }
    func stop() { link?.invalidate(); link = nil }

    @objc private func tick(_ display: CADisplayLink) {
        if last != 0 { intervals.append((display.timestamp - last) * 1000) }
        last = display.timestamp
    }

    var report: Report {
        guard !intervals.isEmpty else { return Report(avg: 0, worst: 0, over: 0, total: 0) }
        return Report(
            avg: intervals.reduce(0, +) / Double(intervals.count),
            worst: intervals.max() ?? 0,
            over: intervals.filter { $0 > 16.7 }.count,
            total: intervals.count)
    }
}

struct EngineResult: Identifiable {
    let id: String          // "MDUI" / "ENT"
    let avgFrame: Double
    let worstFrame: Double
    let dropped: Int
    let frames: Int
}

struct SpikeView: View {
    @State private var engine = "MDUI"
    @State private var scrollTarget: Int?
    @State private var results: [EngineResult] = []
    @State private var status = "preparing entities off-main…"
    @State private var entitiesPerBubble: [[MarkdownEntity]] = []
    @State private var manual = false
    private let sampler = FrameSampler()

    var body: some View {
        VStack(spacing: 8) {
            header
            if manual {
                Picker("mode", selection: $engine) {
                    Text("Live MarkdownUI").tag("MDUI")
                    Text("Entities").tag("ENT")
                }
                .pickerStyle(.segmented)
            }
            listPane
            if !results.isEmpty { resultsCard }
        }
        .padding(12)
        .task { await prepareThenRun() }
    }

    private var header: some View {
        HStack {
            Text(status).font(.system(size: 12, design: .monospaced))
            Spacer()
            Button("Re-run") { manual = false; Task { await run() } }.font(.caption)
            Button("Manual") { manual = true }.font(.caption)
        }
    }

    private var listPane: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(0..<bubbleCount, id: \.self) { index in
                    bubble(index)
                        .id(index)
                        .padding(10)
                        .background(Color.gray.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
        .scrollPosition(id: $scrollTarget)
        .overlay(alignment: .topTrailing) {
            Text(engine).font(.caption2.bold())
                .foregroundStyle(engine == "ENT" ? .green : .orange).padding(4)
        }
    }

    @ViewBuilder
    private func bubble(_ index: Int) -> some View {
        if engine == "ENT" {
            if entitiesPerBubble.count == bubbleCount {
                EntityMessageView(entities: entitiesPerBubble[index])
            } else {
                Text("…").frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            Markdown(docFor(index))
        }
    }

    private var resultsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Fast-scroll fling — frame intervals (fewer dropped = smoother)")
                .font(.caption.weight(.semibold))
            ForEach(results) { result in
                VStack(alignment: .leading, spacing: 2) {
                    Text(result.id).font(.system(size: 13, weight: .bold, design: .monospaced))
                        .foregroundStyle(result.id == "ENT" ? .green : .orange)
                    Text("dropped >16.7ms: \(result.dropped)/\(result.frames)   worst \(Int(result.worstFrame))ms   avg \(String(format: "%.1f", result.avgFrame))ms")
                        .font(.system(size: 12, design: .monospaced))
                }
                .padding(8)
                .background(Color.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            }
            Text("\(bubbleCount) distinct bubbles, unit×4; 120Hz (8.3ms budget)")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(10)
        .background(Color.gray.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }

    private func prepareThenRun() async {
        if entitiesPerBubble.isEmpty {
            // Prep is BACKGROUND (off-main), as it will be in the app.
            let produced = await Task.detached(priority: .userInitiated) { () -> [[MarkdownEntity]] in
                (0..<bubbleCount).map { markdownEntities(docFor($0), style: proseStyle) }
            }.value
            entitiesPerBubble = produced
        }
        await run()
    }

    private func run() async {
        results = []
        for candidate in ["MDUI", "ENT"] {
            engine = candidate
            scrollTarget = 0
            status = "\(candidate) fast-scroll…"
            try? await Task.sleep(nanoseconds: 800_000_000)   // settle at top
            sampler.start()
            withAnimation(.linear(duration: 1.0)) { scrollTarget = bubbleCount - 1 }
            try? await Task.sleep(nanoseconds: 1_200_000_000)  // fling + margin
            sampler.stop()
            let report = sampler.report
            results.append(EngineResult(
                id: candidate, avgFrame: report.avg, worstFrame: report.worst,
                dropped: report.over, frames: report.total))
            scrollTarget = 0
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        engine = "MDUI"
        status = "done — \(bubbleCount) distinct bubbles"
    }
}

// MARK: - Entity renderer (the pluggable materialization)

struct EntityMessageView: View {
    let entities: [MarkdownEntity]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(entities.enumerated()), id: \.offset) { _, entity in
                entityView(entity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func entityView(_ entity: MarkdownEntity) -> some View {
        switch entity {
        case .prose(let attributed):
            Text(attributed).frame(maxWidth: .infinity, alignment: .leading)
        case .code(_, let text):
            Text(text)
                .font(.system(.footnote, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
        case .table(let model):
            EntityTableView(model: model)
        case .list(let model):
            EntityListView(model: model)
        case .blockquote(let children):
            EntityBlockquoteView(children: children)
        case .thematicBreak:
            Divider()
        case .raw(let text):
            Text(text).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct EntityTableView: View {
    let model: MarkdownTableModel

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
            ForEach(Array(model.rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        Text(cell)
                    }
                }
            }
        }
        .padding(8)
        .background(Color.gray.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
    }
}

struct EntityListView: View {
    let model: MarkdownListModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(model.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 6) {
                    Text(item.marker)
                        .font(.body.monospacedDigit())
                        .foregroundStyle(.secondary)
                    EntityMessageView(entities: item.content)
                }
            }
        }
    }
}

struct EntityBlockquoteView: View {
    let children: [MarkdownEntity]

    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Color.gray.opacity(0.5)).frame(width: 3)
            EntityMessageView(entities: children)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

@main
struct MarkdownForkSpikeApp: App {
    var body: some Scene {
        WindowGroup { SpikeView() }
    }
}
