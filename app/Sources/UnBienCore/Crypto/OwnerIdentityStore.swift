import Foundation

/// Persistence for the Owner-key (DESIGN §5). The reference app stores a
/// 64-byte blob `publicKey(32) || privateSeed(32)`; we keep that exact layout
/// so an identity is portable across the two implementations.
public protocol OwnerIdentityStore: Sendable {
    /// Load the stored identity, or `nil` if none exists yet.
    func load() throws -> Ed25519Identity?
    /// Persist (create or overwrite) the identity.
    func save(_ identity: Ed25519Identity) throws
    /// Remove the stored identity.
    func delete() throws
}

public enum OwnerIdentityBlob {
    /// Encode as the reference app's 64-byte `pubkey || seed` blob.
    public static func encode(_ identity: Ed25519Identity) -> Data {
        var blob = Data(capacity: 64)
        blob.append(identity.publicKeyRaw)
        blob.append(identity.rawSeed)
        return blob
    }

    /// Decode a 64-byte blob back into an identity (seed is the source of
    /// truth; the leading pubkey is redundant and re-derived).
    public static func decode(_ blob: Data) throws -> Ed25519Identity {
        guard blob.count == 64 else {
            throw OwnerIdentityError.malformedBlob(count: blob.count)
        }
        return try Ed25519Identity(rawSeed: blob.suffix(32))
    }
}

public enum OwnerIdentityError: Error, Equatable {
    case malformedBlob(count: Int)
}

/// In-memory store for tests and previews.
public final class InMemoryOwnerIdentityStore: OwnerIdentityStore, @unchecked Sendable {
    private var stored: Ed25519Identity?
    private let lock = NSLock()

    public init(_ initial: Ed25519Identity? = nil) { self.stored = initial }

    public func load() throws -> Ed25519Identity? { lock.withLock { stored } }
    public func save(_ identity: Ed25519Identity) throws { lock.withLock { stored = identity } }
    public func delete() throws { lock.withLock { stored = nil } }
}
