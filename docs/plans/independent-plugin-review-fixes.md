# Independent Plugin review fixes

Reviewed baseline: `719b7ac59c144dcee824cc55f24264ebdf49b772`.
Scope: confirmed defects from the independent reviews, verified against source and isolated reproductions. No release, deployment, PR, or push is part of this repair.

| Area | Fix and acceptance check | Status |
| --- | --- | --- |
| Catalog persistence | Bound encoded receipts for the full 4 MiB catalog; signed maximum-size refresh/read/refresh round trip retains anti-rollback history. | complete |
| Plugin transactions | Preserve PostgreSQL/MinIO; remove disabled containers before removing active files; recreate only affected services; wait for readiness and public discovery; restore the prior selection/runtime on failure. | complete |
| Interrupted Plugin recovery | Restore active files before composing; retry runtime restoration after file rollback; retain the journal on failure and preserve storage while running. | complete |
| Null connectors | Omit the fragment-directory setting when no connector mount exists; verify generated composition for null and mixed connectors. | complete |
| Startup and repair | Inspect enabled running container identities without gating ordinary start on Plugin health; repair only base and enabled selected images. | complete |
| Reset and locking | Persist running intent when reset starts; never advise deleting one deployment lock while recovery may be pending. | complete |
| Credentials | Stopped rotation uses the base composition only and never starts SDK Plugins, including recovery; document the actual attempt-name prefix. | complete |
| Core recovery | Record a content identity for the validated paired backup before Core update; require that same pair on restored recovery, in addition to attestation and ledger/image checks. Preserve the normal-start versus update-health distinction. | complete |
| Publication | Strict string connector origins; matching unknown-route body contract; anonymous bounded public artifact checks; reasonable bounded Pages propagation retries. | complete |
| Integrated verification | Focused tests, CLI format/lint/typecheck/tests/build/packed install, release tests, workflow validation, independent final review. | complete |

The backup input uses `ATLAS_CORE_BACKUP_DIR` and the existing deployment runbook's paired backup layout. A content identity binds the selected artifacts to the pre-update journal; it does not prove the operator restored them. No backup is created or restored automatically.

Rejected claims are not implementation work: candidate enumeration already selects the greatest compatible release; `queue: max` is supported; ordinary fast-forward catalog pushes fail safely on divergent heads; native Windows and GitHub Enterprise portability are outside this first-party contract. No inferred BuildKit credential-cache behavior or arbitrary epoch-chain requirement is added.

The fresh integration review confirmed two additional recovery defects in `application.ts`: interrupted disable could fail before restoring deleted active files, and a runtime restore failure left `rollback-complete` journals that were cleaned up without retry. The dedicated Plugin recovery path now restores files first, recreates the affected services with `--no-deps`, and verifies runtime and public discovery before removing the journal.

Verification is local and uses fake Docker runners, signed fixtures, bounded HTTP fixtures, and package installation checks. No live deployment, destructive reset, public release, or registry publication is exercised.

## Evidence ledger

| Severity | Location | Confirmed trigger and failure | Verification |
| --- | --- | --- | --- |
| High | `surfaces/core-cli/src/application.ts:1385` | Disable interrupted after active-file removal could not build Compose to recover; a failed runtime restore could then be skipped after file rollback. | Fresh runtime reviewer confirmed both; recovery tests restore files before Compose and retain the journal across a failed restart. Reviewer rechecked the fix. |
| High | `surfaces/core-cli/src/independent-plugins.ts:199` | Running Plugin changes stopped the whole project and accepted services before readiness. | Scoped Compose tests require readiness waits and `--no-deps`; public discovery tests reject missing, duplicate, unavailable, and changed entries. |
| High | `surfaces/core-cli/src/managed-core.ts:220` | Restored recovery had no wired backup identity to compare with the pre-update pair. | Backup and recovery tests cover required artifacts, deterministic content identity, and mismatch rejection. Fresh recovery reviewer found no further defect. |
| Medium | `surfaces/core-cli/src/plugin-catalog-store.ts:37` | A valid near-4 MiB catalog produced a persisted receipt larger than its read limit. | Signed maximum-size refresh/read/refresh passes and older sequences remain rejected. |
| Medium | `surfaces/core-cli/src/independent-plugins.ts:1099` | Null connectors configured a fragment directory with no mount, causing startup failure. | Generated composition tests cover null and mixed connectors. |
| Medium | `surfaces/core-cli/src/application.ts:1089` | Image repair pulled disabled and previous images; ordinary start skipped enabled container identity checks; reset retained stopped intent. | Adapter regressions check selected/enabled repairs, mismatched Plugin container identity, and persisted reset intent. |
| Medium | `surfaces/core-cli/src/host-credentials.ts` | Stopped credential rotation/recovery started SDK Plugins unnecessarily. | Stopped and original-running recovery tests verify the base composition contract. |
| Medium | `scripts/plugin-release.mjs:258` | Publisher accepted malformed connector origins and weaker runtime responses, while authenticated downloads did not prove public availability. | Publisher tests cover exact candidate contract, anonymous canonical release URLs, redirects, body bounds, and matching bytes. |
| Medium | `scripts/plugin-release-catalog.mjs:444` | Short retries and mixed CDN generations could reject successful Pages publication. | Tests cover both mixed catalog/signature generations; bounded retries accept only the exact validated pair. Fresh recovery reviewer independently confirmed the original defect. |
| Low | `surfaces/core-cli/src/application.ts` | Lock errors advised deleting one lock despite possible pending recovery. | Stale-lock regression checks the recovery guidance and preserved lock. |

Coverage includes persistence/trust, runtime contracts, transaction/crash recovery, credentials, image identity, backup recovery, packaging, and publication. Historical compatibility with journals from the unreleased implementation that already stopped all storage services is outside this greenfield repair.

## Final validation

- Node 24 `npm run check --workspace atlas-core`: passed; 389 tests in 17 files, formatting, lint, typecheck, build, and packed-install check.
- `node --test .github/scripts/atlas-core-release.test.mjs scripts/plugin-release*.test.mjs`: 34 tests passed.
- Release workflow YAML and Actionlint passed. Actionlint 1.7.11 needed its known `queue` schema warning excluded; no other diagnostics were suppressed.
- `git diff --check`: passed.
- Fresh runtime and recovery/publication reviews completed; confirmed follow-up findings were fixed and rechecked.
- Validated repair targets `codex/implement-independent-plugins` on baseline `719b7ac59c144dcee824cc55f24264ebdf49b772`.

## ChatGPT Extra High review

Review: https://chatgpt.com/c/6aa33b97-93c4-83ea-81b5-4bd8e00a97d2

Reviewed PR #339 at `108c19c1c8dbff688fe0a4752e66f8008bbe9a17`; the live head matched before verification. The completed review returned nine claims. This repair remains local and does not push, comment on, resolve, or merge the PR.

| Claim | Disposition | Evidence and correction |
| --- | --- | --- |
| Catalog jumps can rewrite observed releases or undo revocations | fixed | Every newer checkpoint must preserve previously observed release identities and revocations; skipped generations remain supported. |
| Catalog renewal cannot rotate to the next trusted key epoch | fixed | Next-epoch renewal preserves the ledger and prior hash, signs with the new key, and uses its configured sequence floor. |
| Existing release tags can point to a different source commit | fixed | Verify the remote tag's peeled commit before version-image promotion and again before release creation or reuse; missing tags are explicitly created at the source SHA. |
| Plugin mutations proceed with degraded base services | fixed | Adapter checks required base health before lifecycle mutation. Stopped deployments and unhealthy target Plugins remain supported. |
| Invalid stored credentials wedge pending Core recovery | fixed | Definitive HTTP 401/403 rejection and malformed local keys trigger journaled replacement in the existing transaction; transport/server failures remain retryable. |
| Restored recovery must prove the live MinIO volume was restored | rejected | MANAGEMENT.md explicitly requires operator-confirmed paired restore and says the backup identity does not independently prove it. Adding live attestation changes the approved contract; a copied receipt alone would not prove all live objects match. |
| Unattended start accepts an inactive supervisor | fixed | Both macOS and Linux tests reproduce the old acceptance. Start now requires a running supervisor and available user manager unless manual mode is selected. |
| Connector retry idempotency header need not be allowed | fixed | Publisher and host now match the Go gateway's normalized allowed-request-header requirement. Tests reject omitted headers and accept case-normalized inclusion. |
| Publisher accepts more operations than host runtime allows | fixed | Candidate acceptance enforces the host's 128-operation maximum, with boundary tests. |

Validation on the repaired worktree:

- `node --test .github/scripts/atlas-core-release.test.mjs scripts/plugin-release*.test.mjs`: 42 tests passed after the final publisher fix.
- `git diff --check`: passed.
- Node 24 `npm run check --workspace atlas-core`: passed, including 397 tests across 17 files, formatting, lint, typecheck, build, and packed-install check.
- Release workflow Actionlint passed with only the known unsupported `concurrency.queue` schema diagnostic excluded.
- Fresh independent runtime/credential review passed; the publication recheck caught the missing publisher half of the header check, which was then added with focused rejection and normalization tests. The final independent publication recheck passed with no remaining finding.
- The PR head still matched `108c19c1c8dbff688fe0a4752e66f8008bbe9a17` after implementation. Existing GitHub CI failures are not cleared by these local checks.
- Local changes are uncommitted and unpushed.


## Thermos follow-up

The combined correctness and maintainability review identified three scoped changes:

- Core rollback must retain its journal until prior-runtime startup and verification succeed. Paired-restore recovery and pre-start rollback now resume through one completion path, including retries after failure.
- Catalog append and release generation must enforce the same release contract. Both now use `scripts/plugin-release-validation.mjs`; malformed connector input fails before changing the signed ledger.
- Plugin exception handling and crash recovery must have one owner. `IndependentPluginManager.recover` now restores files, reconstructs affected services, verifies the restored runtime, and cleans up only after success. `application.ts` delegates Plugin recovery and routes unfinished Core rollback to the Core manager. The duplicated per-operation restore callbacks and runtime-change flag are removed.

The recovery changes preserve cancellation-resistant compensation and stopped run intent. Broader application decomposition is limited here to removing duplicated recovery ownership; legacy migration behavior remains documented and supported.

The PR update also corrects the observed workflow quoting diagnostics, the Go test's redundant embedded-field selector, and the CI registry digest lookup that incorrectly used HTTP against its TLS-only registry. Rebased onto `331ac6c535eb0b37aad71e9db1a53d2659a9edb9`, preserving the retirement of FieldLink and its dependency update.

Final validation:

- Node 24 `npm run check --workspace atlas-core`: 399 tests in 17 files, formatting, lint, typecheck, build, and packed installation passed.
- Core and Plugin release script tests: 42 passed.
- Workflow lint passed with ShellCheck enabled and only the known unsupported `concurrency.queue` schema diagnostic excluded.
- `go test ./internal/plugins`: passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- Ignore checks and `git diff --check`: passed.
- Independent Plugin recovery recheck: no confirmed defects.

These checks do not exercise the Docker acceptance job against a live registry locally; that remains a GitHub CI check. The earlier local-only status above records the preceding review pass. This follow-up is authorized for commit, push, and updating PR #339.


## Latest-commit Codex review follow-up

Codex reviewed `f44a8353779abbb26d62509f9dbd4801e97ea41b` after an explicit review request and reported four confirmed defects:

- Forward recovery retained staged files removed by the replacement Core bundle. The replacement now prunes stale staged base entries before applying and committing the bundle.
- Removing an old catalog signing key blocked refresh from a cached receipt using that key. Refresh can now accept a catalog signed by a strictly newer trusted epoch, preserving the local clock floor and embedded checkpoint checks.
- A publication retry rebuilt an image even after its version digest had been promoted. The workflow now reuses the promoted digest, verifies the source tag, and validates any existing release document against the reviewed metadata before resuming publication.
- Bundle repair used the installed CLI's assets even when Core retained an older package version. Repair now fetches the exact recorded npm package as data, checks its version and image, and requires the candidate bundle hash to match before replacement.

Focused tests cover removed-file recovery followed by startup, retired-key and lower-epoch replay rejection, publication retry states, and repairing a damaged bundle after a CLI upgrade. No merge is authorized by this follow-up.


Codex's next review of `6ee771948ebbe81ac95df397bdd73654987c5a20` identified seven further cases. Restart now refuses a stopped deployment so operators use the supervised or explicit manual start path. Supervisor status verifies the installed and loaded definition targets the selected deployment and CLI. Core updates journal temporary PostgreSQL startup before reading the migration ledger. Publication compares reused documents byte for byte, and both release and catalog validation enforce the CLI's UTF-8 string limits. Legacy import and repair enforce archive, decompression, entry-count, and per-entry size limits before extraction. The generated CLI Protocol revision is also refreshed after the rebase onto movement-history main.


The review of `3716bdc0b2dbb610664b1b318a0fd05df9d86f4f` confirmed four remaining boundaries: publication must reject serialized release documents above 1 MiB and catalogs above 4 MiB before writing or publishing them; a running Core update must check existing Enabled Plugin health before beginning its transaction; and install/update may use a verified unexpired catalog when refresh fails. The fixes preserve explicit refresh errors, fail closed after cache expiry, and keep the post-update Plugin health gate.

Codex review of `2f7f0688` found two further runtime defects: Plugin removal used the base MinIO service label, and automatic rollback required a previously unhealthy Plugin to become healthy. Removal now checks the actual Plugin service label with the existing project and engine ownership checks. Transactions retain prior Plugin health, allowing recovery of an already-unavailable Plugin while preserving base readiness and exact image verification.

Codex review of `4ba79e07` found two crash gaps and four validation/menu defects. Automatic recovery now stops an interrupted target before requiring an explicit recovery decision. Legacy import disables live restart policies while its journal is present, before committing imported state. Candidate acceptance checks JSON response media types; status rejects unknown IDs. The Plugins menu refreshes its catalog when opened or refreshed and permits actions on Installed independent Plugins.
