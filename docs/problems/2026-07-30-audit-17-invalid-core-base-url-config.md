# Command-interface config accepts unusable Core base URLs

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Name:** Command-interface config accepts unusable Core base URLs
3. **Issue:** `parseConfigUrl` accepts any scheme and does not reject credentials, queries, or fragments; consumers then append endpoint strings directly.
4. **Severity:** **S3 (Moderate)** — bad deployment values produce misleading connection failures or misrouted requests; no security exploit was reproduced.
5. **Location:** `atlas_command_interface/src/app/config.ts:20-23,45-53,106-121`, `atlas_command_interface/src/auth/ui/AuthGate.tsx:177-181`, `atlas_sdk/src/http.ts:41-45,86-92`, `atlas_command_interface/src/atlas/data-source.ts`
6. **Expected:** Absolute bases are HTTP(S), contain no credentials/query/fragment, and normalize trailing slashes. Relative bases follow one explicit contract: a root-relative path beginning with `/`, with no query or fragment. All consumers join endpoint pathnames through one URL-aware helper so both absolute and relative bases preserve their base path correctly.
7. **Actual:** `ftp:`, `javascript:`, credential-bearing, query-bearing, and fragment-bearing values pass parsing. String concatenation can place endpoint text inside a query or fragment and does not define reliable relative-base behavior. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Pass `ftp://core.test`, `javascript:alert(1)`, `https://user:pass@core.test`, `https://core.test/base?tenant=x`, and `https://core.test/base#frag` to `coreConfigFromEnv`; none throws.
   2. Concatenating `/admin/auth/me` to the query example yields `https://core.test/base?tenant=x/admin/auth/me`, where the endpoint is query data.
   3. Add config tests for rejected schemes/userinfo/query/fragment and accepted HTTPS, loopback HTTP, and root-relative base paths; add request tests proving URL-aware joining preserves the intended pathname.
