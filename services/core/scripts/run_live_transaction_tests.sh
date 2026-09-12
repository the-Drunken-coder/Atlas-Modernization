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
mkdir -p "${artifact_root}"
artifact_root="$(cd "${artifact_root}" && pwd -P)"
artifact_dir="${artifact_root}/${run_id}"
mkdir -p "${artifact_dir}"

postgres_image="postgres:15@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e"
postgres_container="atlas-core-live-${run_id}"
postgres_password="atlas-test"
container_cleanup_needed="false"
verification_complete="false"

run_with_timeout() {
  timeout_seconds="$1"
  shift
  python3 -c '
import subprocess
import sys

timeout_seconds = float(sys.argv[1])
command = sys.argv[2:]
try:
    completed = subprocess.run(command, timeout=timeout_seconds)
except subprocess.TimeoutExpired:
    print(f"command timed out after {timeout_seconds:g} seconds", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(completed.returncode)
' "${timeout_seconds}" "$@"
}

finish() {
  original_status=$?
  status="${original_status}"
  logs_status=0
  inspect_status=0
  cleanup_status=0
  set +e
  if [[ "${container_cleanup_needed}" == "true" ]]; then
    record_command docker logs "${postgres_container}"
    run_with_timeout 15 docker logs "${postgres_container}" >"${artifact_dir}/postgres.log" 2>&1
    logs_status=$?
    record_command docker inspect "${postgres_container}"
    run_with_timeout 15 docker inspect "${postgres_container}" >"${artifact_dir}/postgres-inspect.json" 2>&1
    inspect_status=$?
    record_command docker rm -f "${postgres_container}"
    run_with_timeout 30 docker rm -f "${postgres_container}" >"${artifact_dir}/postgres-cleanup.log" 2>&1
    cleanup_status=$?
    if (( original_status == 0 )); then
      for support_status in "${logs_status}" "${inspect_status}" "${cleanup_status}"; do
        if (( support_status != 0 )); then
          status="${support_status}"
          break
        fi
      done
    fi
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
    if (( logs_status != 0 )); then
      printf '%s\n' \
        "- Owned container log capture failed with status ${logs_status}: ${postgres_container}." \
        '- Inspect postgres.log for the capture error.' >>"${artifact_dir}/classification.md"
    fi
    if (( inspect_status != 0 )); then
      printf '%s\n' \
        "- Owned container inspection failed with status ${inspect_status}: ${postgres_container}." \
        '- Inspect postgres-inspect.json for the capture error.' >>"${artifact_dir}/classification.md"
    fi
    if (( cleanup_status != 0 )); then
      printf '%s\n' \
        "- Owned container cleanup failed with status ${cleanup_status}: ${postgres_container}." \
        '- Inspect postgres-cleanup.log and remove that exact container before continuing.' >>"${artifact_dir}/classification.md"
    fi
  fi
  printf 'postgres_logs_status=%d\npostgres_inspect_status=%d\npostgres_cleanup_status=%d\nexit_status=%d\nfinished_at=%s\n' \
    "${logs_status}" "${inspect_status}" "${cleanup_status}" "${status}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"${artifact_dir}/metadata.txt"
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
  {
    printf '$'
    printf ' %q' "$@"
    printf '\n'
  } >>"${artifact_dir}/commands.log"
}

run_logged() {
  log_path="$1"
  shift
  record_command "$@"
  "$@" 2>&1 | tee "${log_path}"
}

run_logged_with_timeout() {
  log_path="$1"
  timeout_seconds="$2"
  shift 2
  record_command "$@"
  run_with_timeout "${timeout_seconds}" "$@" 2>&1 | tee "${log_path}"
}

require_command docker
require_command git
require_command go
require_command python3

revision="$(git -C "${repo_dir}" rev-parse HEAD)"
record_command git -C "${repo_dir}" status --short
git -C "${repo_dir}" status --short >"${artifact_dir}/checkout-status.txt"
record_command git -C "${repo_dir}" diff --binary HEAD --
git -C "${repo_dir}" diff --binary HEAD -- >"${artifact_dir}/checkout-tracked.diff"
record_command git -C "${repo_dir}" ls-files --others --exclude-standard
git -C "${repo_dir}" ls-files --others --exclude-standard >"${artifact_dir}/checkout-untracked-paths.txt"
working_tree_dirty="false"
if [[ -s "${artifact_dir}/checkout-status.txt" ]]; then
  working_tree_dirty="true"
fi
{
  printf 'revision=%s\n' "${revision}"
  printf 'working_tree_dirty=%s\n' "${working_tree_dirty}"
  printf 'checkout_status=%s\n' "${artifact_dir}/checkout-status.txt"
  printf 'checkout_tracked_diff=%s\n' "${artifact_dir}/checkout-tracked.diff"
  printf 'checkout_untracked_paths=%s\n' "${artifact_dir}/checkout-untracked-paths.txt"
  printf 'mode=%s\n' "${mode}"
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'go_version=%s\n' "$(go version)"
  printf 'docker_server=%s\n' "$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
  printf 'coverage_process=Go test binaries; no separate Atlas Core process is instrumented\n'
  printf 'postgres_image=%s\n' "${postgres_image}"
  printf 'postgres_container=%s\n' "${postgres_container}"
  printf 'postgres_pull_timeout_seconds=180\n'
  printf 'postgres_start_timeout_seconds=30\n'
  printf 'postgres_cleanup_timeout_seconds=30\n'
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

run_logged_with_timeout "${artifact_dir}/postgres-pull.log" 180 docker pull "${postgres_image}"

docker_run_command=(docker run --pull never --rm -d \
  --name "${postgres_container}" \
  -e POSTGRES_DB=atlas_core \
  -e POSTGRES_USER=atlas \
  -e POSTGRES_PASSWORD="${postgres_password}" \
  -e POSTGRES_INITDB_ARGS='--auth-local=md5 --auth-host=md5' \
  -p 127.0.0.1::5432 \
  "${postgres_image}")
record_command "${docker_run_command[@]}"
container_cleanup_needed="true"
run_with_timeout 30 "${docker_run_command[@]}" \
  >"${artifact_dir}/postgres-start.log" 2>&1
container_id="$(tr -d '\r\n' <"${artifact_dir}/postgres-start.log")"
printf 'postgres_container_id=%s\n' "${container_id}" >>"${artifact_dir}/metadata.txt"

ready="false"
ready_deadline=$((SECONDS + 60))
attempt=0
while (( SECONDS < ready_deadline )); do
  attempt=$((attempt + 1))
  if run_with_timeout 2 docker exec "${postgres_container}" pg_isready -U atlas -d atlas_core >/dev/null 2>&1; then
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
run_logged "${artifact_dir}/coverage.txt" "${coverage_command[@]}"
verification_complete="true"

printf 'artifacts=%s\n' "${artifact_dir}"
