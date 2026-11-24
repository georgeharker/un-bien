# syntax=docker/dockerfile:1.29.0@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# ── Build stage ────────────────────────────────────────────────────────────
FROM rust:1.100.0-slim-bookworm@sha256:7c7d4eb4d05b7781187a327809466cfddf29753f6defdc3d19a0e291951b7a37 AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Migrations are baked into the binary at compile time via `include_str!`
# (see src/mesh/store.rs). Without this COPY, `cargo build` fails inside
# the container with "couldn't read .../migrations/001_mesh_versions.sql".
COPY migrations ./migrations

RUN cargo build --release

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM debian:bookworm-20261123-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/unbien-relay /usr/local/bin/unbien-relay

# Runs as an unprivileged user (uid/gid 10001), not root. /data must be
# writable by it: a volume created by an older (root) image keeps
# root-owned files, so chown it once before upgrading:
#   docker run --rm -v un-bien-data:/data debian:bookworm-slim chown -R 10001:10001 /data
RUN groupadd --system --gid 10001 unbien && \
    useradd --system --uid 10001 --gid unbien --home-dir /data --no-create-home unbien

# Persistent state — BOTH stores live here: the mesh-version SQLite
# (UNBIEN_MESH_DB_PATH) and the pairing DB (UNBIEN_PAIRING_DB_PATH — the
# pin/gate state; losing it means re-pairing every peer). Mount a host
# directory or a named volume at /data to keep them across container
# restarts. Without a mount, /data is ephemeral.
RUN mkdir -p /data && chown unbien:unbien /data
VOLUME ["/data"]

ENV UNBIEN_RELAY_PORT=3000
ENV UNBIEN_MESH_DB_PATH=/data/mesh.db
ENV UNBIEN_PAIRING_DB_PATH=/data/pairing.db

EXPOSE 3000

# Federation (relay ≥0.8): set these at RUN time (docker run -e), not here:
#   UNBIEN_RELAY_URL   — REQUIRED for a federated relay. The default bind
#                        (0.0.0.0, all interfaces) advertises NOTHING via
#                        the bind-derived mechanism (a bare-IP bind carries
#                        no name to advertise), so a container that
#                        federates must say its dialable URL explicitly:
#                        e.g. ws://droplet.tailnet.ts.net:3000
#   UNBIEN_RELAY_NAME  — the name peers see (e.g. "droplet"); defaults to
#                        the hostname, which inside a container is noise.
#   UNBIEN_RELAY_BIND  — leave unset: the 0.0.0.0 default is the right
#                        in-container bind (the container binds all; the
#                        host's networking constrains reachability). The
#                        named-bind lockdown form applies to bare-metal
#                        relays, not containers.

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${UNBIEN_RELAY_PORT}/health

USER unbien

CMD ["unbien-relay"]