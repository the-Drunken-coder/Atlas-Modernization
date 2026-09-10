#!/usr/bin/env bash

# Source this file anywhere Atlas Core release commits are created or validated.
atlas_core_release_paths=(
  CHANGELOG.md
  package-lock.json
  surfaces/core-cli/package.json
  surfaces/core-cli/src/package-metadata.ts
)

validate_atlas_core_release_paths() {
  local error_prefix="${1:?error prefix is required}"
  local path

  while IFS= read -r path; do
    case "$path" in
      CHANGELOG.md|package-lock.json|surfaces/core-cli/package.json|surfaces/core-cli/src/package-metadata.ts)
        ;;
      *)
        printf '%s: %s\n' "$error_prefix" "$path" >&2
        return 1
        ;;
    esac
  done
}
