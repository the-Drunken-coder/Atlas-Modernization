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

SNAKE_CASE_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
CATALOG_TOP_LEVEL_FIELDS = {"type", "name", "description", "commands"}
COMMAND_FIELDS = {"id", "name", "description", "parameters_schema"}
PARAMETER_FIELDS = {"type", "description", "required", "minimum", "maximum"}
PARAMETER_TYPES = {"string", "number", "boolean"}


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


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _require_object(value: Any, path: str, errors: list[str]) -> Optional[dict[str, Any]]:
    if isinstance(value, dict):
        return value
    errors.append(f"{path} must be an object")
    return None


def _reject_unknown_fields(
    value: dict[str, Any],
    *,
    allowed: set[str],
    path: str,
    label: str,
    errors: list[str],
) -> None:
    for field in sorted(set(value) - allowed):
        errors.append(f"{path}.{field}: unknown {label} field")


def _validate_finite_numbers(value: Any, path: str, errors: list[str]) -> None:
    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            errors.append(f"{path} must be a finite number")
        return
    if isinstance(value, dict):
        for key, child in value.items():
            _validate_finite_numbers(child, f"{path}.{key}", errors)
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            _validate_finite_numbers(child, f"{path}[{index}]", errors)


def _validate_parameter_schema(value: Any, path: str, errors: list[str]) -> None:
    parameters = _require_object(value, path, errors)
    if parameters is None:
        return

    for parameter_name, parameter_value in parameters.items():
        parameter_path = f"{path}.{parameter_name}"
        if not isinstance(parameter_name, str) or not SNAKE_CASE_PATTERN.fullmatch(parameter_name):
            errors.append(f"{parameter_path}: parameter name must be lowercase snake_case")
        parameter = _require_object(parameter_value, parameter_path, errors)
        if parameter is None:
            continue

        _reject_unknown_fields(
            parameter,
            allowed=PARAMETER_FIELDS,
            path=parameter_path,
            label="parameter",
            errors=errors,
        )

        parameter_type = parameter.get("type")
        if parameter_type not in PARAMETER_TYPES:
            allowed = ", ".join(sorted(PARAMETER_TYPES))
            errors.append(f"{parameter_path}.type must be one of: {allowed}")
        if not _is_nonempty_string(parameter.get("description")):
            errors.append(f"{parameter_path}.description must be a non-empty string")
        if not isinstance(parameter.get("required"), bool):
            errors.append(f"{parameter_path}.required must be a boolean")

        for bound_name in ("minimum", "maximum"):
            if bound_name in parameter and not _is_finite_number(parameter[bound_name]):
                errors.append(f"{parameter_path}.{bound_name} must be a finite number")

        has_type = "type" in parameter
        has_numeric_bounds = "minimum" in parameter or "maximum" in parameter
        # Missing type is already reported above; avoid duplicating that with a bounds error.
        if has_type and parameter_type != "number" and has_numeric_bounds:
            errors.append(f"{parameter_path}: minimum and maximum are only valid for number parameters")
        if (
            _is_finite_number(parameter.get("minimum"))
            and _is_finite_number(parameter.get("maximum"))
            and float(parameter["minimum"]) > float(parameter["maximum"])
        ):
            errors.append(f"{parameter_path}: minimum must be <= maximum")


def _validate_command_catalog_data(catalog_data: dict[str, Any]) -> None:
    errors: list[str] = []
    _reject_unknown_fields(
        catalog_data,
        allowed=CATALOG_TOP_LEVEL_FIELDS,
        path="$",
        label="catalog",
        errors=errors,
    )
    _validate_finite_numbers(catalog_data, "$", errors)

    if catalog_data.get("type") != "command_catalog":
        errors.append("$.type must be 'command_catalog'")
    if not _is_nonempty_string(catalog_data.get("name")):
        errors.append("$.name must be a non-empty string")
    if not _is_nonempty_string(catalog_data.get("description")):
        errors.append("$.description must be a non-empty string")

    commands = catalog_data.get("commands")
    if not isinstance(commands, list) or not commands:
        errors.append("$.commands must be a non-empty array")
        commands = []

    seen_ids: set[str] = set()
    for index, command_value in enumerate(commands):
        command_path = f"$.commands[{index}]"
        command = _require_object(command_value, command_path, errors)
        if command is None:
            continue

        _reject_unknown_fields(
            command,
            allowed=COMMAND_FIELDS,
            path=command_path,
            label="command",
            errors=errors,
        )

        command_id = command.get("id")
        if not isinstance(command_id, str) or not SNAKE_CASE_PATTERN.fullmatch(command_id):
            errors.append(f"{command_path}.id must be lowercase snake_case")
        elif command_id in seen_ids:
            errors.append(f"{command_path}.id {command_id!r} is duplicated")
        else:
            seen_ids.add(command_id)

        if not _is_nonempty_string(command.get("name")):
            errors.append(f"{command_path}.name must be a non-empty string")
        if not _is_nonempty_string(command.get("description")):
            errors.append(f"{command_path}.description must be a non-empty string")
        _validate_parameter_schema(
            command.get("parameters_schema"),
            f"{command_path}.parameters_schema",
            errors,
        )

    if errors:
        raise ValueError("command catalog validation failed:\n  - " + "\n  - ".join(errors))


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
