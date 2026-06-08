from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compose_env import load_compose_dotenv, normalize_compose_env_value, parse_compose_env_file


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

    def test_normalize_compose_env_value_leaves_unclosed_quotes_alone(self) -> None:
        self.assertEqual(normalize_compose_env_value("'unterminated value"), "'unterminated value")

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


if __name__ == "__main__":
    unittest.main()
