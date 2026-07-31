# Production launcher accepts a destructive volume reset

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Production launcher accepts a destructive volume reset
3. **Issue:** `atlas.py --production --reset-volumes` selects the production Compose project and passes `--volumes`, deleting the durable PostgreSQL and MinIO named volumes before starting the replacement stack.
4. **Severity:** **S1 (Blocker)** — the accepted operator command can erase the database, `admin_records`, migration history, tombstones, deletion outbox, and object bucket.
5. **Location:** `atlas_core/scripts/atlas.py:422-434,452-475,588-621,748-814`, `atlas_core/scripts/test_atlas.py:357-371`, `atlas_core/docker/docker-compose.production.yml:53-86`, `atlas_core/docs/DEPLOYMENT_RUNBOOK.md:270-287`
6. **Expected:** The launcher rejects `--production --reset-volumes` before loading secrets or invoking Docker. Production destruction remains an explicit manual Compose operation accompanied by the runbook warning and backup procedure.
7. **Actual:** Argument validation does not reject production plus reset. `start_containers` forwards both flags to `cleanup_containers`, and `compose_down_command(production=True, remove_volumes=True)` returns `docker compose -f docker-compose.production.yml down --remove-orphans --volumes --rmi local`. This was confirmed against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
8. **Reproduction:**
   1. Run `python3 atlas_core/scripts/test_atlas.py`; all 26 tests pass, including `test_compose_down_command_uses_production_stack_when_requested`.
   2. Inspect `atlas_core/scripts/test_atlas.py:357-371`; the expected production command includes `--volumes`.
   3. Inspect `atlas_core/docker/docker-compose.production.yml:64-65,85-86,119-123`; the selected project owns `postgres_data` and `minio_data`.
   4. Inspect `atlas_core/docs/DEPLOYMENT_RUNBOOK.md:283-287`; the equivalent `down -v` is documented as destructive and not a rollback mechanism.
   5. Fix with one early parser guard for `args.production and args.reset_volumes`; test rejection before any subprocess call while retaining development reset behavior.
