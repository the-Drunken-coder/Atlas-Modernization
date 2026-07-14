#!/usr/bin/env sh
set -eu

compose_file="docker/docker-compose.yml"
api_url="${ATLAS_CORE_API_URL:-http://localhost:8000}"
api_url="${api_url%/}"
api_key="${ATLAS_API_AUTH_KEY:-${API_AUTH_KEY:-}}"
session_cookies="$(mktemp)"

cleanup() {
    rm -f "$session_cookies"
}
trap cleanup 0 HUP INT TERM

login_admin_session() {
    if [ -n "$api_key" ]; then
        return 0
    fi

    login_payload="$(jq -n \
        --arg username "${ATLAS_ADMIN_USERNAME:-admin}" \
        --arg password "${ATLAS_ADMIN_PASSWORD:-password}" \
        '{username:$username,password:$password}')"
    curl -fsS \
        -c "$session_cookies" \
        -H "Accept: application/json" \
        -H "Content-Type: application/json" \
        -H "Origin: ${ATLAS_UI_ORIGIN:-http://localhost:5173}" \
        -d "$login_payload" \
        "$api_url/admin/auth/login" >/dev/null
}

get_catalog() {
    if [ -n "$api_key" ]; then
        curl -fsS -H "X-API-Key: $api_key" "$api_url/objects/command_catalog"
    else
        curl -fsS -b "$session_cookies" "$api_url/objects/command_catalog"
    fi
}

wait_for_catalog() {
    attempt=1
    while [ "$attempt" -le 60 ]; do
        if curl -fsS "$api_url/readiness" >/dev/null && \
            login_admin_session && \
            get_catalog >/dev/null; then
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
