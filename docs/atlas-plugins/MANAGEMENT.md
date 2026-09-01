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
  docker-compose.yml               immutable bundle for the installed Core release
  docker-compose.init.yml
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
      source-connector.json
      deployment.json
    config/                          retained until explicit purge
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

`base/` is copied from the exact installed Core package during initialization or Core update. Every restart-capable
Plugin operation uses that retained Compose bundle and `baseDeployment.coreImage`, never the Compose file or Core image
from a newer CLI package. It verifies the bundle hash and local Core image ID before changing containers. This preserves
the installed Core version while allowing a newer CLI to manage compatible Plugins.

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
fsyncs this object and its parent directory before using a new catalog. The destructive `atlas-core reset` intentionally
deletes this receipt and warns that it clears the deployment's local catalog high-water mark. The next initialization
still enforces the minimum catalog checkpoint embedded in the CLI.

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
Configuration is operator-owned and does not belong to either release.

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

The manager regenerates this receipt when a selected release becomes active. Container inspection must match it before
an enable, enabled update, rollback, Core update, or normal start succeeds.

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
atlas-core plugins purge <plugin_id>
atlas-core plugins status [plugin_id]
atlas-core plugins logs <plugin_id> [--follow]
atlas-core plugins refresh
```

Omitting `version` installs the latest compatible, non-revoked stable release. Install fails when the Plugin is already
Installed; the operator uses update or rollback to change its selected release. `install` never enables implicitly. The
interactive menu may offer a second explicit "Enable now?" confirmation after installation.

Uninstall requires the Plugin to be disabled. It removes installed release records and active deployment metadata, but
retains operator configuration and cached Docker layers. Purge requires the Plugin to be uninstalled and removes only
Atlas-managed configuration. It never deletes an external environment variable, secret store entry, or source file.

## Compatibility

Plugin management uses contract compatibility instead of exact CLI and Core package equality. Plugin commands still
require the same Docker engine recorded by the deployment. Install, disabled-Plugin update, uninstall, purge, refresh,
status, and logs do not recreate Core. Enable, disable, enabled-Plugin update, and enabled-Plugin rollback may recreate
Core or Source Gateway, so they must use the retained base bundle and exact image records above. Core deployment updates
retain their exact package-version guard because they replace the Core stack itself.

Before install, update, enable, or rollback, the CLI requires each release protocol major to be a member of the matching
deployed supported-major set. When `atlas_protocol_revision` is non-null, it must equal the deployed Core revision. The
CLI also checks its supported package-schema majors. Package schema 1 permits only the already coordinated `map_area`
interaction; a CLI-only update cannot add another interaction because Core, Atlas Protocol, and the Command Interface
must support it together. A Core update changes recorded contracts and base assets only after its transaction succeeds.
No new Core capability-discovery endpoint is needed.

Runtime checks remain authoritative after manual image or deployment-file changes:

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

Recovery restores `before/` and the prior running composition when no durable commit marker exists. After all target
health and identity checks pass, the manager writes and fsyncs the commit marker. Recovery that sees that marker keeps
the target state and only finishes cleanup. The manager removes the transaction directory and fsyncs its parent last.
Because the journal sits outside every Plugin subtree, uninstall and purge cannot erase their own recovery data.

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
performs the same image, manifest, and health checks.

Update selects the greatest compatible, non-revoked stable version newer than the selected version. It reports that the
Plugin is current when no such release exists. While disabled, update verifies, pulls, and stores the candidate, moves
the prior selected release to `previous`, and does not restart Atlas. Updating an Enabled Plugin requires Atlas to be
running; when Atlas is stopped, the command tells the operator to start Atlas or disable the Plugin first. While enabled,
update stages candidate active files, validates Compose, pulls the candidate digest, recreates the affected services
with pulling disabled, and waits for the same image, health, and discovery checks. Only then does it commit selected and
previous release state. Failure restores the old release, active files, deployment state, and running composition.

Rollback uses the update transaction with the retained previous release. The catalog must be fresh, and that release
must remain compatible and non-revoked. After success, selected and previous swap, which permits an explicit return to
the newer release if it also remains permitted. The manager pulls and verifies the retained image when it is missing
locally. Rollback of an Enabled Plugin also requires Atlas to be running.

Disable removes the Plugin container, active files, and deployment membership. It retains selected and previous releases,
configuration, and Docker cache. A running deployment recreates Core and Source Gateway and waits for health. A stopped
deployment stays stopped.

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

The Core update uses the same durable root transaction. It stages the target Core image and base Compose bundle, records
the prior image and complete state, starts the target with pulling disabled, and verifies the exact Core container image,
base health, every Enabled Plugin container image, runtime manifest, and health. It commits the Core package version,
base bundle hash, image records, supported-major sets, and Atlas Protocol revision together only after those checks pass.
Failure or pre-commit crash restores the previous Core image, base bundle, Plugin active files, state, and running
composition.

Normal `atlas-core start` verifies that the recorded Core and Enabled Plugin image IDs still exist locally, then uses the
retained base bundle with Compose pulling disabled. It inspects every started container and waits for base health, Plugin
manifests, and Plugin health before recording the deployment as started. A missing or mismatched local image fails with
an instruction to run an explicit update or recovery command. Catalog and registry availability are therefore not
prerequisites for restarting an already installed deployment.

The first independent-release Core update does not migrate enabled bundled-v1 Plugins. If schema-2 state contains an
enabled Plugin without a verified `installed.json`, the update stops without changing the deployment and tells the
operator to disable it with the matching v1 CLI. If a newer CLI was installed directly, the error names the exact
`state.packageVersion` to invoke temporarily for that disable operation. After updating Core, the operator installs and
enables an independent release from the signed catalog. This is an intentional greenfield cutoff rather than a
compatibility bridge.

## Catalog and offline behavior

Opening the Plugins menu checks the catalog once; `refresh` checks again. There is no background updater. A valid cached
catalog may be used until its expiry. Catalog network or signature failure never stops Installed Plugins.

Catalog refresh verifies the new catalog completely, then atomically replaces `catalog-state.json`. Sequence, hash, and
key epoch advance with the cached bytes in that one write, so a crash cannot separate the usable catalog from its
anti-rollback state.

After catalog expiry, install, enable, update, and manual rollback fail closed. Status, logs, disable, uninstall, purge,
Core start, and Core stop continue to work from local verified state. Core start may therefore restart an already
Enabled Plugin, but it does not permit a disabled Installed Plugin to become Enabled. Automatic rollback inside an
already-started update uses the before-state captured under the fresh catalog that admitted that update.

Revoked Installed Plugins appear with the catalog reason and explicit update and disable actions. Atlas never updates,
disables, or uninstalls them without operator approval.
