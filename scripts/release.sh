#!/bin/sh
# Cut a release: version bumps, tags, push. One command per component — or all.
#
# Usage: scripts/release.sh <ext|cli|relay|all> <patch|minor> [--dry-run|--yes|--dev]
#
#   ext     -> extension/package.json  (@geohar/un-bien)        tag v<ver>
#   cli     -> unbien-cli/package.json (@geohar/unbien-cli)     tag cli-v<ver>
#   relay   -> relay/Cargo.toml        (un-bien-relay)          tag relay-v<ver>
#   all     -> ext + cli + relay (relay/cli patch unless given per-component)
#
#   --dev   append -dev.YYYYMMDD to each version (pre-release). npm packages
#           publish under the `dev` tag (not `latest`); crates.io treats it
#           as a pre-release version (cargo install gets latest stable).
#
# COUPLING (the reason this script exists): the launcher wrapper
# (@geohar/un-bien-launcher) is a one-line re-export of the extension, and its
# published dependency pin is frozen at whatever ext version its tag was cut
# against. An ext release therefore ALWAYS carries a launcher patch-bump so
# standalone `npm i -g @geohar/un-bien-launcher` pulls current code (0.1.5 was
# silently serving ^0.18.2 — no install subcommands, no --version).
#
# Tag -> workflow mapping (each tag publishes exactly one package):
#   v* -> npm-publish (ext)   cli-v* -> cli-publish   relay-v* -> relay-publish
#   launcher-v* -> launcher-publish
#
# - Pushes via the gh-credential URL recipe (plain `git push origin` fails
#   under this repo's gh-auth setup).
# - ASCII-only on purpose: /bin/sh is bash 3.2 (see build-iphone.sh).
# - Run from anywhere — paths resolve from the repo root.

set -eu

SCRIPT_DIR=$( # shellcheck disable=SC1007
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
ROOT="$SCRIPT_DIR/.."
REPO_URL="https://github.com/georgeharker/un-bien"

# ── args ────────────────────────────────────────────────────────────────────

COMPONENT="${1:-}"
BUMP="${2:-patch}"
shift 2 2>/dev/null || shift $# 2>/dev/null || true
DRY_RUN=0
ASSUME_YES=0
DEV=0
for arg in "$@"; do
  case "$arg" in
  --dry-run) DRY_RUN=1 ;;
  --yes | -y) ASSUME_YES=1 ;;
  --dev) DEV=1 ;;
  *)
    echo "unknown flag: $arg" >&2
    exit 2
    ;;
  esac
done

case "$COMPONENT" in
ext | cli | relay | all) ;;
*)
  echo "usage: scripts/release.sh <ext|cli|relay|all> <patch|minor> [--dry-run|--yes]" >&2
  exit 2
  ;;
esac
case "$BUMP" in
patch | minor) ;;
*)
  echo "bump must be patch or minor (got: $BUMP)" >&2
  exit 2
  ;;
esac

# ── helpers ─────────────────────────────────────────────────────────────────

json_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1; }
cargo_version() { sed -n 's/^version = "\([^"]*\)".*/\1/p' "$1" | head -1; }

bump_version() { # $1=version $2=patch|minor
  v_major=$(echo "$1" | cut -d. -f1)
  v_minor=$(echo "$1" | cut -d. -f2)
  v_patch=$(echo "$1" | cut -d. -f3)
  if [ "$2" = minor ]; then
    echo "${v_major}.$((v_minor + 1)).0"
  else
    echo "${v_major}.${v_minor}.$((v_patch + 1))"
  fi
}

# ── plan ────────────────────────────────────────────────────────────────────

EXT_NOW=$(json_version "$ROOT/extension/package.json")
CLI_NOW=$(json_version "$ROOT/unbien-cli/package.json")
RELAY_NOW=$(cargo_version "$ROOT/relay/Cargo.toml")
LAUNCHER_NOW=$(json_version "$ROOT/launcher/package.json")

EXT_NEW=$(bump_version "$EXT_NOW" "$([ "$COMPONENT" = all ] && echo "$BUMP" || echo patch)")
CLI_NEW=$(bump_version "$CLI_NOW" "$([ "$COMPONENT" = all ] && echo "$BUMP" || echo patch)")
RELAY_NEW=$(bump_version "$RELAY_NOW" "$([ "$COMPONENT" = all ] && echo "$BUMP" || echo patch)")
LAUNCHER_NEW=$(bump_version "$LAUNCHER_NOW" patch)

# ext explicit: user chose the bump; all: shared bump; others: patch only.
[ "$COMPONENT" = ext ] && EXT_NEW=$(bump_version "$EXT_NOW" "$BUMP")
[ "$COMPONENT" = cli ] && CLI_NEW=$(bump_version "$CLI_NOW" "$BUMP")
[ "$COMPONENT" = relay ] && RELAY_NEW=$(bump_version "$RELAY_NOW" "$BUMP")

# --dev: append a date-based pre-release suffix to each version.
if [ "$DEV" = 1 ]; then
  DEV_SUFFIX="-dev.$(date +%Y%m%d)"
  EXT_NEW="${EXT_NEW}${DEV_SUFFIX}"
  CLI_NEW="${CLI_NEW}${DEV_SUFFIX}"
  RELAY_NEW="${RELAY_NEW}${DEV_SUFFIX}"
  LAUNCHER_NEW="${LAUNCHER_NEW}${DEV_SUFFIX}"
fi

# What actually gets cut.
DO_EXT=0
DO_CLI=0
DO_RELAY=0
DO_LAUNCHER=0
case "$COMPONENT" in
ext)
  DO_EXT=1
  DO_LAUNCHER=1
  ;; # launcher repin ALWAYS rides an ext cut
cli) DO_CLI=1 ;;
relay) DO_RELAY=1 ;;
all)
  DO_EXT=1
  DO_CLI=1
  DO_RELAY=1
  DO_LAUNCHER=1
  ;;
esac

echo "Release plan ($COMPONENT, $BUMP):"
[ "$DO_EXT" = 1 ] && echo "  ext      $EXT_NOW  -> $EXT_NEW        tag v$EXT_NEW            (npm-publish)"
[ "$DO_CLI" = 1 ] && echo "  cli      $CLI_NOW  -> $CLI_NEW        tag cli-v$CLI_NEW        (cli-publish)"
[ "$DO_RELAY" = 1 ] && echo "  relay    $RELAY_NOW  -> $RELAY_NEW        tag relay-v$RELAY_NEW    (relay-publish)"
[ "$DO_LAUNCHER" = 1 ] && echo "  launcher $LAUNCHER_NOW  -> $LAUNCHER_NEW        tag launcher-v$LAUNCHER_NEW (launcher-publish; repin to ext $EXT_NEW)"

# ── preflight ───────────────────────────────────────────────────────────────

cd "$ROOT"
if git status --porcelain -- extension unbien-cli relay launcher | grep -qv '^??'; then
  echo "ERROR: uncommitted changes in component dirs — commit or stash first." >&2
  exit 1
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != main ]; then
  echo "ERROR: on branch '$BRANCH' — cut releases from main." >&2
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "dry run — no changes made."
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  printf "Proceed? [y/N] "
  read -r ANSWER
  case "$ANSWER" in
  y | Y | yes | YES) ;;
  *)
    echo "aborted."
    exit 1
    ;;
  esac
fi

# ── cut ─────────────────────────────────────────────────────────────────────

TAGS=""

if [ "$DO_EXT" = 1 ]; then
  sed -i '' "s/\"version\": \"$EXT_NOW\"/\"version\": \"$EXT_NEW\"/" extension/package.json
  git add extension/package.json
  git commit -m "chore(release): ext $EXT_NEW" >/dev/null
  git tag -a "v$EXT_NEW" -m "Extension $EXT_NEW"
  TAGS="$TAGS v$EXT_NEW"
  echo "cut ext $EXT_NEW"
fi

if [ "$DO_CLI" = 1 ]; then
  sed -i '' "s/\"version\": \"$CLI_NOW\"/\"version\": \"$CLI_NEW\"/" unbien-cli/package.json
  git add unbien-cli/package.json
  git commit -m "chore(release): cli $CLI_NEW" >/dev/null
  git tag -a "cli-v$CLI_NEW" -m "CLI $CLI_NEW"
  TAGS="$TAGS cli-v$CLI_NEW"
  echo "cut cli $CLI_NEW"
fi

if [ "$DO_RELAY" = 1 ]; then
  sed -i '' "s/^version = \"$RELAY_NOW\"/version = \"$RELAY_NEW\"/" relay/Cargo.toml
  # Refresh the lock's own-package version (cargo writes it on any command).
  cargo check --manifest-path relay/Cargo.toml -q >/dev/null 2>&1 || cargo check --manifest-path relay/Cargo.toml >/dev/null
  git add relay/Cargo.toml relay/Cargo.lock
  git commit -m "chore(release): relay $RELAY_NEW" >/dev/null
  git tag -a "relay-v$RELAY_NEW" -m "Relay $RELAY_NEW"
  TAGS="$TAGS relay-v$RELAY_NEW"
  echo "cut relay $RELAY_NEW"
fi

if [ "$DO_LAUNCHER" = 1 ]; then
  sed -i '' "s/\"version\": \"$LAUNCHER_NOW\"/\"version\": \"$LAUNCHER_NEW\"/" launcher/package.json
  git add launcher/package.json
  git commit -m "chore(release): launcher $LAUNCHER_NEW — repin @geohar/un-bien to $EXT_NEW" >/dev/null
  git tag -a "launcher-v$LAUNCHER_NEW" -m "Launcher $LAUNCHER_NEW: repin to @geohar/un-bien $EXT_NEW"
  TAGS="$TAGS launcher-v$LAUNCHER_NEW"
  echo "cut launcher $LAUNCHER_NEW (repin -> ext $EXT_NEW)"
fi

# ── push ────────────────────────────────────────────────────────────────────

echo "pushing main + tags:$TAGS"
env -u GH_TOKEN git -c credential.helper='!gh auth git-credential' \
  push "$REPO_URL" main $TAGS
echo ""
echo "Pushed. Workflows triggered:"
[ "$DO_EXT" = 1 ] && echo "  v$EXT_NEW            -> npm-publish        (@geohar/un-bien)"
[ "$DO_CLI" = 1 ] && echo "  cli-v$CLI_NEW        -> cli-publish        (@geohar/unbien-cli)"
[ "$DO_RELAY" = 1 ] && echo "  relay-v$RELAY_NEW    -> relay-publish      (un-bien-relay)"
[ "$DO_LAUNCHER" = 1 ] && echo "  launcher-v$LAUNCHER_NEW -> launcher-publish (@geohar/un-bien-launcher -> ext $EXT_NEW)"
echo "Watch: gh run list --limit 4"
