# Problem Report

1. **Time & Date:** 2026-08-30T14:57:23Z
2. **Name:** Google Maps session request can hold authenticated bootstrap indefinitely
3. **Issue:** When `VITE_GOOGLE_MAPS_API_KEY` is configured, command-interface startup waits for a direct Google Maps `createSession` request without an SDK-owned deadline or abort signal. A request that never completes can therefore prevent the authenticated map workspace from bootstrapping.
4. **Severity:** S3 (Moderate)
5. **Location:** `surfaces/command-interface/src/app/config.ts` (`fetchAppConfig()` at lines 147-151 and `fetchGoogleMapsTileSession()` at lines 262-280); `surfaces/command-interface/src/app/providers.tsx` (`AtlasBootstrap` at lines 43-98)
6. **Expected:** Google session setup should settle within a finite deadline. If Google is unavailable, the application should mark that provider unavailable or show a retryable configuration error while allowing the rest of the authenticated command interface to load.
7. **Actual:** `fetchGoogleMapsTileSession()` calls `fetch()` without `signal` or timeout and catches only rejection. It also awaits `response.json()` without a deadline after headers arrive. `fetchAppConfig()` awaits that helper before returning any config. In `AtlasBootstrap`, `config` is set only when `loadConfig()` resolves and `error` is set only when it rejects; a permanently pending promise leaves the authenticated UI on `Loading configuration...` with no retry or map workspace.
8. **Reproduction:**
   1. Build the command interface with `VITE_GOOGLE_MAPS_API_KEY` set. Authenticate so `AuthGate` mounts `AtlasBootstrap`.
   2. Arrange for `https://tile.googleapis.com/v1/createSession` to either never return a response or return headers with a body that never closes. This can be done safely with the following source-equivalent harness; it performs no network request:

      ```sh
      node --input-type=module -e 'let settled = false; const fetchGoogleMapsTileSession = async (apiKey) => { const response = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" }) }).catch(() => undefined); if (!response) return undefined; if (!response.ok) return undefined; const payload = await response.json().catch(() => undefined); const session = typeof payload?.session === "string" ? payload.session.trim() : ""; return session || undefined; }; globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }), { status: 200, headers: { "Content-Type": "application/json" } }); void fetchGoogleMapsTileSession("google-key").then(() => { settled = true; }, () => { settled = true; }); await new Promise((resolve) => setTimeout(resolve, 40)); console.log(JSON.stringify({ settledAfterMs: 40, settled }));'
      ```

      The harness prints `{"settledAfterMs":40,"settled":false}`. A never-settling `fetch` promise produces the same result. In the application, the unresolved helper keeps `fetchAppConfig()` unresolved, so `AtlasBootstrap` remains on `Loading configuration...` indefinitely.

   3. Existing focused checks pass (`npm test --workspace surfaces/command-interface -- --run src/app/config.test.ts src/app/providers.test.tsx`, 32 tests), but cover rejection and successful JSON only; they do not cover a pending request or pending response body.
9. **Notes:** Add an owned `AbortController` or `AbortSignal.timeout()` around the complete session request, including body consumption. On timeout, treat Google as unavailable and preserve the configured default map source, or surface the existing retryable configuration error. Add focused tests for both a fetch that never settles and a response body that never completes. This is a source trace plus a safe pending-fetch/body harness; no external provider or live deployment was contacted.
