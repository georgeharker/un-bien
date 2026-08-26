import SwiftUI
import UnBienApp

/// The shipping app entry (real bundle — iOS simulator/device + macOS).
/// Wraps the shared ``RootView`` from the UnBienApp package.
@main
struct UnBienApplication: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
