"""Read and summarize atomic Go coverage profiles for Core coverage gates."""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path


@dataclass(frozen=True)
class Floor:
    covered: int
    total: int


class ProfileError(ValueError):
    pass


def read_profile(path: Path, group_paths: dict[str, str]) -> dict[str, tuple[int, int]]:
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

    totals = {name: [0, 0] for name in {"total", *group_paths}}
    seen_groups: set[str] = set()
    for location, (statements, count) in blocks.items():
        totals["total"][1] += statements
        if count > 0:
            totals["total"][0] += statements
        for name, fragment in group_paths.items():
            if fragment not in location:
                continue
            seen_groups.add(name)
            totals[name][1] += statements
            if count > 0:
                totals[name][0] += statements
            break

    missing = sorted(set(group_paths) - seen_groups)
    if missing:
        raise ProfileError(f"coverage profile {path} is missing modules: {', '.join(missing)}")
    return {name: (covered, total) for name, (covered, total) in totals.items()}


def displayed_percent(covered: int, total: int) -> Decimal:
    if total == 0:
        return Decimal("0.0")
    return (Decimal(covered * 100) / Decimal(total)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
