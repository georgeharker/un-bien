import Foundation

/// A relay the app connects to (DESIGN §6 — multi-relay). Identified by a
/// stable local UUID; `url` is the http(s)/ws(s) endpoint the user entered.
public struct RelayConfig: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public var name: String
    public var url: String

    public init(id: UUID = UUID(), name: String, url: String) {
        self.id = id
        self.name = name
        self.url = url
    }

    /// Normalize the configured endpoint to a `ws(s)://` URL for the socket.
    public var webSocketURL: URL? {
        var value = url.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("https://") { value = "wss://" + value.dropFirst(8) }
        // Plaintext ws:// is intentional: relays commonly run over a private
        // Tailnet/LAN on http:// (e.g. http://host.ts.net:3000), where TLS is
        // neither present nor needed. Mirrors the reference app's mapping.
        // nosemgrep: detect-insecure-websocket
        else if value.hasPrefix("http://") { value = "ws://" + value.dropFirst(7) }
        else if !value.hasPrefix("ws") { value = "wss://" + value }
        return URL(string: value)
    }
}

/// A machine (Pi-key identity) the phone has paired with, scoped to the relay
/// it was paired on. `epk` is the peer's Ed25519 public key — the routing key
/// the app subscribes to and sends toward (DESIGN §6, §10.2).
public struct PairedMachine: Codable, Equatable, Sendable, Identifiable {
    public let epk: String
    public var relayID: UUID
    public var nickname: String?
    public var hostname: String?
    public var harnessName: String?

    public var id: String { "\(relayID.uuidString):\(epk)" }

    public init(epk: String, relayID: UUID, nickname: String? = nil,
                hostname: String? = nil, harnessName: String? = nil) {
        self.epk = epk
        self.relayID = relayID
        self.nickname = nickname
        self.hostname = hostname
        self.harnessName = harnessName
    }
}

/// The persisted mesh: which relays the app knows and which machines it has
/// paired with. Serialized as JSON in app storage. The Owner-key itself lives
/// in the Keychain, never here.
public struct MeshConfig: Codable, Equatable, Sendable {
    public var relays: [RelayConfig]
    public var machines: [PairedMachine]

    public init(relays: [RelayConfig] = [], machines: [PairedMachine] = []) {
        self.relays = relays
        self.machines = machines
    }

    public func machines(onRelay relayID: UUID) -> [PairedMachine] {
        machines.filter { $0.relayID == relayID }
    }

    public mutating func upsert(_ machine: PairedMachine) {
        if let index = machines.firstIndex(where: { $0.id == machine.id }) {
            machines[index] = machine
        } else {
            machines.append(machine)
        }
    }
}
