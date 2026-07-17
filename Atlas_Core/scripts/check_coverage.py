#!/usr/bin/env python3
"""Enforce the committed Atlas Core coverage floors from a Go coverprofile."""

import sys
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

FLOORS = {
    "total": Decimal("40.6"),
    "actions": Decimal("23.0"),
    "database": Decimal("22.4"),
    "storage": Decimal("24.1"),
    "admin": Decimal("10.1"),
}


def coverage(profile: Path) -> dict[str, tuple[int, int]]:
    totals: dict[str, list[int]] = {name: [0, 0] for name in FLOORS}
    for line in profile.read_text(encoding="utf-8").splitlines()[1:]:
        fields = line.split()
        if len(fields) != 3:
            continue
        source, statements_text, count_text = fields
        try:
            statements = int(statements_text)
            count = int(count_text)
        except ValueError:
            continue
        if statements < 0 or count < 0:
            continue
        group = "total"
        for candidate in ("actions", "database", "storage", "admin"):
            if f"/internal/{candidate}/" in source:
                group = candidate
                break
        for bucket in {"total", group}:
            totals[bucket][1] += statements
            if count > 0:
                totals[bucket][0] += statements
    return {name: (covered, total) for name, (covered, total) in totals.items()}


def percent(covered: int, total: int) -> Decimal:
    if total == 0:
        return Decimal("0.0")
    return Decimal(covered * 100) / Decimal(total)


def displayed_percent(covered: int, total: int) -> Decimal:
    return percent(covered, total).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


def main(profile_path: str | None = None) -> int:
    profile = Path(profile_path if profile_path is not None else sys.argv[1] if len(sys.argv) > 1 else "coverage.out")
    if not profile.is_file():
        print(f"coverage profile not found: {profile}", file=sys.stderr)
        return 1

    failed = False
    for name, (covered, total) in coverage(profile).items():
        observed = percent(covered, total)
        floor = FLOORS[name]
        print(f"{name}: {displayed_percent(covered, total):.1f}% ({covered}/{total}), floor {floor:.1f}%")
        if observed < floor:
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
