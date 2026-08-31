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

### 1. ✅ Privacy manifest (`PrivacyInfo.xcprivacy`)

Added `app/App/Shared/PrivacyInfo.xcprivacy` (bundled into both targets via the
shared sources path):

- **Data collection / tracking:** none — `NSPrivacyCollectedDataTypes` empty,
  `NSPrivacyTracking` false (mesh config is local JSON; no analytics).
- **Required-reason APIs:** UserDefaults `CA92.1` (app-only preferences:
  theme, toggles, scroll memory) + file-timestamp `C617.1` (in-container,
  transitive). NB: **Keychain is NOT a required-reason category** — Apple's
  five categories are UserDefaults / file-timestamp / disk-space /
  system-boot-time / active-keyboard (verified against the vendor docs;
  `C56D.1` is a UserDefaults SDK-wrapper code, not a keychain one).
- If App Store Connect's upload scan (ITMS-91053) flags disk-space or
  boot-time APIs pulled in by a dependency, add that category then.

### 2. ✅ App Transport Security posture

**Settled (2026-08-31, empirically):** `NSAllowsArbitraryLoads = true` stays,
with the justification below in the review notes. We TRIED the "preferred"
`NSAllowsLocalNetworking` posture and it severed every phone pairing within
minutes — the primary connection path is **Tailscale**, whose 100.64/10 CGNAT
range is not RFC1918 and therefore NOT covered by the local-network exemption.
Relay endpoints are user-configured (localhost / LAN / Tailnet / self-hosted
VPS) and unknowable at build time, so arbitrary loads is the honest posture for
a user-configured self-hosted-server client — the same class as SSH and
home-automation clients. Long-term tightening: `wss://` relays (`tailscale
serve` issues ts.net certs) would allow revisiting.

Review-notes justification:

> The app is a client for user-configured, self-hosted relay servers — the
> user enters the address (localhost, LAN, VPN, or their own VPS). No fixed
> hosts exist to enumerate, and the app makes no connections to arbitrary
> internet hosts beyond the one the user configures.

### 3. ✅ Local Network permission (iOS)

`NSLocalNetworkUsageDescription` added (pinned in `project.yml`, flows to the
generated plist): "Un Bien connects to relays on your local network to reach
the machines running your agents." No Bonjour key — paste/QR-addressed relays
do no service discovery.

### 4. ✅ macOS App Sandbox

`com.apple.security.app-sandbox = true` + `com.apple.security.network.client
= true` added to the macOS entitlements (pinned in `project.yml`). Both
targets build clean with them (device + macOS verified 2026-08-31).
Still to do under §13 TestFlight: re-test Keychain + relay connect UNDER the
sandbox at runtime.

### 5. ✅ Export compliance

`ITSAppUsesNonExemptEncryption = false` set in both Info.plists (pinned in
`project.yml`): CryptoKit Ed25519 + TLS = standard/exempt crypto, declared so
uploads don't prompt.

### 6. ✅ Privacy policy URL

Published as a docs-site page: `docs/privacy.md` (rendered at
<https://docs.georgeharker.com/un-bien/docs/privacy.html> — deployed by the
docs workflow on push). Content matches the privacy manifest: nothing

collected, nothing tracked, no fixed servers; local storage + keychain;
user-hosted relays (with the trust-model caveat).

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
  pairing, no socket. Reuses the _same_ canned scenarios the extension-side
  `/unbien test <scenario>` harness broadcasts: bundle those fixtures in the app
  and replay them through the same `applyRPC` fold used for live frames (one
  scenario source, two players). Note the existing `/unbien test` harness alone
  does **not** solve this — it runs on the extension side and still needs relay + Pi.

**Chosen (user, 2026-08-31): Route B demo mode for v1, with docs + screencast
in the review notes as the COMPLEMENT — not Route A, not video-only.** Split of
roles:

- **Demo mode (the load-bearing 2.1 answer):** a "Try the demo" affordance on
  onboarding loads an in-memory fake mesh with canned sessions — replaying the
  SAME fixture corpus the extension-side `/unbien test` harness broadcasts,
  folded through the real `applyRPC` reducer. Deliberately READ-ONLY and
  honestly labeled (a "demo data" banner, composer disabled) so it reads as
  "the app works", not marketing — no fake agent replies. It exists so the
  binary is never an empty shell for the reviewer.
- **Docs + screencast (the complement):** a public setup-docs page + a short
  video of the REAL flow (relay, pairing, live agent turn) in the review
  notes — covering exactly what fixtures can't show — plus the principled
  note that there is no service to provision (client of user-owned
  machines; no account system).
- **Never pre-host a relay.** If a reviewer explicitly demands live access,
  stand one up that hour, for that review only.

Route A (standing demo relay + session) is RETIRED as the v1 plan — the
babysitting burden through review + every re-review isn't worth it. Video-only
was rejected: it doesn't change what the binary shows, and the empty-shell
first impression is the 2.1/4.2 trigger.

## Standard submission work

### 8. 🔲 App Store Connect records

Create iOS + macOS records: primary/secondary category, age-rating
questionnaire, support URL, marketing URL, copyright.

### 9. 🔲 Screenshots

Per platform: iPhone 6.9", iPad 13", Mac. (Onboarding, session list, live
transcript, tool-approval, mesh view are the natural set.)

### 10. 🔲 Store metadata (copy drafted — paste into ASC)

- **Name:** Un Bien
- **Subtitle** (≤30): Your Pi agents, on your phone
- **Keywords:** pi,agent,coding,developer,ai,remote,terminal,relay,transcript,mesh
- **Promo text** (≤170): Attach to your Pi coding-agent sessions from your phone — stream transcripts, watch tool calls, answer questions, and steer the agent. Self-hosted; nothing leaves your machines.
- **Description (lead):**
  > Un Bien is a native iOS/macOS client for the Pi coding agent. Pair your
  > phone with your own machines over a relay you host, then attach to running
  > agent sessions: live transcripts with styled edit diffs and tool results,
  > inline images, thinking blocks, plan & subagent panels — and an interactive
  > prompt for ask-style clarifications. Steer mid-turn or queue follow-ups;
  > launch new sessions on paired machines (opt-in, machine-side).
  >
  > Self-hosted by design: there is no Un Bien cloud, no account, and no
  > telemetry — your relay, your keys, your machines. Includes a read-only demo
  > mode so you can look around without any setup.
- **What's new (1.0):** Initial release.
- **Privacy nutrition labels:** mirror the manifest — Data Not Collected,
  no tracking. Category answers: everything "none".
- **Support URL:** <https://docs.georgeharker.com/un-bien> (the docs site
  home — Install & setup is the practical entry); issues:
  <https://github.com/georgeharker/un-bien/issues>.

### 11. ✅ LICENSE + in-app third-party acknowledgements

- Root `LICENSE` (MIT, © 2026 George Harker); the remote-pi MIT license +
  attribution preserved in `extension/LICENSE` and the README.
- Settings → Acknowledgements → **Licenses** (drill-down screen, `LicensesView`):
  the FULL agreement text for every bundled part — Un Bien, remote-pi,
  Highlightr, highlight.js (notice from the minified bundle + BSD-3),
  swift-markdown-ui, NetworkImage, swift-cmark — selectable, monospaced,
  rendered verbatim. Texts are vendored into `app/App/Shared/Licenses/`
  (bundled as resources) and guarded by `scripts/sync-licenses.sh`, which
  syncs from the SPM checkouts and FAILS on drift (highlightjs.txt is
  hand-maintained — upstream ships no standalone file).

### 12. 🔲 Archive / upload pipeline

Today the app runs via SwiftPM (`swift run un-bien-mac`). Ship path needs a real
`xcodebuild archive` of the Xcode targets → validate → upload (Xcode Organizer
or Transporter). Covered by the existing app-CI plan item. (App Store distribution
does not need separate notarization — that's for direct distribution.)

### 13. 🔲 TestFlight beta

Run a beta pass before public release — especially the iOS Local-Network prompt
flow and the macOS sandboxed Keychain + relay-connect flow.

## Both v1-blocking decisions are settled

1. **ATS posture** (task 2) — `NSAllowsArbitraryLoads` + review-notes
   justification (empirically settled; see task 2).
2. **Reviewability strategy** (task 7) — Route B demo mode + docs/screencast
   complement; never pre-host a relay (see task 7).
