#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: require-atlas-core-tag-rulesets.sh <missing-rulesets message> <release-app-id>" >&2
  exit 2
fi

error_message="$1"
release_app_id="$2"
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
validation_args=(
  --creation "$temp_dir/creation.json"
  --immutability "$temp_dir/immutability.json"
  --release-app-id "$release_app_id"
)
release_cli="${ATLAS_CORE_RELEASE_CLI:-$script_dir/../../tools/atlas-core-release/dist/cli.js}"
node "$release_cli" validate-tag-rulesets "${validation_args[@]}"
