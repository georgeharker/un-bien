---
title: "Install & setup"
---

Un Bien is three pieces that work together:

- the **Pi extension** — adds `/unbien`, the agent mesh, and relay connectivity
  to your terminal Pi sessions;
- the **relay** — a small WebSocket server you host, the meeting point between
  your machine and your phone;
- the **app** — the native iOS/macOS client that drives Pi from your phone.

A typical setup is: **stand up a relay**, **install the extension** and point it
at that relay, then **build/install the app** and pair it. Do them in that order.

> **There is no default relay.** Un Bien ships pointing at nobody's
> infrastructure — you must run your own (or point at one you trust) before the
> app can connect. This is deliberate: the relay operator can see routed
> plaintext (see [Design & protocol](design.md#trust-model-in-one-paragraph)).

---

## Quickstart

The 5-minute path: one relay (Docker), one machine, one pairing. (The app also
ships a **demo mode** — canned sessions, no infrastructure — if you just want
to look around first.)

### 1. Run a relay (any host your phone can reach)

```bash
docker build -t un-bien-relay ./relay
docker run -d --name un-bien-relay -p 3000:3000 -v un-bien-data:/data \
  --restart unless-stopped un-bien-relay
```

Note the address your phone will use — e.g. `http://192.168.1.20:3000` on your
LAN, or a Tailnet address. Put it behind a VPN or TLS for anything beyond your
home network (see [trust model](design.md#trust-model-in-one-paragraph)).

### 2. Set up Pi on your machine

Un Bien drives the [Pi coding agent](https://github.com/earendil-works/pi) — you
need Pi installed **with a working model provider** (an AI backend), plus the
un-bien extension:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@geohar/un-bien
```

Then, inside `pi`, authenticate a provider and point un-bien at your relay:

```text
/login          # pick a provider (Claude Pro/Max, ChatGPT Plus/Pro, or an API key)
/model          # pick the model to use
/unbien set-relay http://192.168.1.20:3000
```

No cloud provider needed if you run a local one — configure Ollama / vLLM /
LM Studio via `~/.pi/agent/models.json` (see [Pi's models
docs](https://github.com/earendil-works/pi)) and `/login` with a placeholder
key.

### 3. Pair your phone

In the app: **Add relay** → the same URL. Then on the machine:

```text
/unbien pair
```

Scan the QR (or paste the code). Your Pi sessions appear on the phone — tap in
to attach, or launch a new session remotely.

---

## Deployment flows

Every setup has the same three pieces — a relay your phone can reach, the
extension on your working machine, the paired app. What differs is **where the
relay lives and how it stays running**. Pick one of three flows:

| Flow                                                                                     | Relay runs as…                        | Best for                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| **A. [Tailscale + launchd / systemd](#flow-a--tailscale--launchd--systemd-recommended)** | bare-metal binary, OS login service   | the durable home setup — always-on box you own (**recommended**) |
| **B. [Docker](#flow-b--docker)**                                                         | container with a restart policy       | any Docker host — NAS, home server, VPS                          |
| **C. [Raw run from binaries](#flow-c--raw-run-from-binaries)**                           | foreground process, nothing installed | trying Un Bien out, development                                  |

All three flows also cover the machine side, including the optional
**unbien-launcher** — a small daemon (`unbien install`) that lets the app start
Pi sessions on your machine even when no Pi is running. Skip it if you only
ever attach to sessions you started yourself.

### Flow A — Tailscale + launchd / systemd (recommended)

A small always-on machine you own (Mac mini, home server, Linux box) runs the
relay as an OS service; [Tailscale](https://tailscale.com) makes it reachable
from your phone anywhere, with no port opened to the internet. The working
machine gets the extension plus the launcher as a login service, so everything
survives reboots unattended.

**1. Tailscale everything.** Install Tailscale on the relay host, your phone,
and your working machines. Note the relay host's MagicDNS name (e.g.
`relay-box.tailnet-name.ts.net`, or just `relay-box` with MagicDNS search) —
the relay URL in the steps below is `http://<relay-host>:3000`. Traffic inside
the tailnet is already encrypted (WireGuard), so plain `http://` is fine here;
TLS is only needed if you ever expose the relay beyond the tailnet (see
[TLS](#tls-production)).

**2. Build and install the relay on the host** (needs a Rust toolchain):

```bash
git clone https://github.com/georgeharker/un-bien
cd un-bien/relay
cargo build --release
install -m 755 target/release/un-bien-relay ~/.local/bin/
```

State (the membership DB `mesh.db` and `relay.log`) defaults to
`~/.local/state/un-bien/` on the host — relocate with `UNBIEN_STATE_DIR` (see
[relay environment variables](#relay-environment-variables)).

**3. Keep the relay running as a service.**

Linux — `~/.config/systemd/user/unbien-relay.service`:

```ini
[Unit]
Description=Un Bien relay
After=network-online.target

[Service]
ExecStart=%h/.local/bin/un-bien-relay
Restart=on-failure
RestartSec=5s
Environment=RUST_LOG=info

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now unbien-relay.service
loginctl enable-linger "$USER"    # headless boxes: keep user services after logout
curl -s http://localhost:3000/health   # → 200 OK
```

macOS — `~/Library/LaunchAgents/dev.unbien.relay.plist` (replace `YOU` with
your username):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.unbien.relay</string>
  <key>ProgramArguments</key>
  <array><string>/Users/YOU/.local/bin/un-bien-relay</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/.local/state/un-bien/relay.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.local/state/un-bien/relay.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.unbien.relay.plist
curl -s http://localhost:3000/health   # → 200 OK
```

**4. Working machine — extension + launcher service.** Same base steps as the
[Quickstart](#quickstart): install Pi and the extension, `/login` + `/model`,
then point un-bien at the relay (now via its tailnet name):

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@geohar/un-bien
```

```text
/unbien set-relay http://relay-box:3000
/unbien         # first-run wizard: agent name, session, relay on this terminal
/unbien pair    # QR for the app (scan it in step 6)
```

Then install the **unbien-launcher** as a login service so the machine is
reachable for remote launches even when no Pi is running:

```bash
npm install -g @geohar/un-bien    # puts the `unbien` CLI on PATH
unbien install                    # systemd --user (Linux) / launchd (macOS)
```

`unbien install` generates and activates the service from the bundled
templates:

- **Linux:** `~/.config/systemd/user/unbien-launcher.service` —
  `journalctl --user -u unbien-launcher -f` to follow it
- **macOS:** `~/Library/LaunchAgents/dev.unbien.launcher.plist` (label
  `dev.unbien.launcher`) — logs to `~/.local/state/un-bien/launcher.log`
- **Windows:** a Task Scheduler task (`RemotePiLauncher`) — the install step
  prompts for elevation once

The launcher is a lightweight mesh peer, **not** a Pi session: it reuses the
machine's paired identity and relay config, and spawns a `pi` window via
`tmux` (or `herdr`) when the app asks. Remote launch is **opt-in per
directory** — set `allow_remote_launch: true` in `<cwd>/.pi/un-bien/config.json`,
or machine-wide via `defaults.allow_remote_launch` in
`~/.pi/extensions/un-bien.json`. See the
[launcher README](../launcher/README.md) and
[Remote launch](../extension/README.md#remote-launch) for details.

**5. Phone.** Build and install the app (see [Build & install the
app](#build--install-the-app)), then **Add relay** →
`http://relay-box:3000`.

**6. Pair.** Scan the `/unbien pair` QR from step 4 (or re-run `/unbien pair`).
Your Pi sessions appear on the phone; with the launcher installed and remote
launch enabled, you can also start new sessions from the app when nothing is
running on the machine.

### Flow B — Docker

The quickest to stand up on any Docker host. `--restart unless-stopped` is the
keep-alive story — no service files needed. If the host is only reachable on
your LAN, your phone must be on the same network (or put the Docker host on
Tailscale like Flow A and use its tailnet name).

**1. Relay container:**

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
Verify with `curl http://<docker-host>:3000/health`.

**2. Working machine** — identical to Flow A step 4 (Pi + extension +
`/unbien set-relay http://<docker-host>:3000` + `/unbien pair` + optional
`unbien install` for the launcher service).

**3. Phone** — build/install the app, **Add relay** →
`http://<docker-host>:3000`, scan the pairing QR.

### Flow C — Raw run from binaries

Nothing installed, no service manager — every process runs in the foreground
under your terminal. Good for evaluating Un Bien, poking at the protocol, or
developing against it. Nothing survives a reboot or a closed terminal.

**1. Relay, straight from a release build** (needs a Rust toolchain):

```bash
cd relay
cargo build --release
RUST_LOG=info ./target/release/un-bien-relay   # Ctrl-C to stop
```

Defaults: port `3000`, state (mesh DB + `relay.log`) at
`~/.local/state/un-bien/`. Same machine as Pi? `http://localhost:3000` is
fine; otherwise use the host's LAN/tailnet address.

**2. Working machine** — Pi + extension as usual:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@geohar/un-bien
```

```text
/login
/model
/unbien set-relay http://localhost:3000
/unbien pair
```

**3. Launcher in the foreground** (optional — only if you want to test remote
launch):

```bash
npm install -g @geohar/un-bien-launcher
unbien-launcher    # Ctrl-C to stop
```

(From a dev clone instead: `node extension/dist/bin/launcher.js` after
`pnpm build`.)

**4. Phone** — build/install the app, **Add relay** → the same URL, scan the
QR.

---

## Relay environment variables

| Variable              | Default                                                        | Description                                                                        |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `UNBIEN_RELAY_PORT`   | `3000`                                                         | Port for the WS upgrade, `/health`, and `/mesh/*`.                                 |
| `UNBIEN_MESH_DB_PATH` | `/data/mesh.db` (Docker) · `<state root>/mesh.db` (bare metal) | SQLite membership DB (`UNBIEN_STATE_DIR`/XDG state root; parent dir auto-created). |
| `UNBIEN_STATE_DIR`    | `~/.local/state/un-bien`                                       | State root (mesh DB default, relay log).                                           |
| `RUST_LOG`            | _(none)_                                                       | Log filter — e.g. `info`, `debug`.                                                 |

Full reference (mesh endpoint, reverse proxy) is in the
[relay README](../relay/README.md).

## TLS (production)

Only needed when the relay is reachable beyond a VPN — terminate TLS in a
reverse proxy and expose an `https://` URL. Caddy example:

```caddy
relay.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Point both the extension and the app at `https://relay.yourdomain.com` — the
extension converts to `wss://` internally when it opens the socket.

---

## Build & install the app

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

## Pairing & devices

With the relay up and the extension connected:

```text
/unbien pair
```

Scan the printed QR with the app (or use the paste-code fallback). Pairing is
**per machine** — once a device is paired, every Pi process on that machine
accepts it (including the launcher daemon). In the app, set the same relay URL
in its preferences and you'll see the machine's sessions; tap in to attach, or
launch a new session.

Manage devices with `/unbien devices` and `/unbien revoke <shortid>`.

---

## Where things live

| What                                                  | Path                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| What                                                  | Path                                                                                                  |
| Global extension settings (relay URL, launch backend) | `~/.pi/extensions/un-bien.json`                                                                       |
| Per-directory config (incl. `allow_remote_launch`)    | `<cwd>/.pi/un-bien/config.json`                                                                       |
| State (sessions, identity, peers, logs)               | `~/.local/state/un-bien/` (`UNBIEN_STATE_DIR` relocates)                                              |
| Launcher service (Linux / macOS)                      | `~/.config/systemd/user/unbien-launcher.service` · `~/Library/LaunchAgents/dev.unbien.launcher.plist` |
| Relay membership DB                                   | `UNBIEN_MESH_DB_PATH` (`/data/mesh.db` in Docker; bare metal: `<state root>/mesh.db`)                 |

The complete settings reference — every config field and environment variable —
is in the [extension guide](../extension/README.md#configuration--settings).
Troubleshooting the launcher service:
[Remote launch & troubleshooting](../extension/docs/daemon.md).
