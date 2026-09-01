# Remote launch & launcher daemon — troubleshooting

Companion to the README's [Remote launch](../README.md#remote-launch) section.
Each scenario starts with the symptom you'd actually observe, followed by
likely causes and how to fix it.

---

## 1. `unbien install` fails

### "launcher script not found"

```text
[un-bien] install failed: Error: launcher script not found at
/Users/x/dist/bin/launcher.js. Run `pnpm build` (dev) or
`npm install -g @geohar/un-bien` (prod) first.
```

You're running `unbien install` from a dev clone where `dist/` doesn't
exist yet, or from a partial install.

```bash
# Dev clone:
cd extension && pnpm build

# Production install:
npm install -g @geohar/un-bien
unbien install
```

### "launchctl: bootstrap … already running"

A previous install left a stale entry. The fix is built into `install` —
re-run it and the launcher unloads the old entry before bootstrapping the
new one. If it still fails:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.unbien.launcher.plist
launchctl unload ~/Library/LaunchAgents/dev.unbien.launcher.plist 2>/dev/null
rm ~/Library/LaunchAgents/dev.unbien.launcher.plist
unbien install
```

### "systemctl --user … No such file or directory"

Linux without a logged-in graphical session (headless server). On most
distros `systemctl --user` requires `loginctl enable-linger <user>` so
the unit survives logout:

```bash
loginctl enable-linger $USER
systemctl --user daemon-reload
unbien install
```

### Windows: the UAC prompt fails or is declined

`unbien install` needs elevation **once** — only the `schtasks /Create`
that registers the task requires admin. Accept the prompt when it appears.
Stopping/starting the task afterwards (`/End`, `/Run`) works un-elevated.

---

## 2. The launcher doesn't start at login

### Check the service status

```bash
# Linux
systemctl --user status unbien-launcher
journalctl --user -u unbien-launcher -n 50

# macOS
launchctl list | grep dev.unbien
tail -100 ~/.local/state/un-bien/launcher.log
```

### Common failures

- **`node: cannot find module …`** or immediate exit — the absolute paths
  baked into the unit/plist no longer match where the package lives. This
  happens when you reinstall Node via a version manager (nvm/fnm) or
  uninstall/reinstall the package to a different location. Fix:
  `unbien uninstall && unbien install` (install snapshots the current
  node binary and paths).
- **`tmux: command not found`** (at launch time, not startup) — the PATH
  captured at install time didn't include the remote-launch backend.
  Install tmux (or herdr), then re-run `unbien install` to refresh PATH.
- **First connect race** — the launcher logs `initial connect failed (…)
— retrying every 3000ms` and retries on its own. This is normal when
  the relay starts in the same breath; it clears once the relay is up.

### Run the launcher in the foreground for debugging

Bypass systemd/launchd and run it directly so you can see startup errors
live:

```bash
unbien-launcher          # from @geohar/un-bien-launcher
# or, from the extension package:
node $(npm root -g)/@geohar/un-bien/dist/bin/launcher.js
```

If it prints `[un-bien launcher] listening on control room …` and stays
up, the daemon itself is fine — the problem is in the unit/plist
environment (PATH, node path). Re-run `unbien install`.

---

## 3. Remotely launched pis can't read the keychain (tmux security sessions)

**Symptoms:** a remote launch opens the tmux window but pi dies silently (no
output, no stderr), or fails with `No identity could be read, but N device(s)
are already paired — refusing to generate a NEW one` (the
`PairedIdentityMissingError` guard). An `identity.json.bogus-*` file appears
in the state root. Everything works when you start pi yourself in Terminal.

**Cause — macOS security sessions:** keychain access follows the *security
session* a process was spawned into, and every tmux pane inherits the tmux
**server's** context — not the terminal that opened the window. With
`launch.backend: "tmux"` the server is created by whichever process first
needed it: the launcher. If the launcher was started from a detached or
session-poor context (a daemon, a service manager like `sharedserver`, SSH),
the tmux server it creates carries that context and **denies keychain access
to every pane it ever hosts**. Worse, the server **outlives the launcher**:
killing/restarting the launcher just attaches new windows to the orphaned
server, so a bad creation context persists across launcher restarts.

A second wrinkle: a keychain read can require an **ACL confirmation** when
the reading binary differs from the one that created the item (e.g. after an
nvm/npm reinstall swaps the node binary). A background process has no path to
the Security Agent UI, so it gets `errSecInteractionNotAllowed` instead of a
prompt — same symptom, same fixes.

**Recovery:** kill the orphaned tmux server so the next launch recreates it
from a healthy context:

```bash
tmux kill-session -t un-bien    # or tmux kill-server (kills ALL sessions)
```

**Lasting fixes (any one of these):**

1. **Pre-seed the tmux session from your own Terminal** — the server then
   lives in your GUI login session for good, and the launcher only ever adds
   windows to it:

   ```bash
   tmux new-session -d -s un-bien
   ```

2. **Run the launcher as a login service** (`unbien install` — launchd
   LaunchAgent / systemd `--user`), not from a detached daemon: the launcher
   — and any tmux server it creates — stays inside your login session where
   the keychain just works.

3. **The context-proof option — seed the file identity fallback.** The
   resolver reads `~/.local/state/un-bien/identity.json` automatically
   whenever the keychain throws (no prompt, no re-pairing, any security
   session):

   ```bash
   security find-generic-password -s dev.unbien.pi -a longterm-ed25519 -w \
     > ~/.local/state/un-bien/identity.json
   chmod 600 ~/.local/state/un-bien/identity.json
   ```

**Related:** the launcher needs your env (`PI_CODING_AGENT_DIR`, and
`UNBIEN_RELAY`/`UNBIEN_STATE_DIR` if you use them) in its spawn context. If
you run it under a service manager, pin them explicitly in the server
definition's env map instead of relying on ambient shell env — a daemon's
children inherit the *daemon's* environment, not your shell's.

---

## 4. The app can't launch a session on this machine

The launcher is running and the app sees the machine's control room, but
launch requests do nothing.

### Remote launch is not enabled for that directory

The launcher only honors `session_launch` where it's opted in:

```jsonc
// <cwd>/.pi/un-bien/config.json — per directory
{ "allow_remote_launch": true }
```

or machine-wide, in `~/.pi/extensions/un-bien.json`:

```jsonc
{ "defaults": { "allow_remote_launch": true } }
```

### Turn on the diagnostic log

The launcher writes its decisions to the envelope debug log. Enable it in
`~/.pi/extensions/un-bien.json`:

```jsonc
{ "debug": { "envelope": true } }
```

then reproduce and read
`~/.local/state/un-bien/envelope-debug.log` — look for
`remote launch disabled on this machine` (the opt-in above) or
`session_launch error: …` (the backend failing to spawn).

### The backend is missing or misconfigured

`launch.backend` in the global config picks the spawn mechanism — `tmux`
(default) or `herdr`. The chosen binary must be on the PATH the service
inherited (see §2). Verify what the launcher will use from any Pi
session: `/unbien config`.

### "Peer not paired — re-scan QR"

The app's device key isn't in this machine's `peers.json` (never paired
here, or revoked). Pairing is interactive: run `/unbien pair` in any Pi
session on the machine and scan the QR from the app.

---

## 5. The app can't see the machine at all

- **Relay mismatch.** The launcher uses the same global relay config as
  the extension — check `/unbien config` and make sure the app is pointed
  at the same URL.
- **Launcher not running.** Check §2; the control room only exists while
  the launcher is connected.

---

## 6. Uninstall cleanly + re-install from scratch

When you suspect everything is misconfigured:

```bash
unbien uninstall                    # removes the service, keeps config + pairing
rm -rf ~/.local/state/un-bien       # nukes pairing + identity (re-pair after this)
npm uninstall -g @geohar/un-bien
npm install -g @geohar/un-bien
unbien install
# Then re-pair from scratch: pi → /unbien pair
```

This is the "nuke everything" path. After it, the only state left is each
cwd's `<cwd>/.pi/un-bien/config.json`, which you can keep or delete for a
full reset.

---

## 7. Diagnostic commands cheat-sheet

```bash
# Service status
systemctl --user status unbien-launcher          # Linux
launchctl list | grep dev.unbien                 # macOS
schtasks /Query /TN RemotePiLauncher             # Windows

# Logs
journalctl --user -u unbien-launcher -f          # Linux
tail -f ~/.local/state/un-bien/launcher.log      # macOS / Windows

# Global config the launcher reads (relay, launch backend, defaults)
cat ~/.pi/extensions/un-bien.json

# Paired devices (per machine)
cat ~/.local/state/un-bien/peers.json

# What the extension thinks (from any Pi session, in pi):
#   /unbien config
#   /unbien status
#   /unbien devices
```

If after walking the list you're still stuck, file an issue with the
output of the service status, the launcher log, and the contents of
`~/.pi/extensions/un-bien.json`.
