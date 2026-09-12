#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf '%s\n' 'usage: run_storage_recovery_tests.sh [--nightly]'
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
started_epoch="$(date +%s)"
artifact_root="${ATLAS_STORAGE_RECOVERY_ARTIFACT_ROOT:-${repo_dir}/.atlas/core-storage-recovery}"
artifact_dir="${artifact_root}/${run_id}"
mkdir -p "${artifact_dir}"

postgres_image="postgres:15@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e"
minio_image="quay.io/minio/minio:RELEASE.2024-01-31T20-20-33Z@sha256:4092433a77e510826874b36f369696df43407a763d7f901a61d74e83e6fd95bc"
postgres_container="atlas-storage-postgres-${run_id}"
minio_container="atlas-storage-minio-${run_id}"
postgres_password="atlas-test"
minio_access_key="atlas-recovery"
minio_secret_key="atlas-recovery-${run_token}"
postgres_started="false"
minio_started="false"
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

finish() {
  original_status=$?
  status="${original_status}"
  support_failure=""
  set +e

  capture_and_remove() {
    service="$1"
    container="$2"
    record_command docker logs "${container}"
    run_with_timeout 15 docker logs "${container}" >"${artifact_dir}/${service}.log" 2>&1
    capture_status=$?
    if (( capture_status != 0 )); then
      support_failure+="${service}_logs=${capture_status} "
      if (( status == 0 )); then status="${capture_status}"; fi
    fi

    record_command docker inspect "${container}"
    run_with_timeout 15 docker inspect "${container}" >"${artifact_dir}/${service}-inspect.json" 2>&1
    inspect_status=$?
    if (( inspect_status != 0 )); then
      support_failure+="${service}_inspect=${inspect_status} "
      if (( status == 0 )); then status="${inspect_status}"; fi
    fi

    record_command docker rm -f "${container}"
    run_with_timeout 30 docker rm -f "${container}" >"${artifact_dir}/${service}-cleanup.log" 2>&1
    cleanup_status=$?
    if (( cleanup_status != 0 )); then
      support_failure+="${service}_cleanup=${cleanup_status} "
      if (( status == 0 )); then status="${cleanup_status}"; fi
    fi
  }

  if [[ "${postgres_started}" == "true" ]]; then
    capture_and_remove postgres "${postgres_container}"
  fi
  if [[ "${minio_started}" == "true" ]]; then
    capture_and_remove minio "${minio_container}"
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
      '- Inspect commands.log and the matching dependency or test log before classifying it.' \
      '- The runner did not retry the failure.' >"${artifact_dir}/classification.md"
    if [[ -n "${support_failure}" ]]; then
      printf '%s\n' "- Evidence or cleanup failure: ${support_failure}" >>"${artifact_dir}/classification.md"
    fi
  fi
  finished_epoch="$(date +%s)"
  printf 'support_failure=%s\nexit_status=%s\nfinished_at=%s\nduration_seconds=%s\n' \
    "${support_failure}" "${status}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((finished_epoch - started_epoch))" >>"${artifact_dir}/metadata.txt"
  printf 'artifacts=%s\n' "${artifact_dir}"
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
  printf 'coverage_process=instrumented Go actions test binary; no separate Atlas Core server process is run or measured\n'
  printf 'crash_helper_coverage=separate child test process is not included in storage.coverage.out\n'
  printf 'postgres_image=%s\n' "${postgres_image}"
  printf 'minio_image=%s\n' "${minio_image}"
  printf 'postgres_container=%s\n' "${postgres_container}"
  printf 'minio_container=%s\n' "${minio_container}"
  printf 'dependency_pull_timeout_seconds=180\n'
  printf 'dependency_start_timeout_seconds=60\n'
  printf 'dependency_cleanup_timeout_seconds=30\n'
} >"${artifact_dir}/metadata.txt"

cd "${core_dir}"

run_logged "${artifact_dir}/coverage-checker-tests.log" python3 scripts/test_check_storage_recovery_coverage.py
run_logged "${artifact_dir}/selection-verifier-tests.log" python3 scripts/test_verify_storage_recovery_tests.py
run_logged_with_timeout "${artifact_dir}/postgres-pull.log" 180 docker pull "${postgres_image}"
run_logged_with_timeout "${artifact_dir}/minio-pull.log" 180 docker pull "${minio_image}"

postgres_run=(
  docker run --pull never --rm -d
  --name "${postgres_container}"
  -e POSTGRES_DB=atlas_core
  -e POSTGRES_USER=atlas
  -e POSTGRES_PASSWORD="${postgres_password}"
  -e "POSTGRES_INITDB_ARGS=--auth-local=md5 --auth-host=md5"
  -p 127.0.0.1::5432
  "${postgres_image}"
)
record_command docker run --pull never --rm -d --name "${postgres_container}" '[owned PostgreSQL settings]' -p 127.0.0.1::5432 "${postgres_image}"
postgres_started="true"
run_with_timeout 30 "${postgres_run[@]}" >"${artifact_dir}/postgres-start.log" 2>&1
printf 'postgres_container_id=%s\n' "$(tr -d '\r\n' <"${artifact_dir}/postgres-start.log")" >>"${artifact_dir}/metadata.txt"

minio_run=(
  docker run --pull never --rm -d
  --name "${minio_container}"
  -e MINIO_ROOT_USER="${minio_access_key}"
  -e MINIO_ROOT_PASSWORD="${minio_secret_key}"
  -p 127.0.0.1::9000
  "${minio_image}"
  server /data --console-address :9001
)
record_command docker run --pull never --rm -d --name "${minio_container}" '[owned MinIO credentials]' -p 127.0.0.1::9000 "${minio_image}" server /data --console-address :9001
minio_started="true"
run_with_timeout 30 "${minio_run[@]}" >"${artifact_dir}/minio-start.log" 2>&1
printf 'minio_container_id=%s\n' "$(tr -d '\r\n' <"${artifact_dir}/minio-start.log")" >>"${artifact_dir}/metadata.txt"

postgres_ready="false"
for attempt in $(seq 1 60); do
  if docker exec "${postgres_container}" pg_isready -U atlas -d atlas_core >/dev/null 2>&1; then
    postgres_ready="true"
    printf 'postgres_ready_attempt=%d\n' "${attempt}" >>"${artifact_dir}/metadata.txt"
    break
  fi
  sleep 1
done
if [[ "${postgres_ready}" != "true" ]]; then
  printf '%s\n' 'disposable PostgreSQL did not become ready within 60 seconds' >&2
  exit 1
fi

minio_ready="false"
for attempt in $(seq 1 60); do
  if docker exec "${minio_container}" mc ready local >/dev/null 2>&1; then
    minio_ready="true"
    printf 'minio_ready_attempt=%d\n' "${attempt}" >>"${artifact_dir}/metadata.txt"
    break
  fi
  sleep 1
done
if [[ "${minio_ready}" != "true" ]]; then
  printf '%s\n' 'disposable MinIO did not become ready within 60 seconds' >&2
  exit 1
fi

postgres_port="$(docker port "${postgres_container}" 5432/tcp)"
postgres_port="${postgres_port##*:}"
minio_port="$(docker port "${minio_container}" 9000/tcp)"
minio_port="${minio_port##*:}"
export ATLAS_ACTIONS_DATABASE_URL="postgres://atlas:${postgres_password}@127.0.0.1:${postgres_port}/atlas_core?sslmode=disable"
export ATLAS_STORAGE_RECOVERY_ENDPOINT="127.0.0.1:${minio_port}"
export ATLAS_STORAGE_RECOVERY_ACCESS_KEY="${minio_access_key}"
export ATLAS_STORAGE_RECOVERY_SECRET_KEY="${minio_secret_key}"
export ATLAS_CORE_REQUIRE_LIVE_TESTS=1

test_count=1
test_shuffle="off"
test_timeout="8m"
export ATLAS_STORAGE_RECOVERY_NIGHTLY=0
if [[ "${mode}" == "nightly" ]]; then
  test_count=3
  test_shuffle="on"
  test_timeout="20m"
  export ATLAS_STORAGE_RECOVERY_NIGHTLY=1
fi
test_pattern="$(python3 scripts/verify_storage_recovery_tests.py pattern)"
{
  printf 'test_pattern=%s\n' "${test_pattern}"
  printf 'test_count=%d\n' "${test_count}"
  printf 'test_shuffle=%s\n' "${test_shuffle}"
  printf 'nightly_injected_deletion_failures=%s\n' "$([[ "${mode}" == "nightly" ]] && printf 3 || printf 1)"
} >>"${artifact_dir}/metadata.txt"

test_command=(
  go test
  -json
  -race
  "-count=${test_count}"
  "-shuffle=${test_shuffle}"
  -covermode=atomic
  "-coverpkg=./internal/actions,./internal/database,./internal/storage,./internal/testenv"
  "-coverprofile=${artifact_dir}/storage.coverage.out"
  "-run=${test_pattern}"
  "-timeout=${test_timeout}"
  ./internal/actions
)
run_logged "${artifact_dir}/storage.log" "${test_command[@]}"
run_logged "${artifact_dir}/selection-verification.log" python3 scripts/verify_storage_recovery_tests.py verify "${artifact_dir}/storage.log"
run_logged "${artifact_dir}/coverage.txt" python3 scripts/check_storage_recovery_coverage.py "${artifact_dir}/storage.coverage.out"
verification_complete="true"
