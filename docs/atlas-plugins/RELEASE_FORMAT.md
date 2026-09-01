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
  "atlas_protocol_revision": null,
  "interactions": ["map_area"],
  "source_connector": null
}
```

The manager rejects unknown or missing fields, duplicate object keys, trailing JSON, a byte-order mark, invalid UTF-8,
and a document larger than 1 MiB. Hashes cover the exact downloaded bytes; parsing and reserialization never change the
bytes being authenticated.

Field rules:

- `schema` is the Plugin package contract major and is exactly `1`.
- `plugin_id` uses the existing Plugin identifier grammar and has at most 50 characters. This narrower package limit
  keeps the generated `atlas-plugin-<normalized_id>` service name within the 63-byte DNS-label limit.
- `version` is an immutable stable Semantic Version.
- `display_name` is trimmed, non-empty, and at most 100 characters. The private runtime manifest must repeat it.
- `lifecycle` is exactly `query_only` in package schema 1.
- `image` is an immutable first-party GHCR image-index reference ending in one SHA-256 digest.
- Both protocol majors are positive integers within the JSON safe-integer range. Initial releases use `1`; changing a
  private protocol major does not require changing the package schema.
- `atlas_protocol_revision` is `null` when the Plugin never calls Core through the Atlas SDK. Otherwise it is the exact
  `sha256:<64 lowercase hexadecimal characters>` revision required by that SDK build.
- `interactions` is a sorted, duplicate-free array of fixed Command Interface interaction kinds. Every interaction
  advertised later by a runtime Operation must appear here. Package schema 1 accepts `map_area`; the array may be empty.
- `source_connector` is either `null` or one strict Source Gateway connector policy using the existing connector schema.
  A non-null connector ID must equal `plugin_id`. Package schema 1 rejects secret headers and defines no Plugin setting or
  secret injection model. A later package-schema major may add one when a concrete Plugin requires it.

The repository's `atlas-plugin.json` file is authoring input, not part of the published release. The independent release
workflow updates `scripts/plugins.mjs` so `source_connector` in that authoring file accepts `null` or one local filename.
For a filename, the workflow loads the referenced JSON, validates it against the existing strict connector schema,
requires its connector ID to equal `plugin_id`, rejects secret headers in package schema 1, and embeds the parsed policy
object in the release document. A null authoring value produces a null release value. The published release never
contains the filename or another repository path. The bundled-v1 generator keeps its current required-filename behavior
until the independent workflow replaces it.

The release document does not contain Operations, health status, credentials, secret values, executable hooks, Compose,
host paths, container names, networks, mounts, restart policy, resource limits, or another Plugin dependency. The manager
derives deployment details from the installed Core bundle's retained, hash-verified templates. A Plugin release may fill
only the templates' documented placeholders and cannot provide or replace a template. Runtime Operations remain
authoritative in the private Plugin manifest.

## Generated deployment

The manager derives one Compose service from `plugin_id`. It fixes the private network, port `8080`, `/health` check,
`restart: "no"`, Source Gateway origin, Core endpoint fragment, optional connector fragment mount, and container
filesystem access. The Plugin release can select only its image, declared contracts and interactions, and optional
connector policy. Full-model validation rejects another restart policy so Docker cannot bypass manager recovery after a
daemon or host restart.

The generated service name is `atlas-plugin-<plugin_id>` with underscores converted to hyphens. Plugin identifiers do
not contain hyphens, so this conversion cannot collide. Core reaches the Plugin at
`http://atlas-plugin-<normalized_id>:8080`. The Plugin listens on port `8080` and receives the fixed
`ATLAS_SOURCE_GATEWAY_ORIGIN=http://source-gateway:8080` environment variable.

When `atlas_protocol_revision` is non-null, the service also receives
`ATLAS_CORE_ORIGIN=http://api:8000` and `ATLAS_API_AUTH_KEY=${ATLAS_PLUGIN_API_KEY}`. The CLI owns the shared full-access
managed key in the owner-only root deployment configuration, supplies it to Compose, and rotates it through the
transaction defined in `MANAGEMENT.md`. The release cannot provide or override either value. These fixed platform values
are not a general Plugin configuration mechanism.

When `source_connector` is non-null, the manager writes the validated object to `active/source-connector.json` and mounts
that file into Source Gateway. When it is null, the manager generates neither the file nor a Source Gateway mount for the
Plugin. It never writes JSON `null` as a connector file.

After pulling a signed image-index reference for a selected or previous release, the manager records its platform-manifest
digest and local Docker image ID in the matching durable `installed.json` record. After starting a Plugin, it inspects the
container and requires its configured image reference and resolved image ID to match those recorded values. Runtime
discovery verifies the Plugin manifest; it is not proof of the running release identity.

## Catalog document

Atlas publishes one signed stable catalog through the repository's GitHub Pages deployment. The CLI embeds that stable
catalog URL and trusted Ed25519 public keys, not Plugin entries. Release documents remain GitHub Release assets, and
images remain GHCR artifacts. The catalog has this shape:

```json
{
  "schema": 1,
  "sequence": 42,
  "previous_catalog_sha256": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "issued_at": "2026-09-01T16:00:00Z",
  "expires_at": "2026-10-01T16:00:00Z",
  "key_epoch": 2,
  "key_id": "atlas-plugin-catalog-2026-01",
  "plugins": [
    {
      "plugin_id": "building_scan",
      "releases": [
        {
          "version": "0.2.0",
          "display_name": "Building Scan",
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

The publisher and manager both reject duplicate `plugin_id` entries and duplicate Semantic Versions within one Plugin
before sorting or selecting a release. The catalog otherwise uses strict decoding and stable sorting by `plugin_id` and
Semantic Version. `sequence` increases for every publication within one key epoch. Epoch 1, sequence 1 has a null
`previous_catalog_sha256`; every later catalog, including
the first catalog in a newer epoch, pins the exact prior catalog bytes. A newer trusted epoch starts at the initial
sequence floor embedded in the CLI and may use a lower sequence than the prior epoch's high-water mark. `issued_at` and
`expires_at` use UTC RFC 3339 timestamps, and expiry is at most 30 days after issue. Issue time must increase with every
publication, including across epoch transitions, and cannot be more than five minutes ahead of the manager's clock. Each
release document must repeat its catalog release's Plugin ID, display name, and version. The manager rejects a mismatch.
Display names belong to releases, so renaming a later release does not invalidate retained history.

The manager bounds the catalog response at 4 MiB and the detached signature response at 1 KiB before parsing or
verification. Schema 1 permits at most 128 Plugins and 256 releases per Plugin. Plugin IDs, display names, versions,
key IDs, URLs, hashes, and revocation reasons have explicit parser limits; no string may exceed 2,048 UTF-8 bytes. A
release URL must exactly match the repository's HTTPS GitHub Release tag and asset pattern for that Plugin and version,
with no credentials, query, or fragment. The downloader follows at most five HTTPS redirects to CLI-allowlisted GitHub
release-asset hosts and never forwards credentials across a redirect.

The detached `catalog.json.sig` document contains exactly `algorithm`, `key_id`, and a standard-base64 signature. The
algorithm is `ed25519`; `key_id` must match the signed catalog; and the signature covers the exact `catalog.json` bytes.
The signed catalog entry authenticates the exact release-document bytes, which authenticate the image digest. A second
release-document signature would add another path without adding trust and is not used.

The protected `plugin-catalog` branch is the canonical catalog ledger. Force pushes are forbidden. Each publication
rejects duplicate identities, validates the transition against the current branch head, preserves every existing Plugin,
version, display name, release-document hash, and true revocation, then pushes the new catalog with a compare-and-swap on
that head commit. A release may be added and a revocation may change only from false to true. Existing release identity,
display name, and hash never change. Ordinary
publication keeps the current key epoch and increments its sequence. An authorized key rotation increments the epoch
and starts at that epoch's CLI-embedded sequence floor. A Pages deployment is built from that exact ledger commit, not
by reading the mutable Pages endpoint.

The manager atomically stores the accepted catalog bytes, signature bytes, sequence, catalog hash, key epoch, key ID,
issue time, and expiry as described in `MANAGEMENT.md`. It compares `(key_epoch, sequence)` lexicographically. It rejects
an older epoch, a lower sequence within the accepted epoch, the same pair with different bytes, or a pair below the
minimum checkpoint embedded in its CLI. A higher trusted epoch supersedes every sequence from an older epoch. It may use
a cached catalog until `expires_at`. After expiry, installed Plugins continue to run and the operator may inspect,
disable, or uninstall them. Install, enable, update, and manual rollback require a fresh catalog. The menu checks
when opened and exposes a manual refresh; no background updater runs.

## Revocation and key rotation

Revocation publishes a new catalog sequence that marks the immutable release `revoked` and gives a concise reason. The
manager refuses a new install, enable, update, or manual rollback to that release. It warns about an already Installed
revoked release but does not stop or replace it without operator approval. Starting Atlas may continue an already
Enabled revoked release from its locally verified state; it does not create a new enablement decision.

Each trusted public key has an ordered epoch and initial sequence floor embedded in the CLI. Rotation first publishes a
CLI that trusts the new key and its floor. The signed catalog's key epoch must match the embedded epoch for its `key_id`.
Atlas then publishes the first catalog in that epoch at the floor. The higher authenticated epoch is accepted even when
its sequence is lower than the prior epoch's accepted sequence. After accepting it, a manager permanently rejects older
epochs even when they carry a higher sequence. A later CLI may remove the old key. Older CLIs that do not trust the new
key cannot mutate Plugin state after their last catalog expires and must update. Compromise of the active signing key
requires a CLI update that removes that key and trusts a newer epoch. An attacker-created high sequence in the
compromised epoch cannot block the newer epoch. Installed Plugins remain operable while catalog mutations fail closed.

Every CLI release embeds the newest `(key_epoch, sequence)` pair it verified while building. This checkpoint limits replay
for a fresh installation or after an explicit Atlas reset. Existing installations retain their stronger local pair. A
fresh installation can still accept a replay between its embedded checkpoint and the current catalog for at most the
catalog's 30-day lifetime; short expiry is the bound for that remaining case.

## Publication transaction

The Plugin release workflow acquires a non-cancelling concurrency group keyed by `plugin_id` and version before its first
publication side effect. It pins one reviewed source commit for every build and generated byte, then:

1. verifies the selected Plugin folder and confirms its package version matches the requested release;
2. runs its focused lint, format, type, test, build, Docker, and contract checks;
3. builds and publishes the multi-architecture candidate image, then records its immutable index digest;
4. generates the exact release document from authored Plugin metadata and that digest;
5. publishes the immutable tag and GitHub Release with the release document;
6. downloads and rechecks the public release document and image digest;
7. enters the global non-cancelling catalog-publication group, validates and appends to the protected canonical ledger,
   signs the new catalog, and compare-and-swap pushes the ledger commit;
8. publishes one GitHub Pages artifact containing `catalog.json` and `catalog.json.sig` from that exact ledger commit;
9. verifies the stable catalog URL, signature, sequence, release-document hash, and public image.

Neither concurrency group cancels an in-progress publication. A failure before the ledger update leaves unlisted
artifacts that no manager can install. A retry treats an existing tag, GitHub Release asset, image digest, release
document, or catalog entry as success only when every byte, digest, and source commit matches. Any conflict is a hard
failure. A published version is never replaced. Revocation uses a separate catalog-only workflow and never rewrites
release artifacts.

A scheduled catalog workflow runs weekly even when no Plugin release or revocation occurred. It enters the same
non-cancelling concurrency group, increments the sequence, renews the issue and expiry timestamps, signs with the current
key, compare-and-swap updates the ledger, and publishes one complete Pages artifact. The Ed25519 private key lives in a
dedicated `plugin-catalog` GitHub environment restricted to the default branch and narrowly scoped catalog workflow. It
does not reuse the manually approved Core `release` environment, because a scheduled renewal must not wait for a human
reviewer. Trusted public keys are source-controlled in the CLI. The Pages deployment is replaced as one artifact so the
catalog and detached signature cannot be published from different transactions.

Atlas Core's release workflow does not build Plugin images, write Plugin digests into the CLI package, copy Plugin
deployment files, promote Plugin tags, or verify Plugin package visibility. It may continue running Plugin source and
container checks in ordinary repository CI.

The first Core release that removes bundled Plugin assets is an explicit greenfield transition. Its CLI refuses the Core
update while any bundled-v1 Plugin remains enabled. The operator disables those Plugins with the matching v1 CLI,
updates Core, then installs the independently published release from the signed catalog. Atlas does not manufacture an
`installed.json` receipt for an old image whose independent release document was never verified. No compatibility bridge
or automatic provenance migration is provided.
