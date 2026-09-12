from __future__ import annotations

import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from check_live_transaction_coverage import (
    FLOORS,
    Floor,
    ProfileError,
    check_profile,
    main,
    read_profile,
)


def profile(lines: list[str], mode: str = "atomic") -> str:
    return f"mode: {mode}\n" + "\n".join(lines) + "\n"


def block(group: str, statements: int, count: int, line: int = 1) -> str:
    path = "internal/api/handlers" if group == "handlers" else f"internal/{group}"
    return (
        f"github.com/the-drunken-coder/atlas/services/core/{path}/sample.go:{line}.1,{line + 1}.1 {statements} {count}"
    )


class LiveTransactionCoverageTest(unittest.TestCase):
    def test_profile_counts_required_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "coverage.out"
            path.write_text(
                profile([block("actions", 3, 1), block("feed", 2, 0)]),
                encoding="utf-8",
            )
            self.assertEqual(
                read_profile(path, {"actions", "feed"}),
                {"total": (3, 5), "actions": (3, 3), "feed": (0, 2)},
            )

    def test_duplicate_blocks_merge_across_instrumented_test_processes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "coverage.out"
            covered = block("actions", 3, 1)
            uncovered = block("feed", 2, 0)
            path.write_text(profile([covered, uncovered, covered, uncovered]), encoding="utf-8")
            self.assertEqual(
                read_profile(path, {"actions", "feed"}),
                {"total": (3, 5), "actions": (3, 3), "feed": (0, 2)},
            )

    def test_missing_and_incomplete_profiles_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            cases = {
                "missing": temp / "missing.out",
                "empty": temp / "empty.out",
                "wrong mode": temp / "wrong-mode.out",
                "malformed": temp / "malformed.out",
                "missing module": temp / "missing-module.out",
            }
            cases["empty"].write_text("mode: atomic\n", encoding="utf-8")
            cases["wrong mode"].write_text(profile([block("actions", 1, 1)], "set"), encoding="utf-8")
            cases["malformed"].write_text(profile(["broken"]), encoding="utf-8")
            cases["missing module"].write_text(profile([block("feed", 1, 1)]), encoding="utf-8")
            for name, path in cases.items():
                with self.subTest(name=name), self.assertRaises(ProfileError):
                    read_profile(path, {"actions"})

    def test_exact_floor_passes_and_lower_ratio_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            passing = temp / "passing.out"
            failing = temp / "failing.out"
            passing.write_text(profile([block("actions", 3, 1), block("actions", 2, 0, line=2)]), encoding="utf-8")
            failing.write_text(profile([block("actions", 2, 1), block("actions", 3, 0, line=2)]), encoding="utf-8")
            floors = {"total": Floor(3, 5), "actions": Floor(3, 5)}
            with patch.dict(FLOORS, {"live": floors}), redirect_stdout(StringIO()):
                self.assertTrue(check_profile("live", passing))
                self.assertFalse(check_profile("live", failing))

    def test_main_requires_both_profiles(self) -> None:
        with redirect_stderr(StringIO()):
            self.assertEqual(main([]), 2)
            self.assertEqual(main(["offline.out"]), 2)

    def test_main_fails_when_either_profile_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, redirect_stderr(StringIO()), redirect_stdout(StringIO()):
            path = Path(temp_dir) / "offline.out"
            lines = [block(group, 1, 1) for group in FLOORS["offline"] if group != "total"]
            path.write_text(profile(lines), encoding="utf-8")
            self.assertEqual(main([str(path), str(Path(temp_dir) / "missing.out")]), 1)


if __name__ == "__main__":
    unittest.main()
