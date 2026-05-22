# syntax=docker/dockerfile:1

# ── Build stage ────────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS builder

WORKDIR /app

# Copy manifests first so dependency compilation is cached separately
COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/relay /usr/local/bin/relay

ENV REMOTEPI_RELAY_PORT=3000
EXPOSE 3000

CMD ["relay"]
