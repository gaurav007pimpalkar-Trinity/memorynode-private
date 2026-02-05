#!/usr/bin/env bash
set -euo pipefail

# Optional dotenv for local runs
if [[ -f .env.e2e ]]; then
  # shellcheck disable=SC1091
  source .env.e2e
fi

REQUIRED_VARS=(E2E_API_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY API_KEY_SALT)
missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required env vars: ${missing[*]}" >&2
  exit 1
fi

# Choose a random free port
PORT="$(python - <<'PY'
import socket
s = socket.socket()
s.bind(("",0))
print(s.getsockname()[1])
s.close()
PY
)"

export PORT
export EMBEDDINGS_MODE="${EMBEDDINGS_MODE:-stub}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG=.tmp/e2e_smoke.log
mkdir -p .tmp

WRANGLER_TOML="$ROOT_DIR/apps/api/wrangler.toml"
if [[ ! -f "$WRANGLER_TOML" ]] || ! grep -q 'durable_objects' "$WRANGLER_TOML"; then
  echo "ERROR: wrangler.toml is missing durable_objects section (expected RATE_LIMIT_DO)" >&2
  exit 1
fi
if ! grep -q 'binding *= *\"RATE_LIMIT_DO\"' "$WRANGLER_TOML"; then
  echo "ERROR: wrangler.toml is missing durable_objects binding RATE_LIMIT_DO" >&2
  sed -n '/durable_objects/,+12p' "$WRANGLER_TOML"
  exit 1
fi

cleanup() {
  if [[ -n "${WRANGLER_PID:-}" ]] && ps -p "$WRANGLER_PID" >/dev/null 2>&1; then
    kill "$WRANGLER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Starting wrangler dev on port $PORT..."
pnpm --filter @memorynode/api wrangler dev --port "$PORT" --log-level error >"$LOG" 2>&1 &
WRANGLER_PID=$!

wait_health() {
  printf "Waiting for /healthz"
  for _ in {1..60}; do
    if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then
      echo " ok"
      return 0
    fi
    printf "."
    sleep 1
  done
  echo " failed"
  echo "Health check failed. Recent logs:"
  tail -n 200 "$LOG" || true
  exit 1
}

BASE="http://127.0.0.1:${PORT}"
echo "Base URL: $BASE"
wait_health

fail() {
  echo "E2E smoke failed: $1"
  tail -n 200 "$LOG" || true
  exit 1
}

redact_headers() {
  sed -E 's/[Aa]uthorization: Bearer [^[:space:]]+/Authorization: Bearer ***redacted***/'
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
  curl_args=(-sS -D "$header_file" -o "$body_file" -X "$method" "$BASE$path" -H "Authorization: Bearer ${E2E_API_KEY}")
  if [[ -n "$body" ]]; then
    curl_args+=(-H "Content-Type: application/json" --data "$body")
  fi

  if ! curl "${curl_args[@]}" >/dev/null; then
    echo "Request execution failed"
  fi

  status="$(head -n1 "$header_file" | awk '{print $2}')"
  if [[ "$status" != "$expect_status" ]]; then
    echo "Expected $expect_status got $status"
    echo "Headers:"; redact_headers <"$header_file"
    echo "Body:"; cat "$body_file"
    fail "$method $path"
  fi

  if [[ -n "$jq_filter" ]]; then
    if ! jq -e "$jq_filter" <"$body_file" >/dev/null 2>&1; then
      echo "Response validation failed: $jq_filter"
      cat "$body_file"
      fail "$method $path validation"
    fi
  fi

  rm -f "$header_file" "$body_file"
}

call_api "POST" "/v1/memories" 200 '{"user_id":"e2e-user","text":"hello e2e memory","namespace":"e2e"}' '.memory_id'
call_api "POST" "/v1/search" 200 '{"user_id":"e2e-user","namespace":"e2e","query":"hello","top_k":3}' '.results'
call_api "POST" "/v1/context" 200 '{"user_id":"e2e-user","namespace":"e2e","query":"hello"}' '.context_text'
call_api "GET" "/v1/usage/today" 200 "" '.day'

echo "E2E smoke passed."
