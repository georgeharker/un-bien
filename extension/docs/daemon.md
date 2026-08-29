# Daemon mode — troubleshooting

Companion to the README's [Daemon mode](../README.md#daemon-mode) section.
Each scenario starts with the symptom you'd actually observe, followed by
likely causes and how to fix.

---

## 1. `unbien install` fails

### "supervisor script not found"

```
[un-bien] install failed: Error: supervisor script not found at
/Users/x/dist/bin/supervisord.js. Run `pnpm build` (dev) or
`npm install -g @geohar/un-bien` (prod) first.
```

You're running `unbien install` from a dev clone where `dist/` doesn't
exist yet, or from a partial install.

```bash
# Dev clone:
cd extension && pnpm build

# Production install:
npm install -g @geohar/un-bien   # or pnpm install -g @geohar/un-bien
which pi-supervisord             # confirm bin is on PATH
unbien install
```

### "launchctl: bootstrap … already running"

A previous install left a stale entry. The fix is built into `install` —
re-run it and the supervisor unloads the old entry before bootstrapping
the new one. If it still fails:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.unbien.supervisord.plist
launchctl unload ~/Library/LaunchAgents/dev.unbien.supervisord.plist 2>/dev/null
rm ~/Library/LaunchAgents/dev.unbien.supervisord.plist
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

---

## 2. Supervisor doesn't start at login

### Check the service status

```bash
# Linux
systemctl --user status unbien-supervisord
journalctl --user -u unbien-supervisord -n 50

# macOS
launchctl list | grep unbien
tail -100 ~/.pi/un-bien/supervisord.log
```

### Common failures

- **`pi: command not found`** in the log — Pi's binary isn't on the
  PATH that the unit inherited. `unbien install` captures
  `process.env.PATH` at install time; if you installed Pi *after*
  running install, re-run `unbien install` to refresh.
- **`Cannot find module …`** — the path baked into the unit doesn't
  match where `dist/bin/supervisord.js` actually lives. Happens if you
  uninstalled then reinstalled the package to a different location.
  Fix: `unbien uninstall && unbien install`.
- **Permission denied on UDS** — `~/.pi/un-bien/` exists with wrong
  perms (rare; only happens if you ran `pi` as `sudo` once). Delete
  the dir and let it re-create: `rm -rf ~/.pi/un-bien && unbien install`.

### Run the supervisor in the foreground for debugging

Bypass systemd/launchd and run it directly so you can see startup
errors live:

```bash
pi-supervisord
# or: node $(npm root -g)/@geohar/un-bien/dist/bin/supervisord.js
```

Ctrl-C to stop. If that works but the service doesn't, the problem is
in the unit/plist environment (PATH, HOME) — re-run `unbien install`.

---

## 3. A specific daemon stays `crashed`

`unbien daemon status` shows one row with `state=crashed` and a
restart count near 4 (the supervisor gives up after exponential
backoff: 1s, 5s, 30s, 5min).

### Step 1 — read the daemon's stderr

The supervisor forwards each daemon's stderr with a `[<cwd>]` prefix:

```bash
# Linux
journalctl --user -u unbien-supervisord -f | grep '\[/Users/x/Movies\]'

# macOS
tail -f ~/.pi/un-bien/supervisord.log | grep '\[/Users/x/Movies\]'
```

### Step 2 — run that daemon manually

Reproduce the failure with full visibility:

```bash
cd /Users/x/Movies
UNBIEN_DAEMON=1 pi --mode rpc -e $(npm root -g)/@geohar/un-bien/dist/index.js
```

Common reasons a daemon won't start:

- **Local config missing.** `cd` into the daemon's folder and check
  `.pi/un-bien/config.json` exists with `auto_start_relay: true`.
  Recreate via `unbien create <cwd>` (it provisions a default config
  when missing).
- **Pi extension config drift.** Pi's own settings (model, API keys)
  reset → daemon fails to authenticate to the provider. Run
  `cd <cwd> && pi` interactively to fix.
- **Port/UDS collision.** Another Pi process is already running in
  that cwd. The cwd-lock should reject the second one, but stale UDS
  sockets sometimes linger; check `lsof ~/.pi/un-bien/locks/<roomId>.sock`.

### Step 3 — force a re-spawn

After fixing the underlying problem, kick the supervisor:

```bash
unbien daemon restart      # bounces every daemon
```

---

## 4. `daemon send` says "daemon not running"

The supervisor has the registry entry but no live child for that id.
Most common cause: the daemon never started OR it crashed past the
retry budget.

```bash
unbien daemon status       # is state running?
unbien daemon start        # spawn any that aren't running
# Then retry send.
```

If `daemon start` shows `started=0, already_running=N`, the supervisor
isn't actually spawning. Possible reasons:
- Registry empty: `unbien daemons` to verify.
- Child crashes faster than the status check: `daemon status` immediately
  after start may still show `running` for a few seconds before the
  exit event marks it crashed. Re-check 2-3 seconds later.

---

## 5. Mobile app doesn't connect to a daemon

The daemon is up but the app doesn't see it.

### Confirm the daemon is paired

`pair_request` must have happened **before** the folder became a daemon
(daemons don't show QRs themselves):

```bash
cd <daemon-cwd>
pi
> /unbien devices         # confirm the device is listed
> /unbien stop            # stop interactive session — daemon takes over
unbien daemon restart
```

### Confirm the relay URL matches

The daemon uses the cwd's local config (`<cwd>/.pi/un-bien/config.json`
agent_name) plus the global relay in `~/.pi/extensions/un-bien.json`. Verify
with:

```bash
cd <daemon-cwd>
pi
> /unbien status
```

The relay line should match what the mobile app is connecting to. If
not, update the relay URL and bounce the daemon:

```bash
unbien set-relay https://relay.example.tld
unbien daemon restart
```

---

## 6. Registry corrupted / partial

Symptom: `unbien daemons` errors out or shows nothing despite
having created entries.

```bash
cat ~/.pi/un-bien/daemons.json    # inspect
```

The file should be:

```json
{
  "daemons": [
    { "cwd": "/Users/x/Movies" },
    { "cwd": "/Users/x/Projects/backend" }
  ]
}
```

Fix manually if needed (it's a JSON list of `{cwd}` entries), or wipe
and re-create:

```bash
rm ~/.pi/un-bien/daemons.json
unbien create ~/Movies --name "Video Editor"
unbien create ~/Projects/backend --name "Backend"
unbien daemon restart
```

---

## 7. Uninstall cleanly + re-install from scratch

When you suspect everything is misconfigured:

```bash
unbien uninstall                 # removes service, keeps registry
rm -rf ~/.pi/un-bien             # nukes registry + paired devices + keys
npm uninstall -g @geohar/un-bien
npm install -g @geohar/un-bien
unbien install
# Then re-pair + re-create daemons from scratch.
```

This is the "nuke everything" path. After this, the only state left is
each cwd's `<cwd>/.pi/un-bien/config.json` — which you can either
keep (re-create restores the daemon) or delete (full reset).

---

## 8. Diagnostic commands cheat-sheet

```bash
# Where is the supervisor's UDS?
ls -la ~/.pi/un-bien/supervisor.sock

# Talk to the supervisor manually (raw JSONL):
echo '{"op":"list"}' | nc -U ~/.pi/un-bien/supervisor.sock

# Where are the daemon configs?
find ~/Projects -name "config.json" -path "*/.pi/un-bien/*" 2>/dev/null

# Where are the cwd locks?
ls ~/.pi/un-bien/locks/

# Where are the paired devices?
cat ~/.pi/un-bien/peers.json

# What Pi binary is the supervisor about to spawn?
unbien install --dry-run      # (not implemented; check ~/Library/LaunchAgents or systemd unit manually)

# Quick liveness check
unbien daemon status
```

If after walking the list you're still stuck, file an issue with the
output of `unbien daemon status`, the recent supervisor log, and
the contents of `~/.pi/un-bien/daemons.json`.
