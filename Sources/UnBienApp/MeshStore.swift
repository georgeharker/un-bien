import Foundation
import UnBienCore

/// Persists ``MeshConfig`` (relays + paired machines) as JSON in Application
/// Support. Cross-platform (iOS + macOS). The Owner-key is NOT stored here —
/// it lives in the Keychain via ``OwnerIdentityStore``.
@MainActor
public final class MeshStore: ObservableObject {
    @Published public private(set) var config: MeshConfig

    private let fileURL: URL

    public init(filename: String = "mesh.json") {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("un-bien", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent(filename)
        if let data = try? Data(contentsOf: fileURL),
           let loaded = try? JSONDecoder().decode(MeshConfig.self, from: data) {
            self.config = loaded
        } else {
            self.config = MeshConfig()
        }
    }

    public func addRelay(_ relay: RelayConfig) {
        config.relays.append(relay)
        persist()
    }

    public func removeRelay(id: UUID) {
        config.relays.removeAll { $0.id == id }
        config.machines.removeAll { $0.relayID == id }
        persist()
    }

    public func upsertMachine(_ machine: PairedMachine) {
        config.upsert(machine)
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(config) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
