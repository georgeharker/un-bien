import Foundation
import Security

/// Keychain-backed Owner-key custody (DESIGN §5).
///
/// Stored in the **data-protection keychain** (`kSecUseDataProtectionKeychain`)
/// so access is gated by the app's entitlement (like iOS) rather than the
/// legacy macOS per-binary ACL — the latter re-prompts on every launch whenever
/// the app's code signature changes (ad-hoc / dev rebuilds). Falls back to the
/// legacy keychain when the process has no keychain entitlement (the unsigned
/// `swift run un-bien-mac` dev tool), and `load()` migrates a legacy item into
/// the data-protection keychain when the entitlement is present so existing
/// installs stop prompting.
///
/// iCloud Keychain sync is an option (`syncsToICloud`): when on, a second
/// `kSecAttrSynchronizable` copy is stored so the Owner-key follows the user's
/// Apple ID. Value is the 64-byte `pubkey || seed` blob (``OwnerIdentityBlob``).
public final class KeychainOwnerIdentityStore: OwnerIdentityStore, @unchecked Sendable {
    public enum KeychainError: Error, Equatable {
        case unexpectedStatus(OSStatus)
        /// The process holds no keychain entitlement (unsigned dev build): the
        /// data-protection keychain is unavailable, use the legacy one.
        case missingEntitlement
    }

    private let service: String
    private let account: String
    private let syncsToICloud: Bool

    public init(service: String = "com.georgeharker.un-bien.owner-key",
                account: String = "owner",
                syncsToICloud: Bool) {
        self.service = service
        self.account = account
        self.syncsToICloud = syncsToICloud
    }

    private func query(dataProtection: Bool) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // Match both synced and non-synced items so a sync-toggle change
            // still finds an existing key rather than silently minting a new one.
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        if dataProtection {
            query[kSecUseDataProtectionKeychain as String] = true
        }
        return query
    }

    public func load() throws -> Ed25519Identity? {
        if let identity = try read(dataProtection: true) { return identity }
        // Fall back to a legacy-keychain item (pre-migration installs, or the
        // unsigned `swift run` tool). When the data-protection keychain IS
        // available, migrate it over so future launches stop hitting the ACL
        // prompt, then drop the legacy copy.
        guard let legacy = try read(dataProtection: false) else { return nil }
        do {
            try insert(blob: OwnerIdentityBlob.encode(legacy),
                       synchronizable: false, dataProtection: true)
            try? remove(dataProtection: false)
        } catch {
            // missingEntitlement (unsigned) or any other error: leave legacy as-is.
        }
        return legacy
    }

    public func save(_ identity: Ed25519Identity) throws {
        let blob = OwnerIdentityBlob.encode(identity)
        // Prefer the data-protection keychain; fall back to legacy only when the
        // app has no keychain entitlement (unsigned dev build).
        do {
            try remove(dataProtection: true)
            try insert(blob: blob, synchronizable: false, dataProtection: true)
            if syncsToICloud {
                try? insert(blob: blob, synchronizable: true, dataProtection: true)
            }
            try? remove(dataProtection: false) // clear any stale legacy copy
        } catch KeychainError.missingEntitlement {
            try remove(dataProtection: false)
            try insert(blob: blob, synchronizable: false, dataProtection: false)
            if syncsToICloud {
                try? insert(blob: blob, synchronizable: true, dataProtection: false)
            }
        }
    }

    public func delete() throws {
        try remove(dataProtection: true)
        try remove(dataProtection: false)
    }

    // MARK: - SecItem primitives

    private func read(dataProtection: Bool) throws -> Ed25519Identity? {
        var query = query(dataProtection: dataProtection)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let blob = item as? Data else { return nil }
            return try OwnerIdentityBlob.decode(blob)
        case errSecItemNotFound, errSecMissingEntitlement:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func insert(blob: Data, synchronizable: Bool, dataProtection: Bool) throws {
        var attributes = query(dataProtection: dataProtection)
        attributes[kSecAttrSynchronizable as String] = synchronizable
        attributes[kSecValueData as String] = blob
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess, errSecDuplicateItem:
            return
        case errSecMissingEntitlement:
            throw KeychainError.missingEntitlement
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func remove(dataProtection: Bool) throws {
        let status = SecItemDelete(query(dataProtection: dataProtection) as CFDictionary)
        switch status {
        case errSecSuccess, errSecItemNotFound, errSecMissingEntitlement:
            return
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
