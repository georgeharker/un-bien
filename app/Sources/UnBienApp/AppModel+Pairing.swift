import Foundation
import os
import UnBienCore

// Pairing + owner-identity creation split out of AppModel.swift (its 1000-line
// cap): owner-key creation, the `unbien://` deep-link entry point, and the
// dedicated short-lived pairing connection. State (identityStore / owner /
// pendingPairing) stays on AppModel; this extension only drives it.

private let log = Logger(subsystem: "un-bien", category: "relay")

extension AppModel {
    public func createOwnerKey() async {
        let identity = Ed25519Identity()
        identityStore = KeychainOwnerIdentityStore(syncsToICloud: syncsToICloud)
        // Do NOT swallow a save failure: if the key isn't written it won't
        // persist and the next launch silently re-onboards (looks like 'doesn't
        // stick'). Surface it. (The Simulator wipes its keychain on reinstall
        // regardless — that's environmental, not this path.)
        do {
            try identityStore.save(identity)
            identityLoadFailed = false
        } catch {
            log.error("owner key SAVE failed — identity will NOT persist: \(String(describing: error), privacy: .public)")
            identityLoadFailed = true
        }
        UserDefaults.standard.set(syncsToICloud, forKey: Self.iCloudDefaultsKey)
        owner = identity
        needsOnboarding = false
        await connectAll()
    }

    /// Parse an `unbien://pair?…` deep link (system Camera / pasted link) into a
    /// pending invite. The relay is NOT in the URL (the QR carries no `r`), so
    /// the UI then presents a relay chooser. Non-pairing URLs are ignored.
    public func handleOpenURL(_ url: URL) {
        guard let invite = try? PairingURI.parse(url.absoluteString) else { return }
        pendingPairing = PendingPairing(invite: invite)
    }

    // MARK: - Pairing

    /// Pair on a dedicated short-lived connection (keeps the persistent event
    /// loop's channel uncontended), then persist the machine and re-subscribe.
    public func pair(relay: RelayConfig, invite: PairingInvite, deviceName: String) async throws {
        guard let owner, let url = relay.webSocketURL else { return }
        let channel = URLSessionWebSocketChannel(url: url)
        let pairingConnection = RelayConnection(channel: channel, identity: owner)
        try await pairingConnection.authenticate()
        let result: PairResult
        do {
            result = try await withThrowingTaskGroup(of: PairResult.self) { group in
                group.addTask { try await pairingConnection.pair(invite: invite, deviceName: deviceName) }
                group.addTask {
                    try await Task.sleep(nanoseconds: 15_000_000_000)
                    throw RelayConnection.PairingError.unexpected(
                        "No response from the machine. Is Pi running with un-bien "
                        + "attached to this relay, and the code still valid?")
                }
                let first = try await group.next()!
                group.cancelAll()
                return first
            }
        } catch {
            await pairingConnection.close()
            throw error
        }
        await pairingConnection.close()

        mesh.upsertMachine(PairedMachine(
            epk: invite.epk, relayID: relay.id, nickname: nil,
            hostname: result.hostname, harnessName: result.harness?.name))
        // Re-pair clears any stale unknown_peer prompt for this machine.
        unpairedPeers.remove(invite.epk)

        if let connection = connections[relay.id] {
            let peers = mesh.config.machines(onRelay: relay.id).map(\.epk)
            try? await connection.subscribe(peers: peers)
        }
    }
}
