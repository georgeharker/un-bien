import SwiftUI
import UnBienCore

/// Multi-line on-device activity readout (Settings-gated). Polls RenderActivity
/// every 0.5s; each row is coloured orange when it moved in the last interval,
/// green when quiescent. Tap to toggle a symbol legend. Polls on a timer rather
/// than observing each increment, so the HUD adds no per-event churn of its own.
struct DebugActivityHUD: View {
    @State private var prev: [Int] = []
    @State private var rows: [(text: String, active: Bool)] = []
    @State private var showLegend = false
    private let tick = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if showLegend { legend } else { counters }
        }
        .font(.system(size: 15, weight: .bold, design: .monospaced))
        .padding(8)
        .background(.black.opacity(0.78), in: RoundedRectangle(cornerRadius: 8))
        .onTapGesture { showLegend.toggle() }
        .onReceive(tick) { _ in sample() }
        .onAppear { sample() }
    }

    private var counters: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Text(row.text).foregroundStyle(row.active ? .orange : .green)
            }
        }
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\u{2699} produce   \u{2315} get_entries")
            Text("\u{21BB} window   \u{2298} reset   + extend")
            Text("\u{25A6} bounds-gen   \u{2195} measure/set")
            Text("\u{29D6} in-flight \u{25B6} started \u{2713} done \u{2302} cache")
            Text("\u{2668}\u{FE0E} prewarm: pw spawned \u{23F8}\u{FE0E} deferred(cap) j joined \u{2708}\u{FE0E} in-flight")
            Text("w=wait(spawn+queue) s=self(parse) \u{00B5}s")
            Text("cb flip=fan-out cross=anchor-crossings scr=scroll hp=height-probe")
            Text("tap to close").foregroundStyle(.gray)
        }
        .foregroundStyle(.white)
    }

    private func sample() {
        let raw = RenderActivity.raw()
        let base = prev.count == raw.count ? prev : raw
        func moved(_ idxs: Int...) -> Bool { idxs.contains { raw[$0] != base[$0] } }
        func num(_ i: Int) -> String {
            let delta = raw[i] - base[i]
            return delta > 0 ? "\(raw[i])+\(delta)" : "\(raw[i])"
        }
        // 0 produceStarted 1 produceFinished 2 window 3 reset 4 extend
        // 5 getEntriesStarted 6 getEntriesRetired 7 getEntriesCached
        // 8 boundsInvalidated 9 boundsMeasured 10 boundsSet
        // 11 getEntriesStraggler
        let rr = RenderActivity.lastResetReason, dp = RenderActivity.lastDerivePath
        let ro = RenderActivity.lastResetOldCount, rn = RenderActivity.lastResetNewCount
        let rc = RenderActivity.lastResetCommonPrefix
        let prodRow = "\u{2699} \u{29D6}\(raw[0] - raw[1]) \u{25B6}\(num(0)) \u{2713}\(num(1))"
            + " w\(RenderActivity.produceWaitMicros)\u{00B5}s+s\(RenderActivity.produceSelfMicros)\u{00B5}s"
        let warmRow = "\u{2668}\u{FE0E} pw\(RenderActivity.prewarmStarted) \u{23F8}\u{FE0E}\(RenderActivity.prewarmDeferred)"
            + " j\(RenderActivity.produceJoined) \u{2708}\u{FE0E}\(MarkdownEntityStore.shared.prewarmInFlight) t\(RenderActivity.prewarmTouched)"
            + " \(RenderActivity.produceLastMicros)\u{00B5}s wall"
        rows = [
            (prodRow, moved(0, 1)),
            (warmRow, moved(0, 1)),
            ("\u{2315} \u{29D6}\(raw[5] - raw[6]) \u{25B6}\(num(5)) \u{2713}\(num(6)) \u{2302}\(num(7)) S\(num(11))", moved(5, 6, 7, 11)),
            ("\u{21BA} st\(RenderActivity.walkStarts) tm\(RenderActivity.walkTerminals) sl\(RenderActivity.walkStalls) \(RenderActivity.lastWalkInfo)", false),
            ("\u{21BB} \(num(2)) \(RenderActivity.lastWindowMicros)\u{00B5}s n\(RenderActivity.nearCount)"
                + " f\(RenderActivity.lastFoldMicros)\u{00B5}s\u{00B7}\(RenderActivity.lastFoldBytes / 1024)kB b\(RenderActivity.foldFlushedByBytes)",
                moved(2)),
            ("\u{2318} d\(RenderActivity.scrollDir) ent\(RenderActivity.entityCacheCount) ev\(RenderActivity.entityCacheEvicted)", false),
            ("\u{2298} \(num(3)) \(rr) \(ro)\u{2192}\(rn) c\(rc) dp:\(dp)", moved(3)),
            ("+ \(num(4))", moved(4)),
            ("\u{25A6} \(num(8))", moved(8)),
            ("\u{2195} \u{25B6}\(num(9)) \u{2713}\(num(10)) hd\(RenderActivity.heightDeltasWhileScrolling)p\(RenderActivity.heightDeltaPointsWhileScrolling)"
                + " es\(RenderActivity.heightEstimatesSeeded)e\u{394}\(RenderActivity.heightEstimatesMeasured > 0 ? RenderActivity.heightEstimateErrSum / RenderActivity.heightEstimatesMeasured : 0)"
                + "b\(RenderActivity.heightEstimatesMeasured > 0 ? RenderActivity.heightEstimateBiasSum / RenderActivity.heightEstimatesMeasured : 0)",
                moved(9, 10)),
            // WORST height-delta offender: which row spiked hd/p, how far, and
            // whether it had an estimate at all (!seed = coverage gap, not
            // calibration). Row id is tail-trimmed to fit the HUD.
            ("\u{26A0} \(RenderActivity.worstHeightDelta)pt"
                + " \(RenderActivity.worstHeightDeltaWasSeeded ? "seed" : "NOSEED")"
                + " \(RenderActivity.worstHeightDeltaRow.suffix(18))",
             false),
            ("cb flip\(num(12)) cross\(num(13)) scr\(num(14)) hp\(num(15))", moved(12, 13, 14, 15))
        ]
        prev = raw
    }
}
