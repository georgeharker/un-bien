#!/bin/sh
# Upload the App Store artifacts (Un Bien.ipa / Un Bien.pkg) to App Store
# Connect via `xcrun altool --upload-app`. The CLI complement to
# archive-appstore.sh — no Organizer, no GUI; an ASC asset-server flake is a
# one-line retry.
#
# Usage: scripts/upload-appstore.sh [ios|macos|both]     (default: both)
#
# Prerequisites (one-time):
#   1. Transporter app installed — altool delegates its upload machinery to
#      it (mas install 1450874784, or the Mac App Store).
#   2. An App Store Connect API key: appstoreconnect.apple.com → Users and
#      Access → Integrations → App Store Connect API → generate (Admin or
#      App Manager). Save the .p8 as
#      ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8  (altool's default
#      lookup) and export:
#        export ASC_KEY_ID=<the key's ID>
#        export ASC_ISSUER_ID=<the issuer ID>
#      (or ASC_KEY_PATH to point at the .p8 explicitly.)
#   3. Artifacts exist: run scripts/archive-appstore.sh first.
#
# - ASCII-only on purpose: /bin/sh is bash 3.2 (see build-iphone.sh).
# - Run from anywhere — paths resolve relative to the repo root.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT="$SCRIPT_DIR/.."
EXPORT="$ROOT/app/build/Export"

PLATFORM="${1:-both}"

IPA="$EXPORT/Un Bien.ipa"
PKG="$EXPORT/Un Bien.pkg"

# --- credentials -----------------------------------------------------------
if [ -z "${ASC_KEY_ID:-}" ] || [ -z "${ASC_ISSUER_ID:-}" ]; then
    echo "ERROR: ASC_KEY_ID / ASC_ISSUER_ID not set."
    echo ""
    echo "Create an App Store Connect API key (one-time):"
    echo "  appstoreconnect.apple.com -> Users and Access -> Integrations ->"
    echo "  App Store Connect API -> generate (Admin or App Manager role)."
    echo "Save the .p8 as ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8"
    echo "then:   export ASC_KEY_ID=<key id>   ASC_ISSUER_ID=<issuer id>"
    exit 1
fi
if [ -z "${ASC_KEY_PATH:-}" ]; then
    KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
else
    KEY_PATH="$ASC_KEY_PATH"
fi
if [ ! -f "$KEY_PATH" ]; then
    echo "ERROR: key not found at $KEY_PATH"
    echo "Save the .p8 there (altool's default lookup), or set ASC_KEY_PATH."
    exit 1
fi

# --- artifacts -------------------------------------------------------------
upload_ios() {
    if [ ! -f "$IPA" ]; then
        echo "ERROR: $IPA missing — run scripts/archive-appstore.sh ios first."
        exit 1
    fi
    echo "=> uploading $IPA"
    xcrun altool --upload-app -f "$IPA" --type ios \
        --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
}

upload_macos() {
    if [ ! -f "$PKG" ]; then
        echo "ERROR: $PKG missing — run scripts/archive-appstore.sh macos first."
        exit 1
    fi
    echo "=> uploading $PKG"
    xcrun altool --upload-app -f "$PKG" --type macos \
        --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
}

case "$PLATFORM" in
    ios)    upload_ios ;;
    macos)  upload_macos ;;
    both)   upload_ios; upload_macos ;;
    *)      echo "usage: $0 [ios|macos|both]" >&2; exit 1 ;;
esac

echo "OK: upload(s) submitted to App Store Connect."
echo "(An asset-delivery flake (e.g. 90170) is a retry — rerun this script.)"