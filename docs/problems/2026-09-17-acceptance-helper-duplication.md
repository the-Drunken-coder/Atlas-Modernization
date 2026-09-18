# Acceptance SSE collector bypasses the browser event contract

1. **Time & Date:** 2026-09-17T15:26:09Z
2. **Name:** Moving-assets acceptance parser accepts SSE frames the browser ignores
3. **Issue:** The moving-assets acceptance collector has its own raw `data:` parser. It does not reject named SSE events or validate the decoded object against the `RunEvent` contract, so acceptance can pass while the browser's `EventSource` would ignore or reject the same frame.
4. **Severity:** S4 (Minor)
5. **Location:** `tests/acceptance/simulations/moving-assets.mjs:861-909`; compare `tests/acceptance/simulations/support/sse-response-contract.mjs:22-57`, `simulations/src/client/run-event-stream.ts:24-39`, and `simulations/src/client/run-state.ts:149-175`
6. **Expected:** Every acceptance SSE collector should observe the same browser-visible event stream and reject frames that use a non-`message` event type or contain an invalid `RunEvent` payload.
7. **Actual:** `moving-assets` extracts every `data:` line and returns `JSON.parse(data)` at lines 902-908. It ignores `event:` fields and accepts unknown or structurally incomplete objects. The shared acceptance parser rejects non-`message` events at lines 34-37 and validates the payload at lines 44-57. Production binds only `EventSource.onmessage` and validates each delivered payload with `parseRunEvent` at `simulations/src/client/run-event-stream.ts:24-39`.
8. **Reproduction:**
   1. Make the simulation SSE endpoint emit a valid run-event payload under a named frame such as `event: ignored` (or emit an additional malformed/unknown event alongside the normal frames):
      ```text
      event: ignored
      data: {"sequence":99,"runId":"run-1","timestamp":"2026-09-17T00:00:00.000Z","message":"ignored","type":"log"}
      ```
   2. Run `npm run build:simulations && node tests/acceptance/simulations/moving-assets.mjs` through the normal acceptance stack.
   3. `collectRunEvents` calls the local parser at `moving-assets.mjs:886`; it records the named frame because only its `data:` field is considered. Downstream checks ignore the extra event and can remain green.
   4. The browser client receives no `onmessage` callback for `event: ignored`, while malformed payloads cause `parseRunEvent` to report an invalid event and close the stream.
9. **Notes:**
   - The repository currently has five `waitUntil` definitions with materially different timeout results: `{}`/`{error}` (`browser/commands/commands.mjs:896-904`), `true`/`false` (`browser/geofeatures.mjs:1105-1113`), `undefined` (`browser/map-windows.mjs:823-830` and `browser/smoke.mjs:445-452`), and throw-on-timeout (`simulations/browser.mjs:919-927`). Their current callers either record the observable condition or intentionally inspect the returned error, so no current false-green was demonstrated from that duplication alone.
   - There are eleven `appendJSON` definitions, all currently equivalent JSONL append operations. There are four local abortable `delay` helpers; `node:timers/promises` aliases in three simulation files are intentional API variants. These are maintenance drift risks, not standalone defects.
   - The support parser's independent framing checks are valuable because a fetch reader does not provide the browser `EventSource` semantics. The immediate defect is that `moving-assets` bypasses that check. The smallest repair is to route it through `parseBrowserRunEventFrame`; longer-term structural validation should have one maintained source or an explicit parity test against `parseRunEvent`.
