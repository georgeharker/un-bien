import Foundation
import UnBienCore
#if os(iOS)
import UIKit
#endif

/// This device's default pairing name (shown pre-filled in the pair sheets).
var defaultPairingDeviceName: String {
    #if os(iOS)
    return UIDevice.current.name
    #else
    return Host.current().localizedName ?? "Mac"
    #endif
}

/// A human-readable message for a pairing / connection failure. Shared by the
/// in-app `PairSheet` and the deep-link `ChooseRelayPairSheet`.
func pairFailureMessage(_ error: Error) -> String {
    switch error {
    case let RelayConnection.PairingError.failed(code, message):
        return "\(code.rawValue): \(message)"
    case let RelayConnection.PairingError.unexpected(message):
        return message
    case let RelayConnection.ConnectionError.rejected(code, message):
        return "Relay rejected the connection (\(code ?? "?"): \(message ?? ""))"
    case RelayConnection.ConnectionError.handshakeTimeout:
        return "Couldn't reach the relay (handshake timed out). "
            + "Check the relay is reachable from this device — a Tailscale "
            + "*.ts.net address may not resolve here."
    case let urlError as URLError:
        return "Network error reaching the relay: \(urlError.localizedDescription) "
            + "(\(urlError.code.rawValue)). If the relay is on Tailscale, the "
            + "simulator may not resolve its *.ts.net name."
    default:
        return "Pairing failed: \(error.localizedDescription)"
    }
}
