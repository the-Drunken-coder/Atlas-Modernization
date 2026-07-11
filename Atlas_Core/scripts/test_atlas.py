from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from atlas import (
    DEFAULT_TUNNEL_HOSTNAME,
    compose_down_command,
    compose_up_command,
    public_base_url_from_hostname,
    start_containers,
    verify_tunnel_connection,
)


class FakeHTTPResponse:
    def __init__(self, body: str) -> None:
        self.body = body

    def __enter__(self) -> "FakeHTTPResponse":
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        return None

    def read(self) -> bytes:
        return self.body.encode()


class AtlasScriptHelpersTest(unittest.TestCase):
    def test_public_base_url_from_hostname_formats_bare_hostnames(self) -> None:
        self.assertEqual(public_base_url_from_hostname("example.com"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("example.com/"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("localhost:8080"), "https://localhost:8080")
        self.assertEqual(public_base_url_from_hostname("localhost:8080/"), "https://localhost:8080")

    def test_public_base_url_from_hostname_preserves_absolute_url_schemes(self) -> None:
        self.assertEqual(public_base_url_from_hostname("http://example.com/"), "http://example.com")
        self.assertEqual(public_base_url_from_hostname("https://example.com/"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("http://localhost:8080/"), "http://localhost:8080")
        self.assertEqual(public_base_url_from_hostname("https://example.com:443/"), "https://example.com:443")
        self.assertEqual(public_base_url_from_hostname("https://example.com/api/v1"), "https://example.com/api/v1")

    def test_public_base_url_from_hostname_uses_default_for_blank_values(self) -> None:
        want = f"https://{DEFAULT_TUNNEL_HOSTNAME}"
        self.assertEqual(public_base_url_from_hostname(""), want)
        self.assertEqual(public_base_url_from_hostname("  "), want)

    def test_public_base_url_from_hostname_uses_custom_default_for_blank_values(self) -> None:
        custom_default = "custom.example.com"
        want = f"https://{custom_default}"
        self.assertEqual(public_base_url_from_hostname("", custom_default), want)
        self.assertEqual(public_base_url_from_hostname("  ", custom_default), want)

    def test_public_base_url_from_hostname_handles_slash_edge_cases(self) -> None:
        want_default = f"https://{DEFAULT_TUNNEL_HOSTNAME}"
        self.assertEqual(public_base_url_from_hostname("https://"), want_default)
        self.assertEqual(public_base_url_from_hostname("http://"), want_default)
        self.assertEqual(public_base_url_from_hostname("//example.com"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("///example.com///"), "https://example.com")

    def test_verify_tunnel_connection_accepts_degraded_readiness(self) -> None:
        with patch("urllib.request.urlopen", return_value=FakeHTTPResponse('{"status": "degraded"}')):
            verified, status = verify_tunnel_connection(
                public_url="https://example.com/readiness",
                max_retries=1,
                delay=0,
            )

        self.assertTrue(verified)
        self.assertEqual(status, "Connected and degraded")

    def test_verify_tunnel_connection_rejects_unknown_readiness_status(self) -> None:
        with patch("urllib.request.urlopen", return_value=FakeHTTPResponse('{"status": "starting"}')):
            verified, status = verify_tunnel_connection(
                public_url="https://example.com/readiness",
                max_retries=1,
                delay=0,
            )

        self.assertFalse(verified)
        self.assertEqual(status, "Connection not verified (may still be starting)")

    def test_compose_up_command_uses_dev_stack_by_default(self) -> None:
        self.assertEqual(
            compose_up_command(),
            ["docker", "compose", "up", "-d", "--build"],
        )

    def test_compose_up_command_uses_dev_tunnel_override(self) -> None:
        self.assertEqual(
            compose_up_command(tunnel=True),
            [
                "docker",
                "compose",
                "-f",
                "docker-compose.yml",
                "-f",
                "docker-compose.tunnel.yml",
                "up",
                "-d",
                "--build",
            ],
        )

    def test_compose_up_command_uses_production_stack(self) -> None:
        self.assertEqual(
            compose_up_command(production=True),
            [
                "docker",
                "compose",
                "-f",
                "docker-compose.production.yml",
                "up",
                "-d",
                "--build",
            ],
        )

    def test_compose_up_command_uses_production_tunnel_overlay(self) -> None:
        self.assertEqual(
            compose_up_command(production=True, tunnel=True),
            [
                "docker",
                "compose",
                "-f",
                "docker-compose.production.yml",
                "-f",
                "docker-compose.tunnel.yml",
                "up",
                "-d",
                "--build",
            ],
        )

    def test_compose_down_command_uses_production_tunnel_overlay(self) -> None:
        self.assertEqual(
            compose_down_command(production=True, tunnel=True),
            [
                "docker",
                "compose",
                "-f",
                "docker-compose.production.yml",
                "-f",
                "docker-compose.tunnel.yml",
                "down",
                "--remove-orphans",
            ],
        )

    def test_compose_down_command_uses_production_stack_when_requested(self) -> None:
        self.assertEqual(
            compose_down_command(production=True, remove_volumes=True),
            [
                "docker",
                "compose",
                "-f",
                "docker-compose.production.yml",
                "down",
                "--remove-orphans",
                "--volumes",
                "--rmi",
                "local",
            ],
        )

    def test_production_db_only_does_not_require_api_auth(self) -> None:
        with (
            patch("atlas.resolve_atlas_core_dir", return_value="/tmp/Atlas_Core"),
            patch("atlas.load_compose_dotenv"),
            patch("atlas.ensure_minio_secrets", return_value={}),
            patch("atlas.ensure_postgres_password", return_value={}),
            patch("atlas.persist_compose_env_values"),
            patch("atlas.print_disposable_storage_notice"),
            patch("atlas.ensure_api_auth") as ensure_api_auth,
            patch("atlas.cleanup_containers"),
            patch("atlas.subprocess.run") as run,
            patch("atlas.wait_for_database_docker"),
            patch("builtins.print"),
        ):
            start_containers(db_only=True, production=True)

        ensure_api_auth.assert_not_called()
        run.assert_called_once_with(
            [
                "docker",
                "compose",
                "-f",
                "docker-compose.production.yml",
                "up",
                "-d",
                "--build",
                "postgres",
            ],
            check=True,
            cwd="/tmp/Atlas_Core/docker",
        )


if __name__ == "__main__":
    unittest.main()
