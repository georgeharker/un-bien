import Foundation
import CoreText
import SwiftUI

/// Registers custom fonts so the app can use them (e.g. MesloLGS Nerd Font).
/// Sources, both registered at launch: bundled `.ttf/.otf` under
/// `Resources/Fonts`, and user-imported files copied into Application Support.
/// Import (`importFont`) is the "pull a font" path — no rebuild needed.
@MainActor
public final class FontLibrary: ObservableObject {
    /// Family names of successfully registered custom fonts, sorted, unique.
    @Published public private(set) var installedFamilies: [String] = []

    private var families = Set<String>()

    public init() {}

    /// Directory where imported fonts are persisted.
    public var fontsDirectory: URL {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("un-bien/Fonts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Register every bundled + imported font. Idempotent (re-registration of an
    /// already-registered file is ignored).
    public func registerAll() {
        for url in bundledFontURLs() + importedFontURLs() {
            register(url)
        }
        publish()
    }

    /// Copy a user-picked font into the fonts dir and register it. Returns the
    /// family name(s) it added.
    @discardableResult
    public func importFont(from source: URL) throws -> [String] {
        let needsScope = source.startAccessingSecurityScopedResource()
        defer { if needsScope { source.stopAccessingSecurityScopedResource() } }

        let dest = fontsDirectory.appendingPathComponent(source.lastPathComponent)
        if FileManager.default.fileExists(atPath: dest.path) {
            try? FileManager.default.removeItem(at: dest)
        }
        try FileManager.default.copyItem(at: source, to: dest)
        let added = register(dest)
        publish()
        return added
    }

    // MARK: - Private

    private func bundledFontURLs() -> [URL] {
        guard let dir = Bundle.module.url(forResource: "Fonts", withExtension: nil) else { return [] }
        return fontFiles(in: dir)
    }

    private func importedFontURLs() -> [URL] {
        fontFiles(in: fontsDirectory)
    }

    private func fontFiles(in dir: URL) -> [URL] {
        let items = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil)) ?? []
        return items.filter { ["ttf", "otf"].contains($0.pathExtension.lowercased()) }
    }

    /// Register one font file at process scope; record its family names.
    @discardableResult
    private func register(_ url: URL) -> [String] {
        var error: Unmanaged<CFError>?
        // Ignore the "already registered" failure — registerAll is idempotent.
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
        error?.release()
        return recordFamilies(from: url)
    }

    private func recordFamilies(from url: URL) -> [String] {
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL)
            as? [CTFontDescriptor] else { return [] }
        var added: [String] = []
        for descriptor in descriptors {
            if let family = CTFontDescriptorCopyAttribute(descriptor, kCTFontFamilyNameAttribute) as? String,
               families.insert(family).inserted {
                added.append(family)
            }
        }
        return added
    }

    private func publish() {
        installedFamilies = families.sorted()
    }
}
