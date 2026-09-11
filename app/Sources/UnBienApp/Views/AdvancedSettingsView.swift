import SwiftUI
import UnBienCore

/// Advanced / performance tuning, behind a NavigationLink from Settings so the
/// main page stays uncluttered: render-cache sizes, the transcript window, and
/// the debug activity HUD.
struct AdvancedSettingsView: View {
    // Defaults are the values these were tuned to on device. They apply only
    // to installs that never set them; an existing preference always wins.
    @AppStorage("renderCacheBlocks") private var cacheBlocks = 800
    @AppStorage("renderCacheImages") private var cacheImages = 200
    @AppStorage("renderCacheMessages") private var cacheMessages = 1600
    @AppStorage("transcriptWindowPages") private var windowPages = 8
    @AppStorage("prewarmMaxInFlight") private var prewarmInFlight = 8
    @AppStorage("foldFlushMaxKiB") private var foldFlushKiB = 2048
    #if UNBIEN_DIAGNOSTICS
    @AppStorage("debugActivityHUD") private var debugActivityHUD = false
    #endif

    var body: some View {
        Form {
            Section {
                Stepper("Highlight cache: \(cacheBlocks) blocks", value: $cacheBlocks, in: 50...2000, step: 50)
                    .onChange(of: cacheBlocks) { _, new in AttributedTextCache.shared.cacheLimit = new }
                Stepper("Image cache: \(cacheImages) images", value: $cacheImages, in: 20...1000, step: 20)
                    .onChange(of: cacheImages) { _, new in ImageCache.shared.cacheLimit = new }
                Stepper("Markdown cache: \(cacheMessages) messages", value: $cacheMessages, in: 50...2000, step: 50)
                    .onChange(of: cacheMessages) { _, new in MarkdownEntityStore.shared.cap = new }
                Stepper("Transcript window: \(windowPages) pages", value: $windowPages, in: 3...16, step: 1)
                #if UNBIEN_DIAGNOSTICS
                Stepper("Prewarm in-flight: \(prewarmInFlight)", value: $prewarmInFlight, in: 0...16, step: 1)
                    .onChange(of: prewarmInFlight) { _, new in
                        MarkdownEntityStore.prewarmMaxInFlight = new
                    }
                Stepper("Fold flush ceiling: \(foldFlushKiB) KiB", value: $foldFlushKiB, in: 256...4096, step: 256)
                    .onChange(of: foldFlushKiB) { _, new in
                        AppModel.foldFlushMaxBytes = new * 1024
                    }
                #endif
            } header: {
                Text("Performance")
            } footer: {
                Text("Larger caches keep more highlighted code and decoded images in memory "
                     + "for smoother scrolling on long sessions. A wider transcript window keeps "
                     + "more rows materialised around the viewport - fewer re-renders on "
                     + "back-and-forth scroll, at the cost of more live rows.")
            }
            #if UNBIEN_DIAGNOSTICS
            Section {
                Toggle("Debug activity HUD", isOn: $debugActivityHUD)
            } header: {
                Text("Debug")
            } footer: {
                Text("Live counters (produce / window / reset / extend) overlaid on the "
                     + "transcript. Deltas drop to zero at steady state.")
            }
            #endif
        }
        .formStyle(.grouped)
        .navigationTitle("Advanced")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
