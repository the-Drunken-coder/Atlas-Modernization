#!/usr/bin/env python3
"""
ATLAS Core System - Docker Container Management

Simple script to start Docker containers for the ATLAS Core System.

Usage:
    python atlas.py              # Interactive menu to choose startup options
    python atlas.py --dev         # Start local dev containers (non-interactive)
    python atlas.py --tunnel     # Start all containers with Cloudflare tunnel (non-interactive)
    python atlas.py --production # Start production-image containers (non-interactive)
    python atlas.py --db-only    # Start only PostgreSQL container (non-interactive)
    python atlas.py --help       # Show help
"""

import argparse
import logging
import os
import secrets
import subprocess
import sys
import time

try:
    from .compose_env import load_compose_dotenv, parse_compose_env_file, persist_compose_env_values
except ImportError:
    from compose_env import load_compose_dotenv, parse_compose_env_file, persist_compose_env_values

logger = logging.getLogger(__name__)

API_AUTH_KEY_PLACEHOLDER = "REPLACE_WITH_SECURE_KEY"
API_AUTH_KEY_PLACEHOLDERS = {API_AUTH_KEY_PLACEHOLDER, "REPLACE_WITH_STRONG_BOOTSTRAP_KEY"}
PRODUCTION_STORAGE_PASSWORD_PLACEHOLDER = "replace_with_strong_password"
ADMIN_PASSWORD_PLACEHOLDERS = {
    "password",
    "replace_with_secure_admin_password",
    "replace-with-secure-admin-password",
    "your-secure-admin-password",
}
MIN_PRODUCTION_CREDENTIAL_LENGTH = 12
DEFAULT_TUNNEL_HOSTNAME = "atlascommandapi.org"
TUNNEL_HOSTNAME_ENV = "ATLAS_TUNNEL_HOSTNAME"
DEV_COMPOSE_FILE = "docker-compose.yml"
TUNNEL_COMPOSE_FILE = "docker-compose.tunnel.yml"
PRODUCTION_COMPOSE_FILE = "docker-compose.production.yml"
PRODUCTION_DB_COMPOSE_FILE = "docker-compose.production-db.yml"
DEVELOPMENT_COMPOSE_PROJECT = "atlas_core_development"
PRODUCTION_COMPOSE_PROJECT = "atlas_core_production"
LOCAL_AUTH_ENV_FILE = ".env.local"
DEFAULT_MINIO_BUCKET = "atlas-media"


def print_banner():
    """Print the ATLAS banner."""
    banner = """
===============================================================
                    ATLAS Core System
                   Docker Container Manager
===============================================================
    """
    print(banner)


def ensure_minio_secrets():
    """Generate ephemeral MinIO secrets if they are not set."""
    created = []
    generated_values = {}
    root_password = os.getenv("MINIO_ROOT_PASSWORD")
    secret_key = os.getenv("MINIO_SECRET_KEY")
    root_user = os.getenv("MINIO_ROOT_USER")
    access_key = os.getenv("MINIO_ACCESS_KEY")

    if not root_user:
        os.environ["MINIO_ROOT_USER"] = "atlas"
        generated_values["MINIO_ROOT_USER"] = "atlas"
        created.append("MINIO_ROOT_USER")
        root_user = "atlas"

    if not root_password and not secret_key:
        generated = secrets.token_urlsafe(32)
        os.environ["MINIO_ROOT_PASSWORD"] = generated
        os.environ["MINIO_SECRET_KEY"] = generated
        generated_values["MINIO_ROOT_PASSWORD"] = generated
        generated_values["MINIO_SECRET_KEY"] = generated
        created.extend(["MINIO_ROOT_PASSWORD", "MINIO_SECRET_KEY"])
    elif not root_password and secret_key:
        os.environ["MINIO_ROOT_PASSWORD"] = secret_key
        created.append("MINIO_ROOT_PASSWORD")
    elif root_password and not secret_key:
        os.environ["MINIO_SECRET_KEY"] = root_password
        created.append("MINIO_SECRET_KEY")

    if root_user and not access_key:
        os.environ["MINIO_ACCESS_KEY"] = root_user
        if "MINIO_ROOT_USER" in generated_values:
            generated_values["MINIO_ACCESS_KEY"] = root_user
        created.append("MINIO_ACCESS_KEY")

    if created:
        print(f"[INFO] Set MinIO credentials for this run: {', '.join(created)}")
    return generated_values


def ensure_postgres_password():
    """Ensure POSTGRES_PASSWORD is set (generate one if missing)."""
    if not os.getenv("POSTGRES_PASSWORD"):
        generated = secrets.token_urlsafe(24)
        os.environ["POSTGRES_PASSWORD"] = generated
        print("[INFO] Generated POSTGRES_PASSWORD for this run (redacted)")
        return {"POSTGRES_PASSWORD": generated}
    return {}


def ensure_production_storage_credentials(db_only=False):
    """Require operator-owned credentials before touching production containers."""
    required = ["POSTGRES_PASSWORD"]
    if not db_only:
        required.extend(["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"])
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        print(f"[ERROR] Production mode requires {', '.join(missing)} to be set.")
        return False
    password_names = ["POSTGRES_PASSWORD"] if db_only else ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"]
    placeholders = [
        name
        for name in password_names
        if os.getenv(name, "").strip().lower() == PRODUCTION_STORAGE_PASSWORD_PLACEHOLDER
    ]
    if placeholders:
        print("[ERROR] Production storage passwords must replace the committed example value.")
        return False
    postgres_password = os.environ["POSTGRES_PASSWORD"].strip()
    if any(
        not (character.isascii() and (character.isalnum() or character in "-._~!$&'()*+,;=:"))
        for character in postgres_password
    ):
        print("[ERROR] POSTGRES_PASSWORD must contain only characters safe in the production database URL.")
        return False
    return True


def configured_minio_bucket():
    """Return the bucket selected by the Compose environment."""
    return os.getenv("MINIO_BUCKET") or DEFAULT_MINIO_BUCKET


def ensure_local_auth(docker_dir):
    """Generate or reuse the credentials required by the local authenticated stack."""
    local_auth = parse_compose_env_file(os.path.join(docker_dir, LOCAL_AUTH_ENV_FILE))
    api_auth_key = os.getenv("API_AUTH_KEY", "").strip() or local_auth.get("API_AUTH_KEY", "").strip()
    if not api_auth_key or api_auth_key in API_AUTH_KEY_PLACEHOLDERS:
        api_auth_key = secrets.token_urlsafe(32)
        print("[INFO] Generated local API_AUTH_KEY (redacted)")
    else:
        print("[INFO] Reusing local API_AUTH_KEY (redacted)")

    admin_password = os.getenv("ATLAS_ADMIN_PASSWORD", "").strip() or local_auth.get("ATLAS_ADMIN_PASSWORD", "").strip()
    if not admin_password or admin_password.lower() in ADMIN_PASSWORD_PLACEHOLDERS:
        admin_password = secrets.token_urlsafe(32)
        print("[INFO] Generated local ATLAS_ADMIN_PASSWORD (redacted)")
    else:
        print("[INFO] Reusing local ATLAS_ADMIN_PASSWORD (redacted)")

    if os.getenv("ENABLE_API_AUTH", "").strip().lower() == "false":
        print("[INFO] Local authenticated-stack setup is overriding ENABLE_API_AUTH=false")
    os.environ["ENABLE_API_AUTH"] = "true"
    os.environ["API_AUTH_KEY"] = api_auth_key
    os.environ["ATLAS_ADMIN_PASSWORD"] = admin_password
    return {
        "ENABLE_API_AUTH": "true",
        "API_AUTH_KEY": api_auth_key,
        "ATLAS_ADMIN_PASSWORD": admin_password,
    }


def resolve_atlas_core_dir():
    """Return the absolute path to the atlas_core directory."""
    current_dir = os.path.abspath(os.path.dirname(__file__))
    search_dir = current_dir
    while True:
        if os.path.basename(search_dir) == "atlas_core":
            return search_dir
        candidate = os.path.join(search_dir, "atlas_core")
        if os.path.isdir(candidate):
            return candidate
        parent = os.path.dirname(search_dir)
        if parent == search_dir:
            break
        search_dir = parent
    raise FileNotFoundError("atlas_core directory not found")


def database_recreate_on_startup_enabled(production=False):
    """Return the selected Compose stack's destructive-startup setting."""
    default = "false" if production else "true"
    raw = os.getenv("DATABASE_RECREATE_ON_STARTUP", default).strip().lower()
    return raw not in {"false", "0", "no", "off"}


def print_storage_notice(db_only=False, production=False):
    """Print the selected Compose stack's storage posture before startup."""
    if db_only:
        return
    if database_recreate_on_startup_enabled(production=production):
        print(
            "[WARN] Atlas Core development storage is disposable: startup clears "
            "resource rows and the configured MinIO bucket."
        )
        return
    print(
        "[INFO] Durable storage mode: Atlas Core applies verified PostgreSQL migrations "
        "and preserves the configured MinIO bucket."
    )


def compose_container_name(service, production=False):
    """Return the mode-specific explicit container name."""
    prefix = "atlas_core_production" if production else "atlas_core"
    return f"{prefix}_{service}"


def wait_for_database_docker(container_name=None, max_retries=30, delay=1.0, production=False):
    """Wait for PostgreSQL to be ready using docker exec pg_isready."""
    print("[WAIT] Waiting for PostgreSQL to be ready...")
    container_name = container_name or compose_container_name("postgres", production=production)
    password = os.getenv("POSTGRES_PASSWORD", "")

    for attempt in range(max_retries):
        try:
            cmd = [
                "docker",
                "exec",
            ]
            if password:
                cmd.extend(["-e", f"PGPASSWORD={password}"])
            cmd.extend(
                [
                    container_name,
                    "pg_isready",
                    "-U",
                    "atlas",
                    "-d",
                    "atlas_core",
                ]
            )
            result = subprocess.run(
                cmd,
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                print("[OK] PostgreSQL is ready!")
                return True
        except subprocess.TimeoutExpired:
            pass  # Treat timeout as a failed attempt, continue retrying

        if attempt < max_retries - 1:
            print(f"[WAIT] Database not ready (attempt {attempt + 1}/{max_retries}), retrying...")
            time.sleep(delay)

    raise Exception(f"PostgreSQL not ready after {max_retries} attempts")


def wait_for_minio(container_name=None, max_retries=30, delay=1.0, production=False):
    """Wait for MinIO to be ready using docker exec mc ready."""
    print("[WAIT] Waiting for MinIO to be ready...")
    container_name = container_name or compose_container_name("minio", production=production)

    for attempt in range(max_retries):
        try:
            result = subprocess.run(
                ["docker", "exec", container_name, "mc", "ready", "local"],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                print("[OK] MinIO is ready!")
                return True
        except subprocess.TimeoutExpired:
            pass  # Treat timeout as a failed attempt, continue retrying

        if attempt < max_retries - 1:
            print(f"[WAIT] MinIO not ready (attempt {attempt + 1}/{max_retries}), retrying...")
            time.sleep(delay)

    raise Exception(f"MinIO not ready after {max_retries} attempts")


def cleanup_init_containers(production=False):
    """Remove one-shot init containers after they complete."""
    init_containers = [compose_container_name("minio_init", production=production)]

    for container in init_containers:
        try:
            # Check if container exists and is exited
            result = subprocess.run(
                [
                    "docker",
                    "ps",
                    "-a",
                    "--filter",
                    f"name={container}",
                    "--filter",
                    "status=exited",
                    "-q",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.stdout.strip():
                # Container exists and is exited, remove it
                subprocess.run(
                    ["docker", "rm", container],
                    capture_output=True,
                    timeout=5,
                )
                print(f"[CLEANUP] Removed init container: {container}")
        except subprocess.TimeoutExpired as exc:
            logger.debug("Timeout during container cleanup: %s", exc)
        except Exception as exc:
            logger.debug("Error during container cleanup: %s", exc)


def raise_for_exited_development_core(container_name="atlas_core_api"):
    """Fail fast when the development Core container has stopped during startup."""
    state = subprocess.run(
        ["docker", "inspect", "--format={{.State.Status}}", container_name],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    if state.returncode != 0 or state.stdout.strip() not in {"dead", "exited"}:
        return

    logs = subprocess.run(
        ["docker", "logs", "--tail", "200", container_name],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    output = f"{logs.stdout or ''}\n{logs.stderr or ''}"
    if (
        'password authentication failed for user "atlas"' in output
        or r"password authentication failed for user \"atlas\"" in output
    ):
        raise RuntimeError(
            "Atlas Core exited because its PostgreSQL password does not match the existing "
            "development volume. Restore the POSTGRES_PASSWORD that initialized the volume, "
            "or, if its data is disposable, rerun with: python3 atlas_core/scripts/atlas.py "
            "--dev --reset-volumes (deletes all local development volumes)."
        )
    raise RuntimeError(
        f"Atlas Core container {container_name} exited during startup. "
        f"Run 'docker logs {container_name}' to inspect the failure."
    )


def wait_for_api(max_retries=30, delay=2.0, production=False, container_name=None):
    """Wait for the API to be ready."""
    print("[WAIT] Waiting for API to be ready...")
    container_name = container_name or compose_container_name("api", production=production)

    for attempt in range(max_retries):
        try:
            result = subprocess.run(
                [
                    "docker",
                    "exec",
                    container_name,
                    "curl",
                    "-sf",
                    "--connect-timeout",
                    "3",
                    "--max-time",
                    "5",
                    "http://localhost:8000/readiness",
                ],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                print("[OK] API is ready!")
                return True
        except subprocess.TimeoutExpired:
            pass  # Treat timeout as a failed attempt, continue retrying

        if not production:
            try:
                raise_for_exited_development_core()
            except subprocess.TimeoutExpired:
                pass  # Docker state/log inspection was transiently unavailable

        if attempt < max_retries - 1:
            print(f"[WAIT] API not ready (attempt {attempt + 1}/{max_retries}), retrying...")
            time.sleep(delay)

    raise Exception(f"API not ready after {max_retries} attempts")


def ensure_minio_bucket_docker(container_name=None, bucket=None, production=False):
    """Verify the configured bucket after Compose startup."""
    container_name = container_name or compose_container_name("minio", production=production)
    bucket = bucket or configured_minio_bucket()
    print(f"[CHECK] Verifying MinIO bucket: {bucket}")

    try:
        result = subprocess.run(
            ["docker", "exec", container_name, "mc", "stat", f"local/{bucket}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            print("[OK] MinIO bucket ready!")
            return
    except subprocess.TimeoutExpired as error:
        if production:
            raise RuntimeError(f'Timed out verifying durable MinIO bucket "{bucket}"') from error
    except Exception as e:
        if production:
            raise RuntimeError(f'Could not verify durable MinIO bucket "{bucket}"') from e
        print(f"[WARN] Could not verify MinIO bucket: {e}")

    if production:
        raise RuntimeError(
            f'Durable MinIO bucket "{bucket}" is missing; provision it for a clean deployment '
            "or restore the paired MinIO backup before startup"
        )

    print("[OK] Development bucket initialization delegated to minio-init container!")


def wait_for_database_schema_docker(container_name=None, max_retries=60, delay=2.0, production=False):
    """Wait until the Go API has committed a versioned schema migration."""
    print("[WAIT] Waiting for verified database schema...")
    container_name = container_name or compose_container_name("postgres", production=production)
    password = os.getenv("POSTGRES_PASSWORD", "")
    check_sql = "SELECT version FROM atlas_schema_migrations ORDER BY version DESC LIMIT 1"

    for attempt in range(max_retries):
        try:
            cmd = ["docker", "exec"]
            if password:
                cmd.extend(["-e", f"PGPASSWORD={password}"])
            cmd.extend(
                [
                    container_name,
                    "psql",
                    "-U",
                    "atlas",
                    "-d",
                    "atlas_core",
                    "-tAc",
                    check_sql,
                ]
            )
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,
            )
            version = result.stdout.strip()
            if result.returncode == 0 and version.isdigit() and int(version) > 0:
                print(f"[OK] Database schema version {version} ready!")
                return True
        except subprocess.TimeoutExpired:
            pass

        if attempt < max_retries - 1:
            print(f"[WAIT] Schema not ready (attempt {attempt + 1}/{max_retries}), retrying...")
            time.sleep(delay)

    raise Exception(f"Database schema not ready after {max_retries} attempts")


def compose_down_command(*, production=False, tunnel=False, remove_volumes=False, db_only=False):
    """Return the docker compose down command for the selected deployment mode."""
    project_name = PRODUCTION_COMPOSE_PROJECT if production else DEVELOPMENT_COMPOSE_PROJECT
    cmd = ["docker", "compose", "--project-name", project_name]
    if production:
        cmd.extend(["-f", PRODUCTION_DB_COMPOSE_FILE if db_only else PRODUCTION_COMPOSE_FILE])
        if tunnel and not db_only:
            cmd.extend(["-f", TUNNEL_COMPOSE_FILE])
    elif tunnel:
        cmd.extend(["-f", DEV_COMPOSE_FILE, "-f", TUNNEL_COMPOSE_FILE])
    cmd.extend(["down", "--remove-orphans"])
    if remove_volumes:
        cmd.extend(["--volumes", "--rmi", "local"])
    return cmd


def compose_up_command(*, production=False, tunnel=False, service=None, db_only=False):
    """Return the docker compose up command for the selected deployment mode."""
    project_name = PRODUCTION_COMPOSE_PROJECT if production else DEVELOPMENT_COMPOSE_PROJECT
    cmd = ["docker", "compose", "--project-name", project_name]
    if production:
        cmd.extend(["-f", PRODUCTION_DB_COMPOSE_FILE if db_only else PRODUCTION_COMPOSE_FILE])
        if tunnel and not db_only:
            cmd.extend(["-f", TUNNEL_COMPOSE_FILE])
    elif tunnel:
        cmd.extend(["-f", DEV_COMPOSE_FILE, "-f", TUNNEL_COMPOSE_FILE])
    cmd.extend(["up", "-d", "--build"])
    if service:
        cmd.append(service)
    return cmd


def cleanup_containers(atlas_core_dir, remove_volumes=False, production=False, tunnel=False, db_only=False):
    """Stop containers and optionally delete related volumes/images."""
    print("[STOP] Stopping existing containers...")
    docker_dir = os.path.join(atlas_core_dir, "docker")
    if remove_volumes:
        print("[STOP] Removing container volumes and local images...")
    cmd = compose_down_command(
        production=production,
        tunnel=tunnel,
        remove_volumes=remove_volumes,
        db_only=db_only,
    )
    result = subprocess.run(
        cmd,
        cwd=docker_dir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        msg = f"docker compose down failed (exit {result.returncode})"
        logger.error(msg)
        out = (result.stdout or "").strip()
        err = (result.stderr or "").strip()
        if out:
            logger.error("docker compose down stdout:\n%s", out)
        if err:
            logger.error("docker compose down stderr:\n%s", err)
        detail = err or out
        raise RuntimeError(f"{msg}" + (f": {detail}" if detail else ""))


def ensure_tunnel_token():
    """Ensure tunnel startup has a Cloudflare tunnel token."""
    token = os.getenv("CLOUDFLARE_TUNNEL_TOKEN")
    if token:
        print("[INFO] Using CLOUDFLARE_TUNNEL_TOKEN from environment.")
        return True

    print("[WARN] Tunnel mode requires CLOUDFLARE_TUNNEL_TOKEN.")
    return False


def ensure_api_auth(mode):
    """Ensure public/production modes cannot start with development auth defaults."""
    api_auth_key = os.getenv("API_AUTH_KEY", "").strip()
    if not api_auth_key:
        print(f"[ERROR] {mode} requires API_AUTH_KEY to be set.")
        return False
    if api_auth_key in API_AUTH_KEY_PLACEHOLDERS:
        print(f"[ERROR] {mode} requires a real API_AUTH_KEY, not the example placeholder.")
        return False
    admin_password = os.getenv("ATLAS_ADMIN_PASSWORD", "").strip()
    if not admin_password:
        print(f"[ERROR] {mode} requires ATLAS_ADMIN_PASSWORD; the bundled Compose stack mounts no password file.")
        return False
    if admin_password.lower() in ADMIN_PASSWORD_PLACEHOLDERS:
        print(f"[ERROR] {mode} requires a real ATLAS_ADMIN_PASSWORD, not a development default or example.")
        return False
    if len(admin_password) < MIN_PRODUCTION_CREDENTIAL_LENGTH:
        print(
            f"[ERROR] {mode} requires the admin credential to contain at least "
            f"{MIN_PRODUCTION_CREDENTIAL_LENGTH} characters."
        )
        return False

    os.environ["ENABLE_API_AUTH"] = "true"
    return True


def public_base_url_from_hostname(hostname, default_hostname=DEFAULT_TUNNEL_HOSTNAME):
    """Return a public base URL without trailing slash.

    Bare or empty hostnames become HTTPS URLs using default_hostname as the
    fallback. Absolute URLs keep their original scheme.
    """
    default_hostname = (default_hostname or DEFAULT_TUNNEL_HOSTNAME).strip() or DEFAULT_TUNNEL_HOSTNAME
    hostname = (hostname or "").strip()
    if not hostname:
        hostname = default_hostname
    if "://" in hostname:
        scheme, rest = hostname.split("://", 1)
        if not rest.strip("/"):
            return public_base_url_from_hostname(default_hostname, DEFAULT_TUNNEL_HOSTNAME)
        return f"{scheme}://{rest.strip('/')}"
    return f"https://{hostname.strip('/')}"


def tunnel_public_base_url():
    """Return the configured public tunnel base URL."""
    return public_base_url_from_hostname(os.getenv(TUNNEL_HOSTNAME_ENV, DEFAULT_TUNNEL_HOSTNAME))


def tunnel_readiness_url():
    """Return the configured public tunnel readiness URL."""
    return f"{tunnel_public_base_url()}/readiness"


def verify_tunnel_connection(public_url=None, max_retries=10, delay=2.0):
    """Verify the Cloudflare tunnel is working by checking the public readiness endpoint."""
    import json
    import urllib.error
    import urllib.parse
    import urllib.request

    if public_url is None:
        public_url = tunnel_readiness_url()

    print("[WAIT] Verifying Cloudflare tunnel connection...")
    parsed = urllib.parse.urlparse(public_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        print("[WARN] Invalid public URL for tunnel verification")
        return False, "Invalid tunnel verification URL"

    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(public_url, headers={"User-Agent": "ATLAS-Startup"})
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode())
                status = data.get("status")
                if status in {"healthy", "degraded"}:
                    print("[OK] Cloudflare tunnel verified - public endpoint is accessible!")
                    return True, f"Connected and {status}"
        except urllib.error.HTTPError as e:
            logger.debug("Tunnel verification HTTP error: %s", e)
            # A warming tunnel commonly returns 5xx (e.g. Cloudflare 502/503/504)
            # before the origin is reachable, so keep retrying on server errors.
            if e.code >= 500:
                pass  # Tunnel still warming up, retry
            else:
                return False, f"HTTP {e.code}"
        except urllib.error.URLError:
            pass  # Network error, retry
        except json.JSONDecodeError:
            # A warming tunnel may serve a non-JSON HTML error page; keep retrying.
            logger.debug("Tunnel verification got non-JSON response, retrying")
            pass
        except Exception as exc:
            logger.debug("Tunnel verification attempt failed: %s", exc)  # Other error, retry

        if attempt < max_retries - 1:
            print(f"[WAIT] Tunnel not ready (attempt {attempt + 1}/{max_retries}), retrying...")
            time.sleep(delay)

    print("[WARN] Could not verify tunnel - may still be connecting")
    return False, "Connection not verified (may still be starting)"


def start_containers(db_only=False, tunnel=False, reset_volumes=False, production=False):
    """Start Docker containers using docker compose."""
    print_banner()

    try:
        atlas_core_dir = resolve_atlas_core_dir()
        docker_dir = os.path.join(atlas_core_dir, "docker")
        local_auth_values = ensure_local_auth(docker_dir) if not db_only and not production and not tunnel else {}
        if production:
            if not ensure_production_storage_credentials(db_only=db_only):
                sys.exit(1)
            if not db_only and not ensure_api_auth("Production mode"):
                sys.exit(1)
        load_compose_dotenv(docker_dir)
        if production and not db_only and database_recreate_on_startup_enabled(production=True):
            print("[ERROR] Production mode refuses DATABASE_RECREATE_ON_STARTUP=true.")
            sys.exit(1)
        if not production:
            generated_compose_values = {}
            generated_compose_values.update(ensure_minio_secrets())
            generated_compose_values.update(ensure_postgres_password())
            persist_compose_env_values(docker_dir, generated_compose_values)
        if local_auth_values:
            persist_compose_env_values(docker_dir, local_auth_values, env_filename=LOCAL_AUTH_ENV_FILE)
        print_storage_notice(db_only=db_only, production=production)

        if tunnel and not production:
            if not ensure_api_auth("Tunnel mode"):
                sys.exit(1)

        if tunnel:
            if not ensure_tunnel_token():
                sys.exit(1)

        # Design decision: --reset-volumes applies to whichever Compose project
        # the operator selected. With --production, it intentionally deletes that
        # project's durable PostgreSQL and MinIO volumes; callers must choose it knowingly.
        cleanup_containers(
            atlas_core_dir,
            remove_volumes=reset_volumes,
            production=production,
            tunnel=tunnel,
            db_only=db_only,
        )

        if db_only:
            print("[START] Starting PostgreSQL container...")
            subprocess.run(
                compose_up_command(production=production, service="postgres", db_only=db_only),
                check=True,
                cwd=docker_dir,
            )
            print("[OK] PostgreSQL container started successfully!")
        elif tunnel:
            print("[START] Starting all containers with Cloudflare tunnel...")
            subprocess.run(
                compose_up_command(production=production, tunnel=True),
                check=True,
                cwd=docker_dir,
            )
            print("[OK] All containers with Cloudflare tunnel started successfully!")
        else:
            print("[START] Starting all containers (PostgreSQL, MinIO, API)...")
            subprocess.run(
                compose_up_command(production=production),
                check=True,
                cwd=docker_dir,
            )
            print("[OK] All containers started successfully!")

        wait_for_database_docker(production=production)

        if not db_only:
            wait_for_minio(production=production)
            ensure_minio_bucket_docker(production=production)
            cleanup_init_containers(production=production)
            wait_for_api(production=production)
            wait_for_database_schema_docker(production=production)
        else:
            print("[INFO] --db-only: schema is created when the API starts (EnsureTables in db.go)")

        print("\n" + "=" * 60)
        print("ATLAS Core System - Connection Information")
        print("=" * 60)

        if not db_only:
            print("\nAPI:")
            print("  HTTP:   http://localhost:8000")
            print("  Health:    http://localhost:8000/health")
            print("  Readiness: http://localhost:8000/readiness")
            if not production and not tunnel:
                print("  Admin:     admin (password stored in atlas_core/docker/.env.local)")
            if production:
                print("  Auth:      X-API-Key required for API routes")

        print("\nPostgreSQL:")
        print("  Host:     localhost (or 127.0.0.1)")
        print("  Port:     5432")
        print("  Database: atlas_core")
        print("  User:     atlas")
        if os.getenv("POSTGRES_PASSWORD"):
            print("  Password: **** (set, redacted)")
        else:
            print("  Password: (set POSTGRES_PASSWORD)")
        print("  URL:      postgresql://atlas:<POSTGRES_PASSWORD>@localhost:5432/atlas_core")

        if not db_only:
            print("\nMinIO (Object Storage):")
            print("  API:      http://localhost:9000")
            print("  Console:  http://localhost:9001")
            print("  User:     atlas")
            print("  Password: *****")
            print(f"  Bucket:   {configured_minio_bucket()}")

        if tunnel:
            tunnel_verified, tunnel_status = verify_tunnel_connection()
            print("\nCloudflare Tunnel:")
            print(f"  Public URL: {tunnel_public_base_url()}")
            if tunnel_verified:
                print(f"  Status:     [OK] {tunnel_status}")
            else:
                print(f"  Status:     [WARN] {tunnel_status}")

        print("=" * 60)
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Failed to start containers: {e}")
        sys.exit(1)
    except FileNotFoundError as e:
        print(f"[ERROR] {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[STOP] Startup cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] {e}")
        sys.exit(1)


def show_interactive_menu():
    """Display interactive menu and return user selection."""
    print("\n" + "=" * 60)
    print("ATLAS Core System - Startup Options")
    print("=" * 60 + "\n")
    print("Select startup option:")
    print("  1. Start all containers (PostgreSQL, MinIO, API) - Default")
    print("  2. Start all containers with Cloudflare tunnel")
    print("\n" + "-" * 60)

    while True:
        try:
            choice = input("Enter your choice (1-2) [default: 1]: ").strip()

            # Default to option 1 if empty
            if not choice:
                choice = "1"

            if choice == "1":
                return (False, False)  # (db_only, tunnel)
            elif choice == "2":
                return (False, True)  # (db_only, tunnel)
            else:
                print(f"[ERROR] Invalid choice: {choice}. Please enter 1 or 2.")
        except KeyboardInterrupt:
            print("\n\n[EXIT] Cancelled by user")
            sys.exit(0)
        except EOFError:
            print("\n\n[EXIT] Cancelled by user")
            sys.exit(0)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="ATLAS Core System - Docker Container Manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python atlas.py              # Interactive menu to choose startup options
  python atlas.py --dev         # Start local dev containers without prompting
  python atlas.py --tunnel     # Start all containers with Cloudflare tunnel (non-interactive)
  python atlas.py --production # Start production-image containers (non-interactive)
  python atlas.py --production --tunnel
  python atlas.py --db-only    # Start only PostgreSQL container (non-interactive)
        """,
    )

    parser.add_argument(
        "--dev",
        action="store_true",
        help="Start all development containers without prompting",
    )

    parser.add_argument(
        "--db-only",
        action="store_true",
        help="Start only the PostgreSQL container (skip API and MinIO)",
    )

    parser.add_argument(
        "--tunnel",
        action="store_true",
        help="Start all containers with Cloudflare tunnel for public HTTPS access",
    )
    parser.add_argument(
        "--production",
        action="store_true",
        help="Start the production Docker Compose stack instead of the development stack",
    )
    parser.add_argument(
        "--reset-volumes",
        action="store_true",
        help=(
            "Remove the selected Compose project's volumes and images before starting. "
            "With --production, this deliberately deletes durable production PostgreSQL "
            "and MinIO volumes."
        ),
    )

    args = parser.parse_args()

    if args.dev and (args.db_only or args.tunnel or args.production):
        print("[ERROR] --dev cannot be combined with --db-only, --tunnel, or --production")
        sys.exit(1)

    if args.db_only and args.tunnel:
        print("[ERROR] Cannot use --db-only and --tunnel together")
        sys.exit(1)

    if args.production and args.db_only and args.reset_volumes:
        print("[ERROR] Cannot reset the complete production storage pair in --db-only mode")
        sys.exit(1)

    # Interactive menu only when invoked with no flags (any flag => non-interactive).
    if not (args.dev or args.db_only or args.tunnel or args.production or args.reset_volumes):
        db_only, tunnel = show_interactive_menu()
    else:
        db_only = args.db_only
        tunnel = args.tunnel

    start_containers(
        db_only=db_only,
        tunnel=tunnel,
        reset_volumes=args.reset_volumes,
        production=args.production,
    )


if __name__ == "__main__":
    main()
