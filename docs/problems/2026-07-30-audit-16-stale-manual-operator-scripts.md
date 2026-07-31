# Manual data scripts are stale, unauthenticated, and report success after failure

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Name:** Manual data scripts are stale, unauthenticated, and report success after failure
3. **Issue:** Two optional mutation scripts omit API credentials, use obsolete task workflows, weakly confirm remote targets, and return process status zero after health or write failures.
4. **Severity:** **S3 (Moderate)** — operators can target writable deployments, fail most or all mutations, and still receive a successful exit status.
5. **Location:** `atlas_core/scripts/test_api_manual.py`, `atlas_core/scripts/seed_random_assets.py`, `atlas_core/docker/.env.example`, `AGENTS.md`
6. **Expected:** Delete the scripts if no current operator requirement exists. Any retained tool authenticates, validates and prominently confirms the exact target, uses current protocol workflows, hides credentials/raw response bodies, and exits nonzero on failure.
7. **Actual:** Requests include no `X-API-Key` or bearer auth. `test_api_manual.py` recognizes only one exact configured URL as remote and uses obsolete raw status changes; both scripts swallow failures and return normally. Repository search found no maintained consumer. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Run `rg -n 'requests\.(get|post|patch)|headers=|X-API-Key|Authorization|in_progress|sys\.exit|return$' atlas_core/scripts/test_api_manual.py atlas_core/scripts/seed_random_assets.py`.
   2. Point either script at a healthy authenticated Core; protected writes return 401, yet neither script supplies credentials.
   3. `seed_random_assets.py` reports `Done: 0/100 created` and exits zero; `test_api_manual.py` also returns zero after health/write failure or cancellation.
   4. Prefer deletion plus reference cleanup; if a current requirement is demonstrated, replace both with one small SDK-backed tool and fake-server tests.
