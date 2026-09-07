import SwiftUI
import UnBienCore

/// Advanced / performance tuning, behind a NavigationLink from Settings so the
/// main page stays uncluttered: render-cache sizes, the transcript window, and
/// the debug activity HUD.
struct AdvancedSettingsView: View {
    @AppStorage("renderCacheBlocks") private var cacheBlocks = 400
    @AppStorage("renderCacheImages") private var cacheImages = 200
    @AppStorage("renderCacheMessages") private var cacheMessages = 400
    @AppStorage("transcriptWindowPages") private var windowPages = 3
    @AppStorage("debugActivityHUD") private var debugActivityHUD = false
    @AppStorage("useBisectionWindow") private var useBisection = false

    var body: some View {
        Form {
            Section {
                Stepper("Highlight cache: \(cacheBlocks) blocks", value: $cacheBlocks, in: 50...2000, step: 50)
                    .onChange(of: cacheBlocks) { _, new in AttributedTextCache.shared.cacheLimit = new }
                Stepper("Image cache: \(cacheImages) images", value: $cacheImages, in: 20...1000, step: 20)
                    .onChange(of: cacheImages) { _, new in ImageCache.shared.cacheLimit = new }
                Stepper("Markdown cache: \(cacheMessages) messages", value: $cacheMessages, in: 50...2000, step: 50)
                    .onChange(of: cacheMessages) { _, new in MarkdownEntityStore.shared.cap = new }
                Stepper("Transcript window: \(windowPages) pages", value: $windowPages, in: 3...8, step: 1)
            } header: {
                Text("Performance")
            } footer: {
                Text("Larger caches keep more highlighted code and decoded images in memory "
                     + "for smoother scrolling on long sessions. A wider transcript window keeps "
                     + "more rows materialised around the viewport - fewer re-renders on "
                     + "back-and-forth scroll, at the cost of more live rows.")
            }
            Section {
                Toggle("Debug activity HUD", isOn: $debugActivityHUD)
                Toggle("Bisection window (experimental)", isOn: $useBisection)
            } header: {
                Text("Debug")
            } footer: {
                Text("Live counters (produce / window / reset / extend) overlaid on the "
                     + "transcript. Deltas drop to zero at steady state.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Advanced")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
