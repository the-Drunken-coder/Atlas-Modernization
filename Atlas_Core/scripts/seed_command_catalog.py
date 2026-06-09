#!/usr/bin/env python3
"""Utility script for uploading the command catalog through the Atlas API."""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib import error, request
from urllib.parse import urlparse


COMMAND_CATALOG_OBJECT_ID = "command_catalog"
COMMAND_CATALOG_FILE = (
    Path(__file__).resolve().parents[1] / "command_catalog" / "command_catalog.json"
)
DEFAULT_API_BASE_URL = "http://localhost:8000"
API_REQUEST_TIMEOUT = 10.0
CATALOG_UPLOAD_FILENAME = "command_catalog"

logger = logging.getLogger(__name__)

COMMAND_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
PARAMETER_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
PARAMETER_TYPES = {"string", "number", "boolean", "object", "array"}
CATALOG_TOP_LEVEL_FIELDS = {"type", "name", "description", "commands"}
COMMAND_FIELDS = {"id", "name", "description", "parameters_schema"}
PARAMETER_FIELDS = {"type", "description", "required", "minimum", "maximum"}


def _validate_http_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"Unsupported URL scheme: {parsed.scheme!r}")
    if not parsed.netloc:
        raise ValueError("URL must include host")
    if parsed.username or parsed.password:
        raise ValueError("URL must not include credentials")
    if parsed.query:
        raise ValueError("URL must not include a query string")
    if parsed.fragment:
        raise ValueError("URL must not include a fragment")
    return url


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _validate_parameter_schema(command_id: str, schema: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(schema, dict):
        return [f"{command_id}.parameters_schema must be an object"]

    for parameter_name, parameter in schema.items():
        path = f"{command_id}.parameters_schema.{parameter_name}"
        if not _nonempty_string(parameter_name) or not PARAMETER_NAME_PATTERN.fullmatch(parameter_name):
            errors.append(f"{path}: parameter name must be lowercase snake_case")
        if not isinstance(parameter, dict):
            errors.append(f"{path} must be an object")
            continue

        unknown_fields = set(parameter) - PARAMETER_FIELDS
        for field in sorted(unknown_fields):
            errors.append(f"{path}.{field}: unknown parameter schema field")

        parameter_type = parameter.get("type")
        if parameter_type not in PARAMETER_TYPES:
            errors.append(f"{path}.type must be one of {sorted(PARAMETER_TYPES)}")
        if not _nonempty_string(parameter.get("description")):
            errors.append(f"{path}.description must be a non-empty string")
        if not isinstance(parameter.get("required"), bool):
            errors.append(f"{path}.required must be a boolean")

        minimum = parameter.get("minimum")
        maximum = parameter.get("maximum")
        if minimum is not None and not _finite_number(minimum):
            errors.append(f"{path}.minimum must be a finite number")
        if maximum is not None and not _finite_number(maximum):
            errors.append(f"{path}.maximum must be a finite number")
        if parameter_type != "number" and ("minimum" in parameter or "maximum" in parameter):
            errors.append(f"{path}: minimum/maximum are only valid for number parameters")
        if _finite_number(minimum) and _finite_number(maximum) and float(minimum) > float(maximum):
            errors.append(f"{path}: minimum must be <= maximum")

    return errors


def _validate_command_catalog_data(catalog_data: dict[str, Any]) -> None:
    errors: list[str] = []

    unknown_fields = set(catalog_data) - CATALOG_TOP_LEVEL_FIELDS
    for field in sorted(unknown_fields):
        errors.append(f"{field}: unknown top-level catalog field")

    if catalog_data.get("type") != "command_catalog":
        errors.append("type must be command_catalog")
    if not _nonempty_string(catalog_data.get("name")):
        errors.append("name must be a non-empty string")
    if not _nonempty_string(catalog_data.get("description")):
        errors.append("description must be a non-empty string")

    commands = catalog_data.get("commands")
    if not isinstance(commands, list) or not commands:
        errors.append("commands must be a non-empty array")
        commands = []

    seen_ids: set[str] = set()
    for index, command in enumerate(commands):
        path = f"commands[{index}]"
        if not isinstance(command, dict):
            errors.append(f"{path} must be an object")
            continue

        unknown_command_fields = set(command) - COMMAND_FIELDS
        for field in sorted(unknown_command_fields):
            errors.append(f"{path}.{field}: unknown command field")

        command_id = command.get("id")
        if not _nonempty_string(command_id) or not COMMAND_ID_PATTERN.fullmatch(command_id):
            errors.append(f"{path}.id must be lowercase snake_case")
            command_id = f"<invalid-{index}>"
        elif command_id in seen_ids:
            errors.append(f"{path}.id {command_id!r} is duplicated")
        else:
            seen_ids.add(command_id)

        if not _nonempty_string(command.get("name")):
            errors.append(f"{path}.name must be a non-empty string")
        if not _nonempty_string(command.get("description")):
            errors.append(f"{path}.description must be a non-empty string")
        errors.extend(_validate_parameter_schema(str(command_id), command.get("parameters_schema")))

    if errors:
        formatted = "\n  - ".join(errors)
        raise ValueError(f"command catalog validation failed:\n  - {formatted}")


def _load_command_catalog_data() -> Optional[dict[str, Any]]:
    """Load the preset catalog from disk."""
    if not COMMAND_CATALOG_FILE.exists():
        print(f"[CATALOG] Command catalog file not found: {COMMAND_CATALOG_FILE}")
        return None

    try:
        with COMMAND_CATALOG_FILE.open("r", encoding="utf-8") as catalog_stream:
            catalog_data = json.load(catalog_stream)
            if not isinstance(catalog_data, dict):
                raise ValueError("command catalog must be a JSON object")
            _validate_command_catalog_data(catalog_data)
            return catalog_data
    except Exception as exc:
        print(f"[CATALOG] Failed to read command catalog file: {exc}")
        return None


def _build_api_base_url(explicit: Optional[str] = None) -> str:
    configured = explicit or os.getenv("ATLAS_CORE_API_URL") or DEFAULT_API_BASE_URL
    return _validate_http_url(configured.rstrip("/"))


def _api_request(
    method: str, url: str, payload: Optional[dict[str, Any]] = None
) -> tuple[int, str]:
    """Issue a JSON request to the Atlas Core API."""
    safe_url = _validate_http_url(url)
    headers = {"Accept": "application/json"}
    data: Optional[bytes] = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")

    # nosemgrep: python.django.security.injection.ssrf.ssrf-injection-urllib.ssrf-injection-urllib
    req = request.Request(safe_url, data=data, headers=headers, method=method)
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with request.urlopen(req, timeout=API_REQUEST_TIMEOUT) as response:
        body = response.read().decode("utf-8")
        return response.status, body


def _merge_catalog_payload(catalog_data: dict[str, Any], api_base_url: str) -> bool:
    object_url = f"{api_base_url}/objects/{COMMAND_CATALOG_OBJECT_ID}"
    try:
        _api_request("PATCH", object_url, {"extra": catalog_data})
        return True
    except error.HTTPError as exc:
        print(f"[CATALOG] API request failed (PATCH {object_url}): {exc}")
    except error.URLError as exc:
        print(f"[CATALOG] API unreachable during PATCH {object_url}: {exc}")
    except Exception as exc:  # pragma: no cover
        print(f"[CATALOG] Unexpected error during catalog metadata patch: {exc}")
    return False


def _ensure_catalog_uploaded(api_base_url: str) -> bool:
    """Upload the catalog file to storage via the API."""
    upload_url = _validate_http_url(f"{api_base_url}/objects/upload")

    try:
        catalog_bytes = COMMAND_CATALOG_FILE.read_bytes()
    except Exception as exc:
        print(f"[CATALOG] Failed to read catalog file for upload: {exc}")
        return False

    # Generate a unique boundary
    boundary = f"----AtlasCatalogBoundary{uuid.uuid4().hex}"
    crlf = b"\r\n"

    # Build multipart form data body manually
    body_parts = []

    # Add object_id field
    body_parts.append(f"--{boundary}".encode("utf-8"))
    body_parts.append(b'Content-Disposition: form-data; name="object_id"')
    body_parts.append(b"")
    body_parts.append(COMMAND_CATALOG_OBJECT_ID.encode("utf-8"))

    # Add usage_hint field
    body_parts.append(f"--{boundary}".encode("utf-8"))
    body_parts.append(b'Content-Disposition: form-data; name="usage_hint"')
    body_parts.append(b"")
    body_parts.append(b"command_catalog")

    # Add type field
    body_parts.append(f"--{boundary}".encode("utf-8"))
    body_parts.append(b'Content-Disposition: form-data; name="type"')
    body_parts.append(b"")
    body_parts.append(b"command_catalog")

    # Add file field
    body_parts.append(f"--{boundary}".encode("utf-8"))
    body_parts.append(
        f'Content-Disposition: form-data; name="file"; filename="{CATALOG_UPLOAD_FILENAME}"'.encode("utf-8")
    )
    body_parts.append(b"Content-Type: application/json")
    body_parts.append(b"")
    body_parts.append(catalog_bytes)

    # Add closing boundary
    body_parts.append(f"--{boundary}--".encode("utf-8"))

    # Join all parts with CRLF
    body_bytes = crlf.join(body_parts)

    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body_bytes)),
        "Accept": "application/json",
    }

    # nosemgrep: python.django.security.injection.ssrf.ssrf-injection-urllib.ssrf-injection-urllib
    req = request.Request(upload_url, data=body_bytes, headers=headers, method="POST")

    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with request.urlopen(req, timeout=API_REQUEST_TIMEOUT) as resp:
            body = resp.read()
            snippet = body[:200].decode("utf-8", errors="replace") if body else ""
            logger.debug(
                "catalog upload OK status=%s body_len=%d body_prefix=%r",
                resp.status,
                len(body),
                snippet,
            )
        return True
    except error.HTTPError as exc:
        try:
            error_body = exc.read().decode("utf-8")
            print(f"[CATALOG] API request failed (POST {upload_url}): {exc}")
            print(f"[CATALOG] Error details: {error_body}")
        except Exception:
            print(f"[CATALOG] API request failed (POST {upload_url}): {exc}")
    except error.URLError as exc:
        print(f"[CATALOG] API unreachable during POST {upload_url}: {exc}")
    except Exception as exc:  # pragma: no cover
        print(f"[CATALOG] Unexpected error during catalog upload: {exc}")
    return False


def publish_command_catalog(*, api_base_url: Optional[str] = None) -> bool:
    """Seed the command catalog using the HTTP API."""
    catalog_data = _load_command_catalog_data()
    if catalog_data is None:
        return False

    try:
        base_url = _build_api_base_url(api_base_url)
    except ValueError as exc:
        print(f"[CATALOG] Invalid API base URL: {exc}")
        return False

    if not _ensure_catalog_uploaded(base_url):
        return False

    if not _merge_catalog_payload(catalog_data, base_url):
        return False

    print(f"[CATALOG] Uploaded command catalog via API ({COMMAND_CATALOG_OBJECT_ID})")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload the Atlas command catalog through the API")
    parser.add_argument(
        "--api-url", help="Base URL for the Atlas Core API (default: env or localhost)"
    )
    args = parser.parse_args()

    success = publish_command_catalog(api_base_url=args.api_url)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
