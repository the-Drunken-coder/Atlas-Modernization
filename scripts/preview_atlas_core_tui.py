#!/usr/bin/env python3
"""Build and open the fixture-only Atlas Core terminal UI preview."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PREVIEW_ENTRYPOINT = REPOSITORY_ROOT / "surfaces" / "core-cli" / "scripts" / "tui-preview.mjs"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Navigate the real Atlas Core TUI with fixture data and no deployment side effects."
    )
    parser.add_argument(
        "--state",
        choices=("ready", "stopped", "degraded", "not-initialized"),
        default="ready",
        help="initial fixture deployment state (default: ready)",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="use the existing surfaces/core-cli/dist output",
    )
    return parser.parse_args()


def run() -> int:
    arguments = parse_arguments()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("The Atlas Core TUI preview requires an interactive terminal.", file=sys.stderr)
        return 2

    if not arguments.no_build:
        subprocess.run(
            ["npm", "run", "build:core-cli"],
            cwd=REPOSITORY_ROOT,
            check=True,
        )

    result = subprocess.run(
        ["node", str(PREVIEW_ENTRYPOINT), "--state", arguments.state],
        cwd=REPOSITORY_ROOT,
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(run())
