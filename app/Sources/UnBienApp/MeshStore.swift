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

    #if DEBUG
    /// Inject a relay in memory only (NOT persisted) — for the UNBIEN_DEMO
    /// harness, so a demo session appears without polluting the saved config.
    public func addTransientRelay(_ relay: RelayConfig) {
        if !config.relays.contains(where: { $0.id == relay.id }) {
            config.relays.append(relay)
        }
    }
    #endif

    public func removeRelay(id: UUID) {
        config.relays.removeAll { $0.id == id }
        config.machines.removeAll { $0.relayID == id }
        persist()
    }

    /// Edit an existing relay's name/URL in place (keeps its id + paired
    /// machines). No-op if the id isn't found.
    public func updateRelay(id: UUID, name: String, url: String) {
        guard let idx = config.relays.firstIndex(where: { $0.id == id }) else { return }
        config.relays[idx].name = name
        config.relays[idx].url = url
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
