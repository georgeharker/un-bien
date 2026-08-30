# Un Bien — App Store release checklist (v1)

Tasks to ship the native iOS + macOS app to the App Store. Two distinct Xcode
targets (`UnBien-iOS`, `UnBien-macOS` in `app/project.yml`) → two App Store
Connect records, each with its own metadata and screenshots but shared team and
bundle id (`com.georgeharker.un-bien.app`, team `B8V3694RNX`).

Legend: ✅ done · ⚠️ gap · 🔲 to do.

## Already in place

- ✅ Signing wired — automatic, team `B8V3694RNX`, bundle
  `com.georgeharker.un-bien.app`, pinned in `app/project.yml` (source of truth;
  survives `xcodegen generate`).
- ✅ App icons — iOS 1024 + full macOS set in
  `app/App/Shared/Assets.xcassets/AppIcon.appiconset`.
- ✅ `NSCameraUsageDescription` (QR pairing scan) in both Info.plists.
- ✅ Keychain-access-group entitlement on both platforms (Owner-key custody).
- ✅ macOS hardened runtime on; universal iOS (`TARGETED_DEVICE_FAMILY 1,2`).
- ✅ Deployment targets: iOS 17, macOS 14.

## Blockers — App Review rejects without these

### 1. 🔲 Privacy manifest (`PrivacyInfo.xcprivacy`)

Required by Apple since May 2024; none exists in the repo. Add one per app
target declaring:

- **Data collection:** effectively none (mesh config is local JSON; no
  analytics/tracking). Declare accordingly.
- **Required-reason APIs** actually used: Keychain, `UserDefaults` (if used),
  file-timestamp / disk-space APIs pulled in transitively. Provide the reason
  codes.

### 2. ⚠️ App Transport Security posture

Both Info.plists set `NSAppTransportSecurity → NSAllowsArbitraryLoads = true`.
Global arbitrary-loads is the single biggest review risk. The app only dials
user-specified `ws://` on localhost / LAN / Tailnet.

- **Preferred:** replace with `NSAllowsLocalNetworking = true` (permitted for
  local endpoints) instead of arbitrary loads.
- Keep a written justification in App Review notes either way.
- **Decision required** before finalizing plists + review notes.

### 3. 🔲 Local Network permission (iOS)

Add `NSLocalNetworkUsageDescription` — iOS prompts on first LAN connection to a
relay. Missing today. (Add a Bonjour services key only if service discovery is
introduced; not needed for paste/QR-addressed relays.)

### 4. 🔲 macOS App Sandbox

Mac App Store **requires** the sandbox. macOS entitlements currently carry only
the keychain group. Add:

- `com.apple.security.app-sandbox = true`
- `com.apple.security.network.client = true` (outbound WebSocket only; no server
  entitlement)

Already flagged in `DEPLOY.md`. Re-test Keychain + relay connect under sandbox.

### 5. 🔲 Export compliance

Set `ITSAppUsesNonExemptEncryption` in Info.plist. The app uses CryptoKit
(Ed25519) + TLS — standard crypto, almost certainly **exempt**, but it must be
declared or every upload prompts.

### 6. 🔲 Privacy policy URL

Hard requirement in App Store Connect. Does not exist yet — publish a page and
record the URL. (Can live on the Quarto docs site.)

### 7. 🔲 Reviewability — the app is inert without infrastructure

Un Bien is useless to a reviewer without a self-hosted relay **and** a machine
running Pi. Without a path to exercise it, submission is an immediate rejection.

This is a **well-trodden, sanctioned path**, not a novelty. Guideline **2.1 (App
Completeness)** requires the developer to supply "a demo mode... **or** log-in
information (a valid demo account and login details)" plus any resources needed
to review, and Apple's review guidance says to put demo accounts, auth codes, and
setup steps in the App Review Information notes. Self-hosted / server-required
clients (Termius, Prompt, Working Copy, Home Assistant, etc.) ship exactly this
way. Two routes, not mutually exclusive:

- **Route A — demo credentials → live demo relay + standing Pi session**, in
  review notes. Cheapest to ship (no app code), fully sanctioned. Downside:
  operationally fragile — that relay + Pi session must stay up through the entire
  review **and** be re-stood-up for every update's re-review; "point it at your
  own server" apps sometimes draw a 2.1 request for exactly this.
- **Route B — in-app demo mode.** More app code, but zero live-infra dependency,
  survives every future re-review untouched, doubles as onboarding/marketing.
  Self-contained and **app-side**: a "Try it" affordance on the onboarding /
  relay-chooser screen loads an in-memory fake mesh with canned sessions — no
  pairing, no socket. Reuses the *same* canned scenarios the extension-side
  `/unbien test <scenario>` harness broadcasts: bundle those fixtures in the app
  and replay them through the same `applyRPC` fold used for live frames (one
  scenario source, two players). Note the existing `/unbien test` harness alone
  does **not** solve this — it runs on the extension side and still needs relay + Pi.

**Chosen (phased):** Route A for the v1 submission to move fast, with Route B
(demo mode) as the durable follow-up. If babysitting a relay + Pi session on
Apple's re-review schedule proves too costly, promote Route B ahead of v1.

## Standard submission work

### 8. 🔲 App Store Connect records

Create iOS + macOS records: primary/secondary category, age-rating
questionnaire, support URL, marketing URL, copyright.

### 9. 🔲 Screenshots

Per platform: iPhone 6.9", iPad 13", Mac. (Onboarding, session list, live
transcript, tool-approval, mesh view are the natural set.)

### 10. 🔲 Store metadata

Name, subtitle, description, keywords, promo text, "what's new", and the
**privacy nutrition labels** (mirror the privacy manifest — minimal/none).

### 11. 🔲 LICENSE + in-app third-party acknowledgements

Existing `todo` plan item. Add root `LICENSE` (MIT) and a Settings
acknowledgements screen: Highlightr (MIT) + bundled highlight.js (BSD-3),
swift-markdown-ui (MIT), NetworkImage (MIT), swift-cmark (cmark BSD-2). Preserve
remote-pi attribution.

### 12. 🔲 Archive / upload pipeline

Today the app runs via SwiftPM (`swift run un-bien-mac`). Ship path needs a real
`xcodebuild archive` of the Xcode targets → validate → upload (Xcode Organizer
or Transporter). Covered by the existing app-CI plan item. (App Store distribution
does not need separate notarization — that's for direct distribution.)

### 13. 🔲 TestFlight beta

Run a beta pass before public release — especially the iOS Local-Network prompt
flow and the macOS sandboxed Keychain + relay-connect flow.

## Two decisions to settle first

These shape multiple downstream tasks, so lock them before writing plists/notes:

1. **ATS posture** (task 2) — `NSAllowsLocalNetworking` vs. arbitrary-loads +
   justification.
2. **Reviewability strategy** (task 7) — demo relay+session vs. screencast vs.
   demo mode.
