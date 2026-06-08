"""Small Docker Compose .env parser used by atlas.py startup preflight."""

from __future__ import annotations

import os
from collections.abc import Callable, MutableMapping


def parse_compose_env_file(env_path: str) -> dict[str, str]:
    """Parse the simple KEY=VALUE entries used by Docker Compose .env files."""
    values: dict[str, str] = {}
    if not os.path.exists(env_path):
        return values

    with open(env_path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()

            if "=" in line:
                key, value = line.split("=", 1)
            elif ":" in line:
                key, value = line.split(":", 1)
            else:
                continue

            key = key.strip()
            value = value.strip()
            if not key:
                continue

            values[key] = normalize_compose_env_value(value)

    return values


def find_closing_quote(value: str, quote: str) -> int:
    """Return the closing quote index, ignoring escaped quotes."""
    escaped = False
    for index in range(1, len(value)):
        char = value[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == quote:
            return index
    return -1


def normalize_compose_env_value(value: str) -> str:
    """Normalize one Compose .env value enough for atlas.py preflight checks."""
    value = value.strip()
    if not value:
        return value

    if value[0] in {"'", '"'}:
        quote = value[0]
        closing_quote = find_closing_quote(value, quote)
        if closing_quote != -1:
            trailing = value[closing_quote + 1 :].strip()
            if not trailing or trailing.startswith("#"):
                return value[1:closing_quote]

    comment_index = value.find(" #")
    if comment_index != -1:
        value = value[:comment_index].rstrip()

    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_compose_dotenv(
    docker_dir: str,
    environ: MutableMapping[str, str] | None = None,
    announce: Callable[[str], None] | None = print,
) -> list[str]:
    """Load Compose's default .env values without overriding shell variables."""
    target_environ = os.environ if environ is None else environ
    env_path = os.path.join(docker_dir, ".env")
    values = parse_compose_env_file(env_path)
    loaded = []
    for key, value in values.items():
        if key not in target_environ:
            target_environ[key] = value
            loaded.append(key)

    if loaded and announce is not None:
        loaded_keys = ", ".join(sorted(loaded))
        announce(f"[INFO] Loaded Docker Compose defaults from {env_path}: {loaded_keys}")
    return loaded
