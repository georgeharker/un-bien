#!/bin/sh
# Archive the un-bien app targets for App Store distribution and EXPORT the
# uploadable artifacts (.ipa for iOS, .pkg for macOS). No upload — see NOTES.
#
# Usage: scripts/archive-appstore.sh [ios|macos|both]     (default: both)
#
# - Release configuration, App Store distribution signing: automatic +
#   -allowProvisioningUpdates, so the FIRST run registers the explicit App ID
#   com.georgeharker.un-bien.app on the team and mints the distribution
#   profile (dev builds ride the wildcard team profile — this is the step
#   that creates the real one).
# - Archives:   app/build/Archives/<scheme>.xcarchive
#   Artifacts:  app/build/Export/<scheme>.ipa|.pkg
#   Logs:       app/build/archive-<scheme>.log
#
# NOTES
# - UPLOAD is deliberately not automated: it needs the App Store Connect app
#   records to exist first (APPSTORE.md task 8). Once they do, upload via
#   Xcode Organizer (window → Organizer → distribute), Transporter, or
#   `xcrun altool --upload-app` with an ASC API key.
# - ASCII-only on purpose: /bin/sh is bash 3.2 (see build-iphone.sh).
# - Run from anywhere — paths resolve from the repo root.

set -eu

SCRIPT_DIR=$( # shellcheck disable=SC1007
    CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/.."
PROJECT="$ROOT/app/UnBien.xcodeproj"
DERIVED="$ROOT/app/build"
ARCHIVES="$DERIVED/Archives"
EXPORT="$DERIVED/Export"
TEAM="B8V3694RNX"

PLATFORM="${1:-both}"

mkdir -p "$ARCHIVES" "$EXPORT"

write_export_options() { # $1 = platform tag
    cat > "$DERIVED/ExportOptions-$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>$TEAM</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
    <key>manageAppVersionAndBuildNumber</key>
    <false/>
</dict>
</plist>
PLIST
}

do_archive() { # $1 = scheme, $2 = destination
    scheme="$1"; dest="$2"
    log="$DERIVED/archive-$scheme.log"
    echo "==> archiving $scheme (Release, App Store signing)..."
    if ! xcodebuild \
        -project "$PROJECT" \
        -scheme "$scheme" \
        -configuration Release \
        -destination "$dest" \
        -archivePath "$ARCHIVES/$scheme.xcarchive" \
        -derivedDataPath "$DERIVED" \
        -allowProvisioningUpdates \
        archive > "$log" 2>&1; then
        tail -30 "$log"
        echo "ERROR: $scheme archive failed — NOT exporting (see $log)"
        exit 1
    fi
    tail -2 "$log" | grep -q "ARCHIVE SUCCEEDED" || {
        tail -5 "$log"
        echo "ERROR: $scheme archive did not report success"
        exit 1
    }
    echo "==> archive OK: $ARCHIVES/$scheme.xcarchive"
}

do_export() { # $1 = scheme, $2 = platform tag
    scheme="$1"; tag="$2"
    write_export_options "$tag"
    log="$DERIVED/export-$scheme.log"
    echo "==> exporting $scheme (app-store-connect)..."
    # Resolve rsync to the SYSTEM one (/usr/bin, openrsync): the distribution
    # pipeline shells out to `rsync` from PATH, and a homebrew rsync 3.5.0
    # override made the IPA packaging step die with "rsync: syntax or usage
    # error" ("exportArchive Copy failed", 2026-08-31). /usr/bin stays FIRST
    # only so rsync flips; the rest of the normal PATH follows.
    if ! env PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin" \
        xcodebuild \
        -exportArchive \
        -archivePath "$ARCHIVES/$scheme.xcarchive" \
        -exportOptionsPlist "$DERIVED/ExportOptions-$tag.plist" \
        -exportPath "$EXPORT" \
        -allowProvisioningUpdates > "$log" 2>&1; then
        tail -30 "$log"
        echo "ERROR: $scheme export failed (see $log)"
        exit 1
    fi
    echo "==> export OK → $EXPORT/"
}

case "$PLATFORM" in
    ios|IOS)
        do_archive "UnBien-iOS" "generic/platform=iOS"
        do_export "UnBien-iOS" "ios"
        ;;
    macos|MACOS)
        do_archive "UnBien-macOS" "generic/platform=macOS"
        do_export "UnBien-macOS" "macos"
        ;;
    both)
        do_archive "UnBien-iOS" "generic/platform=iOS"
        do_export "UnBien-iOS" "ios"
        do_archive "UnBien-macOS" "generic/platform=macOS"
        do_export "UnBien-macOS" "macos"
        ;;
    *)
        echo "Usage: $0 [ios|macos|both]"
        exit 1
        ;;
esac

echo "Artifacts in $EXPORT:"
ls -l "$EXPORT" || true
echo "DONE: archive + export complete. Upload once the ASC records exist (APPSTORE.md task 8)."
