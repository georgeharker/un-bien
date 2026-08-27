import SwiftUI
import UnBienCore

/// Pairing — paste the `remotepi://pair?…` code (cross-platform). QR camera
/// scanning is an iOS-only enhancement layered on later; the paste fallback is
/// the parity floor (DESIGN §12) and the only path that also works on macOS.
struct PairSheet: View {
    let relay: RelayConfig
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var pasted = ""
    @State private var deviceName = PairSheet.defaultDeviceName
    @State private var status: Status = .idle

    enum Status: Equatable {
        case idle, pairing, paired(String), error(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Pairing code") {
                    TextField("remotepi://pair?…", text: $pasted, axis: .vertical)
                        .lineLimit(2...4)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #endif
                    TextField("This device's name", text: $deviceName)
                }
                switch status {
                case .pairing:
                    Label("Pairing…", systemImage: "hourglass")
                case let .paired(host):
                    Label("Paired with \(host)", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                case let .error(message):
                    Label(message, systemImage: "xmark.octagon.fill")
                        .foregroundStyle(.red)
                case .idle:
                    Text("Scan the QR shown in your terminal, or paste its code here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Pair — \(relay.name)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair") { pair() }
                        .disabled(pasted.isEmpty || status == .pairing)
                }
            }
        }
    }

    private func pair() {
        guard let invite = try? PairingURI.parse(pasted) else {
            status = .error("That doesn't look like a valid pairing code.")
            return
        }
        status = .pairing
        Task {
            do {
                try await model.pair(relay: relay, invite: invite, deviceName: deviceName)
                status = .paired(invite.sessionName ?? "machine")
                try? await Task.sleep(nanoseconds: 700_000_000)
                dismiss()
            } catch {
                status = .error(pairFailureMessage(error))
            }
        }
    }

    private func pairFailureMessage(_ error: Error) -> String {
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

    private static var defaultDeviceName: String {
        #if os(iOS)
        return UIDevice.current.name
        #else
        return Host.current().localizedName ?? "Mac"
        #endif
    }
}
