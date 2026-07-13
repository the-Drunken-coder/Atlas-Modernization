# Development API Restart Leaves a Healthy but Uncommandable Core

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** API-only restart clears command catalog without reseeding it
3. **Issue:** Development scratch-mode startup clears resource data, including the embedded command catalog, but an API-container restart does not run the launcher step that republishes the catalog.
4. **Severity:** S3 (Moderate)
5. **Location:** `Atlas_Core/cmd/atlas_core/`, `Atlas_Core/scripts/atlas.py`, `Atlas_Core/docker/docker-compose.yml`, `Atlas_Core/command_catalog/`
6. **Expected:** After a supported development restart, either command submission should be usable or readiness/operator diagnostics should clearly indicate that required catalog seeding has not completed.
7. **Actual:** Restarting only `atlas_core_api` recovered health and readiness in about one second, but scratch mode cleared every entity, task, object, and blob, including `command_catalog`. Admin records and the browser session survived. Core reported healthy even though command submission could not work until `atlas.py` reseeded the catalog.
8. **Reproduction:**
   1. Start the development stack with `python3 Atlas_Core/scripts/atlas.py --dev`
   2. Confirm `GET /objects/command_catalog` succeeds through an authenticated request
   3. Restart only the `atlas_core_api` container
   4. Wait for `/health` and `/readiness` to return `200`
   5. Request `/objects/command_catalog`
   6. Observe `404` until the catalog seeding step is run again
9. **Notes:** The destructive resource reset is the documented development contract; the problem is the healthy-but-incomplete state after an API-only restart. Production durable mode was not affected or modified during the trial.
