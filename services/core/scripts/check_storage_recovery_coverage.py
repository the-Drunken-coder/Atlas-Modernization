#!/usr/bin/env python3
"""Check coverage from the in-process storage recovery Go tests."""

from __future__ import annotations

import sys
from pathlib import Path

from coverage_profile import Floor, ProfileError, displayed_percent
from coverage_profile import read_profile as read_grouped_profile

GROUP_PATHS = {
    "actions": "/internal/actions/",
    "database": "/internal/database/",
    "storage": "/internal/storage/",
    "testenv": "/internal/testenv/",
}

# Exact ratios avoid weakening a floor through displayed rounding. The required
# run measured 685/3142 statements overall. Each floor keeps a small margin for
# scheduling-dependent error branches in the lock and retry cases.
FLOORS = {
    "total": Floor(675, 3142),
    "actions": Floor(431, 2730),
    "database": Floor(150, 256),
    "storage": Floor(48, 92),
    "testenv": Floor(32, 64),
}


def read_profile(path: Path) -> dict[str, tuple[int, int]]:
    return read_grouped_profile(path, GROUP_PATHS)


def check(path: Path) -> bool:
    totals = read_profile(path)
    passed = True
    print(f"storage recovery in-process coverage: {path}")
    for name, floor in FLOORS.items():
        covered, total = totals[name]
        print(
            f"  {name}: {displayed_percent(covered, total):.1f}% ({covered}/{total}), "
            f"floor {displayed_percent(floor.covered, floor.total):.1f}%"
        )
        if total == 0 or covered * floor.total < floor.covered * total:
            passed = False
    return passed


def main(arguments: list[str] | None = None) -> int:
    args = sys.argv[1:] if arguments is None else arguments
    if len(args) != 1:
        print("usage: check_storage_recovery_coverage.py COVERAGE_PROFILE", file=sys.stderr)
        return 2
    try:
        return 0 if check(Path(args[0])) else 1
    except (OSError, ProfileError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
