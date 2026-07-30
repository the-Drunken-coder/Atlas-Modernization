# Audit 17: command-interface config accepts unusable Core base URLs

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Original Audit Number:** 17
3. **Validation Status:** Confirmed against `main` at `2426bb6`.
4. **Name:** Command-interface config accepts unusable Core base URLs
5. **Affected Surface & Severity:** Command-interface startup/authentication and all SDK-backed requests; **S3 (Moderate)** because a bad deployment variable produces misleading connection failures or misrouted requests. No security exploit was reproduced.
6. **Issue:** `parseConfigUrl` tests only that a value has any URL scheme (or starts with `/`) and that the platform `URL` constructor accepts it. It does not require HTTP(S) or reject embedded credentials, query strings, or fragments.
7. **Current vs Expected:**
   - **Current:** Values such as `ftp://core.test`, `javascript:alert(1)`, `https://user:pass@core.test`, `https://core.test/base?tenant=x`, and `https://core.test/base#frag` pass configuration parsing. Authentication and SDK code then concatenate endpoint paths onto the serialized string, producing unsupported fetches or placing endpoint text after a query/fragment instead of in the pathname.
   - **Expected:** The Core base is an HTTP(S) origin/base path with no credentials, query, or fragment. Loopback HTTP remains valid for local development; production policy need not be expanded beyond current requirements.
8. **Concrete Source Evidence:** `atlas_command_interface/src/app/config.ts:20-23,45-53,106-121` accepts any regex-matched scheme and returns `new URL(...).toString()`. The value feeds the pre-auth fetch at `atlas_command_interface/src/auth/ui/AuthGate.tsx:177-181`, admin `HttpTransport` at `atlas_sdk/src/http.ts:41-45,86-92`, and normal SDK data-source construction at `atlas_command_interface/src/atlas/data-source.ts`. The simulations project already has the bounded validation behavior to emulate in `atlas_simulations/src/server/config.ts:157-176`: HTTP(S), HTTPS unless loopback, no credentials, and no query/fragment.
9. **Reproduction / Static Proof:**
   1. Call `coreConfigFromEnv({ VITE_ATLAS_CORE_BASE_URL: value })` for each value above; no exception is thrown.
   2. For `ftp:`/`javascript:`, `AuthGate` attempts `fetch("<serialized-value>/admin/auth/me")`, which browsers reject as unsupported or invalid.
   3. For embedded credentials, browser Fetch rejects credential-bearing request URLs.
   4. For `https://core.test/base?tenant=x`, string concatenation yields `https://core.test/base?tenant=x/admin/auth/me`; `/admin/auth/me` is query data, not the path. A fragment similarly captures the appended endpoint client-side.
10. **Root Cause:** URL syntax validation was mistaken for application-level base-URL validation, and later code builds endpoints by string concatenation rather than a URL-aware join.
11. **Simplest Correct Proposed Solution:** In `parseConfigUrl`, require `http:` or `https:`, reject nonempty `username`, `password`, `search`, and `hash`, retain currently supported relative base paths, normalize trailing slashes, and return the clean URL. Reuse a tiny validation rule, not the simulations configuration subsystem.
12. **Acceptance Criteria / Regression-Test Plan:**
   - Config tests reject ftp/javascript/custom schemes, username-only and username/password URLs, query strings, and fragments with the existing safe generic config error.
   - Tests accept production HTTPS, loopback HTTP, and the currently supported relative base path.
   - Auth and SDK endpoint tests prove the final request pathname is correct for a base path.
   - No test or note claims script execution/XSS; the demonstrated impact remains broken configuration and UX.
13. **Scope / Non-Goals:** Do not add allowlists, tenant-query support, URL rewriting compatibility, or environment-specific knobs. Do not change map-source URL rules.
14. **Overlaps:** Finding 5 covers redaction if credential-bearing URLs enter an error before validation is fixed. This finding is configuration validation only.
