#!/usr/bin/env python3
"""Check separate offline and live Atlas Core coverage profiles."""

from __future__ import annotations

import sys
from pathlib import Path

from coverage_profile import Floor, ProfileError, displayed_percent
from coverage_profile import read_profile as read_grouped_profile

GROUP_PATHS = {
    "actions": "/internal/actions/",
    "handlers": "/internal/api/handlers/",
    "database": "/internal/database/",
    "feed": "/internal/feed/",
    "testenv": "/internal/testenv/",
    "storage": "/internal/storage/",
    "admin": "/internal/admin/",
}

# Exact statement ratios avoid rounding a displayed percentage into an
# accidental weaker floor. The offline feed floor leaves one measured statement
# of margin for websocket shutdown scheduling; live total and action coverage
# leave measured margin for error branches in the contention tests.
FLOORS = {
    "offline": {
        "total": Floor(3539, 7572),
        "actions": Floor(674, 2730),
        "handlers": Floor(548, 1201),
        "database": Floor(64, 256),
        "feed": Floor(269, 382),
        "testenv": Floor(18, 64),
        "storage": Floor(27, 92),
        "admin": Floor(51, 366),
    },
    "live": {
        "total": Floor(1645, 4633),
        "actions": Floor(1038, 2730),
        "handlers": Floor(239, 1201),
        "database": Floor(151, 256),
        "feed": Floor(187, 382),
        "testenv": Floor(34, 64),
    },
}


def read_profile(path: Path, required_groups: set[str]) -> dict[str, tuple[int, int]]:
    totals = read_grouped_profile(path, {name: GROUP_PATHS[name] for name in required_groups})
    if totals["total"][1] == 0:
        raise ProfileError(f"coverage profile has no statements: {path}")
    return totals


def check_profile(label: str, path: Path) -> bool:
    floors = FLOORS[label]
    totals = read_profile(path, set(floors) - {"total"})
    failed = False
    print(f"{label} coverage: {path}")
    for name, floor in floors.items():
        covered, total = totals[name]
        print(
            f"  {name}: {displayed_percent(covered, total):.1f}% "
            f"({covered}/{total}), floor "
            f"{displayed_percent(floor.covered, floor.total):.1f}%"
        )
        if total == 0 or covered * floor.total < floor.covered * total:
            failed = True
    return not failed


def main(arguments: list[str] | None = None) -> int:
    args = sys.argv[1:] if arguments is None else arguments
    if len(args) != 2:
        print(
            "usage: check_live_transaction_coverage.py OFFLINE_PROFILE LIVE_PROFILE",
            file=sys.stderr,
        )
        return 2

    try:
        offline_ok = check_profile("offline", Path(args[0]))
        live_ok = check_profile("live", Path(args[1]))
    except (OSError, ProfileError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0 if offline_ok and live_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
