# Plugin release format

Status: accepted target design, not yet implemented. The current Atlas Core release still builds and embeds first-party
Plugin images and deployment files.

This document defines the independently versioned first-party Plugin release, the signed Atlas Plugin catalog, and the
publication transaction. The first package schema supports trusted, query-only Plugins in one stable channel.

## Release identity

A Plugin release is identified by its `plugin_id` and Semantic Version. A published version is immutable. The version
uses `MAJOR.MINOR.PATCH` without a leading `v` or prerelease suffix. The release tag is
`atlas-plugin-<plugin_id>-v<version>`.

One release has two artifacts:

- one UTF-8 JSON document named `<plugin_id>-<version>.atlas-plugin`;
- one `linux/amd64` and `linux/arm64` OCI image index in the Plugin's first-party GHCR repository.

The release document pins the image index by digest. A tag is for human discovery only and is never installed.

## Release document

Package schema 1 has exactly these top-level fields:

```json
{
  "schema": 1,
  "plugin_id": "building_scan",
  "version": "0.2.0",
  "display_name": "Building Scan",
  "lifecycle": "query_only",
  "image": "ghcr.io/the-drunken-coder/atlas-building-scan@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "core_to_plugin_protocol_major": 1,
  "plugin_to_source_gateway_protocol_major": 1,
  "interactions": ["map_area"],
  "source_connector": null,
  "configuration": []
}
```

The manager rejects unknown or missing fields, duplicate object keys, trailing JSON, a byte-order mark, invalid UTF-8,
and a document larger than 1 MiB. Hashes cover the exact downloaded bytes; parsing and reserialization never change the
bytes being authenticated.

Field rules:

- `schema` is the Plugin package contract major and is exactly `1`.
- `plugin_id` uses the existing Plugin identifier grammar and has at most 64 characters.
- `version` is an immutable stable Semantic Version.
- `display_name` is trimmed, non-empty, and at most 100 characters. The private runtime manifest must repeat it.
- `lifecycle` is exactly `query_only` in package schema 1.
- `image` is an immutable first-party GHCR image-index reference ending in one SHA-256 digest.
- Both protocol majors are positive integers. Package schema 1 requires `1` for both.
- `interactions` is a sorted, duplicate-free array of fixed Command Interface interaction kinds. Every interaction
  advertised later by a runtime Operation must appear here. Package schema 1 accepts `map_area`; the array may be empty.
- `source_connector` is either `null` or one strict Source Gateway connector policy using the existing connector schema.
  A non-null connector ID must equal `plugin_id`. Package schema 1 rejects secret headers because it has no non-empty
  configuration declaration yet.
- `configuration` is an empty array in package schema 1. This records that configuration belongs outside immutable
  releases without inventing a generic setting or secret injection contract before a Plugin needs one. A non-empty
  configuration model requires a later package-schema major and a concrete Plugin forcing case.

The release document does not contain Operations, health status, credentials, secret values, executable hooks, Compose,
host paths, container names, networks, mounts, restart policy, resource limits, or another Plugin dependency. The manager
derives deployment details from fixed templates. Runtime Operations remain authoritative in the private Plugin manifest.

## Generated deployment

The manager derives one Compose service from `plugin_id`. It fixes the private network, port `8080`, `/health` check,
restart policy, Source Gateway origin, Core endpoint fragment, connector fragment mount, and container filesystem access.
The Plugin release can select only its image, declared contracts and interactions, and optional connector policy.

The generated service name is `atlas-plugin-<plugin_id>` with underscores converted to hyphens. Plugin identifiers do
not contain hyphens, so this conversion cannot collide. Core reaches the Plugin at
`http://atlas-plugin-<normalized_id>:8080`. The Plugin listens on port `8080` and receives the fixed
`ATLAS_SOURCE_GATEWAY_ORIGIN=http://source-gateway:8080` environment variable.

## Catalog document

Atlas publishes one signed stable catalog through the repository's GitHub Pages deployment. The CLI embeds that stable
catalog URL and trusted Ed25519 public keys, not Plugin entries. Release documents remain GitHub Release assets, and
images remain GHCR artifacts. The catalog has this shape:

```json
{
  "schema": 1,
  "sequence": 42,
  "issued_at": "2026-09-01T16:00:00Z",
  "expires_at": "2026-10-01T16:00:00Z",
  "key_id": "atlas-plugin-catalog-2026-01",
  "plugins": [
    {
      "plugin_id": "building_scan",
      "display_name": "Building Scan",
      "releases": [
        {
          "version": "0.2.0",
          "document_url": "https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-building_scan-v0.2.0/building_scan-0.2.0.atlas-plugin",
          "document_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "revoked": false,
          "revocation_reason": null
        }
      ]
    }
  ]
}
```

The catalog uses strict decoding and stable sorting by `plugin_id` and Semantic Version. `sequence` increases for every
catalog publication. `issued_at` and `expires_at` use UTC RFC 3339 timestamps, and expiry is at most 30 days after issue.
Each release document must repeat the catalog Plugin ID, display name, and version. The manager rejects a mismatch.

The detached `catalog.json.sig` document contains exactly `algorithm`, `key_id`, and a standard-base64 signature. The
algorithm is `ed25519`; `key_id` must match the signed catalog; and the signature covers the exact `catalog.json` bytes.
The signed catalog entry authenticates the exact release-document bytes, which authenticate the image digest. A second
release-document signature would add another path without adding trust and is not used.

The manager stores the greatest valid catalog sequence it has accepted. It rejects a lower sequence and rejects the same
sequence with different bytes. It may use a cached catalog until `expires_at`. After expiry, installed Plugins continue
to run and the operator may inspect, disable, uninstall, or purge them. Install, enable, update, and manual rollback
require a fresh catalog. The menu checks when opened and exposes a manual refresh; no background updater runs.

## Revocation and key rotation

Revocation publishes a new catalog sequence that marks the immutable release `revoked` and gives a concise reason. The
manager refuses a new install, enable, update, or manual rollback to that release. It warns about an already Installed
revoked release but does not stop or replace it without operator approval. Starting Atlas may continue an already
Enabled revoked release from its locally verified state; it does not create a new enablement decision.

The CLI may embed several trusted catalog keys. Rotation first publishes a CLI that trusts the old and new keys. Atlas
then starts signing catalogs with the new key. A later CLI may remove the old key after supported installations have had
time to update. Compromise of the only trusted signing key requires a CLI update; installed Plugins remain operable while
catalog mutations fail closed.

## Publication transaction

The Plugin release workflow accepts one `plugin_id` and version, then:

1. verifies the selected Plugin folder and confirms its package version matches the requested release;
2. runs its focused lint, format, type, test, build, Docker, and contract checks;
3. builds and publishes the multi-architecture candidate image, then records its immutable index digest;
4. generates the exact release document from authored Plugin metadata and that digest;
5. publishes the immutable tag and GitHub Release with the release document;
6. downloads and rechecks the public release document and image digest;
7. enters the single catalog-publication concurrency group, reloads the latest sequence, appends the immutable release,
   signs the new catalog, and publishes one GitHub Pages artifact containing `catalog.json` and `catalog.json.sig`;
8. verifies the stable catalog URL, signature, sequence, release-document hash, and public image.

The catalog publication job never cancels an in-progress publication. A failure before step 7 leaves unlisted artifacts
that no manager can install and that a retry may reuse after exact verification. A published version is never replaced.
Revocation uses a separate catalog-only workflow and never rewrites release artifacts.

A scheduled catalog workflow runs weekly even when no Plugin release or revocation occurred. It enters the same
non-cancelling concurrency group, increments the sequence, renews the issue and expiry timestamps, signs with the current
key, and publishes one complete Pages artifact. The Ed25519 private key lives only in the protected GitHub `release`
environment; trusted public keys are source-controlled in the CLI. The Pages deployment is replaced as one artifact so
the catalog and detached signature cannot be published from different transactions.

Atlas Core's release workflow does not build Plugin images, write Plugin digests into the CLI package, copy Plugin
deployment files, promote Plugin tags, or verify Plugin package visibility. It may continue running Plugin source and
container checks in ordinary repository CI.
