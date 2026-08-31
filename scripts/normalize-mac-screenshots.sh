#!/bin/sh
# Normalize full-screen Mac captures to the App Store 2880x1800 slot
# (APPSTORE.md §9). Built for this machine's 16" MBP display (3456x2234 =
# 16:10.36): resample to 2880 wide -> 2880x1862 -> center-crop to 2880x1800
# (a 1.7% vertical trim; the 0.83x downsample is lossless-grade).
#
# Usage: scripts/normalize-mac-screenshots.sh [dir]   (default store-screenshots/mac)
#
# CAPTURE RECIPE: full-screen the un-bien mac app (Ctrl-Cmd-F), then
# Cmd-Shift-3 per surface. Drop the files in the dir and run this.
#
# ASCII-only: /bin/sh (bash 3.2).

set -eu

SCRIPT_DIR=$( # shellcheck disable=SC1007
    CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIR="${1:-$SCRIPT_DIR/../store-screenshots/mac}"

SLOT_W=2880
SLOT_H=1800

for f in "$DIR"/*.png; do
    [ -e "$f" ] || { echo "no PNGs in $DIR"; exit 1; }
    W=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}')
    H=$(sips -g pixelHeight "$f" | awk '/pixelHeight/{print $2}')
    # Resample to slot width, then center-crop the height.
    TMP=$(mktemp -t macnorm).png
    sips --resampleWidth "$SLOT_W" "$f" --out "$TMP" > /dev/null
    sips -c "$SLOT_H" "$SLOT_W" "$TMP" --out "$f" > /dev/null
    rm -f "$TMP"
    NW=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}')
    NH=$(sips -g pixelHeight "$f" | awk '/pixelHeight/{print $2}')
    echo "normalized: $f ($W x $H -> $NW x $NH)"
done
echo "OK: all Mac shots at ${SLOT_W}x${SLOT_H}."
