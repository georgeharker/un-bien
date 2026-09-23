---
title: "Install the relay with Homebrew"
---

Install the Un Bien relay on macOS or Linux and manage it with `brew services`.
The main Un Bien repository also serves as the tap; it does not need a separate
`homebrew-*` repository.

## Install and start

With a current [Homebrew](https://brew.sh) installation (7.0 or newer):

```bash
brew tap georgeharker/un-bien https://github.com/georgeharker/un-bien.git
brew install georgeharker/un-bien/unbien-relay
brew services start unbien-relay
curl --fail http://127.0.0.1:3000/health   # OK
```

The formula builds the published Rust crate with its locked dependencies;
Homebrew installs the Rust build toolchain automatically. There are currently
no prebuilt Homebrew bottles, so the first installation takes a few minutes.

Run `brew services` as your normal user, without `sudo`. On macOS this starts
the relay now and at login, restarts it after a crash, and stops it at logout.
It does not start before login or wake a sleeping Mac. On Linux, Homebrew uses
`systemd --user`; `loginctl enable-linger "$USER"` allows the service to run
without an active login session.

The relay listens on **all IPv4 interfaces**, on port **3000** by default.
For remote access, use an encrypted VPN or a TLS-terminating reverse proxy as
described in [Install & setup](install.md#tls-production), then use the same
reachable relay URL in Pi and the app.

This formula installs the relay. Continue with
[setting up Pi and pairing your phone](install.md#2-set-up-pi-on-your-machine).
Install the optional launcher and CLI with `/unbien install launcher` and
`/unbien install cli`. Use those explicit targets: `/unbien install` and
`/unbien install all` also install a separate relay service.

## State, logs, and configuration

The Homebrew **service** uses these locations, independently of the versioned
binary in Homebrew's Cellar:

| Contents | Location |
| --- | --- |
| Membership DB, pairing DB, and the relay's own log | `$(brew --prefix)/var/lib/unbien-relay/` |
| Service stdout and stderr | `$(brew --prefix)/var/log/unbien-relay/` |

Both directories are private to the installing user. Upgrades and uninstalling
the formula retain them. Preserve both `mesh.db` and `pairing.db` when backing
up or moving a relay; stop the service before copying its databases.

Running `unbien-relay` directly retains the application's usual defaults,
including `~/.local/state/un-bien/`. To use the Homebrew service's state in a
foreground run, stop the service and set `UNBIEN_STATE_DIR` explicitly.

To change the service port or state directory, create
`~/.homebrew/services/unbien-relay.env` (or
`$HOMEBREW_USER_CONFIG_HOME/services/unbien-relay.env` if you have changed
Homebrew's user configuration directory). These
[service environment files](https://docs.brew.sh/Manpage#services-subcommand)
use one `KEY=value` entry per line, without shell quoting. For example:

```ini
UNBIEN_RELAY_PORT=4455
RUST_LOG=info
```

Use absolute paths for `UNBIEN_STATE_DIR`, `UNBIEN_MESH_DB_PATH`, or
`UNBIEN_PAIRING_DB_PATH`; shell variables and `~` are not expanded. Restart
after editing the file:

```bash
brew services restart unbien-relay
curl --fail http://127.0.0.1:4455/health
```

Shell exports are not a persistent service configuration. See the
[relay environment variable reference](../relay/README.md#environment-variables)
for the other settings.

## Upgrade or stop

```bash
brew upgrade georgeharker/un-bien/unbien-relay
brew services restart unbien-relay
brew services info unbien-relay
```

Check `/health` after an upgrade. Homebrew manages the process but does not
check application readiness or roll back database changes.

To remove the service and binary while retaining the state:

```bash
brew services stop unbien-relay
brew uninstall unbien-relay
```

## Switch from an existing installation

Install the formula first, but **stop the existing relay before starting the
Homebrew service**. If it was installed by `/unbien install relay`, use
`unbien-admin uninstall relay`. For a custom LaunchAgent or systemd unit, stop
and unregister that specific service using its original installation instructions.

With the old relay stopped, back up its state directory. Then either:

- Set `UNBIEN_STATE_DIR` in the Homebrew service environment file to the existing
  absolute state path. This preserves the databases in place.
- Copy `mesh.db` and `pairing.db` into `$(brew --prefix)/var/lib/unbien-relay/`
  before the first start. Do not overwrite databases from an already-used
  Homebrew installation.

The upstream Cargo/service default is `~/.local/state/un-bien/`. A custom
installer may have used a different path. If the old relay used direct
`UNBIEN_MESH_DB_PATH` or `UNBIEN_PAIRING_DB_PATH` overrides, preserve those paths
too. Preserve a custom port with `UNBIEN_RELAY_PORT` so existing client URLs
and reverse proxy settings keep working.

Start the Homebrew service and verify `/health` on the chosen port before
reconnecting clients. Keep the old state backup until the new service is working.

## Maintain the formula

`HomebrewFormula/unbien-relay.rb` installs the immutable crate archive, not the
repository's moving `main` branch. After publishing a relay release, update the
archive version in `url` and its `sha256` together. The crate must include
`Cargo.lock`; `std_cargo_args` uses `--locked`.

The Homebrew workflow checks formula style, builds the published crate, audits
the formula, and tests the installed binary on macOS and Linux. The test uses
a temporary state directory and an available port, checks `/health` and both
SQLite databases, then stops its own relay process.

After tapping a checkout containing the change, the same checks run locally:

```bash
brew style georgeharker/un-bien/unbien-relay
brew install --build-from-source georgeharker/un-bien/unbien-relay
brew audit --strict georgeharker/un-bien/unbien-relay
brew test georgeharker/un-bien/unbien-relay
```

Use `brew reinstall --build-from-source` instead of `brew install` when testing
changes to a version you already have installed.
