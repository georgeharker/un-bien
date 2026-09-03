// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "streaming-markdown-spike",
    platforms: [
        .macOS(.v15),
    ],
    dependencies: [
        // The CANDIDATE: Microsoft Copilot's streaming renderer. Revision-
        // pinned (their highlightswift dep is revision-pinned, so SPM forbids
        // a stable-version requirement on it) — mirrors their own pin style.
        .package(url: "https://github.com/microsoft/SwiftStreamingMarkdown", revision: "95bb755a9b23a1aea8682b9ebc912cb72b176c95"),
        // The CONTROL: what the app renders with today.
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.0"),
    ],
    targets: [
        .executableTarget(
            name: "SpikeHarness",
            dependencies: [
                .product(name: "SwiftStreamingMarkdown", package: "SwiftStreamingMarkdown"),
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
            ],
            path: "Sources/SpikeHarness"
        ),
    ]
)
