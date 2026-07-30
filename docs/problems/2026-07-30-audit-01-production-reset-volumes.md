# Production launcher accepts a destructive volume reset

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Production launcher accepts a destructive volume reset
3. **Original Audit Finding:** 1
4. **Validation Status:** Confirmed against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
5. **Issue:** `atlas.py --production --reset-volumes` selects the production Compose project and passes `--volumes`, deleting the durable PostgreSQL and MinIO named volumes before starting the replacement stack.
6. **Affected Surface & Severity:** Atlas Core production launcher and all durable production data; **S1 (Blocker)** because the accepted operator command can erase the database, `admin_records`, migration history, tombstones, deletion outbox, and object bucket.
7. **Location:** `atlas_core/scripts/atlas.py:422-434`, `atlas_core/scripts/atlas.py:452-475`, `atlas_core/scripts/atlas.py:588-621`, `atlas_core/scripts/atlas.py:748-814`, `atlas_core/scripts/test_atlas.py:357-371`, `atlas_core/docker/docker-compose.production.yml:53-86`, and `atlas_core/docs/DEPLOYMENT_RUNBOOK.md:270-287`.
8. **Expected:** The launcher rejects `--production --reset-volumes` before loading secrets or invoking Docker. Production destruction, if ever needed, remains an explicit manual Compose operation accompanied by the runbook warning and backup procedure.
9. **Actual:** Argument validation rejects several incompatible combinations but not production plus reset. `start_containers` forwards both flags to `cleanup_containers`, and `compose_down_command(production=True, remove_volumes=True)` returns `docker compose -f docker-compose.production.yml down --remove-orphans --volumes --rmi local`. The committed unit test explicitly expects that destructive command.
10. **Concrete Evidence / Reproduction:**
    1. Run `python3 atlas_core/scripts/test_atlas.py`; all 26 tests pass, including `test_compose_down_command_uses_production_stack_when_requested`.
    2. Inspect `atlas_core/scripts/test_atlas.py:357-371`; the expected production command includes `--volumes`.
    3. Inspect `atlas_core/docker/docker-compose.production.yml:64-65,85-86,119-123`; the selected project owns `postgres_data` and `minio_data`.
    4. Inspect `atlas_core/docs/DEPLOYMENT_RUNBOOK.md:283-287`; the project already documents that the equivalent `down -v` destroys production data and is not a rollback mechanism.
    5. No destructive Docker command was run during validation.
11. **Root Cause:** `--reset-volumes` is a deployment-mode-independent boolean. The parser forwards it to a generic cleanup command even though the flag is only a development recovery operation.
12. **Simplest Correct Proposed Solution:** Add one early parser guard rejecting `args.production and args.reset_volumes`, with a message that production volumes must be handled manually through the backup-aware runbook. Keep the existing development reset behavior unchanged.
13. **Acceptance Criteria / Regression-Test Plan:**
    1. A launcher unit test proves `--production --reset-volumes` exits nonzero before `start_containers` or any subprocess call.
    2. `--production --tunnel --reset-volumes` is rejected by the same guard.
    3. `--dev --reset-volumes` and non-production `--reset-volumes` retain their current behavior.
    4. `compose_down_command(production=True, remove_volumes=False)` remains the normal production cleanup command.
14. **Scope / Non-Goals:** Do not remove the runbook's explicit manual destruction command, rename Compose volumes, add interactive confirmation, or change development scratch/reset behavior. A confirmation prompt is weaker than rejecting the dangerous launcher combination.
15. **Overlaps:** Finding 6 also concerns durable object storage, but this finding is operator-triggered whole-volume destruction rather than upload-time blob/metadata atomicity. Finding 15 concerns production launcher/Compose credential wiring.
