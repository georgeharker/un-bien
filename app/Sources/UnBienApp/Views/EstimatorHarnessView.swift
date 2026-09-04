#if DEBUG
import SwiftUI
import UnBienCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif
import os

// ESTIMATOR HARNESS — go/no-go for perf item #4 (analytic height tier,
// risk analysis in .crib/notes/un-bien/estimator-4-mismatch-risk-analysis.md).
//
// The L1-L3 harnesses are standalone swiftc files, but the estimator's
// MEASURED TRUTH is the real TranscriptRow (MarkdownUI + BudgetedContent
// inside) — only observable in the app target. So this harness lives at the
// app layer, routed by launch arg (RootView), and prints proof metrics to
// stdout/os_log — the canned-sequence methodology of perf-harness.swift,
// at the layer where the real renderer exists.
//
//   E1 (go/no-go): error distribution — analytic vs measured for a
//      deterministic markdown corpus, against the 44pt fallback baseline.
//      Variants: NAIVE (boundingRect over the whole raw text) and SMART
//      (fence-aware: code lines x mono line-height, prose paragraphs x
//      wrapped boundingRect, chrome constants CALIBRATED from minimal
//      per-kind rows — the same calibration the app would ship).
//      Gate: smart p90(|err|) < 50% of fallback p90(|err|).
//   E2 (A/B window arithmetic, in-memory after E1): attach counts +
//      first-attach correction totals + blank-visible-row check for the
//      three claim arms (44 / naive / smart) over a scripted anchor walk
//      (identity-anchored, pages 2/3, the app's window semantics).
//   E3: repeat E1 at a second width (760) — the width-sensitivity data
//      the width-keyed heights port needs anyway.
//
// Run (mac): ./build/Build/Products/Debug/UnBien-macOS.app/Contents/MacOS/UnBien-macOS --estimator-harness

private let hlog = Logger(subsystem: "un-bien", category: "estimator-harness")
func ehPrint(_ msg: String) {
    print(msg)
    hlog.info("\(msg, privacy: .public)")
}

// MARK: - Deterministic corpus

private enum RowKind: String, CaseIterable { case user, assistant, tool, reasoning }

private struct RowSpec {
    let id: String
    let kind: RowKind
    let text: String          // raw text the estimator sees
    var isCalibration = false
}

/// Splitmix-ish LCG: deterministic corpus across runs (seeded, no Random).
private struct Seeded {
    var state: UInt64
    init(_ seed: UInt64) { state = seed }
    mutating func next(_ upper: Int) -> Int {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Int((state >> 33) % UInt64(max(upper, 1)))
    }
    mutating func pick<T>(_ items: [T]) -> T { items[next(items.count)] }
}

private nonisolated(unsafe) var rng = Seeded(0x5EED_C0DE)

private let words = ["stream", "window", "anchor", "relay", "envelope", "delta",
                     "husk", "budget", "cursor", "restore", "pin", "hysteresis",
                     "measure", "coalesce", "walk", "terminal", "page", "leaf",
                     "socket", "retry", "watchdog", "flush", "tick", "commit"]

private func sentence(_ r: inout Seeded) -> String {
    let n = 6 + r.next(7)
    return (0..<n).map { _ in r.pick(words) }.joined(separator: " ") + "."
}
private func paragraph(_ r: inout Seeded) -> String {
    (0..<(1 + r.next(3))).map { _ in sentence(&r) }.joined(separator: " ")
}
private func codeBlock(_ r: inout Seeded, lines: Int) -> String {
    var lines = (0..<lines).map { "let v\($0) = compute(\($0 % 9)) // \(r.pick(words))" }
    lines.insert("func run() {", at: 0)
    lines.append("}")
    return "```swift\n" + lines.joined(separator: "\n") + "\n```"
}

private func corpus() -> ([RowSpec], [TranscriptItem]) {
    var specs: [RowSpec] = []
    var items: [TranscriptItem] = []

    func user(_ id: String, _ text: String) {
        specs.append(RowSpec(id: id, kind: .user, text: text))
        items.append(.user(UserBubble(id: id, text: text)))
    }
    func asst(_ id: String, _ text: String, cal: Bool = false) {
        specs.append(RowSpec(id: id, kind: .assistant, text: text, isCalibration: cal))
        items.append(.assistant(AssistantBubble(id: id, inReplyTo: "x", text: text, streaming: false)))
    }
    func tool(_ id: String, _ text: String, cal: Bool = false) {
        specs.append(RowSpec(id: id, kind: .tool, text: text, isCalibration: cal))
        items.append(.tool(ToolCard(toolCallID: id, tool: "bash",
                                    args: ["command": .string("echo hi")],
                                    result: .string(text), state: .ok)))
    }
    func reason(_ id: String, _ text: String, cal: Bool = false) {
        specs.append(RowSpec(id: id, kind: .reasoning, text: text, isCalibration: cal))
        items.append(.reasoning(ReasoningBlock(id: id, text: text, streaming: false)))
    }

    // CALIBRATION rows (minimal per kind + the structural constants):
    // chromeV per kind, paragraph gap, code-block chrome.
    user("cal-user-1", "One line.")
    asst("cal-asst-1", "One line.", cal: true)
    asst("cal-asst-2para", "One line.\n\nOne line.", cal: true)
    asst("cal-asst-code1", "```swift\nlet x = 1\n```", cal: true)
    tool("cal-tool-1", "ok", cal: true)
    reason("cal-reason-1", "One line.", cal: true)

    // CORPUS: the real transcript mix, sizes small → 25KB class.
    for i in 0..<72 {
        let id = "cor-\(String(format: "%03d", i))"
        switch i % 6 {
        case 0: user(id, paragraph(&rng))
        case 1: asst(id, paragraph(&rng))
        case 2:  // markdown doc: paras + list + code
            var doc = ["# Heading \(i)", "", paragraph(&rng), "",
                       "- \(sentence(&rng))", "- \(sentence(&rng))", "",
                       paragraph(&rng), "", codeBlock(&rng, lines: 6 + rng.next(34))]
            if rng.next(2) == 0 { doc += ["", "> \(sentence(&rng))"] }
            asst(id, doc.joined(separator: "\n"))
        case 3: tool(id, (0..<(1 + rng.next(6))).map { _ in sentence(&rng) }.joined(separator: "\n"))
        case 4: reason(id, paragraph(&rng))
        default:  // tall: long code + prose
            asst(id, [paragraph(&rng), "", codeBlock(&rng, lines: 40 + rng.next(80)), "", paragraph(&rng)].joined(separator: "\n"))
        }
        if i == 36 || i == 66 {  // two ~25KB-class monsters
            asst("cor-\(String(format: "%03d", i))-big",
                 [paragraph(&rng), "", codeBlock(&rng, lines: 420), "", paragraph(&rng)].joined(separator: "\n"))
        }
    }
    return (specs, items)
}

// MARK: - Analytic estimator (the candidate the app would ship)

// PlatformFont: the existing public typealias from Theme.swift (NSFont /
// UIFont per platform) — reused, not redeclared.

private func bodyPlatformFont(size: CGFloat = 15) -> PlatformFont {
    #if os(macOS)
    .systemFont(ofSize: size)
    #else
    .systemFont(ofSize: size)
    #endif
}
private func monoPlatformFont(size: CGFloat = 13) -> PlatformFont {
    #if os(macOS)
    .monospacedSystemFont(ofSize: size, weight: .regular)
    #else
    .monospacedSystemFont(ofSize: size, weight: .regular)
    #endif
}

private func textHeight(_ s: String, font: PlatformFont, width: Double) -> Double {
    guard !s.isEmpty else { return 0 }
    let attr = NSAttributedString(string: s, attributes: [.font: font])
    let rect = attr.boundingRect(
        with: CGSize(width: width, height: .greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    return rect.height.rounded()
}

/// Calibrated estimator constants (measured from the calibration rows —
/// the app would measure these once and ship them as literals).
private struct EstimatorKit {
    let lineHeightBody: Double
    let lineHeightMono: Double
    var chromeV: [RowKind: Double] = [:]   // measured(minimal row) − 1 line
    var paraGap: Double = 0                // extra between markdown blocks
    var codeChrome: Double = 0             // code block padding+margin

    /// Horizontal content width per kind at container width w (from the row
    /// views' paddings: user bubble 10x2; assistant 10x2 + code 12x2;
    /// tool/reasoning 10x2).
    func contentWidth(_ kind: RowKind, _ w: Double) -> Double {
        switch kind {
        case .user, .tool, .reasoning: return w - 20
        case .assistant: return w - 24
        }
    }

    /// NAIVE: one boundingRect over the whole raw text.
    func naive(_ spec: RowSpec, width: Double) -> Double {
        let cw = contentWidth(spec.kind, width)
        let h: Double
        switch spec.kind {
        case .tool: h = textHeight(spec.text, font: monoPlatformFont(), width: cw)
        default: h = textHeight(spec.text, font: bodyPlatformFont(), width: cw)
        }
        return h + (chromeV[spec.kind] ?? 0)
    }

    /// SMART: fence-aware line classification.
    func smart(_ spec: RowSpec, width: Double) -> Double {
        let cw = contentWidth(spec.kind, width)
        switch spec.kind {
        case .user, .reasoning:
            return textHeight(spec.text, font: bodyPlatformFont(), width: cw) + (chromeV[.user] ?? 0)
        case .tool:
            return textHeight(spec.text, font: monoPlatformFont(), width: cw) + (chromeV[.tool] ?? 0)
        case .assistant:
            var inFence = false, prose = "", total = 0.0, blocks = 0
            var codeLines = 0
            func flushProse() {
                guard !prose.isEmpty else { return }
                total += textHeight(prose, font: bodyPlatformFont(), width: cw)
                prose = ""
                blocks += 1
            }
            func flushFence() {
                guard codeLines > 0 else { return }
                total += Double(codeLines) * lineHeightMono + codeChrome
                codeLines = 0
                blocks += 1
            }
            for line in spec.text.split(separator: "\n", omittingEmptySubsequences: false) {
                if line.hasPrefix("```") {
                    if inFence { flushFence(); inFence = false } else { flushProse(); inFence = true }
                } else if inFence {
                    codeLines += 1
                } else {
                    prose += line + "\n"
                }
            }
            flushProse(); flushFence()
            // Inter-block gaps: one paraGap between each pair of blocks.
            return total + (chromeV[.assistant] ?? 0) + Double(max(blocks - 1, 0)) * paraGap
        }
    }
}

// MARK: - Stats

private func quantile(_ values: [Double], _ q: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let idx = min(Int((q * Double(sorted.count - 1)).rounded()), sorted.count - 1)
    return sorted[idx]
}
private struct ErrStats {
    let absMed: Double, absP90: Double, absP99: Double
    let bias: Double   // signed mean (analytic − measured)
    let worst: Double
    init(_ errs: [Double]) {
        absMed = quantile(errs.map(abs), 0.5)
        absP90 = quantile(errs.map(abs), 0.9)
        absP99 = quantile(errs.map(abs), 0.99)
        bias = errs.reduce(0, +) / Double(max(errs.count, 1))
        worst = errs.map(abs).max() ?? 0
    }
}

// MARK: - E2: window arithmetic A/B (the app's semantics, in-memory)

/// Intersection-semantics window (mirrors perf-harness MiniDriver / the app):
/// attach within `pages` of the anchor by CLAIMED heights.
private func windowRange(order: [String], claims: [String: Double], center: Int,
                         pages: Double, viewport: Double, spacing: Double) -> Range<Int> {
    guard !order.isEmpty else { return 0..<0 }
    let c = min(max(center, 0), order.count - 1)
    var last = c, budget = (1 + pages) * viewport, i = c
    while i < order.count {
        if i > c, budget <= 0 { break }
        budget -= (claims[order[i]] ?? 44) + spacing
        last = i; i += 1
    }
    var first = c, up = pages * viewport
    i = c - 1
    while i >= 0 {
        if up <= 0 { break }
        up -= (claims[order[i]] ?? 44) + spacing
        first = i; i -= 1
    }
    return first..<last + 1
}

/// One arm of the A/B: walk the anchor tail→head, count attach events,
/// first-attach correction px, and blank rows (visible by MEASURED extent,
/// but left detached by the claim-based window).
private func walkArm(name: String, order: [String], claims: [String: Double],
                     measured: [String: Double], viewport: Double = 700,
                     spacing: Double = 8, attachPages: Double = 2, detachPages: Double = 3) {
    var near = Set<Int>(), attaches = 0, correction = 0.0, maxCorrection = 0.0, blanks = 0
    var firstAttach: Set<String> = []
    // Measured extents once — the blank check needs truth, not claims.
    var offsets: [Double] = [], acc = 0.0
    for id in order { offsets.append(acc); acc += (measured[id] ?? 44) + spacing }
    for center in stride(from: order.count - 1, through: 0, by: -5) {
        let attach = Set(windowRange(order: order, claims: claims, center: center,
                                     pages: attachPages, viewport: viewport, spacing: spacing).map { $0 })
        let keep = Set(windowRange(order: order, claims: claims, center: center,
                                   pages: detachPages, viewport: viewport, spacing: spacing).map { $0 })
        let newNear = attach.union(keep)
        for i in newNear.subtracting(near) {
            attaches += 1
            let id = order[i]
            if !firstAttach.contains(id), let m = measured[id] {
                firstAttach.insert(id)
                let d = abs((claims[id] ?? 44) - m)
                correction += d; maxCorrection = max(maxCorrection, d)
            }
        }
        near = newNear
        // Viewport around the anchor row's measured extent (anchor centered).
        let centerMid = offsets[center] + (measured[order[center]] ?? 44) / 2
        let vpStart = centerMid - viewport / 2
        for (i, id) in order.enumerated() {
            let h = measured[id] ?? 44
            if offsets[i] < vpStart + viewport, offsets[i] + h > vpStart, !near.contains(i) {
                blanks += 1
            }
        }
    }
    ehPrint("E2 [\(name)]: attaches=\(attaches) correctionSum=\(Int(correction))px max=\(Int(maxCorrection))px blanks=\(blanks)")
}

// MARK: - Harness view

struct EstimatorHarnessView: View {
    private let theme = ThemeID.tokyoNight.theme
    private let typography = Typography()
    private let specs: [RowSpec]
    private let items: [TranscriptItem]
    @State private var measured: [String: Double] = [:]
    @State private var width: Double = 480
    @State private var phase = ""

    init() {
        let (s, i) = corpus()
        specs = s
        items = i
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("ESTIMATOR HARNESS — \(phase) w\(Int(width)) measured \(measured.count)")
                .font(.system(size: 10, design: .monospaced))
                .padding(6)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(items) { item in
                        TranscriptRow(item: item, themeID: .tokyoNight, theme: theme,
                                      typography: typography, expandRich: true, hideInputRich: true)
                            .equatable()
                            .background(
                                GeometryReader { geo in
                                    Color.clear.onAppear { record(item.id, geo.size.height) }
                                        .onChange(of: geo.size.height) { _, h in record(item.id, h) }
                                })
                    }
                }
                .padding()
            }
            .frame(width: width, height: 700)
        }
        .frame(width: width + 40)
        .task { await run() }
    }

    private func record(_ id: String, _ h: Double) {
        guard h > 0 else { return }
        if measured[id] != h { measured[id] = h }
    }

    private func run() async {
        ehPrint("=== ESTIMATOR HARNESS (perf #4 go/no-go) ===")
        phase = "pass 1 (w480)"; width = 480
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        var snap1 = measured
        try? await Task.sleep(nanoseconds: 800_000_000)
        let drift = snap1 != measured
        if drift { snap1 = measured; try? await Task.sleep(nanoseconds: 1_000_000_000); snap1 = measured }
        ehPrint("w480: measured \(snap1.count)/\(items.count) rows\(drift ? " (late settle — async highlight)" : "")")
        analyze(snap1, width: 480)

        phase = "pass 2 (w760)"; width = 760
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        var snap2 = measured
        try? await Task.sleep(nanoseconds: 800_000_000)
        snap2 = measured
        ehPrint("w760: measured \(snap2.count)/\(items.count) rows")
        analyze(snap2, width: 760)

        ehPrint("=== DONE ===")
        phase = "done"
    }

    private func analyze(_ measured: [String: Double], width w: Double) {
        let kit = calibrate(measured)
        var fallbackErrs: [Double] = [], naiveErrs: [Double] = [], smartErrs: [Double] = []
        var smartByKind: [RowKind: [Double]] = [:]
        for spec in specs where !spec.isCalibration {
            guard let m = measured[spec.id] else { continue }
            fallbackErrs.append(44 - m)
            naiveErrs.append(kit.naive(spec, width: w) - m)
            let se = kit.smart(spec, width: w) - m
            smartErrs.append(se)
            smartByKind[spec.kind, default: []].append(se)
        }
        let f = ErrStats(fallbackErrs), n = ErrStats(naiveErrs), s = ErrStats(smartErrs)
        ehPrint("E1 w\(Int(w)) n=\(fallbackErrs.count) rows")
        ehPrint("  fallback(44): med |\(Int(f.absMed))| p90 |\(Int(f.absP90))| p99 |\(Int(f.absP99))| worst \(Int(f.worst)) bias \(Int(f.bias))")
        ehPrint("  naive:        med |\(Int(n.absMed))| p90 |\(Int(n.absP90))| p99 |\(Int(n.absP99))| worst \(Int(n.worst)) bias \(Int(n.bias))")
        ehPrint("  smart:        med |\(Int(s.absMed))| p90 |\(Int(s.absP90))| p99 |\(Int(s.absP99))| worst \(Int(s.worst)) bias \(Int(s.bias))")
        for kind in RowKind.allCases {
            guard let errs = smartByKind[kind], !errs.isEmpty else { continue }
            let k = ErrStats(errs)
            ehPrint("    smart[\(kind.rawValue)]: n=\(errs.count) med |\(Int(k.absMed))| p90 |\(Int(k.absP90))| worst \(Int(k.worst)) bias \(Int(k.bias))")
        }
        let gate = s.absP90 < 0.5 * f.absP90
        ehPrint("  GATE w\(Int(w)): smart p90 \(Int(s.absP90)) vs 0.5xfallback \(Int(0.5 * f.absP90)) -> \(gate ? "PASS" : "FAIL")")

        // E2: A/B window walk with the three claim arms.
        let order = specs.map(\.id)
        let naiveH = Dictionary(uniqueKeysWithValues: specs.map { ($0.id, kit.naive($0, width: w)) })
        let smartH = Dictionary(uniqueKeysWithValues: specs.map { ($0.id, kit.smart($0, width: w)) })
        walkArm(name: "fallback", order: order, claims: [:], measured: measured)
        walkArm(name: "naive", order: order, claims: naiveH, measured: measured)
        walkArm(name: "smart", order: order, claims: smartH, measured: measured)
    }

    /// Calibrate the kit from the calibration rows (chromeV per kind,
    /// paraGap, codeChrome) — exactly what the app would ship as literals.
    private func calibrate(_ measured: [String: Double]) -> EstimatorKit {
        let body = bodyPlatformFont()
        let mono = monoPlatformFont()
        var kit = EstimatorKit(lineHeightBody: textHeight("Ag", font: body, width: 10_000),
                               lineHeightMono: textHeight("Ag", font: mono, width: 10_000))
        func chrome(_ id: String, _ kind: RowKind, lineH: Double) {
            guard let m = measured[id] else { return }
            kit.chromeV[kind] = m - lineH
        }
        chrome("cal-user-1", .user, lineH: kit.lineHeightBody)
        chrome("cal-asst-1", .assistant, lineH: kit.lineHeightBody)
        chrome("cal-tool-1", .tool, lineH: kit.lineHeightMono)
        chrome("cal-reason-1", .reasoning, lineH: kit.lineHeightBody)
        if let two = measured["cal-asst-2para"] {
            kit.paraGap = two - 2 * kit.lineHeightBody - (kit.chromeV[.assistant] ?? 0)
        }
        if let code = measured["cal-asst-code1"] {
            kit.codeChrome = code - kit.lineHeightMono - (kit.chromeV[.assistant] ?? 0)
        }
        ehPrint("kit w\(Int(width)): lineBody=\(String(format: "%.1f", kit.lineHeightBody)) lineMono=\(String(format: "%.1f", kit.lineHeightMono)) paraGap=\(String(format: "%.1f", kit.paraGap)) codeChrome=\(String(format: "%.1f", kit.codeChrome)) chromeV=\(kit.chromeV.mapValues { Int($0) })")
        return kit
    }
}
#endif
