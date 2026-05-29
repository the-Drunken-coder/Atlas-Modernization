#!/usr/bin/env python3
"""Create ~100 asset entities at random US locations via ATLAS Core API."""

import os
import random
import time
import uuid

import requests

# Default to the local API to avoid seeding shared environments by accident.
API_BASE = (os.environ.get("ATLAS_CORE_API_URL") or "http://localhost:8000").rstrip("/")

# Contiguous US bounds (approx)
US_LAT_MIN, US_LAT_MAX = 24.5, 49.0
US_LON_MIN, US_LON_MAX = -125.0, -66.0


def random_us_location():
    lat = random.uniform(US_LAT_MIN, US_LAT_MAX)
    lon = random.uniform(US_LON_MIN, US_LON_MAX)
    return lat, lon


def create_asset(session: requests.Session, index: int) -> bool:
    lat, lon = random_us_location()
    entity_id = f"seed-asset-{uuid.uuid4().hex[:12]}"
    payload = {
        "entity_id": entity_id,
        "entity_type": "asset",
        "subtype": "drone",
        "alias": f"US-Asset-{index:03d}",
        "components": {
            "telemetry": {
                "latitude": lat,
                "longitude": lon,
                "altitude_m": random.uniform(50, 500),
                "speed_m_s": random.uniform(0, 15),
                "heading_deg": random.random() * 360.0,
            },
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            },
        },
    }
    try:
        r = session.post(f"{API_BASE}/entities", json=payload, timeout=10)
        r.raise_for_status()
        print(f"  [{index + 1}/100] {entity_id} @ {lat:.4f}, {lon:.4f}")
        return True
    except requests.RequestException as e:
        print(f"  [{index + 1}/100] FAIL {entity_id}: {e}")
        return False


def main():
    print(f"Targeting {API_BASE}")
    with requests.Session() as session:
        try:
            r = session.get(f"{API_BASE}/health", timeout=10)
        except requests.RequestException as e:
            print(f"Health check failed for {API_BASE}: {e}")
            return
        if not r.ok:
            print(f"Health check failed: {r.status_code}")
            return
        print("API healthy")

        print("Creating 100 assets...")
        ok = 0
        for i in range(100):
            if create_asset(session, i):
                ok += 1
            time.sleep(0.05)  # rate limit

    print(f"\nDone: {ok}/100 created")


if __name__ == "__main__":
    main()
