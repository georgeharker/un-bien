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
    private let widths: [Double] = [370, 760]   // iPhone-17-ish portrait content, tablet

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

    /// Drive every producer the card will render through the shared cache
    /// BEFORE measuring. `AsyncAttributedText` falls back to
    /// `Text(producer.plainText)` on a miss and `DiffProducer.plainText` is
    /// "", so a COLD first measurement renders an empty diff and reads short.
    /// That — not DisclosureGroup — is what made each diff card's first touch
    /// unmeasurable while every later touch (warm process-wide cache) was fine.
    private func prewarm(_ card: ToolCard) async {
        if let diff = ToolCardView.diffProducer(for: card, theme: theme, themeID: .oneDark) {
            _ = await AttributedTextCache.shared.attributed(diff)
        }
        if let content = ToolCardView.contentProducer(for: card, theme: theme,
                                                      typography: typography,
                                                      toolBudget: toolBudget) {
            _ = await AttributedTextCache.shared.attributed(content)
        }
        for block in ToolCardView.outputBlocks(for: card) {
            switch block["kind"]?.stringValue {
            case "code":
                guard let text = block["text"]?.stringValue, !text.isEmpty else { continue }
                _ = await AttributedTextCache.shared.attributed(HighlightProducer(
                    code: String(text.prefix(toolBudget)), language: block["lang"]?.stringValue,
                    style: theme.codeHighlightStyle, font: typography.monoPlatformFont()))
            case "diff":
                if let hunks = block["hunks"]?.arrayValue, !hunks.isEmpty {
                    _ = await AttributedTextCache.shared.attributed(DiffProducer(
                        toolCallID: card.toolCallID, themeID: "\(ThemeID.oneDark)", hunks: hunks,
                        add: theme.success, remove: theme.error, context: theme.secondaryText))
                } else if let text = block["text"]?.stringValue, !text.isEmpty {
                    _ = await AttributedTextCache.shared.attributed(HighlightProducer(
                        code: String(text.prefix(toolBudget)), language: "diff",
                        style: theme.codeHighlightStyle, font: typography.monoPlatformFont()))
                }
            default: continue
            }
        }
    }

    private func toolCardRow(_ card: ToolCard, expandRich: Bool,
                             hideInputRich: Bool) -> some View {
        toolCardRow(card, expandRich: expandRich, hideInputRich: hideInputRich,
                    typography: typography)
    }

    private func toolCardRow(_ card: ToolCard, expandRich: Bool, hideInputRich: Bool,
                            typography: Typography) -> some View {
        ToolCardView(card: card, theme: theme, typography: typography,
                     expandRich: expandRich, hideInputRich: hideInputRich,
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
            ("trigger-inline-code-dense",
             """
             Right — the truth from `EntityStack` itself, via `grep -nE` on the
             `.padding(12)` calls and the `VStack(spacing: 8)` in `body`:

             | Item | reality | estimate |
             |---|---|---|
             | inter-entity gap | `spacing: 8` flat | `paraGap 12` wrong |
             | code block | `.padding(12)` = 24 vertical | `codeChrome 48` wrong |
             | list items | `isTight ? 2 : 8` | flat `4` wrong |

             The `DiffProducer` path is `tool-card-only` — `hunks` + `budget:
             Int = 800` — while `markdownEstimateMetrics` scans fences with
             `ceil(chars / charsPerLine)` and `monospacedSystemFont` metrics.
             """, 90),
            ("diff-fence-wrapping",
             "```diff\n"
             + "-    // Session scope for the driver's leading-pass PREWARM keys (design\n"
             + "-    // 01M24A9NR) — the same session scoping MarkdownEntitiesView keys under.\n"
             + "-    @Environment(\\.sessionScope) private var sessionScope\n"
             + "+    // Session scope for the driver's leading-pass PREWARM keys (design\n"
             + "+    // 01M24A9NR) — the same session scoping MarkdownEntitiesView keys under.\n"
             + "+    @Environment(\\.sessionScope) private var sessionScope\n"
             + "+    @Environment(\\.cardUIState) private var cardUI\n"
             + "```", 70),
            ("table-wide-wraps",
             "| column one | column two | column three | column four |\n"
             + "|---|---|---|---|\n"
             + "| a long cell value that certainly wraps | short | another long value that wraps twice over | x |\n"
             + "| more wrapped content here too | y | z | also fairly long content in this cell |", 70),
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

    func testToolCardCorpus() async {
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
        // OUTPUT-as-diff: the shape the corpus was missing. A `diff` block
        // carries `hunks`, not `text`, so it contributed zero estimated lines
        // while rendering a full diff — invisible here until this case existed.
        let diffOutput: JSONValue = .object([
            "v": .number(1),
            "blocks": .array([.object([
                "kind": .string("diff"),
                "hunks": .array([hunk([
                    ("context", "@@ tool output diff @@"),
                    ("remove", "  let oldValue = computeTheThing(withAVeryLongArgumentName: true)"),
                    ("add", "  let newValue = computeTheThing(withAVeryLongArgumentName: false)"),
                    ("context", "  return newValue"),
                ])]),
            ])]),
        ])
        // HISTORICAL diff output: text instead of hunks. Replay carries this
        // shape, and it wraps like any other long code line.
        let historicalDiffOutput: JSONValue = .object([
            "v": .number(1),
            "blocks": .array([.object([
                "kind": .string("diff"),
                "text": .string("""
                @@ historical @@
                -  let oldValue = computeTheThing(withAVeryLongArgumentName: true)
                +  let newValue = computeTheThing(withAVeryLongArgumentName: false)
                   return newValue
                """),
            ])]),
        ])
        let cases: [(String, ToolCard, Double)] = [
            // BUDGETS (2026-09-11): tightened 40-100 -> 12 after the wrap,
            // section-label, hideInputRich, trailing-newline and cold-cache
            // fixes brought worst-case error to 6.1pt. The old budgets were
            // wide enough to pass a 10x regression in silence.
            ("card-collapsed-plain",
             ToolCard(toolCallID: "t1", tool: "bash", args: ["command": .string("ls -la")],
                      result: .string("file1\nfile2"), state: .ok), 12),
            ("card-diff-wrapping",
             ToolCard(toolCallID: "t7", tool: "edit", args: [:], result: nil,
                      state: .ok,
                      hunks: [hunk([
                        ("remove", "    // Session scope for the driver's leading-pass PREWARM keys (design"),
                        ("remove", "    // 01M24A9NR) — the same session scoping MarkdownEntitiesView keys under."),
                        ("remove", "    @Environment(\\.sessionScope) private var sessionScope"),
                        ("add", "    // Session scope for the driver's leading-pass PREWARM keys (design"),
                        ("add", "    // 01M24A9NR) — the same session scoping MarkdownEntitiesView keys under."),
                        ("add", "    @Environment(\\.sessionScope) private var sessionScope"),
                        ("add", "    @Environment(\\.cardUIState) private var cardUI"),
                      ])]), 12),
            ("card-diff",
             ToolCard(toolCallID: "t2", tool: "edit", args: [:], result: nil,
                      state: .ok, hunks: diffHunks), 12),
            ("card-code-output",
             ToolCard(toolCallID: "t3", tool: "bash", args: ["command": .string("make")],
                      result: nil, state: .ok, output: codeOutput), 12),
            ("card-diff-output",
             ToolCard(toolCallID: "t8", tool: "bash", args: ["command": .string("git diff")],
                      result: nil, state: .ok, output: diffOutput), 12),
            ("card-diff-historical",
             ToolCard(toolCallID: "t9", tool: "bash", args: ["command": .string("git show")],
                      result: nil, state: .ok, output: historicalDiffOutput), 12),
            ("card-switcher",
             ToolCard(toolCallID: "t4", tool: "edit",
                      args: ["path": .string("/a.swift"), "new_string": .string("let x = 2\nlet y = 3")],
                      state: .ok, hunks: diffHunks), 12),
            ("card-running",
             ToolCard(toolCallID: "t5", tool: "bash", args: ["command": .string("sleep 1")],
                      result: .string("partial output line\nmore output"), state: .running), 12),
            ("card-error",
             ToolCard(toolCallID: "t6", tool: "bash", args: [:],
                      error: "exit 1", state: .failed), 12),
        ]
        // BOTH pref states: hideInputRich gates the "input" section, so an
        // estimator blind to it is wrong in exactly one of them.
        for width in widths {
          for hideInputRich in [true, false] {
            for (id, card, budget) in cases {
                let rich = ToolCardView.isRich(card)
                await prewarm(card)
                let rendered = measure(toolCardRow(card, expandRich: true,
                                                   hideInputRich: hideInputRich), width: width)
                let facts = RowHeightEstimator.toolCardFacts(
                    for: card, expanded: true && rich,   // expandRich default true
                    hideInputRich: hideInputRich)
                _ = rich
                let est = RowHeightEstimator.estimateToolCard(facts, style: style, width: width)
                let delta = rendered - est
                let id = "\(id)\(hideInputRich ? "" : "/show-input")"
                // (The old TRUTH GUARD here blamed NSHostingView/DisclosureGroup
                // for diff cards measuring short. It was a COLD CACHE: a producer
                // miss renders Text(plainText), and DiffProducer.plainText is "".
                // prewarm() above fixes it, so every case is measurable now.)
                print(String(format: "HEST w=%3.0f %-22s rich=%d rendered=%7.1f est=%7.1f Δ=%+7.1f",
                             width, (id as NSString).utf8String!, rich ? 1 : 0, rendered, est, delta))
                XCTAssertLessThan(abs(delta), budget,
                                  "\(id) @\(Int(width)): rendered \(Int(rendered)) vs est \(Int(est)) (Δ\(Int(delta)))")
                XCTAssertLessThan(abs(delta), 200, "\(id) @\(Int(width)): CATASTROPHIC drift")
            }
          }
        }
    }

    // MARK: - Write cards / wrap

    /// WRITE-CARD WRAP. A write card renders a whole file as a code block, so
    /// its height is dominated by how its lines WRAP, not how many there are.
    /// A real-session survey put this kind at mean |d| 1160pt and worst 2546pt
    /// — by far the largest estimator error, and big enough to shove the
    /// viewport mid-scroll when the real measure lands.
    ///
    /// The shapes here are modelled on that survey's worst offenders (long
    /// prose lines, mean ~90 chars, max ~600) rather than copied from it, plus
    /// the two cases a character-count wrap model gets wrong on its own terms:
    /// unbreakable tokens wider than the line, and content past `toolBudget`
    /// where the card truncates and offers SHOW ALL.
    ///
    /// Swept across text scales because a wrap model that is only right at one
    /// font size is not a wrap model.
    func testToolWriteWrapCorpus() async {
        func repeated(_ unit: String, lines: Int) -> String {
            (0..<lines).map { "\($0) " + unit }.joined(separator: "\n")
        }
        // ~90 chars average with a long tail, the survey's profile.
        let prose = (0..<40).map { i -> String in
            i % 4 == 0
                ? "Short note \(i)."
                : "Paragraph \(i) explaining a decision at some length so that the line must wrap "
                    + "several times at phone width and exercise the greedy fill properly."
        }.joined(separator: "\n")
        // Tokens wider than the content column: the hard-break path.
        let identifiers = repeated(
            "let resultOfCallingSomething = computeTheThing(withAnExtremelyLongArgumentLabel:)",
            lines: 20)
        let overBudget = repeated(
            "filler line that is comfortably long enough to wrap at least twice over",
            lines: 260)   // > toolBudget characters

        // BUDGETS: absolute points, but the residual here is PER-LINE — the
        // estimate still lands ~4% short on wrapped line COUNT, so a card with
        // more lines misses by more. These gate the 2546pt-class error this
        // test exists for; closing the 4% needs the render's true content
        // column, which the harness cannot observe directly.
        let cases: [(String, String, Double)] = [   // (id, content, budget-pt)
            ("write-short", "let a = 1\nlet b = 2", 12),
            ("write-prose-wrap", prose, 120),
            ("write-long-identifiers", identifiers, 60),
            ("write-over-budget", overBudget, 200),
        ]
        XCTAssertGreaterThan(overBudget.count, toolBudget, "over-budget case must truncate")

        for scale in [1.0, 1.15] {
            let typography = Typography(textScale: scale)
            let style = markdownProseStyle(theme: theme, typography: typography)
            for (id, content, budget) in cases {
                let card = ToolCard(
                    toolCallID: "w-\(id)-\(scale)", tool: "write",
                    args: ["path": .string("/tmp/\(id).swift"), "content": .string(content)],
                    result: nil, state: .ok)
                if let producer = ToolCardView.contentProducer(
                    for: card, theme: theme, typography: typography, toolBudget: toolBudget) {
                    _ = await AttributedTextCache.shared.attributed(producer)
                }
                let rendered = measure(
                    toolCardRow(card, expandRich: true, hideInputRich: true,
                                typography: typography),
                    width: 370)
                let facts = RowHeightEstimator.toolCardFacts(
                    for: card, expanded: ToolCardView.isRich(card), hideInputRich: true)
                let est = RowHeightEstimator.estimateToolCard(facts, style: style, width: 370)
                let delta = rendered - est
                print(String(format: "HWRAP scale=%.2f %-24s rendered=%8.1f est=%8.1f d=%+8.1f",
                             scale, (id as NSString).utf8String!, rendered, est, delta))
                XCTAssertLessThan(abs(delta), budget,
                                  "\(id) @scale \(scale): rendered \(Int(rendered)) "
                                  + "vs est \(Int(est)) (d\(Int(delta)))")
            }
        }
    }
}
