import { isDeepStrictEqual } from "node:util";
import { assessReplayAssertionParity } from "./run-event-replay-contract.mjs";

/**
 * The producer emits each concurrent reader's assertions as it settles. IDs are
 * complete and unique, but their reader-name association is intentionally not
 * fixed. The browser must receive the same mapping from the replay and summary.
 */
export function assessMultiClientAssertions(events, summary, expectedResults) {
  const expectedIDs = expectedResults.map((_, index) => `assert-${index + 1}`);
  const expectedResultSet = orderedNamePassMessageSet(expectedResults);
  const stream = events
    .filter((event) => event.type === "assertion")
    .map((event) => event.assertion);
  const replayParity = assessReplayAssertionParity(events, summary);
  const { streamResults, summaryResults } = replayParity;

  return {
    expectedIDs,
    expectedResultSet,
    replayParity,
    streamResults,
    summaryResults,
    passed:
      hasExactNumericIDSet(streamResults, expectedIDs) &&
      hasExactNumericIDSet(summaryResults, expectedIDs) &&
      isDeepStrictEqual(
        orderedNamePassMessageSet(streamResults),
        expectedResultSet,
      ) &&
      isDeepStrictEqual(
        orderedNamePassMessageSet(summaryResults),
        expectedResultSet,
      ) &&
      replayParity.passed,
  };
}

function hasExactNumericIDSet(assertions, expectedIDs) {
  const ids = assertions.map((assertion) => assertion.id);
  return (
    new Set(ids).size === ids.length && isDeepStrictEqual(ids, expectedIDs)
  );
}

function orderedNamePassMessageSet(assertions) {
  return assertions
    .map((assertion) => ({
      name: assertion.name,
      passed: assertion.passed,
      message: assertion.message,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
