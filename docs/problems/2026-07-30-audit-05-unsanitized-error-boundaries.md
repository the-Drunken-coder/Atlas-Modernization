# Error sanitization is incomplete across operator-facing boundaries

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Name:** Error sanitization is incomplete across operator-facing boundaries
3. **Issue:** Connection/bootstrap errors are sanitized, but mutation, SDK/CLI, simulation, HTTP/SSE, and terminal boundaries still expose raw `Error.message` or server `message` text.
4. **Severity:** **S1 (Blocker)** — a server, transport, or callback error can disclose credentials or emit terminal control characters.
5. **Location:** `atlas_command_interface/src/features/MapConsole.tsx`, `atlas_command_interface/src/features/admin/APIKeysPanel.tsx`, `atlas_command_interface/src/ui/map/view/MapView.tsx`, `atlas_sdk/src/http.ts`, `atlas_sdk/src/cli.ts`, `atlas_sdk/src/sync-engine.ts`, `atlas_simulations/src/server`, `atlas_simulations/src/client`
6. **Expected:** Untrusted text is sanitized before it is stored, rendered, logged, or transmitted over HTTP/SSE. HTTP/SSE payloads retain structured status and `error_code` separately from the sanitized message. Redaction covers structured secrets, URL userinfo and sensitive query parameters, Atlas keys, bearer tokens, newlines, terminal controls, and length bounds.
7. **Actual:** Command-interface connection/auth boundaries use `sanitizeConnectionError`, but several mutation/map paths copy raw messages into React state. `AtlasAPIError` incorporates Core's raw message and the CLI prints it. Simulations truncate raw failures but persist, transmit over HTTP/SSE, render, and print the unsanitized text. This was partially confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Run `rg -n 'sanitizeConnectionError|cause instanceof Error \\? cause\\.message|error instanceof Error \\? error\\.message|io\\.stderr\\.write|console\\.error' atlas_command_interface/src atlas_sdk/src atlas_simulations/src`.
   2. Return `{"error_code":"BAD","message":"Authorization: Bearer secret\u001b[31m"}` from a fake non-OK fetch; `HttpTransport` and `runCLI` preserve and print the raw message.
   3. Throw `Error("api_key=atlas_ak_secret")` from a simulation operation; the run store, HTTP/SSE response, browser, and server console retain it.
   4. Reuse one small sanitizer at each trust boundary; tests must prove no canary secret/control sequence crosses any sink while status and `error_code` remain intact.
