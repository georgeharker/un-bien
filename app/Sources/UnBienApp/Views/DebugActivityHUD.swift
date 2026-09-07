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
        .font(.system(size: 16, weight: .bold, design: .monospaced))
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
        // 11 getEntriesStraggler 12 getEntriesRefetch
        rows = [
            ("\u{2699} \u{29D6}\(raw[0] - raw[1]) \u{25B6}\(num(0)) \u{2713}\(num(1)) \(RenderActivity.produceLastMicros)\u{00B5}s", moved(0, 1)),
            ("\u{2315} \u{29D6}\(raw[5] - raw[6]) \u{25B6}\(num(5)) \u{2713}\(num(6)) \u{2302}\(num(7)) S\(num(11)) R\(num(12))", moved(5, 6, 7, 11, 12)),
            ("\u{21BB} \(num(2)) \(RenderActivity.lastWindowMicros)\u{00B5}s n\(RenderActivity.nearCount)", moved(2)),
            ("\u{2298} \(num(3)) \(RenderActivity.lastResetReason)", moved(3)),
            ("+ \(num(4))", moved(4)),
            ("\u{25A6} \(num(8))", moved(8)),
            ("\u{2195} \u{25B6}\(num(9)) \u{2713}\(num(10))", moved(9, 10)),
            ("cb flip\(num(13)) cross\(num(14)) scr\(num(15)) hp\(num(16))", moved(13, 14, 15, 16))
        ]
        prev = raw
    }
}
