#!/bin/sh
# Build the un-bien iOS app for a paired device and install it (no launch).
#
# Usage: scripts/build-iphone.sh [device-name]     (default: geoifon)
#
# - Resolves the device by NAME via devicectl (falls back to listing devices).
# - Builds the UnBien-iOS scheme for the concrete device (Debug), with
#   -allowProvisioningUpdates so signing/profile refresh happens automatically.
# - Installs the resulting .app with devicectl. Does NOT launch it.
#
# ASCII-only on purpose: macOS /bin/sh is bash 3.2, whose parser mishandles
# multibyte UTF-8 adjacent to $VAR references (unbound-variable errors).
#
# Run from anywhere - paths resolve relative to the repo root.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/.."
PROJECT="$ROOT/app/UnBien.xcodeproj"
SCHEME="UnBien-iOS"
DERIVED="$ROOT/app/build"

# --- Resolve the device by name -> CoreDevice identifier ---------------------
# Resolution order: CLI arg > UNBIEN_IPHONE env > .iphone-device (gitignored,
# per-machine). No committed default — device ids/names are personal and stay
# out of the repo.
DEVICE_NAME=""
if [ -n "${1:-}" ]; then
  DEVICE_NAME="$1"
elif [ -n "${UNBIEN_IPHONE:-}" ]; then
  DEVICE_NAME="$UNBIEN_IPHONE"
elif [ -f "$ROOT/.iphone-device" ]; then
  DEVICE_NAME=$(cat "$ROOT/.iphone-device")
fi
if [ -z "$DEVICE_NAME" ]; then
  echo "ERROR: no device name. Pass one ($0 <device-name>), export UNBIEN_IPHONE, or write it to .iphone-device (gitignored). Connected devices:"
  xcrun devicectl list devices
  exit 1
fi
UDID=$(xcrun devicectl list devices 2>/dev/null | awk -v n="$DEVICE_NAME" '$1==n {print $3; exit}')
if [ -z "$UDID" ]; then
  echo "ERROR: device '$DEVICE_NAME' not found. Connected devices:"
  xcrun devicectl list devices
  exit 1
fi
echo "==> device: $DEVICE_NAME ($UDID)"

# --- Build --------------------------------------------------------------------
# Output goes to a FILE first: piping xcodebuild into tail would mask its exit
# status under /bin/sh (no pipefail), and a failed build used to fall through
# and INSTALL A STALE .app from the previous successful build. Capture, check,
# THEN show the tail.
echo "==> building $SCHEME (Debug) for $DEVICE_NAME..."
BUILD_LOG="$DERIVED/build.log"
if ! xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "platform=iOS,id=$UDID" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  build >"$BUILD_LOG" 2>&1; then
  tail -30 "$BUILD_LOG"
  echo "ERROR: build failed — NOT installing the stale .app from a previous build"
  exit 1
fi
tail -2 "$BUILD_LOG" | grep -q "BUILD SUCCEEDED" || {
  tail -5 "$BUILD_LOG"
  echo "ERROR: build did not report success — NOT installing"
  exit 1
}

# --- Locate the bundle ---------------------------------------------------------
APP=$(find "$DERIVED/Build/Products/Debug-iphoneos" -maxdepth 1 -name '*.app' | head -1)
if [ -z "$APP" ]; then
  echo "ERROR: no .app found in $DERIVED/Build/Products/Debug-iphoneos"
  exit 1
fi
echo "==> built: $APP"

# --- Install (no launch) -------------------------------------------------------
echo "==> installing on $DEVICE_NAME..."
xcrun devicectl device install app --device "$UDID" "$APP"
echo "OK: installed $(basename "$APP") on $DEVICE_NAME (not launched)"
