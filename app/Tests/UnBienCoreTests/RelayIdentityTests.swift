import XCTest
@testable import UnBienCore

/// P7 relay-identity verification — the Swift mirror of the extension's
/// `relay identity ack (P7)` suite: the attack shapes, not just happy paths.
/// The two implementations must not diverge in message shape
/// (`nonce|relay_pubkey|relay_name|relay_url`) or refusal reasons.
final class RelayIdentityTests: XCTestCase {

    /// Build a signed ack exactly as the relay does (peering.rs
    /// sign_relay_identity), optionally with a FORGED signer.
    private func signedAck(
        relay: Ed25519Identity,
        nonce: String,
        signer: Ed25519Identity? = nil,
        name: String = "cascade",
        url: String = "ws://cascade.tailnet.ts.net:3000"
    ) -> RelayIdentityAck {
        let message = "\(nonce)|\(relay.publicKeyBase64)|\(name)|\(url)"
        let signKey = signer ?? relay
        let sig = (try? signKey.sign(Data(message.utf8)))
            ?? Data(repeating: 0, count: 64)
        return RelayIdentityAck(
            relayPubkey: relay.publicKeyBase64,
            relayName: name,
            relayUrl: url,
            endpoints: ["ws://cascade.tailnet.ts.net:3000", "ws://127.0.0.1:3000"],
            nonce: nonce,
            sig: Base64.standard(sig))
    }

    private func nonceB64(_ byte: UInt8) -> String {
        Base64.standard(Data(repeating: byte, count: 32))
    }

    func testValidSignedAckVerifiesAndBindsTheNonce() throws {
        let relay = Ed25519Identity()
        let nonce = nonceB64(0x11)
        let check = RelayConnection.verifyRelayIdentityAck(
            signedAck(relay: relay, nonce: nonce), challengeNonce: nonce, pinnedKey: nil)
        guard case let .verified(identity) = check else {
            return XCTFail("expected verified, got \(check)")
        }
        XCTAssertEqual(identity.relayPubkey, relay.publicKeyBase64)
        XCTAssertEqual(identity.relayName, "cascade")
        XCTAssertEqual(identity.endpoints.count, 2)
        // The same frame against a DIFFERENT challenge is a replay → refuse.
        XCTAssertEqual(
            RelayConnection.verifyRelayIdentityAck(
                signedAck(relay: relay, nonce: nonce), challengeNonce: "other", pinnedKey: nil),
            .refused(reason: "wrong_nonce"))
    }

    func testForgedSignatureFails() {
        let relay = Ed25519Identity()
        let attacker = Ed25519Identity()
        let nonce = nonceB64(0x22)
        // Signed by the attacker while claiming relay's pubkey → bad_sig.
        let forged = signedAck(relay: relay, nonce: nonce, signer: attacker)
        XCTAssertEqual(
            RelayConnection.verifyRelayIdentityAck(forged, challengeNonce: nonce, pinnedKey: nil),
            .refused(reason: "bad_sig"))
    }

    func testPinMismatchIsTheMITMCase() {
        let relay = Ed25519Identity()
        let nonce = nonceB64(0x33)
        let legit = signedAck(relay: relay, nonce: nonce)
        // Legit ack + an unrelated pin → pin_mismatch: a verified relay
        // that is not the relay this app paired.
        let otherPin = Ed25519Identity().publicKeyBase64
        XCTAssertEqual(
            RelayConnection.verifyRelayIdentityAck(legit, challengeNonce: nonce, pinnedKey: otherPin),
            .refused(reason: "pin_mismatch"))
        // The matching pin verifies.
        guard case .verified = RelayConnection.verifyRelayIdentityAck(
            legit, challengeNonce: nonce, pinnedKey: relay.publicKeyBase64) else {
            return XCTFail("expected verified with the matching pin")
        }
    }

    func testMalformedAndMissingChallengeRefuse() {
        let relay = Ed25519Identity()
        let nonce = nonceB64(0x44)
        // Empty fields → malformed (lenient decode surfaces here, not at parse).
        let empty = RelayIdentityAck(
            relayPubkey: "", relayName: "", relayUrl: "",
            endpoints: [], nonce: "", sig: "")
        XCTAssertEqual(
            RelayConnection.verifyRelayIdentityAck(empty, challengeNonce: nonce, pinnedKey: nil),
            .refused(reason: "wrong_nonce"))
        // A frame with no challenge captured (no handshake binding) refuses.
        let ack = signedAck(relay: relay, nonce: nonce)
        XCTAssertEqual(
            RelayConnection.verifyRelayIdentityAck(ack, challengeNonce: nil, pinnedKey: nil),
            .refused(reason: "wrong_nonce"))
    }
}