# Audit 16: manual data scripts are stale, unauthenticated, and report success after failure

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Original Audit Number:** 16
3. **Validation Status:** Confirmed against `main` at `2426bb6`.
4. **Name:** Manual data scripts are stale, unauthenticated, and report success after failure
5. **Affected Surface & Severity:** `atlas_core/scripts/test_api_manual.py` and `atlas_core/scripts/seed_random_assets.py`; **S3 (Moderate)** for operators because these optional scripts can target writable deployments, fail most/all mutations, and still exit successfully.
6. **Issue:** Both scripts call protected Core endpoints without an API key. The larger manual script also contains obsolete task status/workflow assumptions and weak remote confirmation. Both use bare `return` from `main`, so health or bulk-operation failure exits with process status zero.
7. **Current vs Expected:**
   - **Current:** Requests use no `X-API-Key`/bearer auth. `test_api_manual.py` accepts an arbitrary prompted URL, identifies only the exact configured tunnel URL as remote unless `--remote` is set, asks only for literal `yes`, catches per-request failures, and completes without a nonzero exit. It creates/patches tasks with raw status fields, including `in_progress`, instead of the current acknowledged/status/complete/fail workflow. `seed_random_assets.py` defaults local but accepts any `ATLAS_CORE_API_URL`, performs 100 writes without confirmation/auth, and prints `Done: N/100` before returning success even when `N` is zero.
   - **Expected:** A currently required operator tool authenticates, validates and prominently confirms the exact target, uses current protocol/API workflows, and exits nonzero on health/validation/write failure. If there is no current requirement, stale mutation scripts should not ship.
8. **Concrete Source Evidence:**
   - Authentication is absent from all request calls in `atlas_core/scripts/test_api_manual.py:52-245` and `seed_random_assets.py:16-73`, while Core accepts credentials through `X-API-Key` or bearer auth in `atlas_core/internal/api/middleware/middleware.go:238-250`.
   - Manual remote confirmation and exact-URL detection are at `test_api_manual.py:35-49,389-414`; any other remote URL entered interactively bypasses the confirmation unless it exactly equals `remote_api_url`.
   - Raw create forms are at `test_api_manual.py:65-169`; task status mutation is at lines 223-245; the seeded workflow includes `in_progress` later in `main`. Current dedicated task transitions are exposed in `atlas_core/internal/api/handlers/handler_task.go:120-218`.
   - Failure swallowing is visible in `test_api_manual.py:83-96,115-128,157-169,405-408` and its final `main()` call, and in `seed_random_assets.py:47-52,61-73,78-79`.
   - Repository search finds no consumer or documented current workflow for either script beyond the AGENTS warning that `test_api_manual.py` is an optional operator script and `atlas_core/docker/.env.example` carrying its remote URL override.
9. **Reproduction / Static Proof:**
   1. Run `rg -n 'requests\\.(get|post|patch)|headers=|X-API-Key|Authorization|in_progress|sys\\.exit|return$' atlas_core/scripts/test_api_manual.py atlas_core/scripts/seed_random_assets.py`.
   2. Point either script at a healthy Core that requires API authentication. Health succeeds; every protected write returns 401; neither script supplies credentials.
   3. For `seed_random_assets.py`, all 100 failures lead to `Done: 0/100 created` and normal process exit. An unreachable/failed health check also returns normally.
   4. For `test_api_manual.py`, decline confirmation or fail health/individual writes; `main` returns and the module exits zero. Enter a non-configured remote URL without `--remote`; the exact-equality remote check does not prompt.
10. **Root Cause:** These ad hoc scripts predate mandatory API auth and the current task workflow, and error reporting was designed for interactive observation rather than automation/operator safety. No maintained requirement or regression tests keep them aligned.
11. **Simplest Correct Proposed Solution:** Delete both scripts and remove their stale `.env.example`/AGENTS references unless the developer identifies a current operator requirement. If one is required, replace it with one small SDK-backed tool that uses current auth and task actions, exact target confirmation, and meaningful exit codes; do not repair two overlapping Python clients.
12. **Acceptance Criteria / Regression-Test Plan:**
   - Preferred deletion path: no references remain, launcher unit discovery stays correct, and existing supported SDK/integration seeding paths are documented if needed.
   - Retention path: fake-server tests assert auth headers, current request shapes/transitions, exact displayed target confirmation for every non-loopback URL, cancellation without mutation, and nonzero exit for health/write/verification failure.
   - No tool prints credential values or raw remote response bodies.
13. **Scope / Non-Goals:** Do not change Core auth policy, loosen protected endpoints, or build a general fixture framework without a demonstrated requirement. Do not keep obsolete forms for compatibility; the project has no users/data requiring them.
14. **Overlaps:** Finding 5 covers raw errors/secrets reaching terminals generally; deleting these scripts removes their raw `resp.text` sinks. Finding 8 owns protocol/Core request-shape drift in production, while this note is limited to operator scripts.
