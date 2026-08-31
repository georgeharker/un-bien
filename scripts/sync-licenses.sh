#!/bin/sh
# Sync the vendored license texts (App/Shared/Licenses/) from the ORIGINAL
# upstream files in the resolved SwiftPM checkouts, then FAIL if any vendored
# copy drifted from upstream (run in CI or before a release build).
#
# The vendored .txt files are what the app BUNDLES (LicensesView reads them as
# resources) — committed, deterministic, and identical in every build path
# (Xcode targets AND `swift build`). This script is the guard that keeps them
# honest: upstream LICENSE/COPYING -> vendored copy, byte-for-byte.
#
# highlightjs.txt is NOT synced: upstream (highlight.js, bundled inside
# Highlightr's minified asset) ships no standalone license file — the notice is
# carried in highlight.min.js; our copy preserves that notice + the BSD-3 text.
# Re-check it when Highlightr's version bumps.
#
# Usage: scripts/sync-licenses.sh          (sync + drift-check)
#        scripts/sync-licenses.sh --check  (drift-check only, no writes)

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/.."
DEST="$ROOT/app/App/Shared/Licenses"

# Checkouts live under <derived>/SourcePackages/checkouts (xcodebuild with the
# repo-pinned -derivedDataPath app/build) or <pkg>/.build/checkouts (plain
# swift build). Probe both.
CHECKOUTS=""
for candidate in \
    "$ROOT/app/build/SourcePackages/checkouts" \
    "$ROOT/.build/checkouts" \
    "$ROOT/app/.build/checkouts"; do
    if [ -d "$candidate/swift-markdown-ui" ]; then
        CHECKOUTS="$candidate"
        break
    fi
done
if [ -z "$CHECKOUTS" ]; then
    echo "ERROR: no resolved SPM checkouts found — run a build first (xcodebuild or swift build)."
    exit 1
fi
echo "==> checkouts: $CHECKOUTS"

# map: vendored file -> upstream source file
upstream_for() {
    case "$1" in
    highlightr.txt) echo "$CHECKOUTS/Highlightr/LICENSE" ;;
    swift-markdown-ui.txt) echo "$CHECKOUTS/swift-markdown-ui/LICENSE" ;;
    networkimage.txt) echo "$CHECKOUTS/NetworkImage/LICENSE" ;;
    cmark.txt) echo "$CHECKOUTS/swift-cmark/COPYING" ;;
    un-bien.txt) echo "$ROOT/LICENSE" ;;
    remote-pi.txt) echo "$ROOT/extension/LICENSE" ;;
    *) return 1 ;;
    esac
}

DRIFT=0
for vendored in "$DEST"/*.txt; do
    name=$(basename "$vendored")
    src=$(upstream_for "$name") || {
        echo "  ? $name — hand-maintained (no upstream file); skipped"
        continue
    }
    if [ ! -f "$src" ]; then
        echo "  ! $name — upstream missing: $src"
        DRIFT=1
        continue
    fi
    if cmp -s "$src" "$vendored"; then
        echo "  = $name — matches upstream"
    elif [ "${1:-}" = "--check" ]; then
        echo "  ! $name — DRIFTED from $src"
        DRIFT=1
    else
        cp "$src" "$vendored"
        echo "  ~ $name — synced from $src"
    fi
done

if [ "$DRIFT" -ne 0 ]; then
    echo "FAIL: vendored licenses drifted from upstream — run scripts/sync-licenses.sh and commit."
    exit 1
fi
echo "OK: all vendored licenses match their originals."
