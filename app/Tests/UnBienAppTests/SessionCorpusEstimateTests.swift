import XCTest
import SwiftUI
import MarkdownUI
import UnBienCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif
@testable import UnBienApp

/// REAL-SESSION estimate survey. The fixed corpus in
/// `HeightEstimateRegressionTests` proves specific SHAPES; this one replays an
/// actual pi session transcript and estimates every row in it, so the question
/// it answers is different: which row kinds drift, how far, and how often, on
/// content nobody curated.
///
/// It is a DISCOVERY instrument, not a gate: it prints a per-kind distribution
/// and the worst offenders, and asserts only against catastrophic drift. It
/// skips unless a session file is present, so it never runs in CI.
///
/// RUN:
///   UNBIEN_SESSION_JSONL=~/.local/share/pi/<session>.jsonl \
///     swift test --filter SessionCorpusEstimate
@MainActor
final class SessionCorpusEstimateTests: XCTestCase {
    private let theme = ThemeID.oneDark.theme
    private lazy var typography = Typography()
    private lazy var style = markdownProseStyle(theme: theme, typography: typography)
    /// iPhone-17-ish portrait CONTENT width (device width less the transcript's
    /// side padding) — the width where wrapping actually bites.
    private let width: Double = 370

    // MARK: - Row replicas (same shapes HeightEstimateRegressionTests measures)

    private func assistantRow(_ markdown: String) -> some View {
        VStack(alignment: .leading, spacing: TranscriptMetrics.assistantHeaderSpacing) {
            Text("Pi").font(.caption.weight(.semibold)).foregroundStyle(theme.toolAccent)
            EntityStack(entities: markdownEntities(markdown, style: style),
                        theme: theme, typography: typography)
        }
    }

    /// The USER bubble shape: role caption + plain (non-markdown) text in a
    /// padded surface. Deliberately separate from the assistant replica — the
    /// chrome differs, and the driver estimates both with the same call.
    private func userRow(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("you").font(.caption.weight(.semibold)).foregroundStyle(theme.toolAccent)
            Text(text)
                .font(typography.bodyFont())
                .padding(10)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func toolCardRow(_ card: ToolCard) -> some View {
        ToolCardView(card: card, theme: theme, typography: typography,
                     expandRich: true, hideInputRich: true,
                     store: CardUIState(), themeID: .oneDark)
    }

    /// Progress breadcrumb: this survey renders ~900 real rows, and a crash in
    /// any one of them takes the process down with no indication which. The
    /// last line printed names the culprit.
    private func trace(_ what: String) {
        guard ProcessInfo.processInfo.environment["UNBIEN_CORPUS_TRACE"] != nil else { return }
        print("  .. \(what)")
        fflush(stdout)
    }

    /// AUTORELEASED per row: this survey hosts ~1000 real rows in one test
    /// method, and without draining between them the accumulated AppKit view
    /// graph takes the process down partway through the corpus.
    private func measure<V: View>(_ view: V) -> Double {
        autoreleasepool {
            #if os(macOS)
            let host = NSHostingView(rootView: view.frame(width: width, alignment: .leading))
            host.layoutSubtreeIfNeeded()
            return host.fittingSize.height
            #else
            let host = UIHostingController(rootView: view.frame(width: width, alignment: .leading))
            return host.view.sizeThatFits(
                CGSize(width: width, height: .greatestFiniteMagnitude)).height
            #endif
        }
    }

    /// Warm every producer a card renders before measuring; a cold cache draws
    /// the empty `plainText` fallback and reads short.
    private func prewarm(_ card: ToolCard) async {
        if let diff = ToolCardView.diffProducer(for: card, theme: theme, themeID: .oneDark) {
            _ = await AttributedTextCache.shared.attributed(diff)
        }
        if let content = ToolCardView.contentProducer(for: card, theme: theme,
                                                      typography: typography,
                                                      toolBudget: toolBudget) {
            _ = await AttributedTextCache.shared.attributed(content)
        }
    }

    // MARK: - Session parsing

    private struct Sample {
        let kind: String
        let label: String
        let rendered: Double
        let estimated: Double
        var delta: Double { rendered - estimated }
    }

    private func sessionPath() -> String? {
        if let env = ProcessInfo.processInfo.environment["UNBIEN_SESSION_JSONL"], !env.isEmpty {
            return (env as NSString).expandingTildeInPath
        }
        return nil
    }

    func testSessionCorpus() async throws {
        guard let path = sessionPath(), FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("set UNBIEN_SESSION_JSONL to a pi session .jsonl to run this survey")
        }
        let raw = try String(contentsOfFile: path, encoding: .utf8)
        let decoder = JSONDecoder()
        var entries: [JSONValue] = []
        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = line.data(using: .utf8),
                  let value = try? decoder.decode(JSONValue.self, from: data) else { continue }
            entries.append(value)
        }

        // Tool results, keyed by call id, so a card carries its output.
        var resultByCall: [String: (text: String, isError: Bool)] = [:]
        for entry in entries {
            let message = entry["message"] ?? entry
            guard message["role"]?.stringValue == "toolResult",
                  let callID = message["toolCallId"]?.stringValue else { continue }
            let text = (message["content"]?.arrayValue ?? [])
                .compactMap { $0["text"]?.stringValue }
                .joined(separator: "\n")
            resultByCall[callID] = (text, message["isError"]?.boolValue ?? false)
        }

        var samples: [Sample] = []
        for entry in entries {
            let message = entry["message"] ?? entry
            guard message["type"]?.stringValue == nil || entry["type"]?.stringValue == "message"
            else { continue }
            guard let role = message["role"]?.stringValue else { continue }
            let parts = message["content"]?.arrayValue ?? []

            switch role {
            case "user":
                for part in parts where part["type"]?.stringValue == "text" {
                    guard let text = part["text"]?.stringValue, !text.isEmpty else { continue }
                    trace("user \(text.count)ch")
                    let budgeted = text.count > markdownBudgetForTest
                        ? String(text.prefix(markdownBudgetForTest)) : text
                    samples.append(Sample(
                        kind: "user",
                        label: String(text.prefix(48)).replacingOccurrences(of: "\n", with: " "),
                        rendered: measure(userRow(budgeted)),
                        estimated: RowHeightEstimator.estimateText(text, images: [],
                                                                   style: style, width: width,
                                                                   spec: .user)))
                }
            case "assistant":
                for part in parts {
                    switch part["type"]?.stringValue {
                    case "text":
                        guard let text = part["text"]?.stringValue, !text.isEmpty else { continue }
                        trace("assistant \(text.count)ch")
                        samples.append(Sample(
                            kind: "assistant",
                            label: String(text.prefix(48)).replacingOccurrences(of: "\n", with: " "),
                            rendered: measure(assistantRow(text)),
                            estimated: RowHeightEstimator.estimateText(text, images: [],
                                                                       style: style, width: width)))
                    case "toolCall":
                        guard let callID = part["id"]?.stringValue else { continue }
                        let name = part["name"]?.stringValue ?? "tool"
                        trace("tool \(name) result=\(resultByCall[callID]?.text.count ?? -1)ch")
                        let args = part["arguments"]?.objectValue ?? [:]
                        let hit = resultByCall[callID]
                        let card = ToolCard(
                            toolCallID: callID, tool: name, args: args,
                            result: hit.map { JSONValue.string($0.text) },
                            error: (hit?.isError ?? false) ? hit?.text : nil,
                            state: hit == nil ? .running : ((hit?.isError ?? false) ? .failed : .ok))
                        await prewarm(card)
                        let facts = RowHeightEstimator.toolCardFacts(
                            for: card,
                            expanded: ToolCardView.isRich(card),
                            hideInputRich: true)
                        samples.append(Sample(
                            kind: "tool:\(name)",
                            label: callID,
                            rendered: measure(toolCardRow(card)),
                            estimated: RowHeightEstimator.estimateToolCard(
                                facts, style: style, width: width)))
                    default:
                        continue   // `thinking` renders only when showThinking is on
                    }
                }
            default:
                continue
            }
        }

        try report(samples)
    }

    /// The transcript budget the user bubble renders under (mirrors
    /// TranscriptRowViews' markdownBudget, which is file-private there).
    private let markdownBudgetForTest = 32_000

    private func report(_ samples: [Sample]) throws {
        try XCTSkipIf(samples.isEmpty, "no renderable rows found in the session")
        // Plain interpolation, not String(format:) — printf string conversions
        // take C pointers, and handing them Swift Strings crashes the process.
        func pad(_ s: String, _ n: Int) -> String {
            s.count >= n ? String(s.prefix(n)) : s + String(repeating: " ", count: n - s.count)
        }
        func num(_ v: Double, _ n: Int = 8) -> String {
            let s = String(format: "%.1f", v)
            return s.count >= n ? s : String(repeating: " ", count: n - s.count) + s
        }
        func stats(_ group: [Sample]) -> String {
            let errs = group.map { abs($0.delta) }.sorted()
            let mean = errs.reduce(0, +) / Double(errs.count)
            let bias = group.map(\.delta).reduce(0, +) / Double(group.count)
            func pct(_ p: Double) -> Double { errs[min(errs.count - 1, Int(Double(errs.count) * p))] }
            return "n=\(pad(String(group.count), 5))mean|d|=\(num(mean))  p50=\(num(pct(0.50)))"
                + "  p90=\(num(pct(0.90)))  max=\(num(errs.last ?? 0))  bias=\(num(bias))"
        }

        print("\n=== SESSION CORPUS @\(Int(width))pt — per-kind error ===")
        let byKind = Dictionary(grouping: samples, by: \.kind)
        for key in byKind.keys.sorted() {
            print("\(pad(key, 24)) \(stats(byKind[key]!))")
        }
        print("\(pad("ALL", 24)) \(stats(samples))")

        print("\n=== WORST 25 ===")
        for sample in samples.sorted(by: { abs($0.delta) > abs($1.delta) }).prefix(25) {
            print("\(num(sample.delta, 9))  rendered=\(num(sample.rendered))"
                + " est=\(num(sample.estimated))  \(pad(sample.kind, 18)) \(sample.label)")
        }
        print("")

        // Discovery instrument: only catastrophic drift fails.
        let worst = samples.max(by: { abs($0.delta) < abs($1.delta) })
        XCTAssertNotNil(worst)
    }
}
