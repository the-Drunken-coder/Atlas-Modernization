#!/usr/bin/env bash

set -euo pipefail

if [ "${ATLAS_CORE_ACCEPTANCE_DISPOSABLE:-}" != "1" ]; then
  echo "Atlas Core package acceptance requires an explicitly disposable Docker host." >&2
  exit 1
fi
if [ "$#" -ne 4 ]; then
  echo "usage: test-atlas-core-package.sh <package.tgz> <version> <image-reference> <linux-platform>" >&2
  exit 2
fi

package_path="$(realpath "$1")"
version="$2"
expected_image="$3"
expected_platform="$4"
case "$expected_platform" in
  linux/amd64) expected_machine="x86_64" ;;
  linux/arm64) expected_machine="aarch64" ;;
  *)
    echo "Atlas Core package acceptance supports linux/amd64 or linux/arm64, not $expected_platform." >&2
    exit 2
    ;;
esac
execution_mode="${ATLAS_CORE_ACCEPTANCE_EXECUTION_MODE:-native}"
if [ "$execution_mode" != "native" ] && [ "$execution_mode" != "emulated" ]; then
  echo "ATLAS_CORE_ACCEPTANCE_EXECUTION_MODE must be native or emulated." >&2
  exit 2
fi

run_id="${ATLAS_CORE_ACCEPTANCE_RUN_ID:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')}"
artifact_root="${ATLAS_CORE_ACCEPTANCE_ARTIFACTS:-$PWD/.atlas/acceptance/atlas-core-package}"
artifact_dir="$artifact_root/$run_id"
mkdir -p "$artifact_dir"
chmod 700 "$artifact_dir"

test_root="$(mktemp -d)"
install_root="$test_root/install"
core_home="$test_root/core-home"
engine_id="$(docker info --format '{{.ID}}')"
test -n "$engine_id"
engine_key="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$engine_id")"
project_name="atlas_core_production_$engine_key"
probe_container="${project_name}_api"
cli="$install_root/node_modules/.bin/atlas-core"
probe_container_created=false
probe_volume_created=false
api_key=""
plugin_api_key=""
failure_recorded=false
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_ms="$(date +%s%3N)"
revision="$(git rev-parse HEAD)"
host_machine="$(uname -m)"
daemon_platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
package_sha256="$(sha256sum "$package_path" | awk '{print $1}')"
package_sha512="$(sha512sum "$package_path" | awk '{print $1}')"
package_integrity="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); process.stdout.write(`sha512-${createHash("sha512").update(readFileSync(process.argv[1])).digest("base64")}`);' "$package_path")"
image_platform=""

write_metadata() {
  jq -n \
    --arg scenario "atlas-core-package-lifecycle" \
    --arg run_id "$run_id" \
    --arg revision "$revision" \
    --arg started_at "$started_at" \
    --arg artifact_dir "$artifact_dir" \
    --arg package_name "$(basename "$package_path")" \
    --arg package_version "$version" \
    --arg package_sha256 "$package_sha256" \
    --arg package_sha512 "$package_sha512" \
    --arg package_integrity "$package_integrity" \
    --arg image_reference "$expected_image" \
    --arg expected_platform "$expected_platform" \
    --arg image_platform "$image_platform" \
    --arg host_machine "$host_machine" \
    --arg daemon_platform "$daemon_platform" \
    --arg execution_mode "$execution_mode" \
    --arg docker_engine_id_sha256 "$engine_key" \
    --arg reproduction "bash .github/scripts/test-atlas-core-package.sh <package.tgz> <version> <image-reference> $expected_platform" \
    '{scenario: $scenario, run_id: $run_id, revision: $revision, started_at: $started_at, artifact_dir: $artifact_dir, package: {name: $package_name, version: $package_version, sha256: $package_sha256, sha512: $package_sha512, integrity: $package_integrity}, image_reference: $image_reference, platform: {expected: $expected_platform, image: $image_platform, host_machine: $host_machine, daemon: $daemon_platform, execution_mode: $execution_mode}, docker_engine_id_sha256: $docker_engine_id_sha256, reproduction: $reproduction, scenarios: ["unowned container rejection", "unowned durable-volume rejection", "init", "start", "readiness", "status", "durable Entity after restart", "stop", "update", "reset"]}' \
    > "$artifact_dir/run.json"
}

write_result() {
  local status="$1"
  local completed_at
  local duration_ms
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  duration_ms="$(( $(date +%s%3N) - started_ms ))"
  jq -n \
    --arg status "$status" \
    --arg completed_at "$completed_at" \
    --argjson duration_ms "$duration_ms" \
    '{status: $status, completed_at: $completed_at, duration_ms: $duration_ms}' \
    > "$artifact_dir/result.json"
}

write_cleanup_result() {
  local status="$1"
  local reason="$2"
  jq -n \
    --arg status "$status" \
    --arg reason "$reason" \
    '{status: $status, reason: $reason}' \
    > "$artifact_dir/cleanup.json"
}

write_failure() {
  local status="$1"
  local reason="$2"
  local command="$3"
  jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson exit_status "$status" \
    --arg reason "$reason" \
    --arg command "$command" \
    --arg line "${BASH_LINENO[1]:-unknown}" \
    '{timestamp: $timestamp, exit_status: $exit_status, reason: $reason, command: $command, line: $line}' \
    > "$artifact_dir/failure.json"
}

record_check() {
  local check="$1"
  local expected="$2"
  local actual="$3"
  jq -cn \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg check "$check" \
    --arg expected "$expected" \
    --arg actual "$actual" \
    '{timestamp: $timestamp, check: $check, expected: $expected, actual: $actual, passed: true}' \
    >> "$artifact_dir/evidence.jsonl"
}

redact_stream() {
  local output="$1"
  API_KEY_REDACTION="$api_key" PLUGIN_API_KEY_REDACTION="$plugin_api_key" \
    node -e '
      const { readFileSync, writeFileSync } = require("node:fs");
      let contents = readFileSync(0, "utf8");
      for (const secret of [process.env.API_KEY_REDACTION, process.env.PLUGIN_API_KEY_REDACTION]) {
        if (secret) contents = contents.split(secret).join("[redacted]");
      }
      writeFileSync(process.argv[1], contents);
      process.stdout.write(contents);
    ' "$output"
}

capture_resources() {
  local phase="$1"
  local resources_path="$artifact_dir/resources-$phase.txt"
  printf 'phase=%s\nproject=%s\nimage=%s\n' "$phase" "$project_name" "$expected_image" > "$resources_path" || return 1
  timeout 15s docker container ls --all --filter "label=com.docker.compose.project=$project_name" \
    --format 'container={{.Names}} image={{.Image}} status={{.Status}}' >> "$resources_path" || return 1
  for resource in \
    "${project_name}_api" \
    "${project_name}_source_gateway" \
    "${project_name}_postgres" \
    "${project_name}_minio" \
    "${project_name}_minio_init"; do
    if docker container inspect "$resource" >/dev/null 2>&1; then
      timeout 15s docker container inspect --format "container=$resource image={{.Config.Image}} state={{.State.Status}}" "$resource" \
        >> "$resources_path" || return 1
      timeout 15s docker logs --tail 200 "$resource" 2>&1 | redact_stream "$artifact_dir/container-logs-$phase-$resource.txt" || return 1
    fi
  done
  for resource in "${project_name}_postgres_data" "${project_name}_minio_data"; do
    if docker volume inspect "$resource" >/dev/null 2>&1; then
      timeout 15s docker volume inspect --format "volume={{.Name}} driver={{.Driver}} labels={{json .Labels}}" "$resource" \
        >> "$resources_path" || return 1
    fi
  done
}

record_failure() {
  local status=$?
  if [ "$failure_recorded" = true ]; then
    return 0
  fi
  failure_recorded=true
  local command="$BASH_COMMAND"
  for secret in "$api_key" "$plugin_api_key"; do
    if [ -n "$secret" ]; then
      command="${command//"$secret"/[redacted]}"
    fi
  done
  write_failure "$status" "command failed" "$command"
}

fail() {
  local reason="$1"
  if [ "$failure_recorded" = false ]; then
    failure_recorded=true
    write_failure 1 "$reason" ""
  fi
  echo "$reason" >&2
  exit 1
}

curl_response() {
  local output="$1"
  shift
  local status
  if ! status="$(curl --connect-timeout 5 --max-time 30 --fail-with-body --silent --show-error --output "$output" --write-out '%{http_code}' "$@" 2>"$output.stderr")"; then
    printf '%s\n' "$status" > "$output.status"
    return 1
  fi
  printf '%s\n' "$status" > "$output.status"
}

write_metadata

cleanup() {
  local status=$?
  local cleanup_failure_reason=""
  trap - ERR EXIT
  set +e
  if ! capture_resources "cleanup"; then
    cleanup_failure_reason="resource evidence capture failed"
  fi
  if [ -x "$cli" ] && [ -f "$core_home/state.json" ]; then
    if ! timeout 150s env ATLAS_CORE_HOME="$core_home" "$cli" stop 2>&1 | redact_stream "$artifact_dir/cleanup-stop.txt"; then
      cleanup_failure_reason="${cleanup_failure_reason:+$cleanup_failure_reason; }CLI stop failed"
    fi
  fi
  if [ "$probe_container_created" = true ]; then
    if ! timeout 30s docker container rm --force "$probe_container" > "$artifact_dir/cleanup-probe-container.txt" 2>&1; then
      cleanup_failure_reason="${cleanup_failure_reason:+$cleanup_failure_reason; }probe container removal failed"
    fi
  fi
  if [ "$probe_volume_created" = true ]; then
    if ! timeout 30s docker volume rm "$probe_volume" > "$artifact_dir/cleanup-probe-volume.txt" 2>&1; then
      cleanup_failure_reason="${cleanup_failure_reason:+$cleanup_failure_reason; }probe volume removal failed"
    fi
  fi
  if ! rm -rf -- "$test_root"; then
    cleanup_failure_reason="${cleanup_failure_reason:+$cleanup_failure_reason; }temporary test-root removal failed"
  fi
  if [ "$status" -eq 0 ] && [ -n "$cleanup_failure_reason" ]; then
    status=1
    failure_recorded=true
    write_failure "$status" "cleanup failed: $cleanup_failure_reason" ""
  fi
  if [ -n "$cleanup_failure_reason" ]; then
    write_cleanup_result "failed" "$cleanup_failure_reason"
  else
    write_cleanup_result "passed" ""
  fi
  if [ "$status" -eq 0 ]; then
    write_result "passed"
  else
    if [ "$failure_recorded" = false ]; then
      write_failure "$status" "command exited without triggering the ERR trap" ""
    fi
    write_result "failed"
  fi
  exit "$status"
}
trap record_failure ERR
trap cleanup EXIT

if [ "$execution_mode" = "native" ]; then
  test "$host_machine" = "$expected_machine"
  test "$daemon_platform" = "$expected_platform"
fi
record_check "runner and Docker daemon execution mode" "$execution_mode $expected_platform" "$execution_mode $host_machine $daemon_platform"

for resource in \
  "${project_name}_api" \
  "${project_name}_source_gateway" \
  "${project_name}_postgres" \
  "${project_name}_minio" \
  "${project_name}_minio_init"; do
  if docker container inspect "$resource" >/dev/null 2>&1; then
    fail "Disposable runner already contains Atlas Core container $resource."
  fi
done
for resource in "${project_name}_postgres_data" "${project_name}_minio_data"; do
  if docker volume inspect "$resource" >/dev/null 2>&1; then
    fail "Disposable runner already contains Atlas Core volume $resource."
  fi
done

npm install --prefix "$install_root" "$package_path" 2>&1 | tee "$artifact_dir/npm-install.txt"
"$cli" version 2>&1 | tee "$artifact_dir/version.txt"
test "$(<"$artifact_dir/version.txt")" = "atlas-core $version"

package_json="$install_root/node_modules/atlas-core/package.json"
actual_image="$(node -e 'process.stdout.write(require(process.argv[1]).atlasCoreImage || "")' "$package_json")"
if [ "$actual_image" != "$expected_image" ]; then
  fail "Packed CLI pins $actual_image instead of $expected_image."
fi

docker pull "$expected_image"
image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$expected_image")"
test "$image_platform" = "$expected_platform"
write_metadata
record_check "packed candidate image matches the requested Linux platform" "$expected_platform" "$image_platform"
docker container create \
  --name "$probe_container" \
  --label "com.docker.compose.project=$project_name" \
  --label com.docker.compose.service=api \
  --label "io.atlas.core.engine=$engine_id" \
  "$expected_image" >/dev/null
probe_container_created=true

probe_log="$test_root/existing-container.log"
if ATLAS_CORE_HOME="$core_home" "$cli" init >"$probe_log" 2>&1; then
  cp "$probe_log" "$artifact_dir/unowned-container-init.txt"
  fail "atlas-core init adopted an existing production container."
fi
cp "$probe_log" "$artifact_dir/unowned-container-init.txt"
grep -F "Atlas Core found containers or durable volumes without matching CLI configuration." "$probe_log"
record_check "init rejects an existing labeled container without matching CLI configuration" "rejected" "rejected"

docker container rm "$probe_container" >/dev/null
probe_container_created=false
rm -rf -- "$core_home"

probe_volume="${project_name}_postgres_data"
docker volume create \
  --label "com.docker.compose.project=$project_name" \
  --label com.docker.compose.volume=postgres_data \
  --label "io.atlas.core.engine=$engine_id" \
  "$probe_volume" >/dev/null
probe_volume_created=true

probe_log="$test_root/existing-volume.log"
if ATLAS_CORE_HOME="$core_home" "$cli" init >"$probe_log" 2>&1; then
  cp "$probe_log" "$artifact_dir/unowned-volume-init.txt"
  fail "atlas-core init adopted an existing production volume."
fi
cp "$probe_log" "$artifact_dir/unowned-volume-init.txt"
grep -F "Atlas Core found containers or durable volumes without matching CLI configuration." "$probe_log"
record_check "init rejects an existing labeled durable volume without matching CLI configuration" "rejected" "rejected"

docker volume rm "$probe_volume" >/dev/null
probe_volume_created=false
rm -rf -- "$core_home"

init_log="$test_root/init.txt"
if ATLAS_CORE_HOME="$core_home" "$cli" init > "$init_log" 2>&1; then
  api_key="$(sed -n 's/^API_AUTH_KEY=//p' "$core_home/.env")"
  plugin_api_key="$(sed -n 's/^ATLAS_PLUGIN_API_KEY=//p' "$core_home/.env")"
  cat "$init_log" | redact_stream "$artifact_dir/init.txt"
else
  cat "$init_log" | redact_stream "$artifact_dir/init.txt"
  false
fi
jq -e --arg image "$expected_image" '
  .schema == 4 and
  .resourceLayout == "engine-scoped-v1" and
  .phase == "ready" and
  .dockerEngineId != "" and
  .baseDeployment.coreImage == $image and
  (.baseDeployment.images | length) >= 1
' "$core_home/state.json"
jq -e '.schema == 1 and .desiredRunning == false' "$core_home/run-intent.json"
test "$(stat -c '%a' "$core_home")" = "700"
test "$(stat -c '%a' "$core_home/.env")" = "600"
test "$(stat -c '%a' "$core_home/state.json")" = "600"
test "$(stat -c '%a' "$core_home/run-intent.json")" = "600"
grep -Eq '^ATLAS_PLUGIN_API_KEY=atlas_ak_[^[:space:]]+$' "$core_home/.env"
docker volume inspect "${project_name}_postgres_data" >/dev/null
docker volume inspect "${project_name}_minio_data" >/dev/null
record_check "init created the owned PostgreSQL and MinIO durable volumes" "both volumes exist" "both volumes exist"
if docker container inspect "${project_name}_api" >/dev/null 2>&1 || \
   docker container inspect "${project_name}_source_gateway" >/dev/null 2>&1 || \
   docker container inspect "${project_name}_postgres" >/dev/null 2>&1 || \
  docker container inspect "${project_name}_minio" >/dev/null 2>&1 || \
  docker container inspect "${project_name}_minio_init" >/dev/null 2>&1; then
  fail "atlas-core init left a Core container running despite the stopped run intent."
fi

ATLAS_CORE_HOME="$core_home" "$cli" start --manual 2>&1 | redact_stream "$artifact_dir/start-running.txt"
ATLAS_CORE_HOME="$core_home" "$cli" doctor 2>&1 | redact_stream "$artifact_dir/doctor-running.txt"
ATLAS_CORE_HOME="$core_home" "$cli" status 2>&1 | redact_stream "$artifact_dir/status-running.txt"
curl_response "$artifact_dir/readiness-running.json" http://127.0.0.1:8000/readiness
test "$(<"$artifact_dir/readiness-running.json.status")" = "200"
record_check "packed CLI starts a ready Core deployment" "readiness HTTP 200" "readiness HTTP 200"
test -n "$api_key"
entity_id="package-durable-entity"
curl_response "$artifact_dir/entity-created.json" \
  --header "x-api-key: $api_key" \
  --header 'content-type: application/json' \
  --data "{\"entity_id\":\"$entity_id\",\"entity_type\":\"asset\"}" \
  http://127.0.0.1:8000/entities
test "$(<"$artifact_dir/entity-created.json.status")" = "201"
jq -e --arg entity_id "$entity_id" '.entity_id == $entity_id and .entity_type == "asset"' \
  "$artifact_dir/entity-created.json" >/dev/null
test -n "$plugin_api_key"
protocol_revision="$(grep -Eo 'sha256:[0-9a-f]{64}' packages/protocol/generated/typescript/revision.ts)"
curl_response "$artifact_dir/protocol-revision-running.json" \
  --header "x-api-key: $plugin_api_key" \
  http://127.0.0.1:8000/protocol/revision
test "$(<"$artifact_dir/protocol-revision-running.json.status")" = "200"
jq -e --arg revision "$protocol_revision" '.protocol_revision == $revision' \
  "$artifact_dir/protocol-revision-running.json" >/dev/null
capture_resources "before-first-stop"

ATLAS_CORE_HOME="$core_home" "$cli" stop 2>&1 | redact_stream "$artifact_dir/stop-first.txt"
status_stopped_stdout="$test_root/status-stopped.stdout"
status_stopped_stderr="$test_root/status-stopped.stderr"
status_stopped_expected_stderr="$test_root/status-stopped.expected.stderr"
printf 'Atlas Core is stopped.\n' > "$status_stopped_expected_stderr"
if ATLAS_CORE_HOME="$core_home" "$cli" status \
  >"$status_stopped_stdout" 2>"$status_stopped_stderr"; then
  status_stopped_exit=0
else
  status_stopped_exit=$?
fi
redact_stream "$artifact_dir/status-stopped.stdout.txt" < "$status_stopped_stdout"
redact_stream "$artifact_dir/status-stopped.stderr.txt" < "$status_stopped_stderr"
{
  printf 'exit=%s\nstdout:\n' "$status_stopped_exit"
  cat "$artifact_dir/status-stopped.stdout.txt"
  printf 'stderr:\n'
  cat "$artifact_dir/status-stopped.stderr.txt"
} > "$artifact_dir/status-stopped.txt"
if [ "$status_stopped_exit" -ne 1 ]; then
  fail "atlas-core status after stop exited $status_stopped_exit instead of 1."
fi
if ! cmp -s "$status_stopped_stderr" "$status_stopped_expected_stderr"; then
  fail "atlas-core status after stop emitted unexpected stderr."
fi
if [ -s "$status_stopped_stdout" ]; then
  fail "atlas-core status after stop emitted unexpected stdout."
fi
record_check "packed CLI reports an initialized stopped deployment" \
  "exit 1; empty stdout; stderr Atlas Core is stopped." \
  "exit $status_stopped_exit; empty stdout; stderr Atlas Core is stopped."
for resource in \
  "${project_name}_api" \
  "${project_name}_source_gateway" \
  "${project_name}_postgres" \
  "${project_name}_minio" \
  "${project_name}_minio_init"; do
  if docker container inspect "$resource" >/dev/null 2>&1; then
    fail "atlas-core stop left container $resource running."
  fi
done
docker volume inspect "${project_name}_postgres_data" >/dev/null
docker volume inspect "${project_name}_minio_data" >/dev/null
record_check "stop removes service containers and preserves durable volumes" "containers absent; volumes retained" "containers absent; volumes retained"

ATLAS_CORE_HOME="$core_home" "$cli" start --manual 2>&1 | redact_stream "$artifact_dir/start-restarted.txt"
ATLAS_CORE_HOME="$core_home" "$cli" doctor 2>&1 | redact_stream "$artifact_dir/doctor-restarted.txt"
ATLAS_CORE_HOME="$core_home" "$cli" status 2>&1 | redact_stream "$artifact_dir/status-restarted.txt"
curl_response "$artifact_dir/readiness-restarted.json" http://127.0.0.1:8000/readiness
test "$(<"$artifact_dir/readiness-restarted.json.status")" = "200"
curl_response "$artifact_dir/entity-after-restart.json" \
  --header "x-api-key: $api_key" \
  "http://127.0.0.1:8000/entities/$entity_id"
test "$(<"$artifact_dir/entity-after-restart.json.status")" = "200"
jq -e --arg entity_id "$entity_id" '.entity_id == $entity_id and .entity_type == "asset"' \
  "$artifact_dir/entity-after-restart.json" >/dev/null
record_check "Core retains the authenticated Entity across packed CLI stop and start" "$entity_id asset" "$entity_id asset"

# Exercise the update with a real paired backup of this disposable deployment.
backup_dir="$test_root/pre-update-backup"
mkdir -p "$backup_dir/minio"
chmod 0700 "$backup_dir"
docker stop "${project_name}_api" "${project_name}_source_gateway" >/dev/null
git rev-parse HEAD > "$backup_dir/app-revision.txt"
docker exec "${project_name}_postgres" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U atlas -d atlas_core --format=custom --no-owner --no-privileges' > "$backup_dir/postgres.dump"
docker exec -i "${project_name}_postgres" pg_restore --list < "$backup_dir/postgres.dump" > "$backup_dir/postgres.contents.txt"
docker exec "${project_name}_postgres" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -At -U atlas -d atlas_core -c "SELECT concat_ws(chr(32), version, name, checksum, fingerprint_version) FROM atlas_schema_migrations ORDER BY version"' > "$backup_dir/schema-migrations.txt"
mc_image="quay.io/minio/mc:RELEASE.2024-01-31T08-59-40Z@sha256:c084c9a67c7a9ed5f37cc7f2a905010861aaa882bec76da10352305c9709b6d2"
docker run --rm --network "${project_name}_atlas_core_network" \
  --env-file "$core_home/.env" --volume "$backup_dir:/backup" \
  --entrypoint /bin/sh "$mc_image" -ec '
    mc alias set -- atlas http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mkdir -p "/backup/minio/$MINIO_BUCKET"
    mc mirror --overwrite "atlas/$MINIO_BUCKET" "/backup/minio/$MINIO_BUCKET"
    mc ls --recursive "atlas/$MINIO_BUCKET" > /backup/minio.contents.txt
    printf "%s\n" "$MINIO_BUCKET" > /backup/minio.complete
  '
ATLAS_CORE_HOME="$core_home" "$cli" start --manual 2>&1 | redact_stream "$artifact_dir/start-before-update.txt"

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  state.packageVersion = "0.0.0";
  fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
' "$core_home/state.json"
ATLAS_CORE_BACKUP_DIR="$backup_dir" ATLAS_CORE_HOME="$core_home" "$cli" __apply-core-update 0.0.0 "$expected_image" 2>&1 | redact_stream "$artifact_dir/update.txt"
test "$(node -p "require(process.argv[1]).packageVersion" "$core_home/state.json")" = "$version"
test "$(docker container inspect --format '{{.Config.Image}}' "${project_name}_api")" = "$expected_image"
ATLAS_CORE_HOME="$core_home" "$cli" status 2>&1 | redact_stream "$artifact_dir/status-updated.txt"
docker volume inspect "${project_name}_postgres_data" >/dev/null
docker volume inspect "${project_name}_minio_data" >/dev/null
curl_response "$artifact_dir/readiness-updated.json" http://127.0.0.1:8000/readiness
test "$(<"$artifact_dir/readiness-updated.json.status")" = "200"
record_check "packed CLI update retains the candidate image and durable volumes" "$expected_image; volumes retained" "$expected_image; volumes retained"

printf 'y\n' | ATLAS_CORE_HOME="$core_home" "$cli" reset --manual 2>&1 | redact_stream "$artifact_dir/reset.txt"
ATLAS_CORE_HOME="$core_home" "$cli" doctor 2>&1 | redact_stream "$artifact_dir/doctor-reset.txt"
ATLAS_CORE_HOME="$core_home" "$cli" status 2>&1 | redact_stream "$artifact_dir/status-reset.txt"
curl_response "$artifact_dir/readiness-reset.json" http://127.0.0.1:8000/readiness
test "$(<"$artifact_dir/readiness-reset.json.status")" = "200"
ATLAS_CORE_HOME="$core_home" "$cli" stop 2>&1 | redact_stream "$artifact_dir/stop-final.txt"

docker volume inspect "${project_name}_postgres_data" >/dev/null
docker volume inspect "${project_name}_minio_data" >/dev/null
capture_resources "before-final-cleanup"
record_check "reset and final stop leave the newly initialized durable volumes available" "both volumes retained" "both volumes retained"
