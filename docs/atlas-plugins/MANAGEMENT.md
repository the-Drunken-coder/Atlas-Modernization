# Plugin management

Status: the independent Plugin lifecycle and release workflow are implemented in this worktree, and local validation passes. The candidate-image Docker acceptance test still awaits CI. The terminal UI redesign still awaits the user's selection from the proposed mocks. Existing published Core
packages may still contain the bundled catalog; the source implementation uses independent catalog state for schema-4
deployments. Production catalog signing, trust bootstrap, and Pages rollout remain external prerequisites; this
repository does not contain a production catalog key.

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
run-intent.json                     durable user intent; never part of rollback snapshots
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
The independent-release state uses schema `4` and records the exact base deployment plus compatibility supplied by the
installed Core release:

```json
{
  "schema": 4,
  "baseDeployment": {
    "bundleSha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "coreImage": "ghcr.io/the-drunken-coder/atlas-core@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "coreLocalImageId": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "images": [
      {
        "image_index": "ghcr.io/the-drunken-coder/atlas-core@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "platform_manifest_sha256": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "local_image_id": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      },
      {
        "image_index": "minio/mc:RELEASE.2024-01-31T08-59-40Z@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "platform_manifest_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "local_image_id": "sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0"
      },
      {
        "image_index": "minio/minio:RELEASE.2024-01-31T20-20-33Z@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "platform_manifest_sha256": "sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
        "local_image_id": "sha256:23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01"
      },
      {
        "image_index": "postgres:15@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "platform_manifest_sha256": "sha256:23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
        "local_image_id": "sha256:3456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012"
      }
    ]
  },
  "pluginContracts": {
    "supportedPackageSchemaMajors": [1],
    "supportedInteractions": ["map_area"],
    "coreToPluginProtocolMajors": [1],
    "pluginToSourceGatewayProtocolMajors": [1],
    "atlasProtocolRevision": "sha256:1c0493ca007d0555baac6e1958350e3efada4397c392bbf69b9038d75d9b90f6"
  }
}
```

This fragment omits the root state's existing phase, timestamps, package version, Docker engine ID, and enabled Plugin
IDs. The major arrays and image receipt array are sorted and duplicate-free. A ready schema-4 state requires the
complete `baseDeployment.images` receipt array and `pluginContracts`; initialization and Core update write one receipt
for each retained base image, including Core. The root state stores `bundleSha256`, but it does not embed the
`RetainedBundleManifest.files` list or per-file hashes. The manager recomputes that manifest from `base/` and verifies its
deterministic hash before use. The CLI does not infer compatibility or base images from an active container. Schema 3 is
the current engine-scoped-v1 bundled Plugin state and cannot use independent Plugin
commands. The first independent Core update requires bundled Plugins to be disabled with the matching v1 CLI before it
can create schema 4 state. If the schema-3 deployment has no retained `base/`, the manager fetches exactly
`atlas-core@state.packageVersion` with `npm pack`, verifies that package's version and `atlasCoreImage`, validates the
archive without executing downloaded code, and pulls receipts for the old Core, PostgreSQL, MinIO, and MinIO client
images. It extracts only the vetted Compose/config files into a private temporary candidate and transactionally retains
that candidate and its receipts before applying the new Core; existing `base/` and state remain untouched during import.

`base/` is copied from the exact installed Core package during initialization or Core update. It contains every relative
file referenced by either retained Compose file plus the declarative templates and strict placeholder schema used to
generate `active/`. Package assembly rejects symlinks, path escapes, and a referenced or required generation file whose
target is absent. `bundleSha256` hashes a deterministic archive of every retained relative path and its bytes, including
`source_gateway.production.json` and `plugin-templates/`. Every restart-capable Plugin operation verifies that complete
bundle and uses it with `baseDeployment.coreImage`, never the Compose files, generation templates, or Core image from a
newer CLI package. It also verifies the local Core image ID before changing containers. This preserves the installed Core
version while allowing a newer CLI to manage compatible Plugins.

Every service in the retained production base bundle and every generated Plugin service uses Compose `restart: "no"`.
The manager rejects another restart policy in the retained production base before accepting or starting it; the Plugin
service template fixes the same policy for generated containers. A Docker daemon or host restart therefore
leaves Atlas stopped until the manager reclaims any dead transaction owner, recovers its journal, verifies retained files
and images, regenerates active files, and starts the composition. `atlas-core supervise` is the recovery-aware long-lived
entry point for an OS service; it may invoke the manager only after the recovery gate. A Linux user service requires
lingering enabled for boot-time operation. A macOS LaunchAgent runs after the user logs in, so it cannot provide
pre-login boot recovery. Compose and Docker must not be installed as a competing auto-start path.

The default `atlas-core start` path requires the recovery-aware supervisor to be installed and active. An operator who
intentionally wants a one-shot start may use `atlas-core start --manual`; the CLI reports that this deployment is running
without automatic recovery and does not imply the supervisor is available.

Schema-4 initialization or upgrade provisions one full-access managed Core API key and stores its one-time value as
`ATLAS_PLUGIN_API_KEY` in the existing owner-only root `.env`. The generated service for an SDK-using Plugin receives that
key as `ATLAS_API_AUTH_KEY` plus the fixed `ATLAS_CORE_ORIGIN=http://api:8000`. A release cannot supply or override either
value. This root platform credential is the one concrete secret schema 1 needs; schema 1 has no per-Plugin setting or
secret lifecycle. Initial provisioning runs inside the root transaction and fsyncs a unique transaction-and-attempt key
name before asking Core to create the key. The host manager invokes `managed-keys` through `docker exec` in the exact
running Core container. That host-only command calls the existing admin domain operations, never bypasses HTTP/CORS, and
does not run database migrations. The resulting one-time secret is staged privately; API-key credentials cannot
administer managed keys.

Fresh initialization first completes the existing MinIO provisioning, pulls and records the exact base image identities,
then records a finish-forward phase and starts the exact retained base composition without Plugin fragments and with
pulling disabled. This creates the PostgreSQL volume, runs the target Core's migrations, and makes the admin API available.
The manager waits for base readiness, creates and authenticates the managed Plugin key, durably writes its secret to
`.env`, commits schema 4, then stops the base composition so `atlas-core init` still returns with Atlas stopped. Once
temporary Core startup begins, recovery never
pretends the deployment is uninitialized or rolls storage backward. It keeps or restarts that same pull-disabled base,
uses the journaled attempt name to revoke an uncertain creation before recording a new attempt, completes provisioning,
and stops the composition. An unrecoverable API, storage, or image failure leaves Atlas stopped with the journal intact;
the explicit destructive reset remains the only abandon path. An upgrade provisions through the already-running Core
inside the Core-update transaction. The manager does not commit schema 4 until the returned secret is durably staged and
authenticated. It owns later rotation as described below. If Core definitively rejects the stored key during an update, the existing transaction creates and verifies a replacement instead of blocking recovery. A malformed stored key follows the same replacement path. Transport failures and server errors remain retryable failures and do not trigger rotation.

`catalog-state.json` is one atomically replaced object. It is catalog trust state, not deployment state: transaction
rollback never restores an older copy or moves its high-water mark backward. The encoded byte fields are abbreviated in
this example:

```json
{
  "schema": 1,
  "sequence": 42,
  "catalog_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "key_epoch": 2,
  "key_id": "atlas-plugin-catalog-2026-01",
  "issued_at": "2026-09-01T16:00:00Z",
  "expires_at": "2026-10-01T16:00:00Z",
  "observed_at": "2026-09-09T12:00:00Z",
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
  "selected": {
    "version": "0.2.0",
    "release_document_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "image_index": "ghcr.io/the-drunken-coder/atlas-building-scan@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "platform_manifest_sha256": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "local_image_id": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "previous": {
    "version": "0.1.0",
    "release_document_sha256": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "image_index": "ghcr.io/the-drunken-coder/atlas-building-scan@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "platform_manifest_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "local_image_id": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  }
}
```

`previous` is `null` before the first successful update. The manager retains only the selected and previous release
documents and their image receipts. Each receipt's image index must equal its immutable release document. The platform
manifest and local image ID are recorded from the verified pull before the selection is committed; neither is inferred
from later Docker state. Release documents never change after installation. Active files are generated and disposable.

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
Core bundle's hash-verified templates, the selected durable image receipt, and root platform credentials. Templates are
fixed declarative package assets; a Plugin release may fill only their documented placeholders and cannot provide or
replace a template. The manager omits `source-connector.json` and its Source Gateway mount when the release declares a
null connector. It atomically replaces any missing, changed, or extra generated file and validates the full Compose model.
Container inspection must match the regenerated receipt before an enable, enabled update, rollback, Core update, or
normal start succeeds.

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

Recovery has an explicit resume policy:

| Durable state | Startup or supervisor behavior | Operator path |
| --- | --- | --- |
| `prepared` or `runtime-changing` | Finish or roll back only after ownership and staged-input checks. | `recover retry` for the exact staged candidate. |
| `core-started` or `credentials-durable` during Core replacement | Leave Atlas stopped; never restore the old Core binary automatically. | `recover retry`, `recover forward <version>`, or paired restore followed by `recover restored --confirm-paired-restore`. |
| `credentials-durable` during standalone key rotation | Finish forward with the new key, revoke the old key, and preserve the durable run intent. | `recover retry`; the old key is not restored. |
| `committed` | Finish cleanup and resume only when the durable run intent says running. | `recover status`; cleanup is manager-owned. |
| `run-intent.json` says stopped | Do not auto-start from `start` or `supervise`. | Explicit `atlas-core start` changes the intent and starts after validation. |

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
atlas-core recover status
atlas-core recover retry
atlas-core recover forward <version>
atlas-core recover restored --confirm-paired-restore
atlas-core supervision [install|uninstall|status]
atlas-core supervise
```

Omitting `version` installs the latest compatible, non-revoked stable release. Install fails when the Plugin is already
Installed; the operator uses update or rollback to change its selected release. `install` never enables implicitly. The
interactive menu may offer a second explicit "Enable now?" confirmation after installation.

Uninstall requires the Plugin to be disabled. It removes installed release records and active deployment metadata but
retains cached Docker layers. Package schema 1 has no separate Plugin configuration lifecycle.

The host manager's managed-key operations run inside the exact running Core container as the host-only executable
`atlas_core managed-keys create <name>`, `atlas_core managed-keys list <name>`, or
`atlas_core managed-keys revoke <key_id>`. The command invokes the existing admin domain operations against the already
initialized database. It does not expose a new HTTP or CORS path, perform migrations, or accept an API key as a
management credential. `create` returns the one-time secret, `list` filters by the exact name, and `revoke` is
idempotent for an absent generated key ID. Operators use `atlas-core plugins rotate-core-key`; the container command is
an implementation detail of that host transaction.

When a transaction remains after its owner dies, `recover status` reports the journal phase, owner identity, and required
operator action without changing containers. `recover retry` retries the same exact staged candidate and is allowed only
when its candidate and durable inputs still match the journal. `recover forward <version>` selects and stages a newly
verified compatible Core version while the deployment is stopped, without the ordinary running-deployment guard. It
does not restore the old Core image. `recover restored --confirm-paired-restore` is an explicit operator attestation
that the paired PostgreSQL and MinIO pre-deploy backup was restored. The manager then compares the prior migration
ledger, retained old image and bundle receipts, and backup identity before it can finish; this check does not itself
perform or prove the backup restore. A pending transaction after the target Core has started never auto-restores the
prior binary. An explicit `atlas-core stop` durably records a stopped `run-intent.json` and overrides automatic resume
from `start` or `supervise`.

`rotate-core-key` replaces only the shared managed key used by SDK-backed Plugins. It is available without a fresh catalog
and uses the root transaction plus the exact running Core container's host-only `managed-keys` command. Before each
key-creation request, the manager writes and fsyncs a unique
`atlas-plugin-key-<transaction_id>-<attempt>` managed-key name in the journal. It never retries a request with an
uncertain result. Recovery lists active keys by that exact name, revokes any match whose one-time secret was not durably
staged, records a fresh attempt name, and only then tries again. After a successful response, the journal records the
candidate key ID but no secret; the candidate secret exists only in the private staged `.env`.

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
CLI also checks the supported package-schema majors and interaction kinds recorded by the installed Core release.
Both capability arrays are required in schema-4 contracts. Package schema 1 permits only the coordinated `map_area`
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

Independent Plugin changes require either a stopped deployment or healthy Core API, Source Gateway, PostgreSQL, and MinIO services. A broken Plugin does not block its own disable or update. If a base service is missing or unhealthy, repair the base deployment before changing Plugins.

Every mutation uses the one root-level `transaction/` directory before it changes files, deployment membership, or
containers. `journal.json` records a transaction ID, operation, Docker engine ID, PID, host boot identity, process-start
identity, prior running status, and phase. `before/` contains the complete previous root state and byte-for-byte copies of
every file that the operation may overwrite or delete, except the monotonic `catalog-state.json` receipt and the durable
`run-intent.json` user intent. `staged/` contains candidate files. The manager fsyncs files and their containing
directories before starting the deployment change.

The local lock file and Docker network lock carry the same transaction and owner identities. On startup, the CLI refuses
to reclaim a live or ambiguous owner. When boot and process-start evidence proves the owner is dead, it atomically
reclaims both matching locks and recovers the transaction before ordinary deployment validation. It never tells an
operator to remove only one lock while a journal exists.
Compose restart policies are disabled, so a daemon restart cannot start either the prior or candidate composition around
this recovery gate.

Recovery for a transaction that did not start a different Core image restores `before/` and the prior running
composition when no durable commit marker exists. Core update recovery follows the storage-aware rules below and never
blindly starts the prior image. After all target health and identity checks pass, the manager writes and fsyncs the
commit marker. Recovery that sees that marker keeps the target state and only finishes cleanup. The manager removes the
transaction directory and fsyncs its parent last. Because the journal sits outside every Plugin subtree, uninstall
cannot erase its own recovery data. Catalog acceptance remains monotonic across a failed deployment transaction: a
rollback may restore deployment files and Plugin selection, but never restores an older catalog receipt or checkpoint.

Install performs these steps:

1. load a fresh signed catalog and verify sequence, expiry, and revocation;
2. fetch the release document and verify its exact hash and strict schema;
3. verify Plugin identity, Semantic Version, lifecycle, contracts, interactions, connector policy, and image repository;
4. pull the exact image digest and record its platform-manifest digest and local image ID;
5. atomically write the immutable release document and `installed.json`, including that durable image receipt.

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
release state, including both durable image receipts. Failure restores the old release, active files, deployment state,
and running composition.

Rollback uses the update transaction with the retained previous release. The catalog must be fresh, and that release
must remain compatible and non-revoked. After success, selected and previous records swap, which permits an explicit
return to the newer release if it also remains permitted. The manager pulls and verifies the retained image against the
previous record when it is missing locally. Rollback of an Enabled Plugin also requires Atlas to be running.

Disable removes the Plugin container, active files, and deployment membership. It retains selected and previous releases
and Docker cache. A running deployment recreates Core and Source Gateway and waits for health. A stopped deployment stays
stopped.

`update all` processes every Installed Plugin in sorted Plugin ID order. Each Plugin is its own transaction. The command
stops at the first failure, reports already updated Plugins, and leaves the failed Plugin on its prior release. It does
not roll back unrelated successful Plugin updates.

## Core update and normal start

A Core update reads enabled Plugins from local `installed.json` files and retained signed release documents, not from a
CLI-embedded catalog. It preflights every Enabled Plugin against the target Core's supported private-major sets, package
schemas, interaction kinds, and Atlas Protocol revision, and blocks the update on any incompatibility. An update of a
stopped deployment temporarily starts the candidate Core for migrations and credential provisioning, then returns to
stopped state according to the durable run intent. An incompatible disabled
Plugin may remain Installed but cannot later be Enabled against that Core.

When an SDK-using Plugin blocks a Core revision change, the operator disables it, updates Core, updates that disabled
Plugin to a release declaring the new revision, then enables it. Atlas does not pretend that one SDK build can use two
exact generated Protocol revisions.

Before `atlas-core update`, export `ATLAS_CORE_BACKUP_DIR` as the absolute path to the validated paired backup directory from the [deployment runbook](../../services/core/docs/DEPLOYMENT_RUNBOOK.md#pre-deploy-backup). The CLI validates its layout and hashes the PostgreSQL dump, MinIO mirror, and companion metadata before starting the update. Keep the pair unchanged. For `recover restored --confirm-paired-restore`, set the variable to that same pair (its directory may have moved). Recovery compares its content hash with the pre-update journal. This check identifies the selected backup; the operator's confirmation still attests that both stores were restored. The CLI does not create or restore backups.

The Core update uses the same durable root transaction and the existing paired-backup confirmation from the deployment
runbook. Before changing containers, its journal records the prior migration version and checksums as well as the prior
image and complete state. It stages the target Core image and base Compose bundle, starts the target with pulling
disabled, and verifies the exact Core container image, base health, every Enabled Plugin container image, runtime
manifest, and health. It commits the Core package version, base bundle hash, image records, supported-major sets, and
Atlas Protocol revision together only after those checks pass.

The first schema-3-to-schema-4 update has an extra engine-locked preflight. The manager identifies the current Core,
Source Gateway, and enabled Plugin containers from the recorded deployment and applies Docker's `restart=no` policy to
each before it stops the legacy Compose project or starts the target. The imported legacy bundle also normalizes its
Compose restart fields to `restart: "no"`. This closes the race where the old `unless-stopped` policy could restart a
legacy container during the transition; the preflight changes container policy only and does not rewrite the live state
or volumes.

If failure occurs before the target Core starts, `recover retry` may restore the prior files and composition automatically.
Once the target Core has started, failure or a pre-commit crash stops the deployment and leaves the journal intact. The
CLI records and inspects the migration ledger, but it never starts the prior Core image automatically. The operator can
use `recover retry` with the same exact staged candidate, or `recover forward <version>` with a newly verified compatible
target while stopped. If migration committed, the target served traffic, or either fact is uncertain, the operator must
restore the paired pre-deploy PostgreSQL and MinIO backup or fix forward. `recover restored --confirm-paired-restore` then
compares the prior migration ledger, retained old image and bundle receipts, and backup
identity before completing; it does not perform or independently prove the restore. This follows the rollback rules in
[`DEPLOYMENT_RUNBOOK.md`](../../services/core/docs/DEPLOYMENT_RUNBOOK.md).

Normal `atlas-core start` acquires the mutation locks, regenerates every Enabled Plugin's complete `active/` directory,
and validates the assembled Compose model before it starts a container. It verifies that the recorded Core and Enabled
Plugin image IDs still exist locally, then uses the retained base bundle with Compose pulling disabled. It inspects every
started container to verify exact image identity and waits only for base Atlas health and readiness before recording the
deployment as started. It does not wait for Plugin manifests or health. Core's retry loop reports each configured Plugin
as `starting`, `available`, or `unavailable` asynchronously, and a Plugin outage never fails base startup. A missing or
changed retained file leaves the deployment stopped and instructs the operator to run `atlas-core start --repair-bundle`.
After a Docker daemon or host restart, this same path is the only supported way to bring Atlas back up.

The bundle-repair form holds the same locks and reads `state.packageVersion` plus the recorded `bundleSha256`. It uses
matching assets from the current CLI package when available; otherwise it downloads the exact public
`atlas-core@<state.packageVersion>` npm archive into a private temporary directory without installing it or executing
package code. Both legacy import and repair limit the compressed archive to 16 MiB, the decompressed tar to 64 MiB,
archive entries to 1,024, and each entry to 8 MiB. They check npm metadata and actual tar headers before extraction.
Repair rejects symlinks, path escapes, missing relative Compose assets, and size-limit violations, builds the
complete candidate `base/`, and requires its deterministic hash to equal the recorded hash. It atomically replaces
`base/`, then performs the normal start without changing the CLI, Core, or Plugin version. npm failure or a hash mismatch
leaves the prior bundle and stopped deployment unchanged. `--repair-bundle` and `--repair-images` may be supplied together.

If an exact recorded image is missing or its local ID no longer matches, normal start remains stopped and instructs the
operator to run `atlas-core start --repair-images`. The repair form holds the same locks and re-pulls only the exact Core
and base-image digests in the retained bundle plus the exact Enabled Plugin digests in selected `installed.json` records.
For each Plugin it requires the release document's index and freshly pulled platform manifest to match that durable
record, verifies the local image ID, atomically refreshes the receipts, then performs the normal pull-disabled start. It
does not read the catalog, select a version, or alter Core or Plugin selection. Registry failure or a receipt mismatch
leaves the deployment stopped and its prior receipts intact. A registry is not required to restart when all recorded
images are still present.

The first independent-release Core update does not migrate enabled bundled-v1 Plugins. If schema-3 state contains an
enabled Plugin without a verified `installed.json`, the update stops without changing the deployment and tells the
operator to disable it with the matching v1 CLI. If a newer CLI was installed directly, the error names the exact
`state.packageVersion` to invoke temporarily for that disable operation. After updating Core, the operator installs and
enables an independent release from the signed catalog. This is an intentional greenfield cutoff rather than a
compatibility bridge.

## Catalog and offline behavior

Opening the Plugins menu checks the catalog once; `refresh` checks again. There is no background updater. A valid cached
catalog may be used until its expiry. Install and update attempt a refresh first, then may use that verified unexpired
receipt if fetching or verification fails. Explicit refresh still reports the failure; a failed receipt write aborts the
operation. Catalog network or signature failure never stops Installed Plugins.

Catalog refresh verifies the new catalog completely, then atomically replaces `catalog-state.json`. The
`(key_epoch, sequence)` pair and catalog hash advance with the cached bytes in that one write, so a crash cannot separate
the usable catalog from its anti-rollback state.

After catalog expiry, install, enable, update, and manual rollback fail closed, including when the release bytes and image
are already cached locally. This is an intentional product constraint: current revocation information takes precedence
over offline availability. Status, logs, disable, uninstall, `rotate-core-key`, Core start, and Core stop continue to work
from local verified state. Core start may therefore restart an already Enabled Plugin, but it does not permit a disabled
Installed Plugin to become Enabled. Automatic rollback inside an already-started update uses the before-state captured
under the fresh catalog that admitted that update, while preserving the newer catalog receipt.

Revoked Installed Plugins appear with the catalog reason and explicit update and disable actions. Atlas never updates,
disables, or uninstalls them without operator approval.


### Recovery completion

A completed file rollback does not complete recovery. The CLI retains the transaction until the restored runtime passes the required checks, and retries those checks after a failed restart. This applies to paired Core restore as well as Plugin changes. Plugin failures in the running CLI and recovery after a process restart use the same manager-owned rollback path.
