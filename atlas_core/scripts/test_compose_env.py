from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compose_env import (
    compose_env_key,
    format_compose_env_value,
    load_compose_dotenv,
    normalize_compose_env_value,
    parse_compose_env_file,
    persist_compose_env_values,
)


class ComposeEnvTest(unittest.TestCase):
    def test_parse_compose_env_file_handles_quotes_exports_and_comments(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "# ignored",
                        "PLAIN=value",
                        "export EXPORTED=from-export",
                        "COLON: from-colon",
                        "QUOTED='value # kept' # dropped",
                        'DOUBLE="quoted value" # dropped',
                        "INLINE=value # dropped",
                        "HASH=value#kept",
                        "SPACED = trimmed ",
                        "NO_SEPARATOR",
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                parse_compose_env_file(str(env_path)),
                {
                    "PLAIN": "value",
                    "EXPORTED": "from-export",
                    "COLON": "from-colon",
                    "QUOTED": "value # kept",
                    "DOUBLE": "quoted value",
                    "INLINE": "value",
                    "HASH": "value#kept",
                    "SPACED": "trimmed",
                },
            )

    def test_parse_compose_env_file_rejects_control_characters(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text("BAD=has\x00nul\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, r"control characters: '\\x00'"):
                parse_compose_env_file(str(env_path))

    def test_normalize_compose_env_value_leaves_unclosed_quotes_alone(self) -> None:
        self.assertEqual(normalize_compose_env_value("'unterminated value"), "'unterminated value")

    def test_compose_env_key_handles_export_prefixes_and_comments(self) -> None:
        self.assertEqual(compose_env_key("export POSTGRES_PASSWORD=secret # comment"), "POSTGRES_PASSWORD")
        self.assertEqual(compose_env_key("  # POSTGRES_PASSWORD=secret"), None)
        self.assertEqual(compose_env_key("MINIO_ROOT_PASSWORD: secret"), "MINIO_ROOT_PASSWORD")

    def test_format_compose_env_value_quotes_when_needed(self) -> None:
        self.assertEqual(format_compose_env_value("abc_123-./:@%+=,"), "abc_123-./:@%+=,")
        self.assertEqual(format_compose_env_value("has space"), '"has space"')
        self.assertEqual(format_compose_env_value('has"quote\\slash'), '"has\\"quote\\\\slash"')

    def test_local_admin_login_payload_treats_compose_env_as_data(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        payload_script = r"""
LOGIN_JSON="$(
  "$2" - "$1" <<'PY'
import json
import sys
from atlas_core.scripts.compose_env import parse_compose_env_file

password = parse_compose_env_file(sys.argv[1]).get("ATLAS_ADMIN_PASSWORD")
if not password:
    raise SystemExit("missing ATLAS_ADMIN_PASSWORD")
print(json.dumps({"username": "admin", "password": password}))
PY
)" || exit 1
printf '%s' "$LOGIN_JSON"
"""

        with tempfile.TemporaryDirectory() as temp_dir:
            command_marker = Path(temp_dir) / "command-executed"
            backtick_marker = Path(temp_dir) / "backtick-executed"
            values = [
                "price$HOME",
                f"literal$(touch {command_marker})",
                f"literal`touch {backtick_marker}`",
                "value with spaces",
                'double"quote',
                "single'quote",
                r"back\\slash",
            ]

            for value in values:
                with self.subTest(value=value):
                    persist_compose_env_values(
                        temp_dir,
                        {"ATLAS_ADMIN_PASSWORD": value},
                        announce=None,
                        env_filename=".env.local",
                    )
                    result = subprocess.run(
                        ["sh", "-c", payload_script, "sh", str(Path(temp_dir) / ".env.local"), sys.executable],
                        check=True,
                        capture_output=True,
                        text=True,
                        cwd=repo_root,
                    )
                    self.assertEqual(json.loads(result.stdout), {"username": "admin", "password": value})

            self.assertFalse(command_marker.exists())
            self.assertFalse(backtick_marker.exists())

            (Path(temp_dir) / ".env.local").unlink()
            missing = subprocess.run(
                ["sh", "-c", payload_script, "sh", str(Path(temp_dir) / ".env.local"), sys.executable],
                capture_output=True,
                text=True,
                cwd=repo_root,
            )
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("missing ATLAS_ADMIN_PASSWORD", missing.stderr)

    def test_api_guide_reads_local_credentials_as_data(self) -> None:
        guide = (Path(__file__).resolve().parents[1] / "docs" / "API_GUIDE.md").read_text(encoding="utf-8")

        self.assertNotIn(". atlas_core/docker/.env.local", guide)
        self.assertEqual(guide.count('parse_compose_env_file("atlas_core/docker/.env.local")'), 2)
        self.assertEqual(guide.count('--data-binary @- <<<"$LOGIN_JSON"'), 2)
        self.assertEqual(guide.count(')" || exit 1'), 2)

    def test_format_compose_env_value_rejects_control_characters(self) -> None:
        for value in [
            "has\x00nul",
            "has\x01start",
            "has\nnewline",
            "has\rcarriage",
            "has\ttab",
            "has\x1bescape",
            "has\x1fseparator",
            "has\x7fdelete",
        ]:
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "control characters"):
                    format_compose_env_value(value)

    def test_persist_compose_env_values_updates_existing_keys_without_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "# existing",
                        "export POSTGRES_PASSWORD=old",
                        "MINIO_ROOT_USER=atlas",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            persist_compose_env_values(
                temp_dir,
                {
                    "POSTGRES_PASSWORD": "new password",
                    "MINIO_ROOT_PASSWORD": 'secret"with\\chars',
                },
                announce=None,
            )

            lines = env_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(sum(1 for line in lines if compose_env_key(line) == "POSTGRES_PASSWORD"), 1)
            self.assertIn('POSTGRES_PASSWORD="new password"', lines)
            self.assertIn('MINIO_ROOT_PASSWORD="secret\\"with\\\\chars"', lines)

    def test_persist_compose_env_values_rejects_control_characters(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(ValueError, r"control characters: '\\t'"):
                persist_compose_env_values(temp_dir, {"POSTGRES_PASSWORD": "has\ttab"}, announce=None)

    def test_persist_compose_env_values_creates_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"

            persist_compose_env_values(
                temp_dir,
                {
                    "POSTGRES_PASSWORD": "new password",
                    "MINIO_ROOT_PASSWORD": "secret",
                },
                announce=None,
            )

            lines = env_path.read_text(encoding="utf-8").splitlines()
            self.assertIn('POSTGRES_PASSWORD="new password"', lines)
            self.assertIn("MINIO_ROOT_PASSWORD=secret", lines)
            self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)

    def test_load_compose_dotenv_does_not_override_existing_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text("API_AUTH_KEY=file-key\nPOSTGRES_PASSWORD=file-password\n", encoding="utf-8")
            environ = {"API_AUTH_KEY": "shell-key"}
            messages: list[str] = []

            loaded = load_compose_dotenv(temp_dir, environ=environ, announce=messages.append)

            self.assertEqual(loaded, ["POSTGRES_PASSWORD"])
            self.assertEqual(environ["API_AUTH_KEY"], "shell-key")
            self.assertEqual(environ["POSTGRES_PASSWORD"], "file-password")
            self.assertEqual(len(messages), 1)
            self.assertIn("POSTGRES_PASSWORD", messages[0])

    def test_local_auth_file_is_not_loaded_as_compose_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            persist_compose_env_values(
                temp_dir,
                {"ENABLE_API_AUTH": "true", "API_AUTH_KEY": "local-only-key"},
                announce=None,
                env_filename=".env.local",
            )
            environ: dict[str, str] = {}

            self.assertEqual(load_compose_dotenv(temp_dir, environ=environ, announce=None), [])
            self.assertNotIn("API_AUTH_KEY", environ)
            self.assertEqual((Path(temp_dir) / ".env.local").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
