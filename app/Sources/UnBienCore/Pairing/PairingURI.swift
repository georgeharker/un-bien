import Foundation

/// A parsed pairing invite from a QR scan or a pasted string
/// (`remotepi://pair?t=<token>&epk=<pubkey>&n=<name>&rm=<room>`, DESIGN §5).
///
/// The `token` and `epk` are treated as **opaque strings** — the app never
/// decodes the token, and echoes it verbatim in `pair_request` (§10.4). `epk`
/// is the destination Pi's Ed25519 public key used as the routing `peer`.
public struct PairingInvite: Equatable, Sendable {
    /// Single-use pairing token (16 random bytes, base64url) — opaque.
    public let token: String
    /// Destination Pi Ed25519 public key (base64url in the URI). Opaque routing key.
    public let epk: String
    /// Session name for the pre-pair preview screen (optional).
    public let sessionName: String?
    /// Pi-side room id; falls back to `"main"` when absent (plan-17 fix).
    public let roomID: String
    /// Optional legacy relay URL (`r`) — modern QRs omit it (app uses config).
    public let relayURL: String?

    public init(token: String, epk: String, sessionName: String?,
                roomID: String, relayURL: String?) {
        self.token = token
        // QR carries epk as base64url (unpadded); the relay routes by STANDARD
        // padded base64, so canonicalize here — else (peer, room) lookups miss.
        self.epk = Base64.canonicalKey(epk) ?? epk
        self.sessionName = sessionName
        self.roomID = roomID
        self.relayURL = relayURL
    }
}

public enum PairingURIError: Error, Equatable {
    case notAPairingURI
    case missingToken
    case missingEPK
}

public enum PairingURI {
    /// Parse a `remotepi://pair?...` string (from QR or paste). Tolerates
    /// surrounding whitespace. `rm` defaults to `"main"` when omitted.
    public static func parse(_ raw: String) throws -> PairingInvite {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme == "remotepi",
              components.host == "pair" else {
            throw PairingURIError.notAPairingURI
        }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value
        }
        guard let token = value("t"), !token.isEmpty else { throw PairingURIError.missingToken }
        guard let epk = value("epk"), !epk.isEmpty else { throw PairingURIError.missingEPK }
        return PairingInvite(
            token: token,
            epk: epk,
            sessionName: value("n"),
            roomID: value("rm") ?? "main",
            relayURL: value("r")
        )
    }
}
