# Problem Report

1. **Time & Date:** 2026-08-30T15:00:40Z
2. **Name:** FieldLink node close does not drain event listeners
3. **Issue:** `FieldLinkNode` tracks message and passive-message listener promises during shutdown, but `onEvent` callbacks are launched without tracking. `close()` can therefore report completion while an event listener is still performing persistence, telemetry, or other application work.
4. **Severity:** S4 (Minor)
5. **Location:** `packages/fieldlink/src/node.ts` (`FieldLinkNode.#close()` at lines 601-609, `#emit()` at lines 1644-1650, and callback tracking at lines 1628-1634)
6. **Expected:** `FieldLinkNode.close()` should settle every registered asynchronous listener callback that has already been started before reporting that the node is closed, or explicitly provide a cancellation/drain guarantee for event listeners.
7. **Actual:** `#close()` waits for `#activeReceives`, `#activeCallbacks`, and `#backgroundCleanup`, but `#emit()` invokes each event listener with `void Promise.resolve().then(() => listener(event)).catch(...)` and never adds that promise to `#activeCallbacks`. An event listener can remain pending after `close()` resolves, and an event persistence write can consequently race transport/evidence shutdown.
8. **Reproduction:**
   1. From the repository root, run this in-memory probe; it injects a complete Test frame and uses no radio or external service:

      ```sh
      node --import tsx --input-type=module --eval 'import { FieldLinkNode, parseNodeId } from "./packages/fieldlink/src/node.ts"; import { testMessage } from "./packages/fieldlink/src/messages/test.ts"; import { encodeFrame, FrameKind } from "./packages/fieldlink/src/frame.ts"; const nodeId = parseNodeId("bbbbbbbbbbbbbbbb"); const source = parseNodeId("aaaaaaaaaaaaaaaa"); let listeners = []; const transport = { send: async () => {}, getQueueLength: async () => 0, onDatagram: (listener) => { listeners.push(listener); return () => { listeners = listeners.filter((entry) => entry !== listener); }; }, close: async () => {} }; const node = new FieldLinkNode({ nodeId, transport }); let startedResolve; const started = new Promise((resolve) => { startedResolve = resolve; }); let releaseResolve; const released = new Promise((resolve) => { releaseResolve = resolve; }); let finished = false; node.onEvent(async (event) => { if (event.type === "message-received") { startedResolve(); await released; finished = true; } }); const bytes = encodeFrame({ transmissionId: 1, kind: FrameKind.complete, source, destination: nodeId, logicalId: 72n, messageType: 1, body: testMessage.encode({ type: "test", kind: "response", correlationId: 1, payload: new Uint8Array() }) }); await listeners[0]({ bytes }); await started; const closing = node.close(); await closing; console.log(JSON.stringify({ closeResolvedBeforeEventListener: !finished })); releaseResolve();'
      ```

   2. Observe `{"closeResolvedBeforeEventListener":true}`. `close()` resolves while the `onEvent` callback is still blocked on `released`; releasing the gate afterward lets the callback finish after node shutdown.
   3. The existing `packages/fieldlink/tests/node.test.ts` close test at lines 1554-1599 verifies that an accepted async `onMessage` listener is drained, but it does not exercise an async `onEvent` listener.
9. **Notes:** The defect is a source trace plus the focused in-memory reproduction above. The smallest repair is to pass event listener promises through the same `#trackCallback` path used by `#deliverMessage()` and `#deliverPassiveMessage()`, then add a close test with a gated async `onEvent` callback. No product or test files were changed beyond this problem report.
