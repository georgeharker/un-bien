import Foundation
import CryptoKit

/// Base64 discipline for the relay + mesh boundary (DESIGN §10.1).
///
/// Ed25519 pubkeys / signatures / nonces are RFC 4648 STANDARD base64, padded.
/// Never compare keys as base64 strings — decode to raw bytes and compare bytes.
public enum Base64 {
    /// Encode raw bytes as RFC 4648 standard base64 (padded). The canonical
    /// representation for keys/sigs/nonces on the wire.
    public static func standard(_ data: Data) -> String {
        data.base64EncodedString()
    }

    /// Decode a base64 string to raw bytes, tolerating both standard and
    /// URL-safe alphabets, padded or unpadded — mirrors the relay's
    /// `decode_ed25519_public_key`, which accepts all four forms.
    public static func decodeTolerant(_ input: String) -> Data? {
        // Normalize URL-safe alphabet to standard.
        var normalized = input.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Restore padding to a multiple of 4.
        switch normalized.count % 4 {
        case 2: normalized += "=="
        case 3: normalized += "="
        case 1: return nil
        default: break
        }
        return Data(base64Encoded: normalized)
    }

    /// Canonicalize a public key (any base64 alphabet, padded or not) to the
    /// relay's routing form: RFC 4648 STANDARD base64, padded (DESIGN §10.1).
    /// The relay keys peers by `STANDARD.encode(vk_bytes)`, so an `epk` taken
    /// from a base64url QR (unpadded, 43 chars) MUST be re-encoded here or the
    /// relay's `(peer, room)` lookup silently misses → pair/routing timeout.
    /// Returns nil only when the input isn't valid base64.
    public static func canonicalKey(_ input: String) -> String? {
        guard let raw = decodeTolerant(input) else { return nil }
        return standard(raw)
    }

    /// Encode raw bytes as RFC 4648 URL-safe base64, UNPADDED — the form the
    /// machine's epk takes on the wire (`Buffer.toString("base64url")`) and the
    /// alphabet room ids use.
    public static func urlUnpadded(_ data: Data) -> String {
        var s = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
        while s.hasSuffix("=") { s.removeLast() }
        return s
    }

    /// Derive the machine-level CONTROL room id from a machine's ed25519 public
    /// key — the Swift mirror of `rooms.ts` `roomIdForControl` (design
    /// 01M17WDQ04). The idle-machine presence daemon joins this room; the app
    /// derives the SAME id to reach it.
    ///
    /// The daemon hashes the epk in base64url-UNPADDED form
    /// (`Buffer.toString("base64url")`), but `PairedMachine.epk` is stored
    /// padded-standard — so we canonicalize to base64url-unpadded FIRST, or the
    /// two sides hash different strings and derive different rooms (never meet).
    /// Formula: `base64url(sha256("\0control\0" + epkBase64url)).prefix(12)`.
    /// Returns nil only when `epk` isn't valid base64.
    public static func deriveControlRoom(epk: String) -> String? {
        guard let raw = decodeTolerant(epk) else { return nil }
        let input = "\u{0}control\u{0}" + urlUnpadded(raw)
        let digest = SHA256.hash(data: Data(input.utf8))
        return String(urlUnpadded(Data(digest)).prefix(12))
    }
}
