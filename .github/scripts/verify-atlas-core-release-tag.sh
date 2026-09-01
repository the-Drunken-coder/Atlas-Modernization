#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: verify-atlas-core-release-tag.sh <version> <release-sha>" >&2
  exit 2
fi

version="$1"
expected_release_sha="$2"
tag="atlas-core-v$version"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ ! "$expected_release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The release tag check received an invalid version or release commit." >&2
  exit 1
fi

tag_object_sha=
peeled_release_sha=
while IFS=$'\t' read -r object_sha ref; do
  case "$ref" in
    "refs/tags/$tag") tag_object_sha="$object_sha" ;;
    "refs/tags/$tag^{}") peeled_release_sha="$object_sha" ;;
  esac
done < <(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")

actual_release_sha="${peeled_release_sha:-$tag_object_sha}"
if [ "$actual_release_sha" != "$expected_release_sha" ]; then
  echo "$tag resolves to ${actual_release_sha:-nothing}, not $expected_release_sha." >&2
  exit 1
fi
