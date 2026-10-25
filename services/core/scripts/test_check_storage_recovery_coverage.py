#!/usr/bin/env python3

from __future__ import annotations

import tempfile
import unittest
import unittest.mock
from pathlib import Path

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
        with unittest.mock.patch.object(coverage, "FLOORS", floors):
            self.assertFalse(coverage.check(self.complete_profile(count=0)))

    def test_zero_statement_groups_are_reported_but_fail_the_gate(self) -> None:
        path = self.write_profile(
            [f"example{fragment}sample.go:1.1,2.1 0 0" for fragment in coverage.GROUP_PATHS.values()]
        )
        self.assertEqual(coverage.read_profile(path), {name: (0, 0) for name in {"total", *coverage.GROUP_PATHS}})
        self.assertFalse(coverage.check(path))


if __name__ == "__main__":
    unittest.main()
