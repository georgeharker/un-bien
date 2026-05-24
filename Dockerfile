# syntax=docker/dockerfile:1

# ── Build stage ────────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/relay /usr/local/bin/relay

# Persistent state — mesh_versions SQLite lives here.
# Mount a host directory or a named volume at /data to keep it across container
# restarts (e.g. `-v remote-pi-data:/data`). Without a mount, /data is ephemeral.
RUN mkdir -p /data
VOLUME ["/data"]

ENV REMOTEPI_RELAY_PORT=3000
ENV REMOTEPI_MESH_DB_PATH=/data/mesh.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${REMOTEPI_RELAY_PORT}/health

CMD ["relay"]
