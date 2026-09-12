#!/usr/bin/env python3

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_storage_recovery_coverage as coverage


class StorageRecoveryCoverageTests(unittest.TestCase):
    def write_profile(self, entries: list[str]) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "coverage.out"
        path.write_text("mode: atomic\n" + "\n".join(entries) + "\n", encoding="utf-8")
        return path

    def complete_profile(self, count: int = 1) -> Path:
        return self.write_profile(
            [
                f"example/internal/actions/a.go:1.1,2.1 1 {count}",
                f"example/internal/database/a.go:1.1,2.1 1 {count}",
                f"example/internal/storage/a.go:1.1,2.1 1 {count}",
                f"example/internal/testenv/a.go:1.1,2.1 1 {count}",
            ]
        )

    def test_accepts_profile_over_floors(self) -> None:
        self.assertTrue(coverage.check(self.complete_profile()))

    def test_rejects_profile_under_floor(self) -> None:
        floors = {name: coverage.Floor(1, 1) for name in coverage.FLOORS}
        with mock.patch.object(coverage, "FLOORS", floors):
            self.assertFalse(coverage.check(self.complete_profile(count=0)))

    def test_rejects_missing_module(self) -> None:
        path = self.write_profile(["example/internal/actions/a.go:1.1,2.1 1 1"])
        with self.assertRaisesRegex(coverage.ProfileError, "missing modules"):
            coverage.read_profile(path)

    def test_rejects_malformed_profile(self) -> None:
        path = self.write_profile(["not a coverage record"])
        with self.assertRaisesRegex(coverage.ProfileError, "malformed coverage line"):
            coverage.read_profile(path)


if __name__ == "__main__":
    unittest.main()
