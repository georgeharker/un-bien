---
title: "Install & setup"
---

un-bien is three pieces that work together:

- the **Pi extension** — adds `/unbien`, the agent mesh, and relay connectivity
  to your terminal Pi sessions;
- the **relay** — a small WebSocket server you host, the meeting point between
  your machine and your phone;
- the **app** — the native iOS/macOS client that drives Pi from your phone.

A typical setup is: **stand up a relay**, **install the extension** and point it
at that relay, then **build/install the app** and pair it. Do them in that order.

> **There is no default relay.** un-bien ships pointing at nobody's
> infrastructure — you must run your own (or point at one you trust) before the
> app can connect. This is deliberate: the relay operator can see routed
> plaintext (see [Design & protocol](design.md#trust-model-in-one-paragraph)).

---

## 1. Stand up a relay

The relay is a Rust binary in the `relay/` crate. Host it yourself and put it
behind a VPN like [Tailscale](https://tailscale.com) or
[WireGuard](https://www.wireguard.com) so only your devices can reach the
WebSocket port. Full reference (env vars, mesh endpoint, reverse proxy) is in the
[relay README](../relay/README.md).

### Docker (quickest)

```bash
# From the monorepo root:
docker build -t un-bien-relay ./relay
docker run -d \
  --name un-bien-relay \
  -p 3000:3000 \
  -v un-bien-data:/data \
  --restart unless-stopped \
  un-bien-relay
```

The relay listens on a **single port** (`3000` by default) serving three
surfaces: `GET /` (WebSocket upgrade), `GET /health`, and `GET|POST
/mesh/<owner_pk_hash>` (signed membership). The SQLite membership DB lives at
`/data/mesh.db` — the `-v un-bien-data:/data` volume keeps it across upgrades.

### From source (bare metal)

```bash
cd relay
cargo build --release
RUST_LOG=info ./target/release/un-bien-relay
```

### Relay environment variables

| Variable            | Default                         | Description                                        |
| ------------------- | ------------------------------- | -------------------------------------------------- |
| `UNBIEN_RELAY_PORT` | `3000`                          | Port for the WS upgrade, `/health`, and `/mesh/*`. |
| `UNBIEN_MESH_DB_PATH` | `/data/mesh.db` (Docker) · `data/mesh.db` (bare metal) | SQLite membership DB. Parent dir auto-created. |
| `RUST_LOG`          | *(none)*                        | Log filter — e.g. `info`, `debug`.                 |

### Keep it running

- **Docker:** `--restart unless-stopped` (above) is enough.
- **launchd / systemd:** wrap `un-bien-relay` in a user unit if you run it
  bare-metal. The extension's supervisor ships templates you can adapt as a
  starting point — see [`extension/service-templates/`](https://github.com/georgeharker/un-bien/tree/main/extension/service-templates)
  (`systemd.service.template`, `launchd.plist.template`).

### TLS (production)

Terminate TLS in a reverse proxy and expose an `https://` URL. Caddy example:

```
relay.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Point both the extension and the app at `https://relay.yourdomain.com` — the
extension converts to `wss://` internally when it opens the socket.

---

## 2. Install the extension

Requirements: Node 20+ and Pi (the host coding agent).

```bash
pi install npm:@geohar/un-bien
```

That registers the `/unbien` slash command and deploys the agent-network skill.
Point it at your relay and verify:

```text
/unbien set-relay https://relay.yourdomain.com
/unbien config          # should print your URL with source `config`
```

First run of the bare `/unbien` walks a short wizard (agent name, default
session, whether to use the relay on this terminal). See the
[extension guide](../extension/README.md) for the full command reference and the
[settings reference](../extension/README.md#configuration--settings).

### CLI + daemon mode (optional)

To use the shell CLI and keep Pi running in the background, install globally and
register the supervisor as a login service:

```bash
npm install -g @geohar/un-bien   # exposes `unbien` + `pi-supervisord` on PATH
unbien install                   # systemd --user (Linux) / launchd LaunchAgent (macOS)
```

`unbien install` generates the service file from the bundled templates:

- **macOS:** `~/Library/LaunchAgents/dev.unbien.supervisord.plist`
  (from [`launchd.plist.template`](https://github.com/georgeharker/un-bien/blob/main/extension/service-templates/launchd.plist.template))
- **Linux:** `~/.config/systemd/user/unbien-supervisord.service`
  (from [`systemd.service.template`](https://github.com/georgeharker/un-bien/blob/main/extension/service-templates/systemd.service.template))
- **Windows:** a Task Scheduler task via the `task-*.template` files

Full daemon walkthrough and troubleshooting:
[Daemon mode](../extension/README.md#daemon-mode) ·
[daemon troubleshooting](../extension/docs/daemon.md).

---

## 3. Build & install the app

The client is a SwiftUI app in `app/` targeting **iOS 17+ / macOS 14+**. Build
and run it from **Xcode** — the interactive app needs the real app targets, not a
command-line runner.

The Xcode project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
from `app/project.yml`:

```bash
cd app
xcodegen generate        # writes UnBien.xcodeproj
open UnBien.xcodeproj     # then build/run the UnBien-iOS / UnBien-macOS scheme
```

Signing, entitlements, and the Info.plist checklist (iCloud Keychain sync, the
macOS network-client sandbox entitlement, camera usage for QR scanning) are in
[Deployment & signing](../DEPLOY.md). The short version: a normal Development
Team + bundle id is enough for Owner-key iCloud sync; **no** iCloud/CloudKit
capability is needed.

---

## 4. Pair your phone

With the relay up and the extension connected:

```text
/unbien pair
```

Scan the printed QR with the app (or use the paste-code fallback). Pairing is
**per machine** — once a device is paired, every Pi process on that machine
accepts it. In the app, set the same relay URL in its preferences and you'll see
the machine's sessions; tap in to attach, or launch a new session.

Manage devices with `/unbien devices` and `/unbien revoke <shortid>`.

---

## Where things live

| What | Path |
| --- | --- |
| Global extension settings | `~/.pi/extensions/un-bien.json` |
| Per-directory config | `<cwd>/.pi/un-bien/config.json` |
| State (sessions, identity, daemons, logs) | `~/.pi/un-bien/` |
| Relay membership DB | `UNBIEN_MESH_DB_PATH` (`/data/mesh.db` in Docker) |

The complete settings reference — every config field and environment variable —
is in the [extension guide](../extension/README.md#configuration--settings).
