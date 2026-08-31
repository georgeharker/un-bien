#!/bin/sh
# App Store screenshot capture (APPSTORE.md §9).
#
# Usage:
#   scripts/appstore-screenshots.sh setup iphone    — boot 6.9" sim, build+install+launch
#   scripts/appstore-screenshots.sh setup ipad      — boot 13" sim, build+install+launch
#   scripts/appstore-screenshots.sh shot <name>     — screenshot the booted sim
#   scripts/appstore-screenshots.sh sizes           — destination/dimension cheatsheet
#
# WORKFLOW: `setup iphone`, then navigate the app in the Simulator (demo mode is
# ON by default — Home shows the canned sessions; complete onboarding first for
# the owner-key shot) and run `shot <name>` after each surface. Screenshots land
# in store-screenshots/<device>/NN-<name>.png at NATIVE simulator resolution —
# exactly the pixel dimensions the App Store Connect slots expect.
#
# Mac screenshots: run the macOS app directly and capture with the system tool
# (Cmd-Shift-4 / Cmd-Shift-5) — no simulator involved.
#
# ASCII-only: /bin/sh (bash 3.2). Run from anywhere.

set -eu

SCRIPT_DIR=$( # shellcheck disable=SC1007
    CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
ROOT="$SCRIPT_DIR/.."
PROJECT="$ROOT/app/UnBien.xcodeproj"
DERIVED="$ROOT/app/build"
OUT="$ROOT/store-screenshots"

IPHONE_SIM="iPhone 17 Pro Max"   # 6.9"  — 1320 x 2864 (portrait)
IPAD_SIM="iPad Pro 13-inch (M5)" # 13"   — 2064 x 2752

case "${1:-}" in
sizes)
    echo "iPhone 6.9\":  $IPHONE_SIM  (1320x2864 portrait)"
    echo "iPad 13\":     $IPAD_SIM  (2064x2752)"
    echo "Mac:          run UnBien-macOS directly, system screenshot tool"
    exit 0
    ;;
esac

booted_device() {
    xcrun simctl list devices booted 2>/dev/null |
        grep -m1 -oE "iPhone [^(]+|iPad [^(]+" | sed 's/ *$//'
}

case "${1:-}" in
setup)
    KIND="${2:?usage: $0 setup [iphone|ipad]}"
    case "$KIND" in
    iphone) SIM="$IPHONE_SIM" ;;
    ipad) SIM="$IPAD_SIM" ;;
    *)
        echo "usage: $0 setup [iphone|ipad]"
        exit 1
        ;;
    esac
    echo "==> booting $SIM..."
    xcrun simctl boot "$SIM" 2>/dev/null || true # already booted is fine
    xcrun simctl bootstatus "$SIM" >/dev/null 2>&1 || true
    open -a Simulator 2>/dev/null || true
    echo "==> building UnBien-iOS (Debug) for the simulator..."
    LOG="$DERIVED/sim-build.log"
    if ! xcodebuild \
        -project "$PROJECT" \
        -scheme UnBien-iOS \
        -configuration Debug \
        -destination "platform=iOS Simulator,name=$SIM" \
        -derivedDataPath "$DERIVED" \
        build >"$LOG" 2>&1; then
        tail -30 "$LOG"
        echo "ERROR: simulator build failed — see $LOG"
        exit 1
    fi
    APP=$(find "$DERIVED/Build/Products/Debug-iphonesimulator" \
        -maxdepth 1 -name '*.app' | head -1)
    [ -n "$APP" ] || {
        echo "ERROR: no built .app found"
        exit 1
    }
    echo "==> installing + launching on $SIM..."
    xcrun simctl install "$SIM" "$APP"
    xcrun simctl launch "$SIM" com.georgeharker.un-bien.app
    echo "OK: app running. Navigate in the Simulator, then: $0 shot <name>"
    ;;
shot)
    if [ $# -ge 3 ] && printf '%s' "$2" | grep -qE '^[0-9]{2}$'; then
        # Explicit slot: `shot <number> <name>` — shoot in any order while
        # keeping a logical filename sequence.
        NN="$2"
        NAME="$3"
    else
        NAME="${2:?usage: $0 shot <name> | $0 shot <number> <name>}"
        # Auto-number: the next capture-order stamp.
        DEV=$(booted_device)
        [ -n "$DEV" ] || {
            echo "ERROR: no booted simulator"
            exit 1
        }
        DIR="$OUT/$DEV"
        mkdir -p "$DIR"
        NN=0
        for f in "$DIR"/[0-9][0-9]-*.png; do
            [ -e "$f" ] && NN=$((NN + 1))
        done
        NN=$((NN + 1))
        FILE=$(printf "%s/%02d-%s.png" "$DIR" "$NN" "$NAME")
        xcrun simctl io booted screenshot "$FILE"
        echo "captured: $FILE"
        exit 0
    fi
    DEV=$(booted_device)
    [ -n "$DEV" ] || {
        echo "ERROR: no booted simulator"
        exit 1
    }
    DIR="$OUT/$DEV"
    mkdir -p "$DIR"
    FILE=$(printf "%s/%02d-%s.png" "$DIR" "$NN" "$NAME")
    xcrun simctl io booted screenshot "$FILE"
    echo "captured: $FILE"
    ;;
*)
    echo "usage: $0 [setup iphone|setup ipad|shot <name>|shot <number> <name>|sizes]"
    exit 1
    ;;
esac
