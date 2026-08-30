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
probe_container="atlas_core_production_api"
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
  atlas_core_production_api \
  atlas_core_production_source_gateway \
  atlas_core_production_postgres \
  atlas_core_production_minio \
  atlas_core_production_minio_init; do
  if docker container inspect "$resource" >/dev/null 2>&1; then
    echo "Disposable runner already contains Atlas Core container $resource." >&2
    exit 1
  fi
done
for resource in atlas_core_production_postgres_data atlas_core_production_minio_data; do
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
  --label com.docker.compose.project=atlas_core_production \
  --label com.docker.compose.service=api \
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
ATLAS_CORE_HOME="$core_home" "$cli" start
ATLAS_CORE_HOME="$core_home" "$cli" doctor
ATLAS_CORE_HOME="$core_home" "$cli" status
curl --fail --silent --show-error http://127.0.0.1:8000/readiness

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  state.packageVersion = "0.0.0";
  fs.writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
' "$core_home/state.json"
ATLAS_CORE_HOME="$core_home" "$cli" __apply-core-update 0.0.0 "$expected_image"
test "$(node -p "require(process.argv[1]).packageVersion" "$core_home/state.json")" = "$version"
test "$(docker container inspect --format '{{.Config.Image}}' atlas_core_production_api)" = "$expected_image"
ATLAS_CORE_HOME="$core_home" "$cli" status
docker volume inspect atlas_core_production_postgres_data >/dev/null
docker volume inspect atlas_core_production_minio_data >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/readiness

printf 'y\n' | ATLAS_CORE_HOME="$core_home" "$cli" reset
ATLAS_CORE_HOME="$core_home" "$cli" doctor
ATLAS_CORE_HOME="$core_home" "$cli" status
curl --fail --silent --show-error http://127.0.0.1:8000/readiness
ATLAS_CORE_HOME="$core_home" "$cli" stop

docker volume inspect atlas_core_production_postgres_data >/dev/null
docker volume inspect atlas_core_production_minio_data >/dev/null
