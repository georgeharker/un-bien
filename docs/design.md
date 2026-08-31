---
title: "Design & development"
---

The decision records, wire specs, and developer references behind Un Bien. Start
here if you want to understand _how_ it works — the client architecture, the
on-the-wire protocol, the identity/trust model — or how to build, sign, and test
it, rather than how to install and run it.

## Design & protocol

| Document                                   | What it covers                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture & design](../DESIGN.md)      | The consolidated decision record for the native iOS/macOS client: layers, wire→`Codable` mapping, crypto/pairing, multi-relay transport, the render pipeline, theming, and the byte-level wire-conformance rules. |
| [rpc-envelope protocol](rpc-envelope.md)   | The canonical wire document: envelope format, identity model, ACK protocol, cross-PC routing, mesh membership, and the trust boundary (what the relay sees and doesn't).                                          |
| [pi.on() ↔ frame map](rpc-on-event-map.md) | How Pi SDK events map to the wire frames the app renders.                                                                                                                                                         |
| [Machine identity](identity.md)            | How a machine's long-term Ed25519 identity is stored and selected (`keychain` vs `file` backend).                                                                                                                 |

## Trust model in one paragraph

The relay is a **routing pipe**, not a confidentiality boundary. TLS protects
transit, but the relay operator can see routed plaintext protocol content and
metadata — Un Bien is **not** end-to-end encrypted. Route eligibility for
Pi↔Pi traffic comes from Owner-signed membership blobs that directly list both
canonical Pi keys; that authorizes routing, it does not prove the Owner controls
either Pi, and there is no transitivity across blobs. Because of all this,
Un Bien ships with **no default relay** and recommends you self-host one behind
a VPN. See [rpc-envelope](rpc-envelope.md) for the exact boundaries.

**Remote launch is never a default.** Pairing lets the phone attach to and
steer sessions _you_ are running — it grants no code execution by itself.
Spawning anything on a machine requires active, machine-side steps the phone
cannot take: a per-directory `allow_remote_launch` opt-in in that machine's
un-bien config (absent ⇒ every `session_launch` request is silently dropped,
regardless of any other un-bien settings), and — for launching on an idle
machine where no Pi is running at all — the [launcher
daemon](../launcher/README.md) explicitly installed and running to hold the
machine's control room. No daemon, no listener: there is nothing to receive a
launch request.

## Building, signing & testing

| Document                                             | What it covers                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Install & setup](install.md#build--install-the-app) | Building the iOS/macOS app with Xcode + XcodeGen, and standing up the relay.                                                                       |
| [Deployment & signing](../DEPLOY.md)                 | Signing, entitlements, and the Info.plist checklist for a shippable app target (iCloud Keychain sync, macOS network-client sandbox, camera usage). |
| [Feature test drive](../TESTING.md)                  | Exercising the features by hand end to end.                                                                                                        |
| [Self-host the relay](../relay/README.md)            | The relay's own build, environment variables, mesh endpoint, and reverse-proxy setup.                                                              |
