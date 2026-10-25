#!/usr/bin/env bash
# Build the launcher image and push it. Version is read from package.json —
# tags :v<version> and :latest.
#
# Usage:
#   ./push-docker.sh
#
# The image installs published npm artifacts (pi + the launcher) — no repo
# build step; bump the ARGs in Dockerfile to pin component versions.
#
# Requirements:
#   docker buildx (bundled with modern Docker).
#   Log in first with: docker login

set -euo pipefail

# Image name — override with UNBIEN_DOCKER_IMAGE (this project's namespace;
# not to be confused with the npm @geohar/un-bien-launcher package name).
IMAGE="${UNBIEN_DOCKER_IMAGE:-georgeharker/unbien-launcher}"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER="multiarch"

cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
if [[ -z "$VERSION" ]]; then
  echo "✗ Could not extract version from package.json" >&2
  exit 1
fi

TAG="v$VERSION"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "→ Creating buildx builder '$BUILDER' (docker-container driver)"
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
fi
docker buildx use "$BUILDER"

echo "→ Building $IMAGE:$TAG + :latest ($PLATFORMS)"

docker buildx build \
  --platform "$PLATFORMS" \
  --tag "$IMAGE:$TAG" \
  --tag "$IMAGE:latest" \
  --push \
  .

echo "✓ Pushed $IMAGE:$TAG and $IMAGE:latest"
