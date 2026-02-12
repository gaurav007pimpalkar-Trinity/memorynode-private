#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG=".tmp/e2e_smoke.log"
mkdir -p .tmp
: >"$LOG"

load_env_file_if_present() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r raw_line; do
    line="$(echo "$raw_line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    if [[ "$line" == *"="* ]]; then
      name="${line%%=*}"
      value="${line#*=}"
      if [[ -z "${!name:-}" ]]; then
        export "$name=$value"
      fi
    fi
  done < "$env_file"
}

load_env_file_if_present ".env.e2e"

# Allow MEMORYNODE_API_KEY as an alias.
if [[ -z "${E2E_API_KEY:-}" && -n "${MEMORYNODE_API_KEY:-}" ]]; then
  export E2E_API_KEY="$MEMORYNODE_API_KEY"
fi

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
USE_LOCAL_DEV=0
if [[ "$BASE_URL" == http://127.0.0.1:* || "$BASE_URL" == http://localhost:* ]]; then
  USE_LOCAL_DEV=1
fi

if [[ "$USE_LOCAL_DEV" -eq 0 && -z "${E2E_API_KEY:-}" ]]; then
  echo "Missing required env vars for remote mode: BASE_URL + E2E_API_KEY (or MEMORYNODE_API_KEY)" >&2
  exit 1
fi

WRANGLER_PID=""
cleanup() {
  if [[ -n "$WRANGLER_PID" ]] && ps -p "$WRANGLER_PID" >/dev/null 2>&1; then
    kill "$WRANGLER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "E2E smoke failed: $1" >&2
  if [[ -f "$LOG" ]]; then
    tail -n 200 "$LOG" || true
  fi
  exit 1
}

pick_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("", 0))
print(s.getsockname()[1])
s.close()
PY
    return
  fi

  if command -v python >/dev/null 2>&1; then
    python - <<'PY'
import socket
s = socket.socket()
s.bind(("", 0))
print(s.getsockname()[1])
s.close()
PY
    return
  fi

  node -e "const n=require('node:net');const s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});"
}

if [[ "$USE_LOCAL_DEV" -eq 1 ]]; then
  LOCAL_VARS_FILE="${E2E_LOCAL_VARS_FILE:-$ROOT_DIR/apps/api/.dev.vars}"
  if [[ -f "$LOCAL_VARS_FILE" ]]; then
    load_env_file_if_present "$LOCAL_VARS_FILE"
  else
    echo "Local vars file not found at $LOCAL_VARS_FILE. Load vars and rerun: set -a; source apps/api/.dev.vars; set +a; pnpm e2e:verify" >&2
  fi

  REQUIRED_VARS=(SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY API_KEY_SALT)
  if [[ -z "${E2E_API_KEY:-}" ]]; then
    REQUIRED_VARS+=(MASTER_ADMIN_TOKEN)
  fi
  missing=()
  for var in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      missing+=("$var")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing required env vars for local dev smoke: ${missing[*]}" >&2
    exit 1
  fi

  PORT="$(pick_port)"
  export PORT
  export EMBEDDINGS_MODE="${EMBEDDINGS_MODE:-stub}"

  WRANGLER_TOML="$ROOT_DIR/apps/api/wrangler.toml"
  if [[ ! -f "$WRANGLER_TOML" ]] || ! grep -q 'durable_objects' "$WRANGLER_TOML"; then
    echo "ERROR: wrangler.toml is missing durable_objects section (expected RATE_LIMIT_DO)" >&2
    exit 1
  fi
  if ! grep -Eq '(binding|name) *= *"RATE_LIMIT_DO"' "$WRANGLER_TOML"; then
    echo "ERROR: wrangler.toml is missing durable_objects binding/name RATE_LIMIT_DO" >&2
    sed -n '/durable_objects/,+12p' "$WRANGLER_TOML"
    exit 1
  fi

  echo "Starting API dev server on port $PORT..."
  pnpm --filter @memorynode/api exec wrangler dev --port "$PORT" --log-level error >"$LOG" 2>&1 &
  WRANGLER_PID=$!

  printf "Waiting for /healthz"
  healthy=0
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then
      healthy=1
      break
    fi
    printf "."
    sleep 1
  done
  if [[ "$healthy" -ne 1 ]]; then
    echo " failed"
    fail "healthz not ready"
  fi
  echo " ok"
  BASE_URL="http://127.0.0.1:${PORT}"
  echo "Base URL (local dev): $BASE_URL"
else
  echo "Base URL (remote): $BASE_URL"
fi

mask_secret() {
  printf '%s' '***redacted***'
}

mask_arg_secrets() {
  local value="${1:-}"
  local masked="$value"
  local name env_value
  while IFS='=' read -r name env_value; do
    if [[ "$name" =~ [Tt][Oo][Kk][Ee][Nn]|[Kk][Ee][Yy]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn] ]]; then
      [[ -z "$env_value" || ${#env_value} -lt 4 ]] && continue
      masked="${masked//"$env_value"/$(mask_secret "$env_value")}"
    fi
  done < <(env)
  printf '%s' "$masked"
}

is_sensitive_header_name() {
  local header_name_lc
  header_name_lc="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  if [[ "$header_name_lc" == "authorization" || "$header_name_lc" == "cookie" ]]; then
    return 0
  fi
  [[ "$header_name_lc" == *token* || "$header_name_lc" == *key* ]]
}

mask_header_value() {
  local header="$1"
  if [[ "$header" =~ ^[[:space:]]*([^:]+)[[:space:]]*:[[:space:]]*(.*)$ ]]; then
    local name="${BASH_REMATCH[1]}"
    local value="${BASH_REMATCH[2]}"
    local name_lc
    name_lc="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    if is_sensitive_header_name "$name"; then
      if [[ "$name_lc" == "authorization" && "$value" =~ ^[Bb]earer[[:space:]]+ ]]; then
        printf '%s: Bearer %s' "$name" "$(mask_secret "$value")"
      else
        printf '%s: %s' "$name" "$(mask_secret "$value")"
      fi
      return
    fi
    printf '%s: %s' "$name" "$(mask_arg_secrets "$value")"
    return
  fi
  printf '%s' "$(mask_arg_secrets "$header")"
}

redact_headers() {
  local line
  while IFS= read -r line; do
    printf '%s\n' "$(mask_header_value "$line")"
  done
}

format_curl_preview() {
  local -a args=("$@")
  local -a out=("curl")
  local i arg
  for ((i = 0; i < ${#args[@]}; i++)); do
    arg="${args[$i]}"
    if [[ "$arg" == "-H" || "$arg" == "--header" ]]; then
      out+=("$arg")
      if (( i + 1 < ${#args[@]} )); then
        out+=("$(mask_header_value "${args[$((i + 1))]}")")
        ((i++))
      fi
      continue
    fi
    out+=("$(mask_arg_secrets "$arg")")
  done

  local preview="" part
  for part in "${out[@]}"; do
    if [[ -z "$preview" ]]; then
      preview="$(printf '%q' "$part")"
    else
      preview="$preview $(printf '%q' "$part")"
    fi
  done
  printf '%s' "$preview"
}

invoke_curl() {
  local -a args=("$@")
  echo ">> $(format_curl_preview "${args[@]}")"
  curl "${args[@]}"
}

run_mask_self_test() {
  local sample_bearer="mn_live_SAMPLE_TOKEN_NOT_REAL"
  local sample_api_key="mn_live_TEST_TOKEN_DO_NOT_USE"
  local sample_cookie="session=mn_live_COOKIE_DO_NOT_USE"
  local sample_token_header="x-session-token: mn_live_HEADER_TOKEN_DO_NOT_USE"
  export E2E_PREVIEW_SELFTEST_KEY="$sample_api_key"

  local preview
  preview="$(format_curl_preview \
    -sS \
    -H "Authorization: Bearer $sample_bearer" \
    -H "x-api-key: $sample_api_key" \
    -H "cookie: $sample_cookie" \
    -H "$sample_token_header" \
    "https://example.test/healthz?access_key=$sample_api_key")"
  echo "$preview"

  local dump masked
  dump=$'HTTP/1.1 401 Unauthorized\nAuthorization: Bearer '"$sample_bearer"$'\nx-api-key: '"$sample_api_key"$'\ncookie: '"$sample_cookie"$'\n'"$sample_token_header"
  masked="$(printf '%s\n' "$dump" | redact_headers)"
  echo "$masked"
  unset E2E_PREVIEW_SELFTEST_KEY

  if [[ "$preview" == *"$sample_bearer"* || "$preview" == *"$sample_api_key"* ]]; then
    echo "Mask self-test failed: secret leaked in command preview" >&2
    exit 1
  fi
  if [[ "$masked" == *"$sample_bearer"* || "$masked" == *"$sample_api_key"* ]]; then
    echo "Mask self-test failed: secret leaked in header redaction" >&2
    exit 1
  fi
}

if [[ "${E2E_MASK_SELF_TEST:-0}" == "1" ]]; then
  run_mask_self_test
  exit 0
fi

get_status_code() {
  awk '/^HTTP/{code=$2} END{print code}' "$1"
}

call_health() {
  local header_file body_file status
  header_file="$(mktemp)"
  body_file="$(mktemp)"

  local -a curl_args=(-sS -D "$header_file" -o "$body_file" "$BASE_URL/healthz")
  if ! invoke_curl "${curl_args[@]}"; then
    rm -f "$header_file" "$body_file"
    fail "GET /healthz request execution"
  fi

  status="$(get_status_code "$header_file")"
  if [[ "$status" != "200" ]]; then
    echo "Expected 200 got $status for /healthz" >&2
    echo "Headers:" >&2
    redact_headers <"$header_file"
    echo "Body:" >&2
    cat "$body_file"
    rm -f "$header_file" "$body_file"
    fail "GET /healthz"
  fi

  rm -f "$header_file" "$body_file"
}

call_api() {
  local method="$1"
  local path="$2"
  local expect_status="$3"
  local body="${4:-}"
  local jq_filter="${5:-}"
  local header_file body_file status

  header_file="$(mktemp)"
  body_file="$(mktemp)"

  echo "-> $method $path"
  curl_args=(-sS -D "$header_file" -o "$body_file" -X "$method" "$BASE_URL$path" -H "Authorization: Bearer ${E2E_API_KEY}")
  if [[ -n "$body" ]]; then
    curl_args+=(-H "Content-Type: application/json" --data "$body")
  fi

  if ! invoke_curl "${curl_args[@]}"; then
    echo "Request execution failed" >&2
    rm -f "$header_file" "$body_file"
    fail "$method $path request"
  fi

  status="$(get_status_code "$header_file")"
  if [[ "$status" != "$expect_status" ]]; then
    echo "Expected $expect_status got $status" >&2
    echo "Headers:" >&2
    redact_headers <"$header_file"
    echo "Body:" >&2
    cat "$body_file"
    rm -f "$header_file" "$body_file"
    fail "$method $path"
  fi

  if [[ -n "$jq_filter" ]]; then
    if ! jq -e "$jq_filter" <"$body_file" >/dev/null 2>&1; then
      echo "Response validation failed: $jq_filter" >&2
      cat "$body_file"
      rm -f "$header_file" "$body_file"
      fail "$method $path validation"
    fi
  fi

  rm -f "$header_file" "$body_file"
}

bootstrap_local_api_key() {
  local header_file body_file status workspace_id api_key
  header_file="$(mktemp)"
  body_file="$(mktemp)"
  echo "Bootstrapping local E2E API key via admin endpoints..."
  if ! invoke_curl -sS -D "$header_file" -o "$body_file" -X POST \
    "$BASE_URL/v1/workspaces" \
    -H "x-admin-token: ${MASTER_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"name":"E2E Smoke Workspace"}'; then
    rm -f "$header_file" "$body_file"
    fail "local bootstrap workspace request"
  fi
  status="$(get_status_code "$header_file")"
  if [[ "$status" != "200" ]]; then
    echo "Workspace bootstrap expected 200 got $status" >&2
    redact_headers <"$header_file"
    cat "$body_file" >&2
    rm -f "$header_file" "$body_file"
    fail "local bootstrap workspace response"
  fi
  workspace_id="$(jq -r '.workspace_id // empty' <"$body_file")"
  if [[ -z "$workspace_id" ]]; then
    rm -f "$header_file" "$body_file"
    fail "local bootstrap workspace_id missing"
  fi

  : >"$header_file"
  : >"$body_file"
  if ! invoke_curl -sS -D "$header_file" -o "$body_file" -X POST \
    "$BASE_URL/v1/api-keys" \
    -H "x-admin-token: ${MASTER_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"workspace_id\":\"$workspace_id\",\"name\":\"e2e-smoke\"}"; then
    rm -f "$header_file" "$body_file"
    fail "local bootstrap api key request"
  fi
  status="$(get_status_code "$header_file")"
  if [[ "$status" != "200" ]]; then
    echo "API key bootstrap expected 200 got $status" >&2
    redact_headers <"$header_file"
    cat "$body_file" >&2
    rm -f "$header_file" "$body_file"
    fail "local bootstrap api key response"
  fi
  api_key="$(jq -r '.api_key // empty' <"$body_file")"
  rm -f "$header_file" "$body_file"
  if [[ -z "$api_key" ]]; then
    fail "local bootstrap api_key missing"
  fi
  export E2E_API_KEY="$api_key"
}

if [[ "$USE_LOCAL_DEV" -eq 1 && -z "${E2E_API_KEY:-}" ]]; then
  bootstrap_local_api_key
fi

call_health
call_api "POST" "/v1/memories" 200 '{"user_id":"e2e-user","text":"hello e2e memory","namespace":"e2e"}' '.memory_id'
call_api "POST" "/v1/search" 200 '{"user_id":"e2e-user","namespace":"e2e","query":"hello","top_k":3}' '.results'
call_api "POST" "/v1/context" 200 '{"user_id":"e2e-user","namespace":"e2e","query":"hello"}' '.context_text'
call_api "GET" "/v1/usage/today" 200 "" '.day'

echo "E2E smoke passed."
