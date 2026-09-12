#!/usr/bin/env python3
"""Build the storage recovery selector and verify its Go test event log."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PACKAGE = "github.com/the-drunken-coder/atlas/services/core/internal/actions"
EXPECTED = {
    "TestObjectDeletePublishesChangeBeforeStorageCleanup",
    "TestObjectUploadLockKey",
    "TestObjectDeletedAfterUploadPreflight",
    "TestStorageDeletionRetryDelay",
    "TestReconcileStorageDeletionsDeletesQueuedPath",
    "TestObjectDeleteUsesPersistedBucket",
    "TestObjectDownloadUsesPersistedBucket",
    "TestPathBearingObjectRequiresPersistedBucket",
    "TestPathBearingObjectDeleteRequiresStorage",
    "TestObjectUploadReplacementDeletesPersistedOldBucket",
    "TestUploadDoesNotResurrectObjectDeletedDuringBlobWrite",
    "TestUploadCrashLeavesRecoverableIntentForNewAndReplacementBlobs",
    "TestStorageUploadCrashHelper",
    "TestUploadHeartbeatOwnershipLossCancelsBeforeMetadataCommit",
    "TestUploadHeartbeatRetriesTransientRenewalFailure",
    "TestReconcileStorageUploadIntentDeletesUnreferencedBlob",
    "TestReconcileStorageUploadIntentRejectsLivePathWithoutBucket",
    "TestRecoverStorageUploadIntentLocksAdvisoryBeforeIntentRow",
    "TestReconcileStorageUploadIntentPreservesLiveBlob",
    "TestReconcileStorageUploadIntentLeavesActiveLease",
    "TestUploadDoesNotResurrectObjectCreatedAndDeletedAfterMissingPreflight",
    "TestQueueStorageDeletionRequeueResetsRetryState",
    "TestQueueStorageDeletionAfterFailurePreservesRetryAttempts",
    "TestReconcileStorageDeletionDrainsQueueAfterUploadRecoveryFailure",
    "TestReconcileStorageDeletionPreservesPathThatBecameLive",
    "TestReconcileStorageDeletionRejectsLivePathWithoutBucket",
    "TestReconcileStorageDeletionUsesQueuedBucketForSamePath",
    "TestRealStorageInterruptedUploadRecovery",
    "TestRealStorageInterruptedUploadHelper",
    "TestRealStorageDeletionRecoveryRetriesAndProtectsLiveContent",
    "TestRealStorageFailedUploadNeverCommitsMetadata",
}


def selection_pattern() -> str:
    return "^(" + "|".join(re.escape(name) for name in sorted(EXPECTED)) + ")$"


def verify(path: Path) -> list[str]:
    if not path.is_file():
        return [f"storage recovery event log not found: {path}"]

    passed: set[str] = set()
    skipped: set[str] = set()
    malformed: list[str] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            malformed.append(f"malformed JSON event on line {line_number}")
            continue
        if event.get("Package") != PACKAGE or not isinstance(event.get("Test"), str):
            continue
        test = event["Test"]
        if event.get("Action") == "pass":
            passed.add(test)
        elif event.get("Action") == "skip":
            skipped.add(test)

    errors = malformed
    for test in sorted(EXPECTED):
        matching_skips = sorted(
            skipped_test for skipped_test in skipped if skipped_test == test or skipped_test.startswith(test + "/")
        )
        if matching_skips:
            errors.extend(f"selected storage recovery test skipped: {test}" for test in matching_skips)
        elif test not in passed:
            errors.append(f"selected storage recovery test did not pass: {test}")
    return errors


def main(arguments: list[str] | None = None) -> int:
    args = sys.argv[1:] if arguments is None else arguments
    if args == ["pattern"]:
        print(selection_pattern())
        return 0
    if len(args) != 2 or args[0] != "verify":
        print("usage: verify_storage_recovery_tests.py pattern | verify LIVE_JSON_LOG", file=sys.stderr)
        return 2

    errors = verify(Path(args[1]))
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"verified {len(EXPECTED)} storage recovery tests passed without skips")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
