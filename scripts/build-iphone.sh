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
# Run from anywhere — paths resolve relative to the repo root.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/.."
PROJECT="$ROOT/app/UnBien.xcodeproj"
SCHEME="UnBien-iOS"
DERIVED="$ROOT/app/build"

DEVICE_NAME="${1:-geoifon}"

# ── Resolve the device by name → CoreDevice identifier ────────────────────────
UDID=$(xcrun devicectl list devices 2>/dev/null | awk -v n="$DEVICE_NAME" '$1==n {print $3; exit}')
if [ -z "$UDID" ]; then
  echo "✗ device '$DEVICE_NAME' not found. Connected devices:"
  xcrun devicectl list devices
  exit 1
fi
echo "→ device: $DEVICE_NAME ($UDID)"

# ── Build ─────────────────────────────────────────────────────────────────────
echo "→ building $SCHEME (Debug) for $DEVICE_NAME…"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "platform=iOS,id=$UDID" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  build \
  | tail -20

# ── Locate the bundle ─────────────────────────────────────────────────────────
APP=$(find "$DERIVED/Build/Products/Debug-iphoneos" -maxdepth 1 -name '*.app' | head -1)
if [ -z "$APP" ]; then
  echo "✗ no .app found in $DERIVED/Build/Products/Debug-iphoneos"
  exit 1
fi
echo "→ built: $APP"

# ── Install (no launch) ───────────────────────────────────────────────────────
echo "→ installing on $DEVICE_NAME…"
xcrun devicectl device install app --device "$UDID" "$APP"
echo "✓ installed $(basename "$APP") on $DEVICE_NAME (not launched)"
