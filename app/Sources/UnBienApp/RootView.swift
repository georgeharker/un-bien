import SwiftUI
#if os(macOS)
import AppKit

/// Without a real `.app` bundle (e.g. `swift run un-bien-mac`), the process
/// launches as an accessory and its window never becomes key — so keystrokes
/// stay with the terminal. Promoting to `.regular` + activating fixes focus.
@MainActor
final class MacActivationDelegate: NSObject, NSApplicationDelegate {
    /// Set by RootView at launch — the AppModel is a @StateObject one level
    /// down and the adaptor can't inject. Weak: lifetime is the scene's.
    /// Used by `applicationWillTerminate` to flush debounced scroll memory
    /// before the process dies (termination never runs pending Tasks).
    static weak var model: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        Self.model?.flushScrollMemory()
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
    @Environment(\.scenePhase) private var scenePhase

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
        .onOpenURL { model.handleOpenURL($0) }
        #if os(macOS)
        .onAppear { MacActivationDelegate.model = model }
        #endif
        .onChange(of: scenePhase) { _, phase in
            // Leaving the foreground: flush debounced scroll memory NOW —
            // the 500ms write would otherwise race the process being
            // suspended/killed and could lose the final reading position.
            if phase != .active {
                model.flushScrollMemory()
            } else {
                // Returning to the foreground: iOS kills sockets silently in
                // the background (no stream end, no reconnect) — ping-probe
                // each relay and reconnect the dead ones, which re-runs
                // reconstruction for open sessions (the stalled-walk heal).
                model.healConnectionsOnForeground()
            }
        }
        .sheet(item: $model.pendingPairing) { pending in
            ChooseRelayPairSheet(invite: pending.invite)
                .environmentObject(model)
                .environmentObject(fonts)
        }
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
