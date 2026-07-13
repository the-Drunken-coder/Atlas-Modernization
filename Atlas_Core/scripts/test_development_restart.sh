#!/usr/bin/env sh
set -eu

compose_file="docker/docker-compose.yml"
api_url="${ATLAS_CORE_API_URL:-http://localhost:8000}"

wait_for_catalog() {
    attempt=1
    while [ "$attempt" -le 60 ]; do
        if curl -fsS \
            -H "X-API-Key: ${ATLAS_API_AUTH_KEY:-${API_AUTH_KEY:-}}" \
            "$api_url/readiness" >/dev/null && \
            curl -fsS \
                -H "X-API-Key: ${ATLAS_API_AUTH_KEY:-${API_AUTH_KEY:-}}" \
                "$api_url/objects/command_catalog" >/dev/null; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done

    docker compose -f "$compose_file" ps
    docker compose -f "$compose_file" logs --no-color
    return 1
}

# Fresh development startup must publish the catalog before readiness succeeds.
wait_for_catalog

# Restarting only Core reruns the scratch reset without rerunning atlas.py.
docker compose -f "$compose_file" restart api
wait_for_catalog
