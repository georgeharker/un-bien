<p align="center">
  <img src="app/icons/un-bien-macos-1024.png" alt="Un Bien" width="128" />
</p>

# Un Bien

Remote-control your [Pi coding agent](https://github.com/earendil-works/pi)
sessions from your phone: a native iOS/macOS client that pairs to your machine
over a relay you host, **attaches to running Pi sessions (or launches new ones)**,
renders their transcripts with styled edit/tool-result summaries, and lets you
approve tools and steer the agent — plus a local agent mesh so multiple Pi
sessions (and agents) can talk to each other.

> **Status:** WIP, actively maturing — functional and usable, with polish
> ongoing toward the first public release.

## Monorepo layout

| Path         | What it is                                                              |
| ------------ | ----------------------------------------------------------------------- |
| `app/`       | Native SwiftUI client (iOS + macOS). Build/test with `swift build` / `swift test`. |
| `extension/` | The Pi extension (TypeScript). Loaded by pointing `pi` at the repo root (`pi.extensions` → `./extension/dist`). Build with `pnpm -C extension build`. |
| `relay/`     | The WebSocket relay (Rust, package `un-bien-relay`). A dumb routing pipe — TLS in transit; the operator can see routed plaintext, so self-host one you trust. |
| `docs/`      | Protocol notes and fixtures.                                            |

## Attribution

Un Bien is derived from **[remote-pi](https://github.com/jacobaraujo7/remote_pi)**
by **Jacob Moura** ([@jacobaraujo7](https://github.com/jacobaraujo7)), used under
the MIT License. The `extension/` and `relay/` trees began as forks of that
project — thank you to Jacob and the remote-pi contributors for the original
design and implementation, which Un Bien builds on.

The original MIT license and copyright are preserved in
[`extension/LICENSE`](extension/LICENSE). Un Bien's own changes (the native app,
the rpc-envelope protocol, the monorepo consolidation, and the Un Bien rename)
are © 2026 George Harker, likewise under the MIT License.
