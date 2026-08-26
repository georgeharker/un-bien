import Foundation

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
}
