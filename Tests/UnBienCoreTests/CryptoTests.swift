import CryptoKit
import Foundation
import XCTest
@testable import UnBienCore

final class CryptoTests: XCTestCase {
    /// Mirrors relay `auth_test.rs::sig_valida`: the client signs the DECODED
    /// 32 nonce bytes and the relay verifies with the raw verifying key.
    func testHandshakeSignatureVerifies() throws {
        let identity = Ed25519Identity()

        // Relay side: 32 random bytes, standard base64.
        var nonce = Data(count: 32)
        nonce.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        let nonceB64 = Base64.standard(nonce)

        // Client side: sign the DECODED nonce bytes (§10.2), not the string.
        let decoded = try XCTUnwrap(Base64.decodeTolerant(nonceB64))
        let sig = try identity.sign(decoded)

        XCTAssertTrue(Ed25519.verify(signature: sig, message: decoded,
                                     publicKeyRaw: identity.publicKeyRaw))
    }

    /// A signature over the wrong bytes must fail (auth_test.rs::sig_invalida).
    func testWrongMessageFailsVerification() throws {
        let identity = Ed25519Identity()
        let sig = try identity.sign(Data("not the nonce".utf8))
        XCTAssertFalse(Ed25519.verify(signature: sig, message: Data(count: 32),
                                      publicKeyRaw: identity.publicKeyRaw))
    }

    func testSeedRoundTrip() throws {
        let identity = Ed25519Identity()
        let restored = try Ed25519Identity(rawSeed: identity.rawSeed)
        XCTAssertEqual(restored.publicKeyRaw, identity.publicKeyRaw)
    }

    func testPublicKeyBase64IsStandardPadded() {
        let identity = Ed25519Identity()
        let encoded = identity.publicKeyBase64
        XCTAssertEqual(encoded.count, 44) // 32 bytes → 44 chars incl. padding
        XCTAssertTrue(encoded.hasSuffix("="))
        XCTAssertFalse(encoded.contains("-") || encoded.contains("_"))
    }

    /// The relay accepts std/url-safe, padded/unpadded (auth_test.rs). Our
    /// tolerant decoder must round-trip all four to the same 32 bytes.
    func testBase64ToleranceMatchesRelay() throws {
        let raw = Data((0..<32).map { UInt8($0) })
        let standard = raw.base64EncodedString()
        let urlSafe = standard.replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
        let stdNoPad = standard.replacingOccurrences(of: "=", with: "")
        let urlNoPad = urlSafe.replacingOccurrences(of: "=", with: "")
        for encoded in [standard, urlSafe, stdNoPad, urlNoPad] {
            XCTAssertEqual(Base64.decodeTolerant(encoded), raw, "decoding \(encoded)")
        }
    }

    /// A base64url QR epk (unpadded) must canonicalize to the relay's routing
    /// form: standard base64, padded. Getting this wrong makes (peer, room)
    /// lookups silently miss and pairing hangs (real bug we hit).
    func testCanonicalKeyPadsAndStandardizes() {
        let raw = Data((0..<32).map { UInt8($0 &* 7 &+ 1) })
        let standardPadded = raw.base64EncodedString()
        let urlUnpadded = standardPadded
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(Base64.canonicalKey(urlUnpadded), standardPadded)
        XCTAssertEqual(standardPadded.count, 44)
        XCTAssertTrue(standardPadded.hasSuffix("="))
        XCTAssertEqual(Base64.canonicalKey(standardPadded), standardPadded)
    }

    func testPairingInviteCanonicalizesEPK() {
        let raw = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let urlUnpadded = raw.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let invite = PairingInvite(token: "t", epk: urlUnpadded, sessionName: nil,
                                   roomID: "main", relayURL: nil)
        XCTAssertEqual(invite.epk, raw.base64EncodedString())
    }
}
