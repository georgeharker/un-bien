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
        .environment(\.appTheme, model.theme)
        .task { await model.bootstrap() }
        .preferredColorScheme(model.theme.isDark ? .dark : .light)
    }
}

/// Shared SwiftUI app scene. The iOS app target and the macOS executable both
/// launch this via `.main()`.
public struct UnBienSceneApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(MacActivationDelegate.self) private var activationDelegate
    #endif

    public init() {}

    public var body: some Scene {
        WindowGroup {
            RootView()
        }
        #if os(macOS)
        .defaultSize(width: 420, height: 720)
        #endif
    }
}
