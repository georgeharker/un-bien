import CryptoKit
import Foundation

/// An Ed25519 signing identity (Owner-key / App-key), wire-identical to the
/// reference impl's `@noble/ed25519` and the relay's `ed25519-dalek`
/// (DESIGN §5, §10.1). Backed by CryptoKit `Curve25519.Signing`.
public struct Ed25519Identity: Sendable {
    public let privateKey: Curve25519.Signing.PrivateKey

    public init(privateKey: Curve25519.Signing.PrivateKey) {
        self.privateKey = privateKey
    }

    /// Generate a fresh random identity.
    public init() {
        self.privateKey = Curve25519.Signing.PrivateKey()
    }

    /// Restore from the raw 32-byte seed (as persisted in the Keychain).
    public init(rawSeed: Data) throws {
        self.privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawSeed)
    }

    /// Raw 32-byte private seed — what gets stored in the Keychain.
    public var rawSeed: Data { privateKey.rawRepresentation }

    /// Raw 32-byte public key — the canonical technical identity.
    public var publicKeyRaw: Data { privateKey.publicKey.rawRepresentation }

    /// Public key as standard padded base64 — canonical wire representation.
    public var publicKeyBase64: String { Base64.standard(publicKeyRaw) }

    /// Sign a message. Returns the raw 64-byte Ed25519 signature.
    ///
    /// For the relay handshake, `message` MUST be the DECODED 32 nonce bytes,
    /// never the base64 string (DESIGN §10.2).
    public func sign(_ message: Data) throws -> Data {
        try privateKey.signature(for: message)
    }
}

public enum Ed25519 {
    /// Verify a raw 64-byte signature over `message` with a raw 32-byte pubkey.
    public static func verify(signature: Data, message: Data, publicKeyRaw: Data) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyRaw) else {
            return false
        }
        return key.isValidSignature(signature, for: message)
    }
}
