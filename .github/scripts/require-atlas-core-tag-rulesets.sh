#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: require-atlas-core-tag-rulesets.sh <missing-rulesets message>" >&2
  exit 2
fi

error_message="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

creation_id="$(
  gh api "repos/$GITHUB_REPOSITORY/rulesets?targets=tag&per_page=100" \
    --jq '.[] | select(.name == "Atlas Core release tag creation" and .enforcement == "active") | .id' |
    head -n 1
)"
immutability_id="$(
  gh api "repos/$GITHUB_REPOSITORY/rulesets?targets=tag&per_page=100" \
    --jq '.[] | select(.name == "Atlas Core release tag immutability" and .enforcement == "active") | .id' |
    head -n 1
)"
if [ -z "$creation_id" ] || [ -z "$immutability_id" ]; then
  echo "$error_message" >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
gh api "repos/$GITHUB_REPOSITORY/rulesets/$creation_id" > "$temp_dir/creation.json"
gh api "repos/$GITHUB_REPOSITORY/rulesets/$immutability_id" > "$temp_dir/immutability.json"
node "$script_dir/atlas-core-release.mjs" \
  validate-tag-rulesets "$temp_dir/creation.json" "$temp_dir/immutability.json"
