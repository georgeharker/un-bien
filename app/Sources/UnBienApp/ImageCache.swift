import Foundation
import UnBienCore
#if os(macOS)
import AppKit
public typealias PlatformImage = NSImage
#else
import UIKit
public typealias PlatformImage = UIImage
#endif

/// Shared, bounded cache for decoded `WireImage`s.
///
/// `WireImageView` decoded base64 + built an `NSImage`/`UIImage` in its `body`,
/// so every scroll re-decoded every visible image. This caches the decoded
/// platform image keyed by the base64 payload (its identity). Bound is a
/// configurable option (`cacheLimit`). Thread-safe (NSCache), `@unchecked Sendable`.
public final class ImageCache: @unchecked Sendable {
    public static let shared = ImageCache()

    private let cache = NSCache<NSString, PlatformImage>()

    /// Max cached decoded images. Configurable (Settings); default 200.
    public var cacheLimit: Int {
        get { cache.countLimit }
        set { cache.countLimit = max(0, newValue) }
    }

    private init() { cache.countLimit = 200 }

    /// Decoded image for `wire`, from cache when available.
    public func image(for wire: WireImage) -> PlatformImage? {
        let key = wire.data as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let data = Self.decodedData(wire), let image = PlatformImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    /// Tolerant base64 decode: strip a `data:<mime>;base64,` prefix and ignore
    /// whitespace/newlines (strict `Data(base64Encoded:)` rejects both).
    public static func decodedData(_ wire: WireImage) -> Data? {
        var payload = wire.data
        if let comma = payload.range(of: ","), payload.hasPrefix("data:") {
            payload = String(payload[comma.upperBound...])
        }
        return Data(base64Encoded: payload, options: .ignoreUnknownCharacters)
    }

    public func clear() { cache.removeAllObjects() }
}
