import { isDeepStrictEqual } from "node:util";

/**
 * The producer emits each concurrent reader's assertions as it settles. IDs are
 * complete and unique, but their reader-name association is intentionally not
 * fixed. The browser must receive the same mapping from the replay and summary.
 */
export function assessMultiClientAssertions(stream, summary, expectedNames) {
  const expectedIDs = expectedNames.map((_, index) => `assert-${index + 1}`);
  const expectedNamePassSet = orderedNamePassSet(
    expectedNames.map((name) => ({ name, passed: true })),
  );
  const streamResults = orderedAssertionResults(stream);
  const summaryResults = orderedAssertionResults(summary);

  return {
    expectedIDs,
    expectedNamePassSet,
    streamResults,
    summaryResults,
    passed:
      hasExactNumericIDSet(streamResults, expectedIDs) &&
      hasExactNumericIDSet(summaryResults, expectedIDs) &&
      isDeepStrictEqual(orderedNamePassSet(streamResults), expectedNamePassSet) &&
      isDeepStrictEqual(orderedNamePassSet(summaryResults), expectedNamePassSet) &&
      isDeepStrictEqual(summaryResults, streamResults),
  };
}

function hasExactNumericIDSet(assertions, expectedIDs) {
  const ids = assertions.map((assertion) => assertion.id);
  return (
    new Set(ids).size === ids.length &&
    isDeepStrictEqual(ids, expectedIDs)
  );
}

function orderedNamePassSet(assertions) {
  return assertions
    .map((assertion) => ({ name: assertion.name, passed: assertion.passed }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function orderedAssertionResults(assertions) {
  return assertions
    .map((assertion) => ({
      id: assertion?.id,
      name: assertion?.name,
      passed: assertion?.passed,
    }))
    .sort((left, right) => assertionSequence(left.id) - assertionSequence(right.id));
}

function assertionSequence(id) {
  const match = /^assert-([1-9]\d*)$/u.exec(id ?? "");
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
