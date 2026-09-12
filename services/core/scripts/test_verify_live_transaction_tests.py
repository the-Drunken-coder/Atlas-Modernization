from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from verify_live_transaction_tests import EXPECTED, selection_pattern, verify


class LiveTransactionSelectionTest(unittest.TestCase):
    def test_pattern_selects_every_expected_name_only(self) -> None:
        import re

        pattern = re.compile(selection_pattern())
        for tests in EXPECTED.values():
            for test in tests:
                self.assertIsNotNone(pattern.fullmatch(test))
        self.assertIsNone(pattern.fullmatch("TestUnlisted"))

    def test_verify_requires_each_test_to_pass_without_skip(self) -> None:
        package = "example/package"
        expected = {package: {"TestFirst", "TestSecond"}}
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(EXPECTED, expected, clear=True):
            path = Path(temp_dir) / "live.json"
            path.write_text(
                "\n".join(
                    json.dumps(event)
                    for event in [
                        {"Action": "pass", "Package": package, "Test": "TestFirst"},
                        {"Action": "skip", "Package": package, "Test": "TestSecond"},
                    ]
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                verify(path),
                [f"selected live test skipped: {package} TestSecond"],
            )

    def test_verify_rejects_missing_and_malformed_events(self) -> None:
        package = "example/package"
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(EXPECTED, {package: {"TestOnly"}}, clear=True):
            path = Path(temp_dir) / "live.json"
            path.write_text("not json\n", encoding="utf-8")
            self.assertEqual(
                verify(path),
                [
                    "malformed JSON event on line 1",
                    f"selected live test did not pass: {package} TestOnly",
                ],
            )

    def test_verify_rejects_skipped_child_of_selected_test(self) -> None:
        package = "example/package"
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(EXPECTED, {package: {"TestOnly"}}, clear=True):
            path = Path(temp_dir) / "live.json"
            path.write_text(
                "\n".join(
                    json.dumps(event)
                    for event in [
                        {"Action": "skip", "Package": package, "Test": "TestOnly/child"},
                        {"Action": "pass", "Package": package, "Test": "TestOnly"},
                    ]
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                verify(path),
                [f"selected live test skipped: {package} TestOnly/child"],
            )


if __name__ == "__main__":
    unittest.main()
