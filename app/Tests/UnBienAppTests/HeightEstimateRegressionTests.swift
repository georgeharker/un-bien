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

/// HEIGHT-ESTIMATE REGRESSION HARNESS (design: analytic height tier) —
/// renders REAL rows at fixed widths and diffs the estimator against the
/// measured truth. This is the drift alarm the same-symbol discipline can't
/// provide for NATURAL heights (switcher, labels, header) and the discovery
/// instrument for whatever still has diffs.
///
/// RUN: swift test --filter HeightEstimateRegression — the per-case table
/// prints rendered vs estimated with per-kind deltas; assertions gate
/// catastrophic drift (>150pt) and per-kind budgets loosen as calibration
/// matures. Corpus emphasis per george: code DIFFS, code OUTPUT, LISTS, etc.
@MainActor
final class HeightEstimateRegressionTests: XCTestCase {
    private let theme = ThemeID.oneDark.theme
    private lazy var typography = Typography()
    private lazy var style = markdownProseStyle(theme: theme, typography: typography)
    private let widths: [Double] = [430, 760]   // phone-ish, tablet-ish

    // MARK: - Measured truth

    /// Host a view at a fixed width and measure its real rendered height.
    private func measure<V: View>(_ view: V, width: Double) -> Double {
        #if os(macOS)
        let host = NSHostingView(
            rootView: view.frame(width: width, alignment: .leading))
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
        #else
        let host = UIHostingController(
            rootView: view.frame(width: width, alignment: .leading))
        return host.view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        #endif
    }

    /// The assistant row SHAPE the estimator targets: "Pi" header + spacing +
    /// entity stack (a replica of assistantView's non-private chrome — the
    /// real one is private; keep the replica honest via TranscriptMetrics).
    private func assistantRow(_ markdown: String) -> some View {
        VStack(alignment: .leading, spacing: TranscriptMetrics.assistantHeaderSpacing) {
            Text("Pi").font(.caption.weight(.semibold)).foregroundStyle(theme.toolAccent)
            EntityStack(entities: markdownEntities(markdown, style: style),
                        theme: theme, typography: typography)
        }
    }

    private func toolCardRow(_ card: ToolCard, expandRich: Bool) -> some View {
        ToolCardView(card: card, theme: theme, typography: typography,
                     expandRich: expandRich, hideInputRich: true,
                     store: CardUIState(), themeID: .oneDark)
    }

    // MARK: - Corpus

    func testMarkdownCorpus() {
        let cases: [(String, String, Double)] = [   // (id, markdown, budget-pt)
            ("prose-short", "Hello there.", 40),
            ("prose-wrap", String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 12), 60),
            ("prose-paras", "First paragraph.\n\nSecond paragraph.\n\nThird.", 50),
            ("code-short", "```\nlet a = 1\nlet b = 2\n```", 50),
            ("code-wraps", "```\n" + String(repeating: "long line of code that must wrap ", count: 8) + "\n```", 70),
            ("code-multi", "```swift\nfunc f() {\n  print(1)\n}\n```\n\n```bash\necho hi\n```", 70),
            ("list-loose", "- one\n- two\n- three", 50),
            ("list-tight", "- a\n- b\n- c\n- d\n- e", 50),
            ("table", "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |", 60),
            ("blockquote", "> quoted line one\n> quoted line two", 50),
            ("headings", "# One\n## Two\n### Three", 70),
            ("mixed-realistic",
             """
             ## Result

             Did the thing, then checked:

             ```swift
             let x = estimate(rendered)
             assert(abs(x - rendered) < tolerance)
             ```

             - first finding
             - second finding

             > Note: the tolerance table lives beside the corpus.
             """, 90),
            // MULTI-BLOCK BATTERY (bigger code sections, richer mixes):
            ("mixed-large-code",
             """
             ## Implementation

             The estimator now handles the wide case:

             ```swift
             func estimate(_ entities: [MarkdownEntity], width: Double) -> Double {
                 var total: Double = 0
                 for (i, e) in entities.enumerated() {
                     if i > 0 { total += paraGap }
                     total += entity(e, style: style, width: width)
                 }
                 for (i, img) in images.enumerated() {
                     if i > 0 || total > 0 { total += 8 }
                     total += imageHeight(img, width: width)
                 }
                 return total + rowChrome
             }

             func entity(_ e: MarkdownEntity, style: MarkdownProseStyle, width: Double) -> Double {
                 switch e {
                 case .prose(let attr):
                     return textHeight(String(attr.characters), size: style.baseSize,
                                       fontName: style.fontName, width: width)
                 case .code(_, let text):
                     let lines = max(1, text.split(separator: "\n").count)
                     return Double(lines) * style.baseSize * 1.3 + 40
                 default:
                     return 0
                 }
             }
             ```

             And the trailing prose wraps a couple of lines to check the gap
             accounting between big blocks and paragraphs after them.
             """, 100),
            ("mixed-code-pair-prose",
             """
             First, the scan:

             ```bash
             find . -name '*.swift' | xargs wc -l | sort -n | tail -20
             ```

             Then the fix:

             ```swift
             let fixed = true
             ```

             Done.
             """, 80),
            ("mixed-table-list-code",
             """
             | kind | Δ | status |
             |---|---|---|
             | table | −25 | backlog |
             | list | −17 | backlog |

             Priorities:

             1. switcher hidden face
             2. output blocks

             ```text
             queue: empty
             ```
             """, 90),
            ("mixed-quote-nested",
             """
             Before:

             > The estimator counts both faces.
             > The renderer shows one.

             After the fix, only the visible face counts — verified:

             ```swift
             XCTAssertLessThan(abs(delta), 100)
             ```
             """, 80),
            ("mixed-long-reply",
             String(repeating: """
             ### Section

             A paragraph that wraps across a couple of lines because it is long enough to do so in the narrow width of the corpus.

             - item one
             - item two
             - item three

             ```swift
             // a code block inside the long reply
             let value = section.index * 2
             print(value)
             ```

             > A closing thought for this section.

             """, count: 4), 140),
        ]
        for width in widths {
            for (id, md, budget) in cases {
                let rendered = measure(assistantRow(md), width: width)
                let est = RowHeightEstimator.estimateText(md, images: [], style: style, width: width)
                let delta = rendered - est
                print(String(format: "HEST w=%3.0f %-18s rendered=%7.1f est=%7.1f Δ=%+7.1f",
                             width, (id as NSString).utf8String!, rendered, est, delta))
                XCTAssertLessThan(abs(delta), budget,
                                  "\(id) @\(Int(width)): rendered \(Int(rendered)) vs est \(Int(est)) (Δ\(Int(delta)))")
                XCTAssertLessThan(abs(delta), 150, "\(id) @\(Int(width)): CATASTROPHIC drift")
            }
        }
    }

    func testToolCardCorpus() {
        func hunk(_ lines: [(String, String)]) -> JSONValue {
            .object(["lines": .array(lines.map { kind, text in
                .object(["kind": .string(kind), "text": .string(text)])
            })])
        }
        let diffHunks: [JSONValue] = [
            hunk([("context", "func old() {"), ("remove", "  return 0"), ("add", "  return 1"), ("context", "}")]),
        ]
        let codeOutput: JSONValue = .object([
            "v": .number(1),
            "blocks": .array([.object(["kind": .string("code"), "text": .string("out1\nout2\nout3"), "lang": .string("bash")])]),
        ])
        let cases: [(String, ToolCard, Double)] = [
            ("card-collapsed-plain",
             ToolCard(toolCallID: "t1", tool: "bash", args: ["command": .string("ls -la")],
                      result: .string("file1\nfile2"), state: .ok), 40),
            ("card-diff",
             ToolCard(toolCallID: "t2", tool: "edit", args: [:], result: nil,
                      state: .ok, hunks: diffHunks), 90),
            ("card-code-output",
             ToolCard(toolCallID: "t3", tool: "bash", args: ["command": .string("make")],
                      result: nil, state: .ok, output: codeOutput), 90),
            ("card-switcher",
             ToolCard(toolCallID: "t4", tool: "edit",
                      args: ["path": .string("/a.swift"), "new_string": .string("let x = 2\nlet y = 3")],
                      state: .ok, hunks: diffHunks), 100),
            ("card-running",
             ToolCard(toolCallID: "t5", tool: "bash", args: ["command": .string("sleep 1")],
                      result: .string("partial output line\nmore output"), state: .running), 80),
            ("card-error",
             ToolCard(toolCallID: "t6", tool: "bash", args: [:],
                      error: "exit 1", state: .failed), 60),
        ]
        for width in widths {
            for (id, card, budget) in cases {
                let rich = ToolCardView.isRich(card)
                let rendered = measure(toolCardRow(card, expandRich: true), width: width)
                let facts = RowHeightEstimator.toolCardFacts(
                    for: card, expanded: true && rich)   // expandRich default true
                _ = rich
                let est = RowHeightEstimator.estimateToolCard(facts, style: style, width: width)
                let delta = rendered - est
                print(String(format: "HEST w=%3.0f %-22s rich=%d rendered=%7.1f est=%7.1f Δ=%+7.1f",
                             width, (id as NSString).utf8String!, rich ? 1 : 0, rendered, est, delta))
                XCTAssertLessThan(abs(delta), budget,
                                  "\(id) @\(Int(width)): rendered \(Int(rendered)) vs est \(Int(est)) (Δ\(Int(delta)))")
                XCTAssertLessThan(abs(delta), 200, "\(id) @\(Int(width)): CATASTROPHIC drift")
            }
        }
    }
}
