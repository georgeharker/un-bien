import SwiftUI
import UnBienApp

/// macOS entry point — launches the shared SwiftUI root. Run with:
/// `swift run un-bien-mac`.
@main
struct UnBienMacApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .defaultSize(width: 420, height: 720)
    }
}
