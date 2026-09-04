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
<https://docs.georgeharker.com/un-bien/main/docs/privacy.html> — deployed by the
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

### Video recording script (real pi, mirrors the demo's shape)

**Before recording:** relay up + a real pi session with un-bien connected +
phone paired (all true today). Demo mode OFF (Settings) so Home shows only
real content. Start iOS screen recording (Control Center). Record the Mac
terminal with the system recorder or Screen Studio. **Blur the machine name**
wherever it appears (Home rows / relay headers) — one masked rectangle in
post is enough; store screenshots need no blur (see §9).

| #   | Surface          | Action / paste-able prompt                                                                                                                               |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mac terminal     | Fresh pi session; `/unbien` shows relay connected. Type: `How do I print text in red in zsh? Show the escape-sequence way and the prompt-expansion way.` |
| 2   | Phone Home       | The machine's session appears (blur the machine name).                                                                                                   |
| 3   | Phone transcript | Tap in — the turn streams live: text, then the answer with code blocks (the `\e[31m` + `%F{red}` pair).                                                  |
| 4   | Second session   | Prompt: `Before you write any code, use ask_user to ask me whether the new header should be a filled bar or a minimal underline.`                        |
| 5   | Phone            | The ask badge appears on Home; tap in — the ask sheet presents; ANSWER FROM THE PHONE (the interactive surface).                                         |
| 6   | Phone Home       | Both sessions listed (blur machine name).                                                                                                                |
| 7   | (optional)       | Demo-mode banner shot — Settings → Demo on, one canned transcript — shows the reviewability affordance.                                                  |

Cut to 30–60 s; land it unlisted and put the URL in the review notes.

## Standard submission work

### 8. 🔲 App Store Connect records

Create iOS + macOS records: primary/secondary category, age-rating
questionnaire, support URL, marketing URL, copyright.

### 9. 🔲 Screenshots (capture pipeline ready — shoot + upload)

**Tooling:** `scripts/appstore-screenshots.sh` — `setup iphone` boots the 6.9"
iPhone 17 Pro Max simulator (1320×2864), builds + installs + launches the app
(demo mode ON by default → deterministic canned content); navigate in the
Simulator, then `shot <name>` after each surface; files land numbered in
`store-screenshots/<device>/`. `setup ipad` same for iPad Pro 13" (2064×2752).
Mac shots: run `UnBien-macOS` directly + the system capture tool.

**Surface checklist (per device, natural set):**

1. Onboarding / owner-key creation
2. Home — demo mode's two sessions (main + nested subagent) + pending-ask
   badge; the demo relay is named "Demo", so NO machine-name blur is needed
   in store shots
3. Transcript — the zsh red-print answer: markdown + the two code blocks
   (`\e[31m` escape + `%F{red}` prompt-expansion)
4. Edit-diff tool card (unrolled)
5. Ask sheet — the design question ("filled bar or minimal underline")
6. Settings — theme picker / Licenses screen

iPhone 6.9" is REQUIRED; iPad 13" required (universal family); Mac for the
macOS platform. ASC accepts the native simulator dimensions directly.

### 10. 🔲 Store metadata (copy drafted — paste into ASC)

- **Name:** Un Bien
- **Subtitle** (≤30): Your Pi agents, on your phone
- **Keywords:** pi,agent,coding,developer,ai,remote,terminal,relay,transcript,mesh
- **Promo text** (159/170): Attach to your Pi coding-agent sessions from
  your phone — stream transcripts, watch tool calls, and steer the agent.
  Self-hosted; nothing leaves your machines.
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
  >
  > Get started (self-hosting in ~5 minutes):
  > <https://docs.georgeharker.com/un-bien/main/docs/install.html>
- **What's new (1.0):** Initial release.
- **Privacy nutrition labels:** mirror the manifest — Data Not Collected,
  no tracking. Category answers: everything "none".
- **Support URL:** <https://docs.georgeharker.com/un-bien/main> (the docs site
  home — Install & setup is the practical entry); issues:
  <https://github.com/georgeharker/un-bien/issues>.

### 11. ✅ LICENSE + in-app third-party acknowledgements

- Root `LICENSE` (MIT, © 2026 George Harker); the remote-pi MIT license +
  attribution preserved in `extension/LICENSE` and the README.
- Settings → Acknowledgements → **Licenses** (drill-down screen, `LicensesView`):
  the FULL agreement text for every bundled part — Un Bien, remote-pi,
  HighlighterSwift (MIT; credits the original Highlightr author), highlight.js
  (notice from the minified bundle + BSD-3),
  swift-markdown-ui, NetworkImage, swift-cmark — selectable, monospaced,
  rendered verbatim. Texts are vendored into `app/App/Shared/Licenses/`
  (bundled as resources) and guarded by `scripts/sync-licenses.sh`, which
  syncs from the SPM checkouts and FAILS on drift (highlightjs.txt is
  hand-maintained — upstream ships no standalone file).

### 12. ✅ Archive / export pipeline (upload pending ASC records)

`scripts/archive-appstore.sh [ios|macos|both]` — Release archive of both
schemes with App Store distribution signing (`-allowProvisioningUpdates`
registers the explicit App ID + mints the distribution profile on first run),
then exports `UnBien-iOS.ipa` / `UnBien-macOS.pkg` to `app/build/Export/`
(gitignored). VERIFIED end-to-end 2026-08-31 — including the fix for the
`exportArchive Copy failed` trap: the distribution pipeline shells out to
`rsync` from PATH, and a homebrew rsync 3.5.0 override kills the IPA packaging
step; the script pins `/usr/bin` first for the export so the system rsync
resolves. UPLOAD stays manual (Xcode Organizer / Transporter / `xcrun altool
--upload-app`) until the ASC records exist — then it can be scripted.

### 13. 🟢 TestFlight beta pass (builds verified 2026-08-31)

iOS 1.0(2) + macOS 1.0(2) live after two processor bounces (fixed:
`UISupportedInterfaceOrientations` for the universal build; macOS
`LSApplicationCategoryType`). **VERIFIED on both platforms:** distribution
builds connect to the real relay (iOS: ATS + Local Network + Tailscale;
macOS: sandboxed Keychain + relay), and the ask flow presents + works from
the app side. Operational notes: a backgrounded iOS app suspends its relay
socket (misses live pushes; sync replay heals on foreground), and asks land
under the ASKING session's key — the Home badge is the discovery surface
when the wrong transcript is open.

**Remaining:** paste review notes (text-first, per §7), pick builds on each
1.0, submit per platform. Optional: launch-chip test (needs the launcher
daemon).

### 14. 🔲 Review notes copy (drafted — paste into ASC "App Review Information → Notes", per platform)

> **What this app is.** Un Bien is the remote client for the Pi coding agent —
> an open-source, self-hosted AI coding assistant. If you know the mobile
> remote clients for hosted AI coding assistants (e.g. the Claude app): this
> is that experience, but the agent runs on the user's own machines and there
> is no hosted service anywhere. The target user already runs Pi in their
> terminal; to get remote access they (1) install the un-bien extension into
> Pi — a standard extension install, (2) run a small self-hosted relay (one
> command; localhost, LAN, Tailnet, or any VPS), and (3) pair the phone by
> scanning a QR code. The app then attaches to their running agent sessions:
> live transcripts (markdown, styled edit diffs, tool results, inline images)
> and answering the agent's clarifying questions mid-turn. There is no Un Bien
> account and no Un Bien server — the app talks only to the user's own
> machines, the same app class as SSH clients and home-automation companions.
>
> **How to review it without any infrastructure (demo mode):**
>
> 1. Launch the app — onboarding creates a local owner key (device keychain
>    only; no account, no signup, nothing leaves the device).
> 2. Open Settings → **Demo** (or the "Try the demo" affordance during
>    onboarding). This loads an in-app, read-only demo mesh: two sessions (a
>    main agent and a nested subagent) with canned transcripts, an edit-diff
>    tool card, and a pending ask — the relay is literally named "Demo", so
>    nothing needs masking. No network connection and no pairing are involved.
> 3. From there the whole UI is exercisable: open a transcript, unroll the
>    Edit tool card to see the diff, open the ask sheet, browse the theme
>    picker and the third-party licenses screen.
>
> **Why there is no demo account to log into:** there is no Un Bien cloud, no
> account system, and no developer-operated server — every relay and agent the
> app talks to belongs to the user. The in-app demo mode exists precisely so
> the binary is reviewable without provisioning anything.
>
> **Why App Transport Security allows arbitrary loads:** relay endpoints are
> user-configured at runtime (QR pairing or manual entry) — the user may point
> the app at a localhost relay, a LAN machine, a Tailscale address (100.64/10
> CGNAT — not RFC1918, so NSAllowsLocalNetworking does not cover it), or a
> self-hosted VPS. The endpoint set is unknowable at build time, so
> arbitrary-loads is the honest posture for a user-configured
> self-hosted-server client. The app makes no requests to any
> developer-operated server; it only connects where the user directs it.
>
> **Camera:** used only to scan the pairing QR code (NSCameraUsageDescription
> present).
>
> **Crypto:** an Ed25519 keypair generated on-device for local identity, plus
> TLS/WebSocket transport — standard exempt crypto
> (ITSAppUsesNonExemptEncryption = NO). No data is collected and there is no
> tracking (privacy manifest attached; App Privacy answers are "none").
>
> **Video (the real flow, for completeness):** <URL — pairing, a live agent
> turn, answering an ask from the phone> — unlisted link.
>
> **Contact:** <name, phone, email>

(macOS record: same text, minus the Local Network paragraph; add "the app
runs in the App Sandbox with only the network-client entitlement — outbound
WebSocket only, no server functionality.")

## Both v1-blocking decisions are settled

1. **ATS posture** (task 2) — `NSAllowsArbitraryLoads` + review-notes
   justification (empirically settled; see task 2).
2. **Reviewability strategy** (task 7) — Route B demo mode + docs/screencast
   complement; never pre-host a relay (see task 7).
