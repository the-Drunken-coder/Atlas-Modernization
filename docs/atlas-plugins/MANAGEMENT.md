# Plugin management

Status: accepted target design, not yet implemented. The current CLI still enables and disables Plugins from the catalog
embedded in its matching Atlas Core package.

The host-side `atlas-core` CLI manages independently versioned, trusted, query-only Plugins. Core remains unaware of the
catalog, release history, image registry, and host filesystem. It receives only generated endpoint configuration and the
private Plugin protocol.

## Local state

The manager stores Plugin state under the existing private Atlas Core configuration directory:

```text
catalog-state.json                  accepted catalog receipt and anti-rollback state
base/
  docker-compose.yml               immutable files from the installed Core release
  docker-compose.init.yml
  source_gateway.production.json
  plugin-templates/                declarative active-file templates and placeholder schema
transaction/                       present only during one global mutation
  journal.json
  before/                          byte-for-byte restorable files
  staged/
plugins/
  <plugin_id>/
    installed.json
    releases/
      <version>.atlas-plugin
    active/                          present only while enabled
      compose.yml
      core-endpoint.json
      source-connector.json          present only when the release declares one
      deployment.json
```

The existing root deployment state remains the only authority for enablement through its sorted `enabledPlugins` IDs.
Its next schema is `3` and records the exact base deployment plus compatibility supplied by the installed Core release:

```json
{
  "schema": 3,
  "baseDeployment": {
    "bundleSha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "coreImage": "ghcr.io/the-drunken-coder/atlas-core@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "coreLocalImageId": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  },
  "pluginContracts": {
    "coreToPluginProtocolMajors": [1],
    "pluginToSourceGatewayProtocolMajors": [1],
    "atlasProtocolRevision": "sha256:1c0493ca007d0555baac6e1958350e3efada4397c392bbf69b9038d75d9b90f6"
  }
}
```

This fragment omits the root state's existing phase, timestamps, package version, Docker engine ID, and enabled Plugin
IDs. The major arrays are sorted and duplicate-free. A schema-3 state is written only by initialization or a successful
Core update from release metadata and exact package assets. The CLI does not infer compatibility or base images from an
active container. Schema 2 remains current-v1 state and cannot use independent Plugin commands.

`base/` is copied from the exact installed Core package during initialization or Core update. It contains every relative
file referenced by either retained Compose file plus the declarative templates and strict placeholder schema used to
generate `active/`. Package assembly rejects symlinks, path escapes, and a referenced or required generation file whose
target is absent. `bundleSha256` hashes a deterministic archive of every retained relative path and its bytes, including
`source_gateway.production.json` and `plugin-templates/`. Every restart-capable Plugin operation verifies that complete
bundle and uses it with `baseDeployment.coreImage`, never the Compose files, generation templates, or Core image from a
newer CLI package. It also verifies the local Core image ID before changing containers. This preserves the installed Core
version while allowing a newer CLI to manage compatible Plugins.

Schema-3 initialization or upgrade provisions one full-access managed Core API key and stores its one-time value as
`ATLAS_PLUGIN_API_KEY` in the existing owner-only root `.env`. The generated service for an SDK-using Plugin receives that
key as `ATLAS_API_AUTH_KEY` plus the fixed `ATLAS_CORE_ORIGIN=http://api:8000`. A release cannot supply or override either
value. This root platform credential is the one concrete secret schema 1 needs; schema 1 has no per-Plugin setting or
secret lifecycle. Initial provisioning runs inside the root transaction and fsyncs a unique transaction-and-attempt key
name before asking Core to create the key. It does not commit schema 3 until the returned secret is durably staged and
authenticated. An uncertain result is never retried; recovery lists and revokes any key with that exact name before it
records a fresh attempt. The manager owns later rotation as described below.

`catalog-state.json` is one atomically replaced object. The encoded byte fields are abbreviated in this example:

```json
{
  "schema": 1,
  "sequence": 42,
  "catalog_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "key_epoch": 2,
  "key_id": "atlas-plugin-catalog-2026-01",
  "issued_at": "2026-09-01T16:00:00Z",
  "expires_at": "2026-10-01T16:00:00Z",
  "catalog_bytes_base64": "...",
  "signature_bytes_base64": "..."
}
```

The manager verifies that the decoded exact bytes match every repeated field before accepting the file. It writes and
fsyncs this object and its parent directory before using a new catalog. The accepted `(key_epoch, sequence)` pair is the
deployment's local catalog high-water mark. The destructive `atlas-core reset` intentionally deletes this receipt and
warns that it clears that mark. The next initialization still enforces the minimum pair embedded in the CLI.

`installed.json` contains exactly:

```json
{
  "schema": 1,
  "plugin_id": "building_scan",
  "selected_version": "0.2.0",
  "selected_document_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "previous_version": "0.1.0",
  "previous_document_sha256": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
}
```

Both previous fields are `null` before the first successful update. The manager retains only the selected and previous
release documents. Release documents never change after installation. Active files are generated and disposable.

While enabled, `active/deployment.json` contains exactly:

```json
{
  "schema": 1,
  "plugin_id": "building_scan",
  "version": "0.2.0",
  "release_document_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "image_index": "ghcr.io/the-drunken-coder/atlas-building-scan@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "platform_manifest_sha256": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "local_image_id": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The manager regenerates this receipt when a selected release becomes active. The receipt and the other files under
`active/` are disposable outputs, not trusted inputs. Before Compose reads them, the manager derives a complete temporary
`active/` directory from root deployment state, `installed.json`, the exact retained release document, the installed
Core bundle's hash-verified templates, and root platform credentials. Templates are fixed declarative package assets; a
Plugin release may fill only their documented placeholders and cannot provide or replace a template. The manager omits
`source-connector.json` and its Source Gateway mount when the release declares a null connector. It atomically replaces
any missing, changed, or extra generated file and validates the full Compose model. Container inspection must match the
regenerated receipt before an enable, enabled update, rollback, Core update, or normal start succeeds.

Every file and directory preserves the CLI's existing owner and mode checks. The manager writes private temporary files,
flushes them, and uses atomic rename. It holds the existing Atlas mutation lock and Docker-engine network lock across
every state-changing operation.

## States and commands

A catalog entry is available to install. Installation, enablement, and runtime availability are independent:

| State | Meaning | Allowed changes |
| --- | --- | --- |
| Catalog entry | A trusted release is listed in a fresh catalog. | Install. |
| Installed Plugin | `installed.json` selects one retained release. | Update, enable, rollback, uninstall. |
| Enabled Plugin | The Plugin ID is in root deployment state and active files exist. | Update, disable, rollback. |
| Runtime status | Core reports `starting`, `available`, or `unavailable`. | Inspect status or logs; runtime status does not change installed state. |

The command family is:

```text
atlas-core plugins install <plugin_id> [version]
atlas-core plugins enable <plugin_id>
atlas-core plugins disable <plugin_id>
atlas-core plugins update <plugin_id|all>
atlas-core plugins rollback <plugin_id>
atlas-core plugins uninstall <plugin_id>
atlas-core plugins rotate-core-key
atlas-core plugins status [plugin_id]
atlas-core plugins logs <plugin_id> [--follow]
atlas-core plugins refresh
```

Omitting `version` installs the latest compatible, non-revoked stable release. Install fails when the Plugin is already
Installed; the operator uses update or rollback to change its selected release. `install` never enables implicitly. The
interactive menu may offer a second explicit "Enable now?" confirmation after installation.

Uninstall requires the Plugin to be disabled. It removes installed release records and active deployment metadata but
retains cached Docker layers. Package schema 1 has no separate Plugin configuration lifecycle.

`rotate-core-key` replaces only the shared managed key used by SDK-backed Plugins. It is available without a fresh catalog
and uses the root transaction plus the deployment-owned admin credential. Before each key-creation request, the manager
writes and fsyncs a unique `atlas-plugin-rotation-<transaction_id>-<attempt>` managed-key name in the journal. It never
retries a request with an uncertain result. Recovery lists active keys by that exact name, revokes any match whose
one-time secret was not durably staged, records a fresh attempt name, and only then tries again. After a successful
response, the journal records the candidate key ID but no secret; the candidate secret exists only in the private staged
`.env`.

When Atlas is running, the manager authenticates the candidate key, stages `.env` and regenerated active files, recreates
only Enabled SDK-using Plugin containers with pulling disabled, and waits for their health. It then makes the new `.env`
durable and revokes the old key before marking the transaction complete. A failure before the new key becomes durable
restores the old `.env` and containers and revokes the candidate key. Recovery after that point must finish revoking the
old key. Cleanup treats an old key that an administrator already revoked as absent.

When Atlas is stopped, the command starts the exact retained base composition without Plugin fragments, creates and
authenticates the replacement, makes the new `.env` durable, and revokes the old key while that temporary Core is still
running. It then stops the base composition and marks the transaction complete. Recovery keeps or restarts that exact
base composition until mandatory old-key revocation succeeds, then restores the prior stopped state. The interactive menu
explains that every SDK-using Plugin shares this credential and confirms rotation.

## Compatibility

Plugin management uses contract compatibility instead of exact CLI and Core package equality. Plugin commands still
require the same Docker engine recorded by the deployment. Install, disabled-Plugin update, uninstall, refresh, status,
and logs do not recreate Core. Enable, disable, enabled-Plugin update, and enabled-Plugin rollback may recreate
Core or Source Gateway, so they must use the retained base bundle and exact image records above. Core deployment updates
retain their exact package-version guard because they replace the Core stack itself.

Before install, update, enable, or rollback, the CLI requires each release protocol major to be a member of the matching
deployed supported-major set. When `atlas_protocol_revision` is non-null, it must equal the deployed Core revision. The
CLI also checks its supported package-schema majors. Package schema 1 permits only the already coordinated `map_area`
interaction; a CLI-only update cannot add another interaction because Core, Atlas Protocol, and the Command Interface
must support it together. A Core update changes recorded contracts and base assets only after its transaction succeeds.
No new Core capability-discovery endpoint is needed.

Generated deployment-file changes are discarded before Compose runs. Runtime checks remain authoritative after manual
container or image changes:

- The private Plugin `/manifest` response adds `core_to_plugin_protocol_major`. Core requires membership in its supported
  set before it accepts and caches the manifest. An unsupported major maps to the existing `invalid_manifest` status
  reason.
- Every Source Gateway request adds `plugin_to_source_gateway_protocol_major` to its strict JSON body. The Gateway rejects
  a missing or unsupported major as its existing HTTP `400` `request_rejected` failure.

These private majors stay outside the generated Atlas Protocol schema and revision token. There is no version range or
negotiation. A transition first ships Core and Source Gateway with both old and new majors in their supported sets. New
Plugin releases may then require the new major. A later Core release drops the old major only after enabled Plugins no
longer require it.

## Transactions

Every mutation uses the one root-level `transaction/` directory before it changes files, deployment membership, or
containers. `journal.json` records a transaction ID, operation, Docker engine ID, PID, host boot identity, process-start
identity, prior running status, and phase. `before/` contains the complete previous root state and byte-for-byte copies of
every file that the operation may overwrite or delete. `staged/` contains candidate files. The manager fsyncs files and
their containing directories before starting the deployment change.

The local lock file and Docker network lock carry the same transaction and owner identities. On startup, the CLI refuses
to reclaim a live or ambiguous owner. When boot and process-start evidence proves the owner is dead, it atomically
reclaims both matching locks and recovers the transaction before ordinary deployment validation. It never tells an
operator to remove only one lock while a journal exists.

Recovery for a transaction that did not start a different Core image restores `before/` and the prior running
composition when no durable commit marker exists. Core update recovery follows the storage-aware rules below and never
blindly starts the prior image. After all target health and identity checks pass, the manager writes and fsyncs the
commit marker. Recovery that sees that marker keeps the target state and only finishes cleanup. The manager removes the
transaction directory and fsyncs its parent last. Because the journal sits outside every Plugin subtree, uninstall
cannot erase its own recovery data.

Install performs these steps:

1. load a fresh signed catalog and verify sequence, expiry, and revocation;
2. fetch the release document and verify its exact hash and strict schema;
3. verify Plugin identity, Semantic Version, lifecycle, contracts, interactions, connector policy, and image repository;
4. pull the exact image digest and record its platform-manifest digest and local image ID;
5. write the immutable release document and `installed.json` atomically.

Install does not change root deployment state and does not restart a stopped or running deployment.

Enable generates active files from the selected release, validates the complete Compose model, commits the Plugin ID to
root deployment state, and recreates Core, Source Gateway, and the Plugin when Atlas is running. It uses the retained
base bundle and exact Core image. It waits for base readiness, Plugin health, and public Plugin discovery. Discovery must
match the release manifest fields and may advertise only interaction kinds declared by the release. Docker inspection
must separately prove that the container uses the release's digest-pinned image and recorded local image ID. Failure
restores state, files, and the previous composition. A stopped Atlas deployment remains stopped; the next normal start
regenerates and validates active files, verifies exact image identity, and relies on Core's asynchronous Plugin status
checks instead of gating base startup on Plugin health.

When the selected release is permitted, update selects the greatest compatible, non-revoked stable version newer than
it and reports that the Plugin is current when none exists. When the selected release is revoked, update instead selects
the greatest compatible, non-revoked stable release other than the selection, even when that replacement has a lower
version. It labels that remediation as a downgrade. If no permitted replacement exists, it reports that condition rather
than calling the revoked Plugin current. While disabled, update verifies, pulls, and stores the candidate, moves the prior
selected release to `previous`, and does not restart Atlas. Updating an Enabled Plugin requires Atlas to be running; when
Atlas is stopped, the command tells the operator to start Atlas or disable the Plugin first. While enabled, update stages
candidate active files, validates Compose, pulls the candidate digest, recreates the affected services with pulling
disabled, and waits for the same image, health, and discovery checks. Only then does it commit selected and previous
release state. Failure restores the old release, active files, deployment state, and running composition.

Rollback uses the update transaction with the retained previous release. The catalog must be fresh, and that release
must remain compatible and non-revoked. After success, selected and previous swap, which permits an explicit return to
the newer release if it also remains permitted. The manager pulls and verifies the retained image when it is missing
locally. Rollback of an Enabled Plugin also requires Atlas to be running.

Disable removes the Plugin container, active files, and deployment membership. It retains selected and previous releases
and Docker cache. A running deployment recreates Core and Source Gateway and waits for health. A stopped deployment stays
stopped.

`update all` processes every Installed Plugin in sorted Plugin ID order. Each Plugin is its own transaction. The command
stops at the first failure, reports already updated Plugins, and leaves the failed Plugin on its prior release. It does
not roll back unrelated successful Plugin updates.

## Core update and normal start

A Core update reads enabled Plugins from local `installed.json` files and retained signed release documents, not from a
CLI-embedded catalog. It requires Atlas to be running, preflights every Enabled Plugin against the target Core's supported
private-major sets and Atlas Protocol revision, and blocks the update on any incompatibility. An incompatible disabled
Plugin may remain Installed but cannot later be Enabled against that Core.

When an SDK-using Plugin blocks a Core revision change, the operator disables it, updates Core, updates that disabled
Plugin to a release declaring the new revision, then enables it. Atlas does not pretend that one SDK build can use two
exact generated Protocol revisions.

The Core update uses the same durable root transaction and the existing paired-backup confirmation from the deployment
runbook. Before changing containers, its journal records the prior migration version and checksums as well as the prior
image and complete state. It stages the target Core image and base Compose bundle, starts the target with pulling
disabled, and verifies the exact Core container image, base health, every Enabled Plugin container image, runtime
manifest, and health. It commits the Core package version, base bundle hash, image records, supported-major sets, and
Atlas Protocol revision together only after those checks pass.

If failure occurs before the target Core starts, recovery may restore the prior files and composition automatically.
Once the target Core has started, failure or a pre-commit crash stops the deployment and leaves the journal intact. The
CLI records and inspects the migration ledger, but it never starts the prior Core image automatically. It permits that
restart only after proving that migration rolled back before commit and that the target served no application traffic.
If a migration committed, the target served traffic, or either fact is uncertain, the operator must restore the paired
pre-deploy PostgreSQL and MinIO backup or fix forward with a compatible Core release. Recovery then verifies the durable
store before completing the transaction. This follows the rollback rules in
[`DEPLOYMENT_RUNBOOK.md`](../../services/core/docs/DEPLOYMENT_RUNBOOK.md).

Normal `atlas-core start` acquires the mutation locks, regenerates every Enabled Plugin's complete `active/` directory,
and validates the assembled Compose model before it starts a container. It verifies that the recorded Core and Enabled
Plugin image IDs still exist locally, then uses the retained base bundle with Compose pulling disabled. It inspects every
started container to verify exact image identity and waits only for base Atlas health and readiness before recording the
deployment as started. It does not wait for Plugin manifests or health. Core's retry loop reports each configured Plugin
as `starting`, `available`, or `unavailable` asynchronously, and a Plugin outage never fails base startup. A missing or
changed retained file leaves the deployment stopped and instructs the operator to run `atlas-core start --repair-bundle`.

The bundle-repair form holds the same locks and reads `state.packageVersion` plus the recorded `bundleSha256`. It uses
matching assets from the current CLI package when available; otherwise it downloads the exact public
`atlas-core@<state.packageVersion>` npm archive into a private temporary directory without installing it or executing
package code. It rejects symlinks, path escapes, missing relative Compose assets, and size-limit violations, builds the
complete candidate `base/`, and requires its deterministic hash to equal the recorded hash. It atomically replaces
`base/`, then performs the normal start without changing the CLI, Core, or Plugin version. npm failure or a hash mismatch
leaves the prior bundle and stopped deployment unchanged. `--repair-bundle` and `--repair-images` may be supplied together.

If an exact recorded image is missing or its local ID no longer matches, normal start remains stopped and instructs the
operator to run `atlas-core start --repair-images`. The repair form holds the same locks and re-pulls only the exact Core
and base-image digests in the retained bundle plus the exact Enabled Plugin digests in retained release documents. It
verifies every platform manifest and local image ID, atomically replaces the image receipts, then performs the normal
pull-disabled start. It does not read the catalog, select a version, or alter Core or Plugin state. Registry failure leaves
the deployment stopped and its prior receipts intact. A registry is not required to restart when all recorded images are
still present.

The first independent-release Core update does not migrate enabled bundled-v1 Plugins. If schema-2 state contains an
enabled Plugin without a verified `installed.json`, the update stops without changing the deployment and tells the
operator to disable it with the matching v1 CLI. If a newer CLI was installed directly, the error names the exact
`state.packageVersion` to invoke temporarily for that disable operation. After updating Core, the operator installs and
enables an independent release from the signed catalog. This is an intentional greenfield cutoff rather than a
compatibility bridge.

## Catalog and offline behavior

Opening the Plugins menu checks the catalog once; `refresh` checks again. There is no background updater. A valid cached
catalog may be used until its expiry. Catalog network or signature failure never stops Installed Plugins.

Catalog refresh verifies the new catalog completely, then atomically replaces `catalog-state.json`. The
`(key_epoch, sequence)` pair and catalog hash advance with the cached bytes in that one write, so a crash cannot separate
the usable catalog from its anti-rollback state.

After catalog expiry, install, enable, update, and manual rollback fail closed. Status, logs, disable, uninstall,
`rotate-core-key`, Core start, and Core stop continue to work from local verified state. Core start may therefore restart
an already Enabled Plugin, but it does not permit a disabled Installed Plugin to become Enabled. Automatic rollback
inside an already-started update uses the before-state captured under the fresh catalog that admitted that update.

Revoked Installed Plugins appear with the catalog reason and explicit update and disable actions. Atlas never updates,
disables, or uninstalls them without operator approval.
