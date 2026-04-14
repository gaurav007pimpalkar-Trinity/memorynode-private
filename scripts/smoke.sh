#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
TMP_DIR="$ROOT_DIR/.tmp"
LOG_FILE="$TMP_DIR/wrangler.log"
PID_FILE="$TMP_DIR/wrangler.pid"

SMOKE_MODE="${SMOKE_MODE:-local}" # local | ci
HEALTH_RETRIES_LOCAL=60
HEALTH_RETRIES_CI=90
HEALTH_SLEEP=1
HEALTH_RETRIES=$([ "$SMOKE_MODE" = "ci" ] && echo "$HEALTH_RETRIES_CI" || echo "$HEALTH_RETRIES_LOCAL")
STEP_TIMEOUT=30

if [ "$SMOKE_MODE" = "ci" ]; then
  export SUPABASE_URL="stub"
  export SUPABASE_SERVICE_ROLE_KEY="stub"
  export SUPABASE_MODE="stub"
  DEV_VARS="$API_DIR/.dev.vars"
  DEV_VARS_BAK="$API_DIR/.dev.vars.smoke.bak"
  if [ -f "$DEV_VARS_BAK" ]; then
    echo "error: backup already exists: $DEV_VARS_BAK. Clean up before running smoke."
    exit 1
  fi
  if [ -f "$DEV_VARS" ]; then
    cp "$DEV_VARS" "$DEV_VARS_BAK"
  fi
  cat >"$DEV_VARS" <<'EOF'
SUPABASE_URL=stub
SUPABASE_SERVICE_ROLE_KEY=stub
SUPABASE_MODE=stub
API_KEY_SALT=dev_salt_stub
MASTER_ADMIN_TOKEN=mn_dev_admin_12345
EMBEDDINGS_MODE=stub
OPENAI_API_KEY=dummy
RATE_LIMIT_DO=stub
EOF
fi

mkdir -p "$TMP_DIR"

echo "Preflight: checking required tools..."

# Node required
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is missing. Install Node.js 20+."
  echo "On Windows, prefer scripts/smoke.ps1."
  exit 127
fi

# Resolve pnpm/corepack
PNPM_CMD=()
try_cmd() { "$@" --version >/dev/null 2>&1; }
if command -v corepack >/dev/null 2>&1 && try_cmd corepack pnpm; then
  PNPM_CMD=(corepack pnpm)
elif command -v pnpm >/dev/null 2>&1 && try_cmd pnpm; then
  PNPM_CMD=(pnpm)
elif command -v npx >/dev/null 2>&1 && try_cmd npx -y pnpm@latest; then
  PNPM_CMD=(npx -y pnpm@latest)
else
  echo "error: pnpm not available."
  echo "Install corepack (recommended): npm install -g corepack && corepack prepare pnpm@9 --activate"
  echo "Or install pnpm: npm install -g pnpm"
  echo "On Windows/Git Bash you can also run scripts/smoke.ps1"
  exit 127
fi

# Wrangler detection (prefer local bin)
if ! command -v wrangler >/dev/null 2>&1; then
  if [[ -x "$ROOT_DIR/node_modules/.bin/wrangler" ]]; then
    export PATH="$ROOT_DIR/node_modules/.bin:$PATH"
  else
    echo "error: wrangler not found. Install with: ${PNPM_CMD[*]} add -D wrangler"
    exit 1
  fi
fi

if [[ ! -f "$API_DIR/.dev.vars" ]]; then
  if [[ -f "$API_DIR/.dev.vars.template" ]]; then
    cp "$API_DIR/.dev.vars.template" "$API_DIR/.dev.vars"
    echo "info: created $API_DIR/.dev.vars from template; fill in missing values."
  else
    echo "error: $API_DIR/.dev.vars is missing and no template found."
    exit 1
  fi
fi

set -a
source "$API_DIR/.dev.vars"
set +a

# Allow ADMIN_TOKEN alias
if [[ -z "${MASTER_ADMIN_TOKEN:-}" && -n "${ADMIN_TOKEN:-}" ]]; then
  MASTER_ADMIN_TOKEN="$ADMIN_TOKEN"
fi

# Required env checklist
MISSING=()
req_envs=("SUPABASE_URL" "SUPABASE_SERVICE_ROLE_KEY" "API_KEY_SALT" "MASTER_ADMIN_TOKEN")
optional_envs=("SUPABASE_ANON_KEY" "SUPABASE_DB_URL" "SUPABASE_PROJECT_REF")
for var in "${req_envs[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done

if ((${#MISSING[@]} > 0)); then
  echo "Missing required env vars in $API_DIR/.dev.vars:"
  for v in "${MISSING[@]}"; do echo " - $v"; done
  echo "Get these from Supabase project settings: Project URL, Service Role key, and set your API_KEY_SALT and MASTER_ADMIN_TOKEN."
  exit 1
fi
MISSING_OPT=()
for var in "${optional_envs[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING_OPT+=("$var")
  fi
done
if ((${#MISSING_OPT[@]} > 0)); then
  echo "Note: optional env vars not set (set if your setup requires them): ${MISSING_OPT[*]}"
fi

export EMBEDDINGS_MODE="stub"
export PORT="${PORT:-8787}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"

redact() {
  echo "$1" | sed -E "s/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1***REDACTED***/g"
}

print_headers() {
  for h in "$@"; do
    case "$h" in
      *x-api-key*|*authorization*|*x-admin-token*)
        echo "  header: $(echo "$h" | cut -d':' -f1): <redacted>"
        ;;
      *)
        echo "  header: $h"
        ;;
    esac
  done
}

call_json() {
  local step="$1"; shift
  local method="$1"; shift
  local url="$1"; shift
  local payload="$1"; shift
  local headers=("$@")
  local curl_headers=()

  echo "==> $step | $method $url" >&2
  print_headers "${headers[@]}" >&2
  echo "  payload bytes: ${#payload}" >&2

  for h in "${headers[@]}"; do
    curl_headers+=(-H "$h")
  done

  local response
  local status
  if ! response="$(curl --silent --show-error --fail-with-body --connect-timeout 5 --max-time "$STEP_TIMEOUT" \
      -X "$method" "${curl_headers[@]}" \
      ${payload:+-d "$payload"} \
      "$url" -w "\n%{http_code}")"; then
    echo "error: curl failed for $step" >&2
    echo "curl output: ${response:0:400}" >&2
    exit 1
  fi

  status="${response##*$'\n'}"
  body="${response%$'\n'*}"

  echo "<== $step | status: $status | resp bytes: ${#body} | preview: ${body:0:200}" >&2

  if [[ "$status" -ge 400 ]]; then
    echo "error: $step returned $status" >&2
    exit 1
  fi

  echo "$body"
}

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  if [ "$SMOKE_MODE" = "ci" ] && [ -f "$DEV_VARS_BAK" ]; then
    mv "$DEV_VARS_BAK" "$DEV_VARS"
  fi
}
trap 'status=$?; if [[ $status -ne 0 ]]; then echo "wrangler log: $LOG_FILE"; fi; cleanup' EXIT

echo "Starting API with stub embeddings on $BASE_URL ..."
(
  cd "$API_DIR"
  EMBEDDINGS_MODE="$EMBEDDINGS_MODE" PORT="$PORT" "${PNPM_CMD[@]}" dev >"$LOG_FILE" 2>&1
) &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"

echo -n "Waiting for /healthz "
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  health_body="$(curl --silent --show-error --fail-with-body --connect-timeout 2 --max-time 5 "$BASE_URL/healthz" 2>/dev/null || true)"
  if [[ -n "$health_body" ]] && echo "$health_body" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.exit(d.status==='ok'?0:1);" >/dev/null; then
    echo "ok"
    HEALTH_OK=1
    break
  fi
  echo -n "."
  sleep "$HEALTH_SLEEP"
done

if [[ -z "${HEALTH_OK:-}" ]]; then
  echo "error: API did not become healthy; log tail:"
  tail -n 80 "$LOG_FILE" || true
  echo "wrangler log: $LOG_FILE"
  exit 1
fi

echo "Creating workspace..."
workspace_json="$(call_json "create workspace" "POST" "$BASE_URL/v1/workspaces" \
  '{"name":"Smoke Workspace"}' \
  "content-type: application/json" "x-admin-token: $MASTER_ADMIN_TOKEN")"
WORKSPACE_ID="$(JSON="$workspace_json" node -e "const d=JSON.parse(process.env.JSON); const re=/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; if(!d.workspace_id||!re.test(d.workspace_id)){console.error('workspace_id missing or invalid'); process.exit(1);} console.log(d.workspace_id);")" || { echo "error: workspace create failed: ${workspace_json:0:400}"; exit 1; }

echo "Creating API key..."
apikey_json="$(call_json "create api key" "POST" "$BASE_URL/v1/api-keys" \
  "{\"workspace_id\":\"$WORKSPACE_ID\",\"name\":\"Smoke Key\"}" \
  "content-type: application/json" "x-admin-token: $MASTER_ADMIN_TOKEN")"
API_KEY="$(JSON="$apikey_json" node -e "const d=JSON.parse(process.env.JSON); if(!d.api_key || typeof d.api_key !== 'string' || !d.api_key.trim()){console.error('api_key missing'); process.exit(1);} if(!d.api_key_id){console.error('api_key_id missing'); process.exit(1);} console.log(d.api_key);")" || { echo "error: api key create failed: ${apikey_json:0:400}"; exit 1; }

echo "Ingesting memory..."
memory_json="$(call_json "ingest memory" "POST" "$BASE_URL/v1/memories" \
  '{"user_id":"smoke-user","text":"hello from smoke test memory"}' \
  "content-type: application/json" "x-api-key: $API_KEY")"
MEMORY_ID="$(JSON="$memory_json" node -e "const d=JSON.parse(process.env.JSON); if(!d.memory_id || !String(d.memory_id).trim()){console.error('memory_id missing'); process.exit(1);} console.log(d.memory_id);")" || { echo "error: memory ingest failed: ${memory_json:0:400}"; exit 1; }
echo "memory response: $memory_json"

echo "Searching..."
search_json="$(call_json "search" "POST" "$BASE_URL/v1/search" \
  '{"user_id":"smoke-user","query":"hello"}' \
  "content-type: application/json" "x-api-key: $API_KEY")"
echo "$search_json" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); if(!Array.isArray(d.results)) {console.error('results not array'); process.exit(1);} console.log(`results count: ${d.results.length}`); if(d.results.length>0){const r=d.results[0]; console.log(`top result chunk_id=${r.chunk_id||'n/a'} score=${r.score||'n/a'}`);} " || { echo "error: search validation failed: ${search_json:0:400}"; exit 1; }
echo "search response: $search_json"

echo "Context..."
context_json="$(call_json "context" "POST" "$BASE_URL/v1/context" \
  '{"user_id":"smoke-user","query":"hello"}' \
  "content-type: application/json" "x-api-key: $API_KEY")"
echo "$context_json" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); if(typeof d.context_text !== 'string' || !d.context_text.trim()){console.error('context_text empty'); process.exit(1);} console.log(`context length: ${d.context_text.length}`); if(d.citations && !Array.isArray(d.citations)){console.error('citations not array'); process.exit(1);} " || { echo "error: context validation failed: ${context_json:0:400}"; exit 1; }
echo "context response: $context_json"

echo "Summary: healthz ok, workspace created ($WORKSPACE_ID), api key created, memories ok, search ok, context ok."
echo "wrangler log: $LOG_FILE"
