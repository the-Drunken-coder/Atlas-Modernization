import type { AssertionResult, CreatedResource, RunEventDetails, RunStatus } from "../shared/types.js";
import type { AtlasClientLike } from "./atlas.js";
import { errorMessage, hasFailedAssertions, lateAssertion } from "./run-store-events.js";
import type { RunRecord } from "./run-store-types.js";
import { createScenarioContext, type Scenario, type ScenarioInput } from "./scenario.js";

type RunExecutionOperations = {
  emit(run: RunRecord, details: RunEventDetails): void;
  assert(run: RunRecord, name: string, passed: boolean, message?: string): AssertionResult;
  track(run: RunRecord, resource: CreatedResource): void;
  trackCleanupCandidate(run: RunRecord, resource: CreatedResource): void;
  finish(run: RunRecord, status: RunStatus, message: string): void;
  prune(): void;
};

export async function executeRun(
  run: RunRecord,
  scenario: Readonly<Scenario>,
  input: ScenarioInput,
  operations: RunExecutionOperations
): Promise<void> {
  let finalStatus: RunStatus = "completed";
  let finalMessage = "Run completed";
  let finalError: string | undefined;
  try {
    const registerClient = (client: AtlasClientLike) => run.clients.push(client);
    const context = createScenarioContext({
      runId: run.id,
      signal: run.controller.signal,
      clientFactory: run.clientFactory,
      registerClient,
      log: (message, data) => {
        if (!run.settled) operations.emit(run, { type: "log", message, data });
      },
      assert: (name, passed, message) =>
        run.settled ? lateAssertion(name, passed, message) : operations.assert(run, name, passed, message),
      track: (resource) => {
        if (!run.settled && !run.cleanupStarted && !run.cleaned) operations.track(run, resource);
      },
      trackCleanupCandidate: (resource) => {
        if (!run.settled && !run.cleanupStarted && !run.cleaned) operations.trackCleanupCandidate(run, resource);
      },
      allowGeneratedTaskIds: !run.target?.deployed
    });
    await scenario.run(context, input);
    if (run.controller.signal.aborted) {
      finalStatus = "cancelled";
      finalMessage = "Run cancelled";
    } else if (run.trackingError) {
      finalStatus = "failed";
      finalMessage = run.trackingError;
      run.lastError = run.trackingError;
    } else if (hasFailedAssertions(run)) {
      finalStatus = "failed";
      finalMessage = "Run completed with failed assertions";
      run.lastError = finalMessage;
    }
  } catch (error) {
    if (run.controller.signal.aborted) {
      finalStatus = "cancelled";
      finalMessage = "Run cancelled";
    } else {
      finalError = errorMessage(error);
      run.lastError = finalError;
      finalStatus = "failed";
      finalMessage = finalError;
    }
  } finally {
    if (!run.controller.signal.aborted) run.controller.abort(new Error("Simulation finished"));
    const outcome = { status: finalStatus, message: finalMessage };
    stopRegisteredClients(run, operations, outcome);
    finalStatus = outcome.status;
    finalMessage = outcome.message;
    run.clients = [];
    run.settled = true;
    if (finalError) operations.emit(run, { type: "error", level: "error", message: finalError });
    operations.finish(run, finalStatus, finalMessage);
    operations.prune();
  }
}

function stopRegisteredClients(
  run: RunRecord,
  operations: RunExecutionOperations,
  outcome: { status: RunStatus; message: string }
): void {
  for (const client of run.clients) {
    try {
      client.sync.stop();
    } catch (error) {
      const message = `Failed to stop client sync: ${errorMessage(error)}`;
      if (outcome.status === "completed") {
        run.lastError = message;
        outcome.status = "failed";
        outcome.message = message;
      } else if (!run.lastError) {
        run.lastError = message;
      }
      operations.emit(run, {
        type: "error",
        level: "error",
        message
      });
    }
  }
}
