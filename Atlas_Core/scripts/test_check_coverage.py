from __future__ import annotations

import tempfile
import unittest
from contextlib import redirect_stdout
from decimal import Decimal
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from check_coverage import FLOORS, coverage, displayed_percent, main, percent


def profile(lines: list[str]) -> str:
    return "mode: atomic\n" + "\n".join(lines) + "\n"


def block(group: str, statements: int, count: int) -> str:
    return f"github.com/example/atlas/atlas_core/internal/{group}/sample.go:1,2 {statements} {count}"


def baseline_lines(
    total_covered: int = 2116,
    below_group: str | None = None,
    empty_group: str | None = None,
) -> list[str]:
    lines = []
    group_covered = 0
    group_total = 0
    for group, (covered, total) in FLOORS.items():
        if group == "total":
            continue
        if group == empty_group:
            continue
        if group == below_group:
            covered -= 1
        lines.extend([block(group, covered, 1), block(group, total - covered, 0)])
        group_covered += covered
        group_total += total
    other_covered = total_covered - group_covered
    other_total = FLOORS["total"][1] - group_total
    return lines + [
        f"github.com/example/atlas/atlas_core/other.go:1,2 {other_covered} 1",
        f"github.com/example/atlas/atlas_core/other_uncovered.go:1,2 {other_total - other_covered} 0",
    ]


class CoverageCheckerTest(unittest.TestCase):
    def test_coverage_groups_and_total_accounting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "coverage.out"
            path.write_text(
                profile(
                    [
                        block("actions", 10, 1),
                        block("database", 5, 0),
                        block("storage", 3, 1),
                        block("admin", 2, 1),
                        "github.com/example/atlas/atlas_core/other.go:1,2 7 0",
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                coverage(path),
                {
                    "total": (15, 27),
                    "actions": (10, 10),
                    "database": (0, 5),
                    "storage": (3, 3),
                    "admin": (2, 2),
                },
            )

    def test_malformed_profile_lines_are_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "coverage.out"
            path.write_text(
                profile(
                    [
                        "malformed",
                        "github.com/example/atlas/atlas_core/internal/actions/bad.go:1,2 1",
                        "github.com/example/atlas/atlas_core/internal/actions/bad.go:1,2 nope 1",
                        "github.com/example/atlas/atlas_core/internal/actions/bad.go:1,2 1 nope",
                        block("actions", 2, 1),
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(coverage(path)["total"], (2, 2))
            self.assertEqual(coverage(path)["actions"], (2, 2))

    def test_zero_statement_and_empty_groups_are_safe(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "coverage.out"
            path.write_text(profile([block("actions", 0, 1)]), encoding="utf-8")

            result = coverage(path)
            self.assertEqual(result["total"], (0, 0))
            self.assertEqual(result["actions"], (0, 0))
            self.assertEqual(result["admin"], (0, 0))
            self.assertEqual(percent(0, 0), Decimal("0.0"))
            self.assertEqual(displayed_percent(0, 0), Decimal("0.0"))

    def test_exact_ratio_boundary_and_rounding_trap(self) -> None:
        self.assertEqual(percent(203, 500), Decimal("40.6"))
        self.assertLess(percent(202, 500), Decimal("40.6"))
        self.assertEqual(displayed_percent(2118, 5208), Decimal("40.7"))
        self.assertLess(percent(2118, 5208), Decimal("40.7"))
        self.assertGreaterEqual(percent(2118, 5208), Decimal("40.6"))

    def test_main_passes_exact_baselines_and_higher_total(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, redirect_stdout(StringIO()):
            for name, total_covered in (("baseline", 2116), ("higher", 2118)):
                path = Path(temp_dir) / f"{name}.out"
                path.write_text(profile(baseline_lines(total_covered)), encoding="utf-8")
                self.assertEqual(main(str(path)), 0)

    def test_main_fails_one_statement_below_exact_baselines(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, redirect_stdout(StringIO()):
            cases = {
                "total": baseline_lines(2115),
                "actions": baseline_lines(below_group="actions"),
                "admin": baseline_lines(below_group="admin"),
                "empty-actions": baseline_lines(empty_group="actions"),
            }
            for name, lines in cases.items():
                path = Path(temp_dir) / f"{name}.out"
                path.write_text(profile(lines), encoding="utf-8")
                self.assertEqual(main(str(path)), 1, name)

    def test_main_missing_profile(self) -> None:
        with patch("check_coverage.sys.argv", ["check_coverage.py", "/tmp/coverage-checker-file-that-does-not-exist"]):
            self.assertEqual(main(), 1)

    def test_main_passes_and_fails(self) -> None:
        passing_lines = [
            block("actions", 10, 1),
            block("database", 10, 1),
            block("storage", 10, 1),
            block("admin", 10, 1),
            "github.com/example/atlas/atlas_core/other.go:1,2 10 1",
        ]
        failing_lines = [*passing_lines[:-2], block("admin", 10, 0), passing_lines[-1]]

        with tempfile.TemporaryDirectory() as temp_dir:
            pass_path = Path(temp_dir) / "pass.out"
            fail_path = Path(temp_dir) / "fail.out"
            pass_path.write_text(profile(passing_lines), encoding="utf-8")
            fail_path.write_text(profile(failing_lines), encoding="utf-8")

            thresholds = {name: (1, 2) for name in FLOORS}
            with patch.dict(FLOORS, thresholds), redirect_stdout(StringIO()):
                self.assertEqual(main(str(pass_path)), 0)
                self.assertEqual(main(str(fail_path)), 1)


if __name__ == "__main__":
    unittest.main()
