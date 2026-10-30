# syntax=docker/dockerfile:1

# ── Build stage ────────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Migrations are baked into the binary at compile time via `include_str!`
# (see src/mesh/store.rs). Without this COPY, `cargo build` fails inside
# the container with "couldn't read .../migrations/001_mesh_versions.sql".
COPY migrations ./migrations

RUN cargo build --release

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/unbien-relay /usr/local/bin/unbien-relay

# Persistent state — BOTH stores live here: the mesh-version SQLite
# (UNBIEN_MESH_DB_PATH) and the pairing DB (UNBIEN_PAIRING_DB_PATH — the
# pin/gate state; losing it means re-pairing every peer). Mount a host
# directory or a named volume at /data to keep them across container
# restarts. Without a mount, /data is ephemeral.
RUN mkdir -p /data
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

CMD ["unbien-relay"]