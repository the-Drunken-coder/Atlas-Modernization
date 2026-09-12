#!/usr/bin/env python3
"""Check separate offline and live Atlas Core coverage profiles."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path


@dataclass(frozen=True)
class Floor:
    covered: int
    total: int


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
# accidental weaker floor. Live total and action coverage leave a measured
# margin for scheduling-dependent error branches in the contention tests.
FLOORS = {
    "offline": {
        "total": Floor(3539, 7572),
        "actions": Floor(674, 2730),
        "handlers": Floor(548, 1201),
        "database": Floor(64, 256),
        "feed": Floor(270, 382),
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


class ProfileError(ValueError):
    pass


def read_profile(path: Path, required_groups: set[str]) -> dict[str, tuple[int, int]]:
    if not path.is_file():
        raise ProfileError(f"coverage profile not found: {path}")
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "mode: atomic":
        raise ProfileError(f"coverage profile must start with 'mode: atomic': {path}")
    if len(lines) == 1:
        raise ProfileError(f"coverage profile has no data: {path}")

    blocks: dict[str, tuple[int, int]] = {}
    for line_number, line in enumerate(lines[1:], start=2):
        fields = line.rsplit(maxsplit=2)
        if len(fields) != 3 or ":" not in fields[0] or "," not in fields[0]:
            raise ProfileError(f"malformed coverage line {line_number} in {path}: {line!r}")
        try:
            statements = int(fields[1])
            count = int(fields[2])
        except ValueError as error:
            raise ProfileError(f"malformed coverage line {line_number} in {path}: {line!r}") from error
        if statements < 0 or count < 0:
            raise ProfileError(f"negative coverage value on line {line_number} in {path}")

        location = fields[0]
        previous = blocks.get(location)
        if previous is not None and previous[0] != statements:
            raise ProfileError(f"inconsistent duplicate coverage block on line {line_number} in {path}")
        blocks[location] = (statements, max(count, previous[1] if previous else 0))

    totals = {name: [0, 0] for name in {"total", *required_groups}}
    seen_groups: set[str] = set()
    for location, (statements, count) in blocks.items():
        totals["total"][1] += statements
        if count > 0:
            totals["total"][0] += statements
        for name in required_groups:
            if GROUP_PATHS[name] not in location:
                continue
            seen_groups.add(name)
            totals[name][1] += statements
            if count > 0:
                totals[name][0] += statements
            break

    missing = sorted(required_groups - seen_groups)
    if missing:
        raise ProfileError(f"coverage profile {path} is missing modules: {', '.join(missing)}")
    if totals["total"][1] == 0:
        raise ProfileError(f"coverage profile has no statements: {path}")
    return {name: (covered, total) for name, (covered, total) in totals.items()}


def percent(covered: int, total: int) -> Decimal:
    if total == 0:
        return Decimal("0")
    return Decimal(covered * 100) / Decimal(total)


def displayed_percent(covered: int, total: int) -> Decimal:
    return percent(covered, total).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


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
