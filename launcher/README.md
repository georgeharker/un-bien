# @geohar/un-bien-launcher

`unbien-launcher` — the un-bien machine-**launcher** daemon.

A lightweight mesh peer (not a Pi session) that lets a paired
[un-bien](https://github.com/georgeharker/un-bien) app launch a Pi session on
this machine even when no Pi is running here. It reads the machine's un-bien
config for identity + relay + launch backend, joins the machine-level control
room, advertises `remote_launch`, and spawns `tmux`/`herdr` on request.

## Install

```sh
npm install -g @geohar/un-bien-launcher
unbien-launcher
```

## What it is

This package is a thin wrapper: the daemon itself lives in the un-bien extension
([`@geohar/un-bien`](https://www.npmjs.com/package/@geohar/un-bien)), and this
binary starts it. Keeping the code in the extension avoids duplicating the mesh /
pairing / launch core; the launcher just ships it as its own installed binary.

For OS-service keepalive (launchd / systemd / Task Scheduler), see the un-bien
`install` command.

## License

MIT — see the [monorepo](https://github.com/georgeharker/un-bien).
