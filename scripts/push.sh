#!/bin/sh
# Push (and optionally fetch) via the gh-credential recipe — the reliable
# path under this repo's auth setup: the SSH agent is often unavailable
# (agent forwarding flakes / keys absent), and a stray GH_TOKEN in the env
# shadows `gh auth git-credential`. Unset the token, let gh supply fresh
# credentials, push straight to the HTTPS URL.
#
# Usage: scripts/push.sh [refs...]     (default: main)
#        scripts/push.sh --fetch       (sync origin/main tracking ref only)
#
# The release script has always pushed this way; this wrapper makes the
# manual case one command instead of re-deriving the recipe.

set -eu

REPO_URL="https://github.com/georgeharker/un-bien"

if [ "${1:-}" = "--fetch" ]; then
  exec env -u GH_TOKEN git -c credential.helper='!gh auth git-credential' \
    fetch "$REPO_URL" +refs/heads/main:refs/remotes/origin/main
fi

REFS="${@:-main}"
exec env -u GH_TOKEN git -c credential.helper='!gh auth git-credential' \
  push "$REPO_URL" $REFS
