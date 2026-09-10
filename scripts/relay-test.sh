#!/usr/bin/env bash
#
# relay-test.sh — launch an ISOLATED second relay for testing.
#
# It runs on its own PORT with its own STATE DIR, so it never touches the
# primary relay's pairing.db / mesh.db / rooms / logs. Because its pairing
# allow-list (fail-closed, design 01M1ZE43 / signed-only 01M23MKVG) starts
# empty and is its own file, NOTHING is exposed on it until a machine you point
# at it pushes a signed allow-list AND an owner pairs — that's how you "limit
# room exposure": only the test pi/phone you aim at this relay show up here.
#
# Relay env vars (all honoured by the relay binary):
#   UNBIEN_RELAY_PORT     listen port                    (default 3000)
#   UNBIEN_STATE_DIR      absolute state root; holds ->  pairing.db, mesh.db, relay.log
#   XDG_STATE_HOME        XDG base ($XDG_STATE_HOME/un-bien) if UNBIEN_STATE_DIR unset
#   UNBIEN_PAIRING_DB_PATH direct pairing.db override (wins over state dir)
#   UNBIEN_MESH_DB_PATH    direct mesh.db override    (wins over state dir)
#   RELAY_MAX_CT_MIB       max outer-envelope ct size in MiB
#
# This script sets only the two that matter for isolation (port + state dir);
# the three db/log files follow the state dir automatically.
#
# Usage:
#   ./scripts/relay-test.sh                       # port 3100, ~/.local/state/un-bien-test
#   UNBIEN_RELAY_PORT=3200 ./scripts/relay-test.sh
#   UNBIEN_STATE_DIR=/tmp/ub-relay-a ./scripts/relay-test.sh   # a throwaway instance
#
# Point a test pi at it by setting the extension's relay URL to
# http://<host>:$UNBIEN_RELAY_PORT (extensions/un-bien.json "relay", or a
# separate PI_CODING_AGENT_DIR for the test session), then pair a test phone.
#
set -euo pipefail

export UNBIEN_RELAY_PORT="${UNBIEN_RELAY_PORT:-3100}"
export UNBIEN_STATE_DIR="${UNBIEN_STATE_DIR:-$HOME/.local/state/un-bien-test}"

RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../relay" && pwd)"
mkdir -p "$UNBIEN_STATE_DIR"

echo "==> test relay"
echo "    port:       $UNBIEN_RELAY_PORT"
echo "    state dir:  $UNBIEN_STATE_DIR"
echo "    pairing.db: $UNBIEN_STATE_DIR/pairing.db   (own fail-closed allow-list)"
echo "    mesh.db:    $UNBIEN_STATE_DIR/mesh.db"
echo "    log:        $UNBIEN_STATE_DIR/relay.log     (tail -f to watch)"

# Build from source so the test relay always runs CURRENT code — avoids the
# stale-installed-binary trap (a `cargo build` alone never updates the
# ~/.cargo/bin/unbien-relay the primary uses; this runs the fresh artifact).
cd "$RELAY_DIR"
cargo build --release
echo "==> starting (Ctrl-C to stop)"
exec ./target/release/unbien-relay
