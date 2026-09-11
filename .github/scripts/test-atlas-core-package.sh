#!/usr/bin/env bash

set -euo pipefail

if [ "${ATLAS_CORE_ACCEPTANCE_DISPOSABLE:-}" != "1" ]; then
  echo "Atlas Core package acceptance requires an explicitly disposable Docker host." >&2
  exit 1
fi
if [ "$#" -ne 3 ]; then
  echo "usage: test-atlas-core-package.sh <package.tgz> <version> <image-reference>" >&2
  exit 2
fi

package_path="$(realpath "$1")"
version="$2"
expected_image="$3"
test_root="$(mktemp -d)"
install_root="$test_root/install"
core_home="$test_root/core-home"
engine_id="$(docker info --format '{{.ID}}')"
test -n "$engine_id"
engine_key="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$engine_id")"
project_name="atlas_core_production_$engine_key"
probe_container="${project_name}_api"
cli="$install_root/node_modules/.bin/atlas-core"

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [ -x "$cli" ] && [ -f "$core_home/state.json" ]; then
    ATLAS_CORE_HOME="$core_home" "$cli" stop >/dev/null 2>&1
  fi
  docker container rm --force "$probe_container" >/dev/null 2>&1
  rm -rf -- "$test_root"
  exit "$status"
}
trap cleanup EXIT

for resource in \
  "${project_name}_api" \
  "${project_name}_source_gateway" \
  "${project_name}_postgres" \
  "${project_name}_minio" \
  "${project_name}_minio_init"; do
  if docker container inspect "$resource" >/dev/null 2>&1; then
    echo "Disposable runner already contains Atlas Core container $resource." >&2
    exit 1
  fi
done
for resource in "${project_name}_postgres_data" "${project_name}_minio_data"; do
  if docker volume inspect "$resource" >/dev/null 2>&1; then
    echo "Disposable runner already contains Atlas Core volume $resource." >&2
    exit 1
  fi
done

npm install --prefix "$install_root" "$package_path"
test "$("$cli" version)" = "atlas-core $version"

package_json="$install_root/node_modules/atlas-core/package.json"
actual_image="$(node -e 'process.stdout.write(require(process.argv[1]).atlasCoreImage || "")' "$package_json")"
if [ "$actual_image" != "$expected_image" ]; then
  echo "Packed CLI pins $actual_image instead of $expected_image." >&2
  exit 1
fi

docker pull "$expected_image"
docker container create \
  --name "$probe_container" \
  --label "com.docker.compose.project=$project_name" \
  --label com.docker.compose.service=api \
  --label "io.atlas.core.engine=$engine_id" \
  "$expected_image" >/dev/null

probe_log="$test_root/existing-container.log"
if ATLAS_CORE_HOME="$core_home" "$cli" init >"$probe_log" 2>&1; then
  echo "atlas-core init adopted an existing production container." >&2
  exit 1
fi
grep -F "Atlas Core found containers or durable volumes without matching CLI configuration." "$probe_log"

docker container rm "$probe_container" >/dev/null
rm -rf -- "$core_home"

ATLAS_CORE_HOME="$core_home" "$cli" init
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
if docker container inspect "${project_name}_api" >/dev/null 2>&1 || \
   docker container inspect "${project_name}_source_gateway" >/dev/null 2>&1 || \
   docker container inspect "${project_name}_postgres" >/dev/null 2>&1 || \
   docker container inspect "${project_name}_minio" >/dev/null 2>&1 || \
   docker container inspect "${project_name}_minio_init" >/dev/null 2>&1; then
  echo "atlas-core init left a Core container running despite the stopped run intent." >&2
  exit 1
fi

ATLAS_CORE_HOME="$core_home" "$cli" start --manual
ATLAS_CORE_HOME="$core_home" "$cli" doctor
ATLAS_CORE_HOME="$core_home" "$cli" status
curl --fail --silent --show-error http://127.0.0.1:8000/readiness
plugin_api_key="$(sed -n 's/^ATLAS_PLUGIN_API_KEY=//p' "$core_home/.env")"
protocol_revision="$(grep -Eo 'sha256:[0-9a-f]{64}' packages/protocol/generated/typescript/revision.ts)"
curl --fail --silent --show-error \
  --header "x-api-key: $plugin_api_key" \
  http://127.0.0.1:8000/protocol/revision |
  jq -e --arg revision "$protocol_revision" '.protocol_revision == $revision'

# Exercise the update with a real paired backup of this disposable deployment.
backup_dir="$test_root/pre-update-backup"
mkdir -p "$backup_dir/minio"
chmod 0700 "$backup_dir"
docker stop "${project_name}_api" "${project_name}_source_gateway" >/dev/null
git rev-parse HEAD > "$backup_dir/app-revision.txt"
docker exec "${project_name}_postgres" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U atlas -d atlas_core --format=custom --no-owner --no-privileges' > "$backup_dir/postgres.dump"
docker exec -i "${project_name}_postgres" pg_restore --list < "$backup_dir/postgres.dump" > "$backup_dir/postgres.contents.txt"
docker exec "${project_name}_postgres" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -At -U atlas -d atlas_core -c "SELECT concat_ws(chr(32), version, name, checksum, fingerprint_version) FROM atlas_schema_migrations ORDER BY version"' > "$backup_dir/schema-migrations.txt"
mc_image="minio/mc:RELEASE.2024-01-31T08-59-40Z@sha256:c084c9a67c7a9ed5f37cc7f2a905010861aaa882bec76da10352305c9709b6d2"
docker run --rm --network "${project_name}_atlas_core_network" \
  --env-file "$core_home/.env" --volume "$backup_dir:/backup" \
  --entrypoint /bin/sh "$mc_image" -ec '
    mc alias set atlas http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mkdir -p "/backup/minio/$MINIO_BUCKET"
    mc mirror --overwrite "atlas/$MINIO_BUCKET" "/backup/minio/$MINIO_BUCKET"
    mc ls --recursive "atlas/$MINIO_BUCKET" > /backup/minio.contents.txt
    printf "%s\n" "$MINIO_BUCKET" > /backup/minio.complete
  '
ATLAS_CORE_HOME="$core_home" "$cli" start --manual

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  state.packageVersion = "0.0.0";
  fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
' "$core_home/state.json"
ATLAS_CORE_BACKUP_DIR="$backup_dir" ATLAS_CORE_HOME="$core_home" "$cli" __apply-core-update 0.0.0 "$expected_image"
test "$(node -p "require(process.argv[1]).packageVersion" "$core_home/state.json")" = "$version"
test "$(docker container inspect --format '{{.Config.Image}}' "${project_name}_api")" = "$expected_image"
ATLAS_CORE_HOME="$core_home" "$cli" status
docker volume inspect "${project_name}_postgres_data" >/dev/null
docker volume inspect "${project_name}_minio_data" >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/readiness

printf 'y\n' | ATLAS_CORE_HOME="$core_home" "$cli" reset
ATLAS_CORE_HOME="$core_home" "$cli" doctor
ATLAS_CORE_HOME="$core_home" "$cli" status
curl --fail --silent --show-error http://127.0.0.1:8000/readiness
ATLAS_CORE_HOME="$core_home" "$cli" stop

docker volume inspect "${project_name}_postgres_data" >/dev/null
docker volume inspect "${project_name}_minio_data" >/dev/null
