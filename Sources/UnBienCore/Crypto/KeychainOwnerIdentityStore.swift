import Foundation
import Security

/// Keychain-backed Owner-key custody (DESIGN §5). iCloud Keychain sync is an
/// **option** (`syncsToICloud`) — when on, the item sets
/// `kSecAttrSynchronizable` so the Owner-key follows the user's Apple ID across
/// devices; when off, it stays device-local. Stored as the 64-byte
/// `pubkey || seed` blob (see ``OwnerIdentityBlob``).
public final class KeychainOwnerIdentityStore: OwnerIdentityStore, @unchecked Sendable {
    public enum KeychainError: Error, Equatable {
        case unexpectedStatus(OSStatus)
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

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // Match both synced and non-synced items so a sync-toggle change
            // still finds an existing key rather than silently minting a new one.
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
    }

    public func load() throws -> Ed25519Identity? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let blob = item as? Data else { return nil }
            return try OwnerIdentityBlob.decode(blob)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func save(_ identity: Ed25519Identity) throws {
        try delete()
        let blob = OwnerIdentityBlob.encode(identity)
        // Always persist a device-local (non-synchronizable) copy so the
        // identity survives relaunch even where iCloud Keychain is unavailable
        // — notably the iOS Simulator, which silently drops synchronizable
        // items between runs. When sync is enabled, ALSO store a synchronizable
        // copy so the key follows the user's Apple ID across devices. Load
        // matches either via kSecAttrSynchronizableAny.
        try add(blob: blob, synchronizable: false)
        if syncsToICloud {
            try? add(blob: blob, synchronizable: true)
        }
    }

    private func add(blob: Data, synchronizable: Bool) throws {
        var attributes = baseQuery
        attributes[kSecAttrSynchronizable as String] = synchronizable
        attributes[kSecValueData as String] = blob
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
