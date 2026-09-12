#!/usr/bin/env python3
"""Check coverage from the in-process storage recovery Go tests."""

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


class ProfileError(ValueError):
    pass


def read_profile(path: Path) -> dict[str, tuple[int, int]]:
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
        previous = blocks.get(fields[0])
        if previous is not None and previous[0] != statements:
            raise ProfileError(f"inconsistent duplicate coverage block on line {line_number} in {path}")
        blocks[fields[0]] = (statements, max(count, previous[1] if previous else 0))

    totals = {name: [0, 0] for name in {"total", *GROUP_PATHS}}
    seen: set[str] = set()
    for location, (statements, count) in blocks.items():
        totals["total"][1] += statements
        if count > 0:
            totals["total"][0] += statements
        for name, fragment in GROUP_PATHS.items():
            if fragment not in location:
                continue
            seen.add(name)
            totals[name][1] += statements
            if count > 0:
                totals[name][0] += statements
            break
    missing = sorted(set(GROUP_PATHS) - seen)
    if missing:
        raise ProfileError(f"coverage profile {path} is missing modules: {', '.join(missing)}")
    return {name: (covered, total) for name, (covered, total) in totals.items()}


def displayed_percent(covered: int, total: int) -> Decimal:
    if total == 0:
        return Decimal("0.0")
    return (Decimal(covered * 100) / Decimal(total)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


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
