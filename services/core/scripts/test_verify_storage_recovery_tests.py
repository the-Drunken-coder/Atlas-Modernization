#!/usr/bin/env python3

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import verify_storage_recovery_tests as verifier


class StorageRecoveryVerifierTests(unittest.TestCase):
    def write_events(self, events: list[dict[str, str]]) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "events.json"
        path.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")
        return path

    def passing_events(self) -> list[dict[str, str]]:
        return [{"Action": "pass", "Package": verifier.PACKAGE, "Test": test} for test in verifier.EXPECTED]

    def test_accepts_every_expected_test_passing(self) -> None:
        self.assertEqual(verifier.verify(self.write_events(self.passing_events())), [])

    def test_rejects_missing_test(self) -> None:
        events = self.passing_events()
        missing = events.pop()["Test"]
        self.assertIn(
            f"selected storage recovery test did not pass: {missing}",
            verifier.verify(self.write_events(events)),
        )

    def test_rejects_skipped_subtest_even_when_parent_passes(self) -> None:
        test = next(iter(verifier.EXPECTED))
        events = self.passing_events()
        events.append({"Action": "skip", "Package": verifier.PACKAGE, "Test": test + "/dependency"})
        self.assertIn(
            f"selected storage recovery test skipped: {test}/dependency",
            verifier.verify(self.write_events(events)),
        )

    def test_rejects_malformed_event(self) -> None:
        path = self.write_events(self.passing_events())
        path.write_text(path.read_text(encoding="utf-8") + "\nnot-json", encoding="utf-8")
        self.assertIn("malformed JSON event", verifier.verify(path)[0])


if __name__ == "__main__":
    unittest.main()
