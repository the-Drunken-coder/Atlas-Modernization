# Plugin management

Status: accepted target design, not yet implemented. The current CLI still enables and disables Plugins from the catalog
embedded in its matching Atlas Core package.

The host-side `atlas-core` CLI manages independently versioned, trusted, query-only Plugins. Core remains unaware of the
catalog, release history, image registry, and host filesystem. It receives only generated endpoint configuration and the
private Plugin protocol.

## Local state

The manager stores Plugin state under the existing private Atlas Core configuration directory:

```text
plugins/
  <plugin_id>/
    installed.json
    transaction.json                 present only during a mutation
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
Its next schema is `3` and adds the private protocol majors supplied by the installed Core release:

```json
{
  "schema": 3,
  "pluginContracts": {
    "coreToPluginProtocolMajor": 1,
    "pluginToSourceGatewayProtocolMajor": 1
  }
}
```

This fragment omits the root state's existing phase, timestamps, package version, Docker engine ID, and enabled Plugin
IDs. The migration from schema 2 takes both majors from the matching installed Core release. It does not infer them from
an active Plugin. The CLI carries its own supported package-schema majors and fixed interaction kinds outside deployment
state.

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
require the same Docker engine recorded by the deployment, but they bypass the root state's exact CLI package-version
guard. Core deployment updates retain that guard because they replace the Core stack itself.

The next deployment-state schema records the Core and Source Gateway contract majors installed with that Core image.
Before install, update, enable, or rollback, the CLI checks the release document against both recorded runtime majors,
its supported package-schema majors, and its fixed interaction kinds. A CLI-only update may add support for a package
schema or interaction without updating Core. A Core update changes the recorded runtime majors only after its own
health-checked transaction succeeds. No new Core capability-discovery endpoint is needed.

Runtime checks remain authoritative after manual image or deployment-file changes:

- The private Plugin `/manifest` response adds `core_to_plugin_protocol_major`. Core requires exact support before it
  accepts and caches the manifest. An unsupported major maps to the existing `invalid_manifest` status reason.
- Every Source Gateway request adds `plugin_to_source_gateway_protocol_major` to its strict JSON body. The Gateway rejects
  a missing or unsupported major as its existing HTTP `400` `request_rejected` failure.

These private majors stay outside the generated Atlas Protocol schema and revision token. There is no version range or
negotiation. Supporting another major means explicitly supporting and testing both contracts.

## Transactions

Every mutation verifies state and writes `transaction.json` before it changes active files, deployment membership, or
containers. The journal records the operation, before-state hashes, staged paths, and phase. The CLI refuses another
mutation while a journal exists. On its next invocation it restores the before-state and previous running composition,
then removes the journal. Recovery never guesses that a partly applied candidate succeeded.

Install performs these steps:

1. load a fresh signed catalog and verify sequence, expiry, and revocation;
2. fetch the release document and verify its exact hash and strict schema;
3. verify Plugin identity, Semantic Version, lifecycle, contracts, interactions, connector policy, and image repository;
4. pull the exact image digest and verify Docker resolved that digest;
5. write the immutable release document and `installed.json` atomically.

Install does not change root deployment state and does not restart a stopped or running deployment.

Enable generates active files from the selected release, validates the complete Compose model, commits the Plugin ID to
root deployment state, and recreates Core, Source Gateway, and the Plugin when Atlas is running. It waits for base
readiness, Plugin health, and public Plugin discovery. Discovery must match the release identity and may advertise only
interaction kinds declared by the release. Failure restores state, files, and the previous composition. A stopped Atlas
deployment remains stopped.

Update selects the greatest compatible, non-revoked stable version newer than the selected version. It reports that the
Plugin is current when no such release exists. While disabled, update verifies and stores the candidate, moves the prior
selected release to `previous`, and does not restart Atlas. While enabled, it stages candidate active files, validates
Compose, pulls the candidate digest, recreates the affected services with pulling disabled, and waits for the same health
and discovery checks. Only then does it commit selected and previous release state. Failure restores the old release,
active files, deployment state, and running composition.

Rollback uses the update transaction with the retained previous release. The catalog must be fresh, and that release
must remain compatible and non-revoked. After success, selected and previous swap, which permits an explicit return to
the newer release if it also remains permitted.

Disable removes the Plugin container, active files, and deployment membership. It retains selected and previous releases,
configuration, and Docker cache. A running deployment recreates Core and Source Gateway and waits for health. A stopped
deployment stays stopped.

`update all` processes every Installed Plugin in sorted Plugin ID order. Each Plugin is its own transaction. The command
stops at the first failure, reports already updated Plugins, and leaves the failed Plugin on its prior release. It does
not roll back unrelated successful Plugin updates.

## Catalog and offline behavior

Opening the Plugins menu checks the catalog once; `refresh` checks again. There is no background updater. A valid cached
catalog may be used until its expiry. Catalog network or signature failure never stops Installed Plugins.

After catalog expiry, install, enable, update, and manual rollback fail closed. Status, logs, disable, uninstall, purge,
Core start, and Core stop continue to work from local verified state. Core start may therefore restart an already
Enabled Plugin, but it does not permit a disabled Installed Plugin to become Enabled. Automatic rollback inside an
already-started update uses the before-state captured under the fresh catalog that admitted that update.

Revoked Installed Plugins appear with the catalog reason and explicit update and disable actions. Atlas never updates,
disables, or uninstalls them without operator approval.
