// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "UnBien",
    platforms: [
        .macOS(.v15),
        .iOS(.v18),
    ],
    products: [
        .library(name: "UnBienCore", targets: ["UnBienCore"]),
        .library(name: "UnBienApp", targets: ["UnBienApp"]),
        .executable(name: "un-bien-mac", targets: ["UnBienMac"]),
    ],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.0"),
        .package(url: "https://github.com/smittytone/HighlighterSwift", from: "3.1.0"),
    ],
    targets: [
        .target(
            name: "UnBienCore"
        ),
        .target(
            name: "UnBienApp",
            dependencies: [
                "UnBienCore",
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "Highlighter", package: "HighlighterSwift"),
            ],
            resources: [.copy("Resources/Fonts")]
        ),
        .executableTarget(
            name: "UnBienMac",
            dependencies: ["UnBienApp"]
        ),
        .testTarget(
            name: "UnBienCoreTests",
            dependencies: ["UnBienCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
