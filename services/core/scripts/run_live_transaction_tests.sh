#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf '%s\n' 'usage: run_live_transaction_tests.sh [--nightly]'
}

mode="required"
case "${1:-}" in
  "") ;;
  --nightly) mode="nightly" ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
if (( $# > 1 )); then
  usage >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${core_dir}/../.." && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'required command is unavailable: python3' >&2
  exit 1
fi
run_token="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${run_token}"
artifact_root="${ATLAS_CORE_LIVE_ARTIFACT_ROOT:-${repo_dir}/.atlas/core-live-transactions}"
artifact_dir="${artifact_root}/${run_id}"
mkdir -p "${artifact_dir}"

postgres_image="postgres:15@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e"
postgres_container="atlas-core-live-${run_id}"
postgres_password="atlas-test"
container_started="false"
verification_complete="false"

finish() {
  status=$?
  set +e
  if [[ "${container_started}" == "true" ]]; then
    docker logs "${postgres_container}" >"${artifact_dir}/postgres.log" 2>&1
    docker inspect "${postgres_container}" >"${artifact_dir}/postgres-inspect.json" 2>&1
    docker rm -f "${postgres_container}" >/dev/null 2>&1
  fi
  if (( status == 0 )) && [[ "${verification_complete}" == "true" ]]; then
    printf '%s\n' \
      '# Run classification' \
      '' \
      '- Corrected test or setup failures: none in this run.' \
      '- Verified product defects: none in this run.' \
      '- Unavailable verification: none in this run.' >"${artifact_dir}/classification.md"
  else
    printf '%s\n' \
      '# Run classification' \
      '' \
      "- Unclassified failure: command exited with status ${status}." \
      '- Inspect commands.log and the matching test or dependency log before classifying it.' \
      '- The runner did not retry the failure.' >"${artifact_dir}/classification.md"
  fi
  printf 'exit_status=%d\nfinished_at=%s\n' "${status}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"${artifact_dir}/metadata.txt"
  exit "${status}"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'required command is unavailable: %s\n' "$1" >&2
    exit 1
  fi
}

record_command() {
  printf '$' >>"${artifact_dir}/commands.log"
  printf ' %q' "$@" >>"${artifact_dir}/commands.log"
  printf '\n' >>"${artifact_dir}/commands.log"
}

run_logged() {
  log_path="$1"
  shift
  record_command "$@"
  "$@" 2>&1 | tee "${log_path}"
}

require_command docker
require_command git
require_command go
require_command python3

revision="$(git -C "${repo_dir}" rev-parse HEAD)"
{
  printf 'revision=%s\n' "${revision}"
  printf 'mode=%s\n' "${mode}"
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'go_version=%s\n' "$(go version)"
  printf 'docker_server=%s\n' "$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
  printf 'coverage_process=Go test binaries; no separate Atlas Core process is instrumented\n'
  printf 'postgres_image=%s\n' "${postgres_image}"
  printf 'postgres_container=%s\n' "${postgres_container}"
} >"${artifact_dir}/metadata.txt"

cd "${core_dir}"

support_command=(
  python3
  scripts/test_check_live_transaction_coverage.py
)
run_logged "${artifact_dir}/coverage-checker-tests.log" "${support_command[@]}"
selection_support_command=(
  python3
  scripts/test_verify_live_transaction_tests.py
)
run_logged "${artifact_dir}/selection-verifier-tests.log" "${selection_support_command[@]}"

offline_command=(
  env
  -u ATLAS_ACTIONS_DATABASE_URL
  -u ATLAS_DATABASE_TEST_URL
  -u DATABASE_URL
  -u POSTGRES_PASSWORD
  -u MINIO_ACCESS_KEY
  -u MINIO_ROOT_USER
  -u MINIO_SECRET_KEY
  -u MINIO_ROOT_PASSWORD
  ATLAS_CORE_REQUIRE_LIVE_TESTS=0
  go test
  -count=1
  -covermode=atomic
  "-coverprofile=${artifact_dir}/offline.coverage.out"
  -timeout=8m
  ./...
)
run_logged "${artifact_dir}/offline.log" "${offline_command[@]}"

container_id="$(docker run --rm -d \
  --name "${postgres_container}" \
  -e POSTGRES_DB=atlas_core \
  -e POSTGRES_USER=atlas \
  -e POSTGRES_PASSWORD="${postgres_password}" \
  -e POSTGRES_INITDB_ARGS='--auth-local=md5 --auth-host=md5' \
  -p 127.0.0.1::5432 \
  "${postgres_image}")"
container_started="true"
printf 'postgres_container_id=%s\n' "${container_id}" >>"${artifact_dir}/metadata.txt"

ready="false"
for attempt in $(seq 1 60); do
  if docker exec "${postgres_container}" pg_isready -U atlas -d atlas_core >/dev/null 2>&1; then
    ready="true"
    printf 'postgres_ready_attempt=%d\n' "${attempt}" >>"${artifact_dir}/metadata.txt"
    break
  fi
  sleep 1
done
if [[ "${ready}" != "true" ]]; then
  printf '%s\n' 'disposable PostgreSQL did not become ready within 60 seconds' >&2
  exit 1
fi

port_mapping="$(docker port "${postgres_container}" 5432/tcp)"
postgres_port="${port_mapping##*:}"
database_url="postgres://atlas:${postgres_password}@127.0.0.1:${postgres_port}/atlas_core?sslmode=disable"

live_test_pattern="$(python3 scripts/verify_live_transaction_tests.py pattern)"
live_count=1
live_shuffle="off"
live_timeout="8m"
if [[ "${mode}" == "nightly" ]]; then
  live_count=3
  live_shuffle="on"
  live_timeout="20m"
fi
{
  printf 'live_test_pattern=%s\n' "${live_test_pattern}"
  printf 'live_count=%d\n' "${live_count}"
  printf 'live_shuffle=%s\n' "${live_shuffle}"
} >>"${artifact_dir}/metadata.txt"

live_command=(
  env
  ATLAS_CORE_REQUIRE_LIVE_TESTS=1
  ATLAS_ACTIONS_DATABASE_URL="${database_url}"
  ATLAS_DATABASE_TEST_URL="${database_url}"
  go test
  -json
  -race
  "-count=${live_count}"
  "-shuffle=${live_shuffle}"
  -covermode=atomic
  "-coverpkg=./internal/actions,./internal/api/handlers,./internal/database,./internal/feed,./internal/testenv"
  "-coverprofile=${artifact_dir}/live.coverage.out"
  "-run=${live_test_pattern}"
  "-timeout=${live_timeout}"
  ./internal/testenv
  ./internal/actions
  ./internal/api/handlers
)
run_logged "${artifact_dir}/live.log" "${live_command[@]}"

verification_command=(python3 scripts/verify_live_transaction_tests.py verify "${artifact_dir}/live.log")
run_logged "${artifact_dir}/selection-verification.log" "${verification_command[@]}"

coverage_command=(
  python3
  scripts/check_live_transaction_coverage.py
  "${artifact_dir}/offline.coverage.out"
  "${artifact_dir}/live.coverage.out"
)
record_command "${coverage_command[@]}"
"${coverage_command[@]}" | tee "${artifact_dir}/coverage.txt"
verification_complete="true"

printf 'artifacts=%s\n' "${artifact_dir}"
