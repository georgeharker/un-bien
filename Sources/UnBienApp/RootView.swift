import SwiftUI
#if os(macOS)
import AppKit

/// Without a real `.app` bundle (e.g. `swift run un-bien-mac`), the process
/// launches as an accessory and its window never becomes key — so keystrokes
/// stay with the terminal. Promoting to `.regular` + activating fixes focus.
final class MacActivationDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
#endif

/// Root scene: onboarding until an Owner key exists, then the aggregated
/// relay/session home. Bootstraps identity + relay connections on appear.
public struct RootView: View {
    @StateObject private var model = AppModel()
    @StateObject private var fonts = FontLibrary()

    public init() {}

    public var body: some View {
        Group {
            if model.needsOnboarding {
                OnboardingView()
            } else {
                HomeView()
            }
        }
        .environmentObject(model)
        .environmentObject(fonts)
        .environment(\.appTheme, model.theme)
        .environment(\.typography, model.typography)
        .task {
            fonts.registerAll()
            #if DEBUG
            // Data-feed for testing before the live protocol exists: launch with
            // UNBIEN_DEMO=1 to show ONLY a large demo session. Skip bootstrap so
            // real relays don't connect and pull in live sessions alongside it.
            if ProcessInfo.processInfo.environment["UNBIEN_DEMO"] != nil {
                model.loadDemoSession()
                return
            }
            #endif
            await model.bootstrap()
        }
        .preferredColorScheme(model.theme.isDark ? .dark : .light)
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 520)
        #endif
    }
}

/// Shared SwiftUI app scene. The iOS app target and the macOS executable both
/// launch this via `.main()`.
public struct UnBienSceneApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(MacActivationDelegate.self) private var activationDelegate
    #endif

    public init() {
        // Apply saved render-cache bounds at launch (Settings persists them).
        let defaults = UserDefaults.standard
        if let blocks = defaults.object(forKey: "renderCacheBlocks") as? Int {
            HighlightEngine.shared.cacheLimit = blocks
        }
        if let images = defaults.object(forKey: "renderCacheImages") as? Int {
            ImageCache.shared.cacheLimit = images
        }
    }

    public var body: some Scene {
        WindowGroup {
            RootView()
        }
        #if os(macOS)
        .defaultSize(width: 460, height: 760)
        .windowResizability(.contentMinSize)
        #endif
    }
}
