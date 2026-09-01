#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/atlas-core-release-files.sh"

: "${VERSION:?VERSION is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

tag="atlas-core-v$VERSION"
recover_existing_release="${RECOVER_EXISTING_RELEASE:-false}"
recovery=false

validate_release_commit() {
  local release_sha="$1"
  if ! git merge-base --is-ancestor "$release_sha" origin/main; then
    echo "$tag is not reachable from main." >&2
    exit 1
  fi
  if [ "$(git show -s --format=%s "$release_sha")" != "chore(release): atlas-core v$VERSION" ]; then
    echo "$tag does not identify the Atlas Core release commit." >&2
    exit 1
  fi
  validate_atlas_core_release_paths "The release commit changed an unexpected file" \
    < <(git diff --name-only "$release_sha^..$release_sha")
  if ! git diff --quiet "$release_sha" -- "${atlas_core_release_paths[@]}"; then
    echo "The reviewed release artifact does not match $tag." >&2
    git diff --stat "$release_sha" -- "${atlas_core_release_paths[@]}" >&2
    exit 1
  fi
}

if [ "$GITHUB_REF" = "refs/heads/main" ]; then
  if [ "$(git rev-parse origin/main)" != "$GITHUB_SHA" ]; then
    echo "main moved after this release was dispatched. Start a new release run." >&2
    exit 1
  fi
  if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    if [ "$recover_existing_release" != "true" ]; then
      echo "$tag already exists. Dispatch this workflow from that immutable tag, or explicitly recover the existing release." >&2
      exit 1
    fi
    release_sha="$(git rev-list -n 1 "$tag")"
    validate_release_commit "$release_sha"
    mode=publish
    recovery=true
    source_sha="$(git rev-parse "$release_sha^")"
  else
    if [ "$recover_existing_release" = "true" ]; then
      echo "Cannot recover Atlas Core $VERSION because $tag does not exist." >&2
      exit 1
    fi
    mode=prepare
    source_sha="$GITHUB_SHA"
    release_sha=
  fi
elif [ "$GITHUB_REF" = "refs/tags/$tag" ]; then
  release_sha="$(git rev-list -n 1 "$tag")"
  if [ "$release_sha" != "$GITHUB_SHA" ]; then
    echo "$tag does not identify the dispatched commit." >&2
    exit 1
  fi
  validate_release_commit "$release_sha"
  mode=publish
  source_sha="$(git rev-parse "$release_sha^")"
else
  echo "Dispatch Atlas Core releases from main or refs/tags/$tag." >&2
  exit 1
fi

{
  echo "mode=$mode"
  echo "recovery=$recovery"
  echo "source_sha=$source_sha"
  echo "release_sha=$release_sha"
} >> "$GITHUB_OUTPUT"
