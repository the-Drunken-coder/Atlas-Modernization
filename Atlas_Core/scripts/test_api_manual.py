#!/usr/bin/env python3
"""
Manual API testing script - Add entities, tasks, and objects to the ATLAS Core API.

Usage:
    python test_api_manual.py
    # The script will prompt you to enter the API URL
"""

from __future__ import annotations

import logging
import os
import sys
import time
import uuid
from datetime import datetime
from typing import Any

import requests

try:
    from .atlas import DEFAULT_TUNNEL_HOSTNAME, public_base_url_from_hostname
except ImportError:
    from atlas import DEFAULT_TUNNEL_HOSTNAME, public_base_url_from_hostname

logger = logging.getLogger(__name__)

# Global API URL - will be set from user input
API_BASE_URL = "http://localhost:8000"
REMOTE_API_URL_ENV = "ATLAS_API_REMOTE_URL"
TUNNEL_HOSTNAME_ENV = "ATLAS_TUNNEL_HOSTNAME"


def configured_remote_api_url() -> str:
    """Return the remote API URL used by --remote mode."""
    configured = os.environ.get(REMOTE_API_URL_ENV, "").strip()
    if not configured:
        configured = os.environ.get(TUNNEL_HOSTNAME_ENV, DEFAULT_TUNNEL_HOSTNAME)
    return public_base_url_from_hostname(configured, DEFAULT_TUNNEL_HOSTNAME)


def confirm_remote_writes() -> bool:
    """Require explicit consent before writing to the shared deployment."""
    print()
    print("[WARNING] Remote API writes are enabled.")
    print(f"[WARNING] Target: {API_BASE_URL}")
    answer = input("Type 'yes' to create test data against this remote API: ").strip()
    return answer == "yes"


def check_health():
    """Check if the API is healthy."""
    try:
        response = requests.get(f"{API_BASE_URL}/health", timeout=10)
        response.raise_for_status()
        data = response.json()
        print(f"[OK] API Health: {data.get('status', 'unknown')}")
        return True
    except requests.RequestException as e:
        print(f"[ERROR] API Health check failed: {e}")
        return False


def create_entity(
    entity_id: str,
    entity_type: str,
    subtype: str,
    alias: str | None = None,
    components: dict[str, Any] | None = None,
):
    """Create a new entity."""
    payload = {
        "entity_id": entity_id,
        "entity_type": entity_type,
        "subtype": subtype,
    }
    if alias:
        payload["alias"] = alias
    if components:
        payload["components"] = components

    try:
        response = requests.post(f"{API_BASE_URL}/entities", json=payload, timeout=10)
        response.raise_for_status()
        data = response.json()
        # Store the entity_id in the response for later use
        data["_requested_entity_id"] = entity_id
        print(f"[OK] Created entity: {entity_id} ({entity_type}/{subtype})")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to create entity {entity_id}: {e}")
        resp = getattr(e, "response", None)
        if resp is not None:
            print(f"  Response: {resp.text}")
        return None


def create_task(
    task_id: str,
    entity_id: str | None = None,
    status: str = "pending",
    components: dict[str, Any] | None = None,
):
    """Create a new task."""
    payload = {
        "task_id": task_id,
        "status": status,
    }
    if entity_id:
        payload["entity_id"] = entity_id
    if components:
        payload["components"] = components

    try:
        response = requests.post(f"{API_BASE_URL}/tasks", json=payload, timeout=10)
        response.raise_for_status()
        data = response.json()
        # Store the task_id in the response for later use
        data["_requested_task_id"] = task_id
        print(f"[OK] Created task: {task_id} (status: {status})")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to create task {task_id}: {e}")
        resp = getattr(e, "response", None)
        if resp is not None:
            print(f"  Response: {resp.text}")
        return None


def create_object(
    object_id: str,
    path: str | None = None,
    content_type: str | None = None,
    object_type: str | None = None,
    size_bytes: int | None = None,
    usage_hints: list[Any] | None = None,
    referenced_by: list[Any] | None = None,
):
    """Create a new object."""
    payload = {
        "object_id": object_id,
    }
    if path:
        payload["path"] = path
    if content_type:
        payload["content_type"] = content_type
    if object_type:
        payload["type"] = object_type
    if size_bytes is not None:
        payload["size_bytes"] = size_bytes
    if usage_hints:
        payload["usage_hints"] = usage_hints
    if referenced_by:
        payload["referenced_by"] = referenced_by

    try:
        response = requests.post(f"{API_BASE_URL}/objects", json=payload, timeout=10)
        response.raise_for_status()
        data = response.json()
        data["_requested_object_id"] = object_id
        print(f"[OK] Created object: {object_id}")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to create object {object_id}: {e}")
        resp = getattr(e, "response", None)
        if resp is not None:
            print(f"  Response: {resp.text}")
        return None


def list_entities():
    """List all entities."""
    try:
        response = requests.get(f"{API_BASE_URL}/entities", timeout=10)
        response.raise_for_status()
        data = response.json()
        # Response is a list directly
        if isinstance(data, list):
            print(f"\n[OK] Found {len(data)} entities")
        else:
            print(f"\n[OK] Found entities (response format: {type(data).__name__})")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to list entities: {e}")
        return None


def list_tasks():
    """List all tasks."""
    try:
        response = requests.get(f"{API_BASE_URL}/tasks", timeout=10)
        response.raise_for_status()
        data = response.json()
        # Response is a list directly
        if isinstance(data, list):
            print(f"\n[OK] Found {len(data)} tasks")
        else:
            print(f"\n[OK] Found tasks (response format: {type(data).__name__})")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to list tasks: {e}")
        return None


def list_objects():
    """List all objects."""
    try:
        response = requests.get(f"{API_BASE_URL}/objects", timeout=10)
        response.raise_for_status()
        data = response.json()
        # Response is a list directly
        if isinstance(data, list):
            print(f"\n[OK] Found {len(data)} objects")
        else:
            print(f"\n[OK] Found objects (response format: {type(data).__name__})")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to list objects: {e}")
        return None


def update_task(
    task_id: str,
    status: str | None = None,
    components: dict[str, Any] | None = None,
):
    """Update a task using PATCH endpoint."""
    payload = {}
    if status:
        payload["status"] = status
    if components:
        payload["components"] = components
    try:
        response = requests.patch(f"{API_BASE_URL}/tasks/{task_id}", json=payload, timeout=10)
        response.raise_for_status()
        data = response.json()
        print(f"[OK] Updated task: {task_id}")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to update task {task_id}: {e}")
        resp = getattr(e, "response", None)
        if resp is not None:
            print(f"  Response: {resp.text}")
        return None


def get_entity(entity_id: str, retries: int = 3, delay: float = 1.0):
    """Get a specific entity with retry logic."""
    for attempt in range(retries):
        try:
            response = requests.get(f"{API_BASE_URL}/entities/{entity_id}", timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            if attempt < retries - 1:
                logger.warning(
                    "get_entity failed (attempt %s/%s) for %s: %s",
                    attempt + 1,
                    retries,
                    entity_id,
                    e,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "get_entity failed after %s attempts for %s",
                    retries,
                    entity_id,
                    exc_info=True,
                )
    return None


def get_task(task_id: str, retries: int = 3, delay: float = 1.0):
    """Get a specific task with retry logic."""
    for attempt in range(retries):
        try:
            response = requests.get(f"{API_BASE_URL}/tasks/{task_id}", timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            if attempt < retries - 1:
                logger.warning(
                    "get_task failed (attempt %s/%s) for %s: %s",
                    attempt + 1,
                    retries,
                    task_id,
                    e,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "get_task failed after %s attempts for %s",
                    retries,
                    task_id,
                    exc_info=True,
                )
    return None


def get_object(object_id: str, retries: int = 3, delay: float = 1.0):
    """Get a specific object with retry logic."""
    for attempt in range(retries):
        try:
            response = requests.get(f"{API_BASE_URL}/objects/{object_id}", timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            if attempt < retries - 1:
                logger.warning(
                    "get_object failed (attempt %s/%s) for %s: %s",
                    attempt + 1,
                    retries,
                    object_id,
                    e,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "get_object failed after %s attempts for %s",
                    retries,
                    object_id,
                    exc_info=True,
                )
    return None


def verify_created_items(entity_ids: list, task_ids: list, object_ids: list):
    """Verify all created items exist using GET requests."""
    print("\n" + "=" * 60)
    print("Verifying Created Items")
    print("=" * 60)

    # Wait for eventual consistency
    print("[WAIT] Waiting 2 seconds for server consistency...")
    time.sleep(2)

    verified = {"entities": 0, "tasks": 0, "objects": 0}
    failed = {"entities": [], "tasks": [], "objects": []}

    # Verify entities
    for entity_id in entity_ids:
        result = get_entity(entity_id)
        if result:
            print(f"[OK] Verified entity: {entity_id}")
            verified["entities"] += 1
        else:
            print(f"[ERROR] Could not verify entity: {entity_id}")
            failed["entities"].append(entity_id)

    # Verify tasks
    for task_id in task_ids:
        result = get_task(task_id)
        if result:
            print(f"[OK] Verified task: {task_id}")
            verified["tasks"] += 1
        else:
            print(f"[ERROR] Could not verify task: {task_id}")
            failed["tasks"].append(task_id)

    # Verify objects
    for object_id in object_ids:
        result = get_object(object_id)
        if result:
            print(f"[OK] Verified object: {object_id}")
            verified["objects"] += 1
        else:
            print(f"[ERROR] Could not verify object: {object_id}")
            failed["objects"].append(object_id)

    return verified, failed


def main():
    """Main function to create entities, tasks, and objects."""
    global API_BASE_URL

    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    print("=" * 60)
    print("ATLAS Core API - Manual Testing")
    print("=" * 60)
    print()

    # Prompt for API URL
    default_url = API_BASE_URL.rstrip("/")
    remote_api_url = configured_remote_api_url()
    remote_enabled = "--remote" in sys.argv or os.environ.get("ATLAS_API_REMOTE", "").lower() == "true"
    if remote_enabled:
        default_url = remote_api_url
        print("Remote API mode is enabled. Writes will target the shared deployment.")
    url_input = input(f"Enter API URL (default: {default_url}): ").strip()

    if url_input:
        API_BASE_URL = url_input.rstrip("/")  # Remove trailing slash if present
    else:
        API_BASE_URL = default_url

    print(f"\nUsing API URL: {API_BASE_URL}\n")

    # Check health
    if not check_health():
        print("\nAPI is not available. Exiting.")
        return

    remote_target = API_BASE_URL.rstrip("/") == remote_api_url
    if remote_enabled or remote_target:
        if not confirm_remote_writes():
            print("\nRemote write confirmation declined. Exiting.")
            return

    print("\n" + "=" * 60)
    print("Creating Entities")
    print("=" * 60)

    # Generate unique IDs (timestamp + short UUID suffix avoids collisions in --remote)
    timestamp = f"{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"

    # Create some entities
    # Note: entity_type must be "asset" for items to appear in the UI's asset list
    # The actual type (drone, rover, sensor) goes in subtype
    entities = [
        {
            "entity_id": f"DRONE-{timestamp}-001",
            "entity_type": "asset",  # Must be "asset" for UI compatibility
            "subtype": "drone",
            "alias": "Alpha Drone",
            "components": {
                "telemetry": {
                    "latitude": 40.7128,
                    "longitude": -74.0060,
                    "altitude_m": 50.0,
                },
                "health": {"battery_percent": 85},
            },
        },
        {
            "entity_id": f"ROVER-{timestamp}-001",
            "entity_type": "asset",  # Must be "asset" for UI compatibility
            "subtype": "rover",
            "alias": "Beta Rover",
            "components": {
                "telemetry": {
                    "latitude": 40.7580,
                    "longitude": -73.9855,
                    "altitude_m": 10.0,
                },
                "health": {"battery_percent": 92},
            },
        },
        {
            "entity_id": f"SENSOR-{timestamp}-001",
            "entity_type": "asset",  # Must be "asset" for UI compatibility
            "subtype": "camera",
            "alias": "Security Camera 1",
            "components": {
                "telemetry": {
                    "latitude": 40.7484,
                    "longitude": -73.9857,
                    "altitude_m": 5.0,
                },
            },
        },
    ]

    created_entities = []
    for entity_data in entities:
        result = create_entity(**entity_data)
        if result:
            created_entities.append(result)

    print("\n" + "=" * 60)
    print("Creating Tasks")
    print("=" * 60)

    # Create some tasks
    tasks = [
        {
            "task_id": f"TASK-{timestamp}-001",
            "status": "pending",
            "entity_id": f"DRONE-{timestamp}-001",
            "components": {
                "command": {
                    "type": "move_to",
                    "target": {"latitude": 40.7580, "longitude": -73.9855},
                },
            },
        },
        {
            "task_id": f"TASK-{timestamp}-002",
            "status": "pending",
            "entity_id": f"ROVER-{timestamp}-001",
            "components": {"command": {"type": "patrol"}},
        },
        {
            "task_id": f"TASK-{timestamp}-003",
            "status": "pending",
            "entity_id": f"SENSOR-{timestamp}-001",
            "components": {"command": {"type": "capture_image"}},
        },
        {
            "task_id": f"TASK-{timestamp}-004",
            "status": "pending",
            "components": {"command": {"type": "system_check"}},
        },
    ]

    created_tasks = []
    for task_data in tasks:
        result = create_task(**task_data)
        if result:
            created_tasks.append(result)

    print("\n" + "=" * 60)
    print("Creating Objects")
    print("=" * 60)

    # Create some objects (without entity/task references to avoid server issues)
    objects = [
        {
            "object_id": f"OBJ-{timestamp}-001",
            "path": f"images/drone_mission_{timestamp}.jpg",
            "content_type": "image/jpeg",
            "object_type": "image",
            "size_bytes": 245760,
            "usage_hints": ["mission_data", "drone_capture"],
        },
        {
            "object_id": f"OBJ-{timestamp}-002",
            "path": f"data/rover_telemetry_{timestamp}.json",
            "content_type": "application/json",
            "object_type": "telemetry",
            "size_bytes": 1024,
            "usage_hints": ["telemetry", "rover_data"],
        },
        {
            "object_id": f"OBJ-{timestamp}-003",
            "path": f"videos/security_feed_{timestamp}.mp4",
            "content_type": "video/mp4",
            "object_type": "video",
            "size_bytes": 15728640,
            "usage_hints": ["security", "surveillance"],
        },
        {
            "object_id": f"OBJ-{timestamp}-004",
            "path": f"maps/nyc_mission_area_{timestamp}.geojson",
            "content_type": "application/geo+json",
            "object_type": "geospatial",
            "size_bytes": 5120,
            "usage_hints": ["map", "mission_planning"],
        },
    ]

    created_objects = []
    for object_data in objects:
        result = create_object(**object_data)
        if result:
            created_objects.append(result)

    print("\n" + "=" * 60)
    print("Summary (Created)")
    print("=" * 60)
    print(f"Created {len(created_entities)} entities")
    print(f"Created {len(created_tasks)} tasks")
    print(f"Created {len(created_objects)} objects")

    # Collect IDs for verification
    entity_ids = [e.get("_requested_entity_id") for e in created_entities if e.get("_requested_entity_id")]
    task_ids = [t.get("_requested_task_id") for t in created_tasks if t.get("_requested_task_id")]
    object_ids = [o.get("_requested_object_id") for o in created_objects if o.get("_requested_object_id")]

    # Verify all created items exist
    verified, failed = verify_created_items(entity_ids, task_ids, object_ids)

    # List all items
    print("\n" + "=" * 60)
    print("Listing All Items")
    print("=" * 60)
    list_entities()
    list_tasks()
    list_objects()

    # Test task operations only on verified tasks
    verified_task_ids = [tid for tid in task_ids if tid not in failed["tasks"]]
    if verified_task_ids:
        print("\n" + "=" * 60)
        print("Testing Task Operations")
        print("=" * 60)

        # Update first verified task to in_progress
        if len(verified_task_ids) > 0:
            update_task(verified_task_ids[0], status="in_progress")

        # Update second verified task to completed
        if len(verified_task_ids) > 1:
            update_task(verified_task_ids[1], status="completed")

    # Final summary
    print("\n" + "=" * 60)
    print("Final Summary")
    print("=" * 60)
    total_verified = verified["entities"] + verified["tasks"] + verified["objects"]
    total_failed = len(failed["entities"]) + len(failed["tasks"]) + len(failed["objects"])
    print(
        f"Verified ({total_verified} total): {verified['entities']} entities, "
        f"{verified['tasks']} tasks, {verified['objects']} objects"
    )
    if total_failed > 0:
        print(
            f"Failed to verify: {len(failed['entities'])} entities, "
            f"{len(failed['tasks'])} tasks, {len(failed['objects'])} objects"
        )
    else:
        print("All items verified successfully!")

    print("\n" + "=" * 60)
    print("Done!")
    print("=" * 60)


if __name__ == "__main__":
    main()
