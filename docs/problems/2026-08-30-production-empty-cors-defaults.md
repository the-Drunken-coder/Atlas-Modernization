# Problem Report

1. **Time & Date:** 2026-08-30T14:54:56Z
2. **Name:** Production Compose turns explicit empty CORS values into hosted defaults
3. **Issue:** The source production Compose file uses `:-` interpolation for `CORS_ORIGINS` and `CORS_ORIGIN_PATTERNS`. Docker Compose therefore substitutes the hosted defaults when an operator intentionally sets either variable to an empty string, making the documented deny-all and environment-owned allowlist behavior unreachable through this launcher.
4. **Severity:** S3 (Moderate)
5. **Location:** `services/core/docker/docker-compose.production.yml:28-29`; comparison: `surfaces/core-cli/assets/docker-compose.yml:24-25`
6. **Expected:** An unset CORS variable may use the source stack's hosted default, but an explicitly empty variable must remain empty. Setting either CORS environment variable must make the environment own the combined allowlist; setting both empty must deny all origins.
7. **Actual:** `CORS_ORIGINS=` renders as `https://atlasinterface.com`, and `CORS_ORIGIN_PATTERNS=` renders as `https://*.atlas-je0.pages.dev`. The resulting Core process therefore allows the hosted origins instead of honoring the explicit empty configuration.
8. **Reproduction:**
   1. From the repository root, render the source stack with safe placeholder values for its other required variables:
      `CORS_ORIGINS= CORS_ORIGIN_PATTERNS= POSTGRES_PASSWORD=postgres-test MINIO_ROOT_USER=minio-test MINIO_ROOT_PASSWORD=minio-password-test API_AUTH_KEY=api-key-test ATLAS_ADMIN_PASSWORD=admin-password-test docker compose -f services/core/docker/docker-compose.production.yml config --format json | jq '.services.api.environment | {CORS_ORIGINS, CORS_ORIGIN_PATTERNS}'`
   2. Observe that the output is `{"CORS_ORIGINS":"https://atlasinterface.com","CORS_ORIGIN_PATTERNS":"https://*.atlas-je0.pages.dev"}` despite both variables being explicitly empty.
   3. Repeat with both variables unset (`env -u CORS_ORIGINS -u CORS_ORIGIN_PATTERNS ...`); the same hosted defaults render, as expected for omission.
   4. Repeat with `CORS_ORIGINS=https://ops.example.test` and `CORS_ORIGIN_PATTERNS=`; the exact origin is preserved but the pattern still renders as the hosted preview default.
   5. Render `surfaces/core-cli/assets/docker-compose.yml` with the same cases and `ATLAS_CORE_IMAGE=example/atlas-core:test`; its `${CORS_ORIGINS-}` and `${CORS_ORIGIN_PATTERNS-}` expressions preserve explicit empty values, demonstrating the intended behavior.
9. **Notes:** Core's contract is documented in `services/core/docs/SECURITY.md:40-42` and implemented by `services/core/internal/config/environment.go:100-125`; focused config tests cover explicit empty values in `services/core/internal/config/cors_test.go`. Replace `:-` with presence-sensitive interpolation or otherwise make the source production stack match the packaged CLI asset, then add Compose rendering coverage for unset, empty, and custom values. No containers were started and no product files were changed during this investigation.
