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
