#!/usr/bin/env bash
# run_integration_tests.sh — Standalone integration tests for the Atlas Core API.
#
# Usage (from repo root):
#   ATLAS_CORE_API_URL=http://localhost:8000 ./Atlas_Core/scripts/run_integration_tests.sh
# or, from within Atlas_Core/scripts/:
#   ATLAS_CORE_API_URL=http://localhost:8000 ./run_integration_tests.sh
# For authenticated deployments:
#   API_AUTH_KEY=... ATLAS_CORE_API_URL=http://localhost:8000 ./Atlas_Core/scripts/run_integration_tests.sh
#
# Requires: curl, jq
# The API must already be running and ready before this script is invoked.

set -euo pipefail

API_URL="${ATLAS_CORE_API_URL:-${ATLAS_API_URL:-http://localhost:8000}}"
API_URL="${API_URL%/}"
CONNECT_TIMEOUT="${ATLAS_CONNECT_TIMEOUT:-5}"
MAX_TIME="${ATLAS_MAX_TIME:-30}"
API_KEY="${ATLAS_API_AUTH_KEY:-${API_AUTH_KEY:-}}"
ADMIN_USERNAME="${ATLAS_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ATLAS_ADMIN_PASSWORD:-password}"
UI_ORIGIN="${ATLAS_UI_ORIGIN:-http://localhost:5173}"
SESSION_COOKIE_HEADER=""
PASS=0
FAIL=0
RUN_ID="$(date +%s)-$$"
ENTITY_ID="test-entity-${RUN_ID}"
TASK_ID="test-task-${RUN_ID}"

# ── helpers ──────────────────────────────────────────────────────────────────

# Make an HTTP request and capture body + status code.
# Sets BODY and HTTP_CODE for the caller.
# Retries only safe/idempotent methods (GET) — POST retries can duplicate resources.
request() {
  local method="$1" path="$2"
  shift 2
  local response
  local retry_args=()
  local auth_args=()
  if [ "$method" = "GET" ] || [ "$method" = "HEAD" ]; then
    retry_args=(--retry 2 --retry-delay 1)
  fi
  if [ -n "$API_KEY" ]; then
    auth_args=(-H "X-API-Key: ${API_KEY}")
  elif [ -n "$SESSION_COOKIE_HEADER" ]; then
    auth_args=(-H "Cookie: ${SESSION_COOKIE_HEADER}" -H "Origin: ${UI_ORIGIN}")
  fi
  set +e
  response=$(curl -sS \
    --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIME" \
    ${retry_args[@]+"${retry_args[@]}"} \
    ${auth_args[@]+"${auth_args[@]}"} \
    -w "\n%{http_code}" \
    -X "$method" "${API_URL}${path}" "$@" 2>&1)
  local curl_exit=$?
  set -e
  if [ "$curl_exit" -ne 0 ]; then
    BODY="$response"
    HTTP_CODE="000"
    return
  fi
  # Portable split: last line is HTTP code (GNU/BSD; avoids `head -n -1`)
  HTTP_CODE=$(printf '%s\n' "$response" | tail -n 1)
  BODY=$(printf '%s\n' "$response" | sed '$d')
}

assert_status() {
  local expected="$1" context="$2"
  if [ "$HTTP_CODE" != "$expected" ]; then
    echo "FAIL  ${context}: expected HTTP ${expected}, got ${HTTP_CODE}"
    echo "      body: ${BODY}"
    FAIL=$((FAIL + 1))
    return 1
  fi
}

assert_json() {
  local expr="$1" context="$2"
  if ! printf '%s' "$BODY" | jq -e "$expr" > /dev/null 2>&1; then
    echo "FAIL  ${context}: jq expression failed: ${expr}"
    echo "      body: ${BODY}"
    FAIL=$((FAIL + 1))
    return 1
  fi
}

# Like assert_json but passes extra args to jq (e.g. --arg name value).
assert_jq() {
  local context="$1"
  shift
  if ! printf '%s' "$BODY" | jq -e "$@" > /dev/null 2>&1; then
    echo "FAIL  ${context}: jq failed"
    echo "      body: ${BODY}"
    FAIL=$((FAIL + 1))
    return 1
  fi
}

pass() {
  echo "PASS  $1"
  PASS=$((PASS + 1))
}

login_admin_session() {
  if [ -n "$API_KEY" ]; then
    return 0
  fi

  local headers_file body_file http_code login_payload
  login_payload="$(jq -n --arg username "$ADMIN_USERNAME" --arg password "$ADMIN_PASSWORD" '{username:$username,password:$password}')"
  headers_file="$(mktemp)"
  body_file="$(mktemp)"
  set +e
  http_code=$(curl -sS \
    --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIME" \
    -D "$headers_file" \
    -o "$body_file" \
    -w "%{http_code}" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Origin: ${UI_ORIGIN}" \
    -X POST "${API_URL}/admin/auth/login" \
    -d "$login_payload" 2>&1)
  local curl_exit=$?
  set -e

  if [ "$curl_exit" -ne 0 ] || [ "$http_code" != "200" ]; then
    echo "FAIL  POST /admin/auth/login: expected HTTP 200, got ${http_code}"
    echo "      body: $(cat "$body_file")"
    rm -f "$headers_file" "$body_file"
    FAIL=$((FAIL + 1))
    return 1
  fi

  SESSION_COOKIE_HEADER="$(
    awk 'tolower($0) ~ /^set-cookie:[[:space:]]*atlas_session=/ {
      sub(/\r$/, "");
      sub(/^[^:]+:[[:space:]]*/, "");
      split($0, parts, ";");
      print parts[1];
      exit;
    }' "$headers_file"
  )"
  rm -f "$headers_file" "$body_file"
  if [ -z "$SESSION_COOKIE_HEADER" ]; then
    echo "FAIL  POST /admin/auth/login: atlas_session cookie missing"
    FAIL=$((FAIL + 1))
    return 1
  fi
  pass "POST /admin/auth/login — dev admin session established"
}

# ── tests ────────────────────────────────────────────────────────────────────

echo "Running Atlas Core integration tests against ${API_URL}"
echo ""

# 1. Health endpoint
request GET /health
assert_status 200 "GET /health" && \
  assert_json '.status == "healthy"' "GET /health body" && \
  pass "GET /health — status healthy"

# 1b. Readiness endpoint
request GET /readiness
assert_status 200 "GET /readiness" && \
  assert_json '.status == "healthy" or .status == "degraded"' "GET /readiness body" && \
  pass "GET /readiness — dependency checks OK"

login_admin_session

# 2. Root endpoint
request GET /
assert_status 200 "GET /" && \
  pass "GET / — root reachable"

# 3. Entities list (initially empty)
request GET /entities
assert_status 200 "GET /entities" && \
  assert_json 'type == "array"' "GET /entities body" && \
  pass "GET /entities — returns array"

# 4. Create an entity
request POST /entities \
  -H "Content-Type: application/json" \
  -d "{\"entity_id\": \"${ENTITY_ID}\", \"entity_type\": \"asset\", \"subtype\": \"drone\"}"
assert_status 201 "POST /entities" && \
  assert_json ".entity_id == \"${ENTITY_ID}\"" "POST /entities entity_id" && \
  assert_json '.entity_type == "asset"' "POST /entities entity_type" && \
  pass "POST /entities — entity created"

# 5. Get the entity
request GET "/entities/${ENTITY_ID}"
assert_status 200 "GET /entities/${ENTITY_ID}" && \
  assert_json ".entity_id == \"${ENTITY_ID}\"" "GET /entities/${ENTITY_ID} body" && \
  pass "GET /entities/${ENTITY_ID} — entity retrieved"

# 6. Tasks list (initially empty)
request GET /tasks
assert_status 200 "GET /tasks" && \
  pass "GET /tasks — returns OK"

# 7. Create a task
request POST /tasks \
  -H "Content-Type: application/json" \
  -d "{\"task_id\": \"${TASK_ID}\", \"entity_id\": \"${ENTITY_ID}\"}"
assert_status 201 "POST /tasks" && \
  assert_json ".task_id == \"${TASK_ID}\"" "POST /tasks task_id" && \
  pass "POST /tasks — task created"

# 8. Get the task
request GET "/tasks/${TASK_ID}"
assert_status 200 "GET /tasks/${TASK_ID}" && \
  assert_json ".task_id == \"${TASK_ID}\"" "GET /tasks/${TASK_ID} body" && \
  pass "GET /tasks/${TASK_ID} — task retrieved"

# 9. Full query (assert created entity/task ids appear in payload)
request GET /queries/full
assert_status 200 "GET /queries/full" && \
  assert_json '.entities | type == "array"' "GET /queries/full entities" && \
  assert_json '.tasks    | type == "array"' "GET /queries/full tasks" && \
  assert_json '.objects  | type == "array"' "GET /queries/full objects" && \
  assert_json '.version  | type == "number"' "GET /queries/full version watermark" && \
  assert_json '.entities | length >= 1'     "GET /queries/full entity count" && \
  assert_json '.tasks    | length >= 1'     "GET /queries/full task count"
# shellcheck disable=SC2016 # $e/$t are jq --arg variables, not shell expansions
assert_jq "GET /queries/full contains ENTITY_ID" --arg e "$ENTITY_ID" 'any(.entities[]?; .entity_id == $e)'
# shellcheck disable=SC2016
assert_jq "GET /queries/full contains TASK_ID" --arg t "$TASK_ID" 'any(.tasks[]?; .task_id == $t)'
pass "GET /queries/full — returns expected data"

# ── summary ──────────────────────────────────────────────────────────────────

echo ""
echo "========================================="
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
