from __future__ import annotations

import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from atlas import (
    ADMIN_PASSWORD_PLACEHOLDER,
    API_AUTH_KEY_PLACEHOLDER,
    DEFAULT_TUNNEL_HOSTNAME,
    LOCAL_AUTH_ENV_FILE,
    compose_down_command,
    compose_up_command,
    database_recreate_on_startup_enabled,
    ensure_local_auth,
    print_storage_notice,
    public_base_url_from_hostname,
    start_containers,
    verify_tunnel_connection,
    wait_for_api,
)


class FakeHTTPResponse:
    def __init__(self, body: str) -> None:
        self.body = body

    def __enter__(self) -> FakeHTTPResponse:
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        return None

    def read(self) -> bytes:
        return self.body.encode()


class AtlasScriptHelpersTest(unittest.TestCase):
    def test_wait_for_api_diagnoses_stale_development_volume_password(self) -> None:
        fixture_credential = "do-not-print-this"
        fixture_stderr_credential = "stderr-do-not-print-this"
        leaked_secret = f"postgres://atlas:{fixture_credential}@postgres/atlas_core"
        responses = [
            CompletedProcess([], 1),
            CompletedProcess([], 0, stdout="exited\n", stderr=""),
            CompletedProcess(
                [],
                0,
                stdout=(f'password authentication failed for user "atlas"\nDATABASE_URL={leaked_secret}\n'),
                stderr=f"diagnostic context: {fixture_stderr_credential}\n",
            ),
        ]
        output = StringIO()

        with patch("atlas.subprocess.run", side_effect=responses), redirect_stdout(output):
            with self.assertRaisesRegex(RuntimeError, "does not match the existing development volume") as error:
                wait_for_api(max_retries=3, delay=0)

        message = str(error.exception)
        self.assertIn("--dev --reset-volumes", message)
        self.assertIn("deletes all local development volumes", message)
        self.assertNotIn(leaked_secret, message)
        self.assertNotIn(fixture_credential, message)
        self.assertNotIn(fixture_stderr_credential, message)
        self.assertNotIn(leaked_secret, output.getvalue())
        self.assertNotIn(fixture_credential, output.getvalue())
        self.assertNotIn(fixture_stderr_credential, output.getvalue())

    def test_wait_for_api_diagnoses_json_escaped_stale_password(self) -> None:
        responses = [
            CompletedProcess([], 1),
            CompletedProcess([], 0, stdout="exited\n", stderr=""),
            CompletedProcess(
                [],
                0,
                stdout=json.dumps({"error": 'password authentication failed for user "atlas"'}),
                stderr="",
            ),
        ]

        with patch("atlas.subprocess.run", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "does not match the existing development volume"):
                wait_for_api(max_retries=3, delay=0)

    def test_wait_for_api_reports_generic_exited_core_without_stale_password_advice(self) -> None:
        responses = [
            CompletedProcess([], 1),
            CompletedProcess([], 0, stdout="exited\n", stderr=""),
            CompletedProcess([], 0, stdout="migration failed", stderr=""),
        ]

        with patch("atlas.subprocess.run", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "exited during startup") as error:
                wait_for_api(max_retries=3, delay=0)

        self.assertNotIn("reset-volumes", str(error.exception))

    def test_wait_for_api_keeps_retrying_while_core_is_running(self) -> None:
        responses = [
            CompletedProcess([], 1),
            CompletedProcess([], 0, stdout="running\n", stderr=""),
            CompletedProcess([], 0),
        ]

        with patch("atlas.subprocess.run", side_effect=responses) as run, patch("atlas.time.sleep") as sleep:
            self.assertTrue(wait_for_api(max_retries=2, delay=0.25))

        self.assertEqual(run.call_count, 3)
        sleep.assert_called_once_with(0.25)

    def test_wait_for_api_preserves_production_readiness_retries(self) -> None:
        responses = [CompletedProcess([], 1), CompletedProcess([], 0)]

        with patch("atlas.subprocess.run", side_effect=responses) as run, patch("atlas.time.sleep"):
            self.assertTrue(wait_for_api(max_retries=2, delay=0, production=True))

        self.assertEqual(run.call_count, 2)

    def test_local_auth_generates_redacted_persistent_values(self) -> None:
        generated_key = "generated-local-machine-key"
        generated_password = "generated-local-admin-password"
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("atlas.secrets.token_urlsafe", side_effect=[generated_key, generated_password]),
            patch("builtins.print") as output,
        ):
            values = ensure_local_auth("/tmp/docker")

            self.assertEqual(
                values,
                {
                    "ENABLE_API_AUTH": "true",
                    "API_AUTH_KEY": generated_key,
                    "ATLAS_ADMIN_PASSWORD": generated_password,
                },
            )
            self.assertEqual(os.environ["ENABLE_API_AUTH"], "true")
            self.assertEqual(os.environ["API_AUTH_KEY"], generated_key)
            self.assertEqual(os.environ["ATLAS_ADMIN_PASSWORD"], generated_password)
            rendered_output = " ".join(str(call) for call in output.call_args_list)
            self.assertNotIn(generated_key, rendered_output)
            self.assertNotIn(generated_password, rendered_output)

    def test_local_auth_reuses_configured_credentials_and_replaces_placeholders(self) -> None:
        configured_key = "configured-local-machine-key"
        configured_password = "configured-local-admin-password"
        with (
            patch.dict(
                "os.environ",
                {
                    "ENABLE_API_AUTH": "false",
                    "API_AUTH_KEY": configured_key,
                    "ATLAS_ADMIN_PASSWORD": configured_password,
                },
                clear=True,
            ),
            patch("atlas.parse_compose_env_file", return_value={}),
            patch("atlas.secrets.token_urlsafe") as generate,
            patch("builtins.print") as output,
        ):
            self.assertEqual(
                ensure_local_auth("/tmp/docker"),
                {
                    "ENABLE_API_AUTH": "true",
                    "API_AUTH_KEY": configured_key,
                    "ATLAS_ADMIN_PASSWORD": configured_password,
                },
            )
            generate.assert_not_called()
            self.assertIn("overriding ENABLE_API_AUTH=false", " ".join(str(call) for call in output.call_args_list))

        with (
            patch.dict(
                "os.environ",
                {
                    "API_AUTH_KEY": API_AUTH_KEY_PLACEHOLDER,
                    "ATLAS_ADMIN_PASSWORD": ADMIN_PASSWORD_PLACEHOLDER,
                },
                clear=True,
            ),
            patch("atlas.parse_compose_env_file", return_value={}),
            patch("atlas.secrets.token_urlsafe", side_effect=["replacement-key", "replacement-password"]),
        ):
            self.assertEqual(
                ensure_local_auth("/tmp/docker"),
                {
                    "ENABLE_API_AUTH": "true",
                    "API_AUTH_KEY": "replacement-key",
                    "ATLAS_ADMIN_PASSWORD": "replacement-password",
                },
            )

    def test_local_auth_reuses_owner_only_local_file(self) -> None:
        with (
            patch.dict("os.environ", {}, clear=True),
            patch(
                "atlas.parse_compose_env_file",
                return_value={
                    "ENABLE_API_AUTH": "true",
                    "API_AUTH_KEY": "persisted-local-key",
                    "ATLAS_ADMIN_PASSWORD": "persisted-local-password",
                },
            ),
            patch("atlas.secrets.token_urlsafe") as generate,
        ):
            self.assertEqual(
                ensure_local_auth("/tmp/docker"),
                {
                    "ENABLE_API_AUTH": "true",
                    "API_AUTH_KEY": "persisted-local-key",
                    "ATLAS_ADMIN_PASSWORD": "persisted-local-password",
                },
            )
            generate.assert_not_called()
            self.assertEqual(os.environ["ENABLE_API_AUTH"], "true")

    def test_storage_mode_defaults_match_compose_stacks(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertTrue(database_recreate_on_startup_enabled(production=False))
            self.assertFalse(database_recreate_on_startup_enabled(production=True))

    def test_storage_notice_describes_selected_mode(self) -> None:
        with patch.dict("os.environ", {}, clear=True), patch("builtins.print") as output:
            print_storage_notice(production=False)
            self.assertIn("clears resource rows", output.call_args.args[0])
            print_storage_notice(production=True)
            self.assertIn("Durable storage mode", output.call_args.args[0])

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
            patch("atlas.resolve_atlas_core_dir", return_value="/tmp/atlas_core"),
            patch("atlas.load_compose_dotenv"),
            patch("atlas.ensure_minio_secrets", return_value={}),
            patch("atlas.ensure_postgres_password", return_value={}),
            patch("atlas.persist_compose_env_values"),
            patch("atlas.print_storage_notice"),
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
            cwd="/tmp/atlas_core/docker",
        )

    def test_development_start_persists_local_api_auth(self) -> None:
        local_auth = {
            "ENABLE_API_AUTH": "true",
            "API_AUTH_KEY": "generated-local-key",
            "ATLAS_ADMIN_PASSWORD": "generated-admin-password",
        }
        with (
            patch("atlas.resolve_atlas_core_dir", return_value="/tmp/atlas_core"),
            patch("atlas.load_compose_dotenv"),
            patch("atlas.ensure_minio_secrets", return_value={}),
            patch("atlas.ensure_postgres_password", return_value={}),
            patch("atlas.ensure_local_auth", return_value=local_auth) as ensure_local,
            patch("atlas.persist_compose_env_values") as persist,
            patch("atlas.print_storage_notice"),
            patch("atlas.cleanup_containers"),
            patch("atlas.subprocess.run"),
            patch("atlas.wait_for_database_docker"),
            patch("atlas.wait_for_minio"),
            patch("atlas.ensure_minio_bucket_docker"),
            patch("atlas.cleanup_init_containers"),
            patch("atlas.wait_for_api"),
            patch("atlas.wait_for_database_schema_docker"),
            patch("builtins.print"),
        ):
            start_containers()

        ensure_local.assert_called_once_with("/tmp/atlas_core/docker")
        persist.assert_any_call("/tmp/atlas_core/docker", local_auth, env_filename=LOCAL_AUTH_ENV_FILE)

    def test_public_start_does_not_load_local_auth(self) -> None:
        for start_options in ({"production": True}, {"tunnel": True}):
            with (
                self.subTest(start_options=start_options),
                patch("atlas.resolve_atlas_core_dir", return_value="/tmp/atlas_core"),
                patch("atlas.ensure_local_auth") as ensure_local,
                patch("atlas.load_compose_dotenv"),
                patch("atlas.ensure_minio_secrets", side_effect=RuntimeError("stop after auth selection")),
                patch("builtins.print"),
                self.assertRaises(SystemExit),
            ):
                start_containers(**start_options)

            ensure_local.assert_not_called()


if __name__ == "__main__":
    unittest.main()
