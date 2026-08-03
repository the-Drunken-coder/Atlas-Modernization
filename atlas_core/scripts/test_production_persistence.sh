#!/usr/bin/env bash
# Focused durable-production integration test for clean install, restart, and paired restore.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${CORE_DIR}/docker/docker-compose.production.yml"
PROJECT_NAME="atlas_durable_persistence_test"
API_URL="http://127.0.0.1:8000"
ENTITY_ID="durable-restart-entity"
OBJECT_ID="durable-restart-object"
ADMIN_ID="durable-restart-admin"
EXPECTED_SCHEMA_VERSION="2"
MARKER_DIR="$(mktemp -d)"
MARKER_FILE="${MARKER_DIR}/marker.txt"
DOWNLOADED_FILE="${MARKER_DIR}/downloaded.txt"
RESTORED_FILE="${MARKER_DIR}/restored.txt"
POSTGRES_DUMP="${MARKER_DIR}/postgres.dump"
MINIO_BACKUP_DIR="${MARKER_DIR}/minio"
MC_IMAGE="minio/mc:RELEASE.2024-01-31T08-59-40Z@sha256:c084c9a67c7a9ed5f37cc7f2a905010861aaa882bec76da10352305c9709b6d2"

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER must be set}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set}"
: "${API_AUTH_KEY:?API_AUTH_KEY must be set}"
: "${ATLAS_ADMIN_PASSWORD:?ATLAS_ADMIN_PASSWORD must be set}"

export DATABASE_RECREATE_ON_STARTUP=false

compose() {
    docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" "$@"
}

cleanup() {
    exit_code=$?
    if [ "${exit_code}" -ne 0 ]; then
        compose logs --no-color || true
    fi
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "${MARKER_DIR}"
    exit "${exit_code}"
}
trap cleanup EXIT

for container in atlas_core_api atlas_core_postgres atlas_core_minio atlas_core_minio_init; do
    if docker container inspect "${container}" >/dev/null 2>&1; then
        printf 'Refusing to disturb existing Atlas container: %s\n' "${container}" >&2
        exit 1
    fi
done

wait_for_api() {
    for attempt in $(seq 1 90); do
        if curl -fsS "${API_URL}/readiness" >/dev/null; then
            return 0
        fi
        if [ "${attempt}" -eq 90 ]; then
            printf 'Atlas Core did not become ready after restart\n' >&2
            return 1
        fi
        sleep 2
    done
}

auth_curl() {
    curl -fsS -H "X-API-Key: ${API_AUTH_KEY}" "$@"
}

mc() {
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        --network "${PROJECT_NAME}_atlas_core_network" \
        -e HOME=/tmp \
        -e "MC_HOST_atlas=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
        -v "${MARKER_DIR}:/backup" \
        "${MC_IMAGE}" "$@"
}

verify_sentinels() {
    output_file="$1"
    auth_curl "${API_URL}/entities/${ENTITY_ID}" | jq -e --arg id "${ENTITY_ID}" '.entity_id == $id' >/dev/null
    auth_curl "${API_URL}/objects/${OBJECT_ID}/download" -o "${output_file}"
    cmp "${MARKER_FILE}" "${output_file}"

    admin_count="$(compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
        psql -At -U atlas -d atlas_core -c "SELECT count(*) FROM admin_records WHERE id = '${ADMIN_ID}'")"
    schema_version="$(compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
        psql -At -U atlas -d atlas_core -c 'SELECT max(version) FROM atlas_schema_migrations')"
    test "${admin_count}" = "1"
    test "${schema_version}" = "${EXPECTED_SCHEMA_VERSION}"
}

printf '%s' 'atlas durable restart marker' >"${MARKER_FILE}"

compose up -d --build
wait_for_api

auth_curl \
    -H 'Content-Type: application/json' \
    -X POST "${API_URL}/entities" \
    -d "{\"entity_id\":\"${ENTITY_ID}\",\"entity_type\":\"asset\"}" \
    >/dev/null
auth_curl \
    -X POST "${API_URL}/objects/upload" \
    -F "object_id=${OBJECT_ID}" \
    -F 'type=durability_probe' \
    -F "file=@${MARKER_FILE};type=text/plain" \
    >/dev/null
compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    psql -v ON_ERROR_STOP=1 -U atlas -d atlas_core \
    -c "INSERT INTO admin_records (id, type, json) VALUES ('${ADMIN_ID}', 'test', '{\"preserved\":true}')" \
    >/dev/null

initial_version="$(compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    psql -At -U atlas -d atlas_core -c 'SELECT max(version) FROM atlas_schema_migrations')"
test "${initial_version}" = "${EXPECTED_SCHEMA_VERSION}"

compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    pg_dump -U atlas -d atlas_core --format=custom --no-owner --no-privileges \
    >"${POSTGRES_DUMP}"
mkdir -p "${MINIO_BACKUP_DIR}"
mc mirror --overwrite atlas/atlas-media /backup/minio
test -s "${POSTGRES_DUMP}"
test -n "$(find "${MINIO_BACKUP_DIR}" -type f -print -quit)"

compose down --remove-orphans
compose up -d
wait_for_api

verify_sentinels "${DOWNLOADED_FILE}"

compose stop api
compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    psql -v ON_ERROR_STOP=1 -U atlas -d atlas_core \
    -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION atlas;' \
    >/dev/null
mc rm --recursive --force atlas/atlas-media
compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    pg_restore -U atlas -d atlas_core --exit-on-error --no-owner --no-privileges \
    <"${POSTGRES_DUMP}"
mc mirror --overwrite /backup/minio atlas/atlas-media
compose start api
wait_for_api
verify_sentinels "${RESTORED_FILE}"

printf '%s\n' 'PASS: production restart and paired restore preserved PostgreSQL resources, admin_records, migration state, and MinIO bytes'
