# Un Bien — deployment & signing notes

What the app needs to be signed/entitled with when you build a shippable target.
Today the repo builds as SwiftPM executables (`swift run un-bien-mac`) with **no
entitlements file**, so none of this is wired yet — it's the checklist for the
real Xcode app target(s).

## Capabilities / entitlements

### iCloud Keychain sync — NO iCloud capability required

The Owner-key "sync to iCloud" toggle uses `kSecAttrSynchronizable` in the
Keychain (`KeychainOwnerIdentityStore`). That rides the user's **iCloud
Keychain** via the Security framework — it is **not** CloudKit and needs none of
the iCloud capability machinery:

- **Do NOT** add the **iCloud** capability (CloudKit / Key-Value / Documents) or
  an iCloud container. Nothing in the app uses them (mesh config is plain JSON in
  Application Support, not iCloud).
- All `kSecAttrSynchronizable` needs is that the app is **normally code-signed**
  (a Development Team + bundle id, which grants the default keychain access
  group) and that the user has iCloud Keychain enabled in system Settings.
- **Keychain Sharing** capability is only needed if you define a *custom*
  keychain-access-group. The store uses the **default** group, so it's not
  required either.

Fails safe without any of this: `save()` always writes a **device-local**
(non-synchronizable) copy first, then a best-effort (`try?`) synchronizable copy.
So on an unsigned `swift run` build — or the iOS Simulator, which silently drops
synced items between runs — the key still persists locally; it just won't sync.

### macOS App Sandbox — network client

If the macOS target is sandboxed, the relay WebSocket connections need:

- `com.apple.security.network.client` = `true`

(No server entitlement; the app only dials out.)

### Camera — only when QR camera scanning lands

QR pairing currently uses paste-code only. When live camera scanning is added
(AVFoundation / DataScanner), add to Info.plist:

- `NSCameraUsageDescription` — e.g. "Scan a pairing QR code from your machine."

## Info.plist / signing checklist (real target)

- Development Team + bundle identifier set (enables the default keychain group).
- Keychain service id is `work.un-bien.owner-key` (see `KeychainOwnerIdentityStore`).
- macOS sandbox (if enabled): `com.apple.security.network.client`.
- No `NSAppTransportSecurity` exceptions needed for `wss://`; only if you must
  allow plain `ws://` to a dev relay would you add an ATS exception.

## Not needed (explicitly)

- iCloud / CloudKit capability or container.
- Push notifications.
- Background modes (unless/until backgrounded reconnect needs `UIBackgroundModes`).
