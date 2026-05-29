#!/usr/bin/env python3
"""
ATLAS Core System - Docker Container Management

Simple script to start Docker containers for the ATLAS Core System.

Usage:
    python atlas.py              # Interactive menu to choose startup options
    python atlas.py --tunnel     # Start all containers with Cloudflare tunnel (non-interactive)
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
    from .seed_command_catalog import publish_command_catalog
except ImportError:
    from seed_command_catalog import publish_command_catalog

logger = logging.getLogger(__name__)


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
    root_password = os.getenv("MINIO_ROOT_PASSWORD")
    secret_key = os.getenv("MINIO_SECRET_KEY")
    root_user = os.getenv("MINIO_ROOT_USER")
    access_key = os.getenv("MINIO_ACCESS_KEY")

    if not root_password and not secret_key:
        generated = secrets.token_urlsafe(32)
        os.environ["MINIO_ROOT_PASSWORD"] = generated
        os.environ["MINIO_SECRET_KEY"] = generated
        created.extend(["MINIO_ROOT_PASSWORD", "MINIO_SECRET_KEY"])
    elif not root_password and secret_key:
        os.environ["MINIO_ROOT_PASSWORD"] = secret_key
        created.append("MINIO_ROOT_PASSWORD")
    elif root_password and not secret_key:
        os.environ["MINIO_SECRET_KEY"] = root_password
        created.append("MINIO_SECRET_KEY")

    if root_user and not access_key:
        os.environ["MINIO_ACCESS_KEY"] = root_user
        created.append("MINIO_ACCESS_KEY")

    if created:
        print(f"[INFO] Set MinIO credentials for this run: {', '.join(created)}")


def ensure_postgres_password():
    """Ensure POSTGRES_PASSWORD is set (generate one if missing)."""
    if not os.getenv("POSTGRES_PASSWORD"):
        generated = secrets.token_urlsafe(24)
        os.environ["POSTGRES_PASSWORD"] = generated
        print("[INFO] Generated POSTGRES_PASSWORD for this run (redacted)")


def resolve_atlas_core_dir():
    """Return the absolute path to the Atlas_Core directory."""
    current_dir = os.path.abspath(os.path.dirname(__file__))
    search_dir = current_dir
    while True:
        if os.path.basename(search_dir) == "Atlas_Core":
            return search_dir
        candidate = os.path.join(search_dir, "Atlas_Core")
        if os.path.isdir(candidate):
            return candidate
        parent = os.path.dirname(search_dir)
        if parent == search_dir:
            break
        search_dir = parent
    raise FileNotFoundError("Atlas_Core directory not found")


def wait_for_database_docker(container_name="atlas_core_postgres", max_retries=30, delay=1.0):
    """Wait for PostgreSQL to be ready using docker exec pg_isready."""
    print("[WAIT] Waiting for PostgreSQL to be ready...")
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


def wait_for_minio(container_name="atlas_core_minio", max_retries=30, delay=1.0):
    """Wait for MinIO to be ready using docker exec mc ready."""
    print("[WAIT] Waiting for MinIO to be ready...")

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


def cleanup_init_containers():
    """Remove one-shot init containers after they complete."""
    init_containers = ["atlas_core_minio_init"]

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


def wait_for_api(max_retries=30, delay=2.0):
    """Wait for the API to be ready."""
    print("[WAIT] Waiting for API to be ready...")

    for attempt in range(max_retries):
        try:
            result = subprocess.run(
                [
                    "docker",
                    "exec",
                    "atlas_core_api",
                    "curl",
                    "-sf",
                    "--connect-timeout",
                    "3",
                    "--max-time",
                    "5",
                    "http://localhost:8000/health",
                ],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                print("[OK] API is ready!")
                return True
        except subprocess.TimeoutExpired:
            pass  # Treat timeout as a failed attempt, continue retrying

        if attempt < max_retries - 1:
            print(f"[WAIT] API not ready (attempt {attempt + 1}/{max_retries}), retrying...")
            time.sleep(delay)

    raise Exception(f"API not ready after {max_retries} attempts")


def ensure_minio_bucket_docker(container_name="atlas_core_minio", bucket="atlas-media"):
    """Ensure the MinIO bucket exists using mc client.

    Note: The Go service also ensures the bucket exists on startup,
    but this provides an early check during container initialization.
    """
    print(f"[BUILD] Ensuring MinIO bucket exists: {bucket}")

    # The minio-init container in docker compose handles bucket creation,
    # but we verify it here as a fallback
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
    except subprocess.TimeoutExpired:
        pass
    except Exception as e:
        print(f"[WARN] Could not verify MinIO bucket: {e}")

    # Bucket creation is handled by minio-init container in docker compose
    print("[OK] MinIO bucket initialization delegated to minio-init container!")


def create_database_tables_docker(container_name="atlas_core_postgres"):
    """Create database tables using docker exec.

    Note: With the Go implementation, tables are created automatically by the
    Go service on startup. This function is kept for compatibility but now
    uses direct SQL instead of Python ORM.
    """
    password = os.getenv("POSTGRES_PASSWORD", "")
    try:
        print("[BUILD] Creating database tables via docker exec...")

        # SQL for creating tables (matches Go implementation)
        sql = """
-- Create entities table
CREATE TABLE IF NOT EXISTS entities (
    entity_id VARCHAR(50) PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    subtype VARCHAR(50),
    alias VARCHAR(255),
    json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_subtype ON entities(subtype);
CREATE INDEX IF NOT EXISTS idx_entities_alias ON entities(alias);

-- Create tasks table
CREATE TABLE IF NOT EXISTS tasks (
    task_id VARCHAR(50) PRIMARY KEY,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    entity_id VARCHAR(50) REFERENCES entities(entity_id) ON DELETE SET NULL,
    json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_entity_id ON tasks(entity_id);

-- Create objects table
CREATE TABLE IF NOT EXISTS objects (
    object_id VARCHAR(50) PRIMARY KEY,
    path VARCHAR(500) UNIQUE,
    content_type VARCHAR(100),
    type VARCHAR(50),
    json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- NOTE: objects.path already has a UNIQUE constraint (implicit unique index),
-- so a separate idx_objects_path would be redundant and is intentionally omitted
-- to stay converged with internal/database/db.go (EnsureTables) — the schema authority.
CREATE INDEX IF NOT EXISTS idx_objects_content_type ON objects(content_type);
CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(type);
CREATE INDEX IF NOT EXISTS idx_objects_referenced_by ON objects USING GIN ((json->'referenced_by') jsonb_path_ops);

-- Tombstones for changed-since (matches internal/database/db.go)
CREATE TABLE IF NOT EXISTS deletions (
    id BIGSERIAL PRIMARY KEY,
    resource_type VARCHAR(20) NOT NULL,
    resource_id VARCHAR(50) NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_deletions_deleted_at ON deletions(deleted_at);
CREATE INDEX IF NOT EXISTS idx_deletions_resource_type ON deletions(resource_type);
"""

        cmd = ["docker", "exec"]
        if password:
            cmd.extend(["-e", f"PGPASSWORD={password}"])
        cmd.extend(["-i", container_name, "psql", "-U", "atlas", "-d", "atlas_core"])

        result = subprocess.run(
            cmd,
            input=sql,
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            print(f"[ERROR] psql error: {result.stderr}")
            raise Exception(f"Failed to create tables: {result.stderr}")

        print("[OK] Database tables created successfully!")

    except Exception as e:
        print(f"[ERROR] Failed to create tables: {e}")
        raise


def cleanup_containers(atlas_core_dir, remove_volumes=False):
    """Stop containers and optionally delete related volumes/images."""
    print("[STOP] Stopping existing containers...")
    docker_dir = os.path.join(atlas_core_dir, "docker")
    cmd = ["docker", "compose", "down"]
    if remove_volumes:
        print("[STOP] Removing container volumes and local images...")
        cmd.extend(["--volumes", "--rmi", "local"])
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


def verify_tunnel_connection(
    public_url="https://atlascommandapi.org/health", max_retries=10, delay=2.0
):
    """Verify the Cloudflare tunnel is working by checking the public health endpoint."""
    import urllib.request
    import urllib.error
    import urllib.parse
    import json

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
                if data.get("status") == "healthy":
                    print("[OK] Cloudflare tunnel verified - public endpoint is accessible!")
                    return True, "Connected and healthy"
        except urllib.error.HTTPError as e:
            logger.debug("Tunnel verification HTTP error: %s", e)
            return False, f"HTTP {e.code}"
        except urllib.error.URLError:
            pass  # Network error, retry
        except json.JSONDecodeError:
            return False, "Non-JSON response"
        except Exception as exc:
            logger.debug("Tunnel verification attempt failed: %s", exc)  # Other error, retry

        if attempt < max_retries - 1:
            print(f"[WAIT] Tunnel not ready (attempt {attempt + 1}/{max_retries}), retrying...")
            time.sleep(delay)

    print("[WARN] Could not verify tunnel - may still be connecting")
    return False, "Connection not verified (may still be starting)"


def start_containers(db_only=False, tunnel=False, reset_volumes=False):
    """Start Docker containers using docker compose."""
    print_banner()

    try:
        atlas_core_dir = resolve_atlas_core_dir()
        ensure_minio_secrets()
        ensure_postgres_password()

        if tunnel:
            if not ensure_tunnel_token():
                sys.exit(1)

        cleanup_containers(atlas_core_dir, remove_volumes=reset_volumes)

        docker_dir = os.path.join(atlas_core_dir, "docker")

        if db_only:
            print("[START] Starting PostgreSQL container...")
            subprocess.run(
                ["docker", "compose", "up", "-d", "--build", "postgres"],
                check=True,
                cwd=docker_dir,
            )
            print("[OK] PostgreSQL container started successfully!")
        elif tunnel:
            print("[START] Starting all containers with Cloudflare tunnel...")
            subprocess.run(
                ["docker", "compose", "--profile", "tunnel", "up", "-d", "--build"],
                check=True,
                cwd=docker_dir,
            )
            print("[OK] All containers with Cloudflare tunnel started successfully!")
        else:
            print("[START] Starting all containers (PostgreSQL, MinIO, API)...")
            subprocess.run(
                ["docker", "compose", "up", "-d", "--build"],
                check=True,
                cwd=docker_dir,
            )
            print("[OK] All containers started successfully!")

        wait_for_database_docker()
        create_database_tables_docker()

        if not db_only:
            wait_for_minio()
            ensure_minio_bucket_docker()
            cleanup_init_containers()
            wait_for_api()

        print("\n" + "=" * 60)
        print("ATLAS Core System - Connection Information")
        print("=" * 60)

        if not db_only:
            print("\nAPI:")
            print("  HTTP:   http://localhost:8000")
            print("  Health: http://localhost:8000/health")

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
            print("  Bucket:   atlas-media")

        if tunnel:
            tunnel_verified, tunnel_status = verify_tunnel_connection()
            print("\nCloudflare Tunnel:")
            print("  Public URL: https://atlascommandapi.org")
            if tunnel_verified:
                print(f"  Status:     [OK] {tunnel_status}")
            else:
                print(f"  Status:     [WARN] {tunnel_status}")

        print("=" * 60)
        if not db_only and not publish_command_catalog():
            print("[ERROR] Failed to publish command catalog")
            sys.exit(1)

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
  python atlas.py --tunnel     # Start all containers with Cloudflare tunnel (non-interactive)
  python atlas.py --db-only    # Start only PostgreSQL container (non-interactive)
        """,
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
        "--reset-volumes",
        action="store_true",
        help="Remove local Docker volumes and images before starting",
    )

    args = parser.parse_args()

    if args.db_only and args.tunnel:
        print("[ERROR] Cannot use --db-only and --tunnel together")
        sys.exit(1)

    # Interactive menu only when invoked with no flags (any flag => non-interactive).
    if not (args.db_only or args.tunnel or args.reset_volumes):
        db_only, tunnel = show_interactive_menu()
    else:
        db_only = args.db_only
        tunnel = args.tunnel

    start_containers(db_only=db_only, tunnel=tunnel, reset_volumes=args.reset_volumes)


if __name__ == "__main__":
    main()
