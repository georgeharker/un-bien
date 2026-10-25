# syntax=docker/dockerfile:1

# un-bien launcher daemon — the headless machine-presence peer.
#
# Runs the launcher (a mesh peer, NOT a pi session) in a container: the
# deployment mode for a Linux box that should appear in the mesh with a
# launch "+" and host the pi sessions it launches. The daemon is
# FILE-ONLY for identity by design (never the platform keyring — a
# headless service must not mint a fresh identity per cold start, which
# would orphan its pairing), so a container needs exactly one of:
#
#   - UNBIEN_IDENTITY_SEED  — the machine's portable 32-byte seed
#     (base64). The identity design decision (machine identity =
#     portable seed) names this the override path; export the same seed
#     the machine uses elsewhere to keep one epk everywhere.
#   - a persisted identity.json — mount a volume at /data and provision
#     it once (any `unbien-admin install`ed machine has one to copy at
#     ~/.local/state/un-bien/identity.json).
#
# With NEITHER the daemon fails LOUDLY at boot — deliberate: a silent
# random identity would pair once and never be seen again.
#
# UNBIEN_RELAY is required (the relay URL this daemon joins — same env
# the extension uses for local connect). The launched pi sessions run
# IN this container (that's the point of a headless agent box): pi and
# the un-bien extension are installed globally and pi's settings load
# the extension, so an app-launched session announces its room and the
# transcript flows back over the mesh.
#
# State: /data holds the launcher's identity + the relay-mesh state the
# daemon tracks; pi session storage + logs land under /config (PI's
# agent dir) — mount volumes at both to survive image updates.

FROM node:22-slim

# tmux + a login shell: the launch path spawns sessions in tmux inside a
# login shell (the tmux-launch lesson — a bare argv spawn misses PATH).
RUN apt-get update && \
    apt-get install -y --no-install-recommends tmux zsh ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Component versions — pinned ARGs so image builds are reproducible.
ARG PI_VERSION=latest
ARG LAUNCHER_VERSION=latest
RUN npm install -g \
      @earendil-works/pi-coding-agent@${PI_VERSION} \
      @geohar/un-bien-launcher@${LAUNCHER_VERSION}

# pi's settings: load the un-bien extension in every pi session this
# container launches (the machine-bootstrap equivalent of the packages
# entry in ~/.config/pi/agent/settings.json).
RUN mkdir -p /config/pi/agent /data && \
    printf '{\n  "packages": ["npm:@geohar/un-bien"]\n}\n' \
      > /config/pi/agent/settings.json

ENV UNBIEN_STATE_DIR=/data
# PI's own config/state under the mounted volume too (sessions + logs).
ENV PI_CODING_AGENT_DIR=/config/pi

VOLUME ["/data", "/config"]

# No HTTP health endpoint — the daemon is a mesh peer, not a server.
# Liveness is observable in the mesh itself: the paired relay shows the
# machine present with its control room (and its launch caps) as long
# as this process is up.
CMD ["unbien-launcher"]