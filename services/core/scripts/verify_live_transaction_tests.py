#!/usr/bin/env python3
"""Build the live test selector and verify that every selected test passed."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


EXPECTED = {
    "github.com/the-drunken-coder/atlas/services/core/internal/testenv": {
        "TestIsolatedDatabaseSchemasDoNotShareData",
        "TestIsolatedDatabaseSchemaIsDroppedAtTestCleanup",
    },
    "github.com/the-drunken-coder/atlas/services/core/internal/actions": {
        "TestTaskLifecycleIdempotencyOrderingAndRuntimeFencing",
        "TestRuntimeManifestEventsCarryReasonAndEntityUpdatesDoNot",
        "TestDeliverableHoldsRuntimeFenceDuringTaskSelection",
        "TestRuntimeStopFailsEveryNonterminalStateAndIsIdempotent",
        "TestRuntimeStopIgnoresMissingAndStaleRuntimeIDs",
        "TestRuntimeRegistrationCannotReactivateRetiredRuntimeIDs",
        "TestRuntimeTaskDrainsUseCommittedBatches",
        "TestTerminalLifecycleOperationsReplayExactlyAfterRuntimeReplacement",
        "TestConcurrentTaskCreateIdempotency",
        "TestEntityMutationAndDeletionRespectTaskingBoundary",
        "TestDeliverableRejectsStoredUnknownCommand",
        "TestTaskCompletionPreservesExplicitNullOutput",
        "TestImmediateTimeoutReconciliationCommitsBoundedBatches",
        "TestCreateDeleteAndUniqueValueRacesDoNotDeadlock",
        "TestVersionedMutationsWaitForClockBeforeResourceRows",
    },
    "github.com/the-drunken-coder/atlas/services/core/internal/api/handlers": {
        "TestFeedReadsCommittedEventsWithoutRejectedWriteGaps",
        "TestTaskLifecycleRoutesWithFixtureCommands",
    },
}


def selection_pattern() -> str:
    names = sorted({name for tests in EXPECTED.values() for name in tests})
    return "^(" + "|".join(re.escape(name) for name in names) + ")$"


def verify(path: Path) -> list[str]:
    if not path.is_file():
        return [f"live test event log not found: {path}"]
    passed: set[tuple[str, str]] = set()
    skipped: set[tuple[str, str]] = set()
    malformed: list[str] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            malformed.append(f"malformed JSON event on line {line_number}")
            continue
        package = event.get("Package")
        test = event.get("Test")
        action = event.get("Action")
        if not isinstance(package, str) or not isinstance(test, str) or "/" in test:
            continue
        key = (package, test)
        if action == "pass":
            passed.add(key)
        elif action == "skip":
            skipped.add(key)

    errors = malformed
    for package, tests in EXPECTED.items():
        for test in sorted(tests):
            key = (package, test)
            if key in skipped:
                errors.append(f"selected live test skipped: {package} {test}")
            elif key not in passed:
                errors.append(f"selected live test did not pass: {package} {test}")
    return errors


def main(arguments: list[str] | None = None) -> int:
    args = sys.argv[1:] if arguments is None else arguments
    if args == ["pattern"]:
        print(selection_pattern())
        return 0
    if len(args) != 2 or args[0] != "verify":
        print("usage: verify_live_transaction_tests.py pattern | verify LIVE_JSON_LOG", file=sys.stderr)
        return 2
    errors = verify(Path(args[1]))
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    count = sum(len(tests) for tests in EXPECTED.values())
    print(f"verified {count} selected live tests passed without skips")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
