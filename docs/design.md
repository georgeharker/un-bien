---
title: "Design & protocol"
---

The decision records and wire specs behind un-bien. Start here if you want to
understand *how* it works — the client architecture, the on-the-wire protocol,
and the identity/trust model — rather than how to install and run it.

| Document | What it covers |
| --- | --- |
| [Architecture & design](../DESIGN.md) | The consolidated decision record for the native iOS/macOS client: layers, wire→`Codable` mapping, crypto/pairing, multi-relay transport, the render pipeline, theming, and the byte-level wire-conformance rules. |
| [rpc-envelope protocol](rpc-envelope.md) | The canonical wire document: envelope format, identity model, ACK protocol, cross-PC routing, mesh membership, and the trust boundary (what the relay sees and doesn't). |
| [pi.on() ↔ frame map](rpc-on-event-map.md) | How Pi SDK events map to the wire frames the app renders. |
| [Machine identity](identity.md) | How a machine's long-term Ed25519 identity is stored and selected (`keychain` vs `file` backend). |

## Trust model in one paragraph

The relay is a **routing pipe**, not a confidentiality boundary. TLS protects
transit, but the relay operator can see routed plaintext protocol content and
metadata — un-bien is **not** end-to-end encrypted. Route eligibility for
Pi↔Pi traffic comes from Owner-signed membership blobs that directly list both
canonical Pi keys; that authorizes routing, it does not prove the Owner controls
either Pi, and there is no transitivity across blobs. Because of all this,
un-bien ships with **no default relay** and recommends you self-host one behind
a VPN. See [rpc-envelope](rpc-envelope.md) for the exact boundaries.
