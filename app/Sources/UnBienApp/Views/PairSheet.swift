import SwiftUI
import UnBienCore

/// Pairing — scan the `unbien://pair?…` QR with the camera (iOS) or paste the
/// code (cross-platform). The paste fallback is the parity floor (DESIGN §12)
/// and the only path that also works on macOS.
struct PairSheet: View {
    let relay: RelayConfig
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var pasted = ""
    @State private var deviceName = PairSheet.defaultDeviceName
    @State private var status: Status = .idle
    #if os(iOS)
    @State private var showScanner = false
    #endif

    enum Status: Equatable {
        case idle, pairing, paired(String), error(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Pairing code") {
                    TextField("unbien://pair?…", text: $pasted, axis: .vertical)
                        .lineLimit(2...4)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #endif
                    #if os(iOS)
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                    }
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
            .formStyle(.grouped)
            .navigationTitle("Pair — \(relay.name)")
            #if os(iOS)
            .sheet(isPresented: $showScanner) {
                QRScannerSheet { code in
                    pasted = code
                    pair(with: code)
                }
            }
            #endif
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

    private func pair() { pair(with: pasted) }

    private func pair(with raw: String) {
        guard let invite = try? PairingURI.parse(raw) else {
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

    private static var defaultDeviceName: String { defaultPairingDeviceName }
}
