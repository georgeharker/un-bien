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
/// PER-DEVICE ACCOUNT (design 01M1VS0X): the `account` is scoped per device
/// (`"owner." + <device id>`) so a re-key on one device can't overwrite another
/// device's identity through the shared, iCloud-synced slot. `legacyAccount`
/// (the old shared `"owner"`) is migrated INTO the per-device slot on first
/// load — the shared item is left in place so other devices migrate from it
/// independently. With per-device accounts iCloud sync can stay on (slots don't
/// collide). Value is the 64-byte `pubkey || seed` blob (``OwnerIdentityBlob``).
public final class KeychainOwnerIdentityStore: OwnerIdentityStore, @unchecked Sendable {
    public enum KeychainError: Error, Equatable {
        case unexpectedStatus(OSStatus)
        /// The process holds no keychain entitlement (unsigned dev build): the
        /// data-protection keychain is unavailable, use the legacy one.
        case missingEntitlement
    }

    private let service: String
    private let account: String
    private let legacyAccount: String?
    private let syncsToICloud: Bool

    public init(service: String = "com.georgeharker.un-bien.owner-key",
                account: String = "owner",
                legacyAccount: String? = nil,
                syncsToICloud: Bool) {
        self.service = service
        self.account = account
        self.legacyAccount = legacyAccount
        self.syncsToICloud = syncsToICloud
    }

    private func query(account: String, dataProtection: Bool) -> [String: Any] {
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
        #if targetEnvironment(simulator)
        // The iOS SIMULATOR keychain does NOT persist across relaunch: the write
        // reports success but the next launch's read is errSecItemNotFound even
        // with protected data available (confirmed empirically). Back the seed
        // with a 0600 file in the app container on the SIMULATOR ONLY so the dev
        // rebuild loop keeps one identity. Compiled out of device/App-Store
        // builds entirely — real devices use the keychain, which persists there.
        if let blob = simFileBlob(), let id = try? OwnerIdentityBlob.decode(blob) { return id }
        #endif
        // 1) Per-device account in the data-protection keychain (steady state).
        if let identity = try read(account: account, dataProtection: true) { return identity }
        // 2) Per-device account in the LEGACY macOS per-binary keychain —
        //    migrate it UP into the data-protection keychain, drop the old copy.
        if let legacy = try read(account: account, dataProtection: false) {
            try? insert(blob: OwnerIdentityBlob.encode(legacy), account: account,
                        synchronizable: syncsToICloud, dataProtection: true)
            try? remove(account: account, dataProtection: false)
            return legacy
        }
        // 3) MIGRATION from the SHARED legacy account (the pre-per-device
        //    `"owner"` slot): COPY it into this device's slot so future launches
        //    find it and future writes stay isolated. Do NOT remove the shared
        //    item — other devices migrate from it independently (removing it
        //    would unpair them). Preserves the current pairing (same key).
        if let legacyAccount {
            for dataProtection in [true, false] {
                if let shared = try read(account: legacyAccount, dataProtection: dataProtection) {
                    try? insert(blob: OwnerIdentityBlob.encode(shared), account: account,
                                synchronizable: syncsToICloud, dataProtection: true)
                    return shared
                }
            }
        }
        return nil
    }

    public func save(_ identity: Ed25519Identity) throws {
        let blob = OwnerIdentityBlob.encode(identity)
        #if targetEnvironment(simulator)
        try? writeSimFile(blob) // sim-only durable fallback (see load())
        #endif
        // Prefer the data-protection keychain; fall back to legacy only when the
        // app has no keychain entitlement (unsigned dev build).
        do {
            try remove(account: account, dataProtection: true)
            try insert(blob: blob, account: account, synchronizable: false, dataProtection: true)
            if syncsToICloud {
                try? insert(blob: blob, account: account, synchronizable: true, dataProtection: true)
            }
            try? remove(account: account, dataProtection: false) // clear any stale legacy copy
        } catch KeychainError.missingEntitlement {
            try remove(account: account, dataProtection: false)
            try insert(blob: blob, account: account, synchronizable: false, dataProtection: false)
            if syncsToICloud {
                try? insert(blob: blob, account: account, synchronizable: true, dataProtection: false)
            }
        }
    }

    public func delete() throws {
        try remove(account: account, dataProtection: true)
        try remove(account: account, dataProtection: false)
        #if targetEnvironment(simulator)
        if let url = simFileURL { try? FileManager.default.removeItem(at: url) }
        #endif
    }

    #if targetEnvironment(simulator)
    // Simulator-only file fallback for the owner seed (the sim keychain does not
    // persist across relaunch). Plain 0600 file, NO file-protection class (that
    // would reintroduce the same lock-gating). Never compiled for device.
    private var simFileURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("un-bien", isDirectory: true)
            .appendingPathComponent("owner-\(account).seed")
    }
    private func simFileBlob() -> Data? {
        guard let url = simFileURL else { return nil }
        return try? Data(contentsOf: url)
    }
    private func writeSimFile(_ blob: Data) throws {
        guard let url = simFileURL else { return }
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try blob.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    #endif

    // MARK: - SecItem primitives

    private func read(account: String, dataProtection: Bool) throws -> Ed25519Identity? {
        var query = query(account: account, dataProtection: dataProtection)
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

    private func insert(blob: Data, account: String, synchronizable: Bool, dataProtection: Bool) throws {
        var attributes = query(account: account, dataProtection: dataProtection)
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

    private func remove(account: String, dataProtection: Bool) throws {
        let status = SecItemDelete(query(account: account, dataProtection: dataProtection) as CFDictionary)
        switch status {
        case errSecSuccess, errSecItemNotFound, errSecMissingEntitlement:
            return
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
