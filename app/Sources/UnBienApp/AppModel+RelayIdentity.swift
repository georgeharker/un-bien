import Foundation
import os
import UnBienCore

private let log = Logger(subsystem: "un-bien", category: "relay-identity")

// Relay-identity (P7) policy, carved from AppModel+Inbound.swift (line cap):
// the TOFU/pin decision for the relay's post-auth identity_ack. Parsing and
// the pure signature check live in UnBienCore (RelayConnection/
// verifyRelayIdentityAck); this is the PIN POLICY — what the app does with a
// verified or refused identity. State stays on AppModel; this extension only
// decides + records.
extension AppModel {
    /// P7 relay-identity pin policy (TOFU), run async — the captured
    /// challenge nonce lives on the RelayConnection actor. Verify the ack
    /// against THIS connection's nonce and the relay's recorded pin:
    /// refused ⇒ the relay at the other end is not the relay we paired (or
    /// the proof is broken) — close BEFORE treating any of its traffic as
    /// ours. Verified + no pin ⇒ TOFU: record the key (MeshStore never
    /// overwrites an existing pin from this path — a pin change is a re-pair
    /// event, not a silent mutation). Verified + pin match ⇒ silent;
    /// identity is expected state, not an event.
    func handleRelayIdentityAck(_ ack: RelayIdentityAck, relayID: UUID) async {
        guard let connection = connections[relayID] else { return }
        let pinned = mesh.config.relays.first(where: { $0.id == relayID })?.pinnedRelayKey
        let check = await RelayConnection.verifyRelayIdentityAck(
            ack, challengeNonce: connection.challengeNonceB64, pinnedKey: pinned)
        switch check {
        case let .verified(identity):
            if pinned == nil {
                mesh.pinRelayKey(id: relayID, key: identity.relayPubkey)
                log.notice("relay identity TOFU: pinned \(identity.relayPubkey, privacy: .public) on first verified ack (\(identity.relayName, privacy: .public))")
            }
        case let .refused(reason):
            log.error("relay identity REFUSED (\(reason, privacy: .public)) — closing relayID \(relayID.uuidString, privacy: .public); re-pair if this relay's key legitimately changed")
            relayHealth[relayID] = .failed("relay identity refused: \(reason)")
            connections[relayID] = nil
            Task { await connection.close() }
        }
    }
}