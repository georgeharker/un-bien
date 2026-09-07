import SwiftUI

/// First-run screen: create the Owner key, with iCloud sync as an opt-in
/// toggle (DESIGN §5 — "iCloud sync should be an option").
struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Un Bien")
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .foregroundStyle(theme.accent)
            Text("A native client for your Pi coding agents.")
                .font(.headline)
                .foregroundStyle(theme.secondaryText)
                .multilineTextAlignment(.center)

            VStack(alignment: .leading, spacing: 12) {
                Text("Create your Owner key")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(theme.text)
                Text("This key is your identity across every relay and machine. "
                     + "It never leaves your devices.")
                    .font(.subheadline)
                    .foregroundStyle(theme.secondaryText)
                if model.iCloudAvailable {
                    Toggle(isOn: $model.syncsToICloud) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Sync via iCloud Keychain").foregroundStyle(theme.text)
                            Text("Follow you to your other devices. Off = this device only.")
                                .font(.caption).foregroundStyle(theme.secondaryText)
                        }
                    }
                    .tint(theme.accent)
                } else {
                    // iCloud unavailable — don't offer a no-op toggle; force sync
                    // off so createOwnerKey doesn't write a (non-syncing) synced copy.
                    HStack(spacing: 8) {
                        Image(systemName: "icloud.slash").foregroundStyle(theme.secondaryText)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("iCloud Keychain unavailable").foregroundStyle(theme.secondaryText)
                            Text("This device only. Sign into iCloud to sync across devices.")
                                .font(.caption).foregroundStyle(theme.secondaryText)
                        }
                        Spacer(minLength: 0)
                    }
                    .onAppear { model.syncsToICloud = false }
                }
            }
            .padding()
            .background(theme.surface, in: RoundedRectangle(cornerRadius: 14))

            Button {
                Task { await model.createOwnerKey() }
            } label: {
                Text("Create key & continue")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accent)
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background)
    }
}
