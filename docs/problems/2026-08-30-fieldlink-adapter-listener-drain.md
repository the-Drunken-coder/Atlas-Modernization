1. **Time & Date:** 2026-08-30T14:59:19Z
2. **Name:** Adapter process closes before proxy listeners drain
3. **Issue:** `AdapterProcessNode` starts message, passive-message, and event listeners without retaining their promises, so `close()` can report completion while an application or evidence callback is still running.
4. **Severity:** S3 (Moderate)
5. **Location:** `packages/fieldlink/src/adapter-process.ts:856-905,1037-1065`
6. **Expected:** `AdapterProcessNode.close()` should settle registered proxy listener callbacks before reporting that the adapter is closed, or otherwise provide an explicit cancellation/drain guarantee for those callbacks.
7. **Actual:** The reader schedules each callback with `void Promise.resolve().then(...).catch(...)` and does not track the resulting promise. `close()` waits for the child response, stdio, and reader completion only. A child can therefore acknowledge close and exit while a listener remains pending; subsequent evidence or application work can be truncated or race shutdown.
8. **Reproduction:**
   1. Start `AdapterProcessNode` with a cooperative child that emits an `event` after `activate`, acknowledges a `close` request, and exits.
   2. Register `onEvent(async () => { started = true; await release; finished = true; })` where `release` is not called.
   3. Activate the adapter, wait until `started` is true, and call `const closing = adapter.close()`.
   4. Observe that `closing` resolves while `finished` is still false. Releasing the listener afterward allows it to finish after adapter shutdown.
9. **Notes:** A focused Node 24 probe using the existing child-process wire protocol produced `{listenerStarted:true,listenerFinished:false}`, then `{closeState:"closed",listenerFinishedBeforeRelease:false}`, and only became finished after the gate was released. The analogous in-process `FieldLinkNode` tracks message and passive callbacks in `#activeCallbacks` and drains them in `#close()` (`packages/fieldlink/src/node.ts:601-604,1505-1563`), but the adapter proxy has no equivalent callback set. No hardware or external service was needed.
