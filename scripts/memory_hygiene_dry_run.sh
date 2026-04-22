#!/usr/bin/env bash
# Memory hygiene dry-run: call POST /admin/memory-hygiene with dry_run=true.
# Schedule weekly via cron. Requires: BASE_URL, MASTER_ADMIN_TOKEN, WORKSPACE_ID.
# Usage: WORKSPACE_ID=<uuid> ./scripts/memory_hygiene_dry_run.sh
# Optional: SIMILARITY_THRESHOLD=0.92 LIMIT=200
#
# Prod/staging enforce signed admin requests. This script sends the three
# signed headers per apps/api/src/auth.ts verifySignedAdminRequest:
#   x-admin-timestamp: ms since epoch
#   x-admin-nonce:     random hex (>=12 chars), single-use
#   x-admin-signature: HMAC-SHA256(MASTER_ADMIN_TOKEN,
#                        "${METHOD}\n${PATH}\n${TS}\n${NONCE}") hex

set -euo pipefail
BASE_URL="${BASE_URL:-https://api.memorynode.ai}"
BASE_URL="${BASE_URL%/}"
if [[ -z "${MASTER_ADMIN_TOKEN:-}" ]]; then
  echo "MASTER_ADMIN_TOKEN is required" >&2
  exit 1
fi
if [[ -z "${WORKSPACE_ID:-}" ]]; then
  echo "WORKSPACE_ID is required (UUID of the workspace to check)" >&2
  exit 1
fi
THRESHOLD="${SIMILARITY_THRESHOLD:-0.92}"
LIMIT="${LIMIT:-200}"

METHOD="POST"
PATH_ONLY="/admin/memory-hygiene"
QUERY="workspace_id=${WORKSPACE_ID}&dry_run=true&similarity_threshold=${THRESHOLD}&limit=${LIMIT}"
URL="${BASE_URL}${PATH_ONLY}?${QUERY}"

TS="$(date +%s%3N)"
NONCE="$(openssl rand -hex 16)"
SIG="$(printf '%s\n%s\n%s\n%s' "$METHOD" "$PATH_ONLY" "$TS" "$NONCE" \
       | openssl dgst -sha256 -mac HMAC -macopt "key:${MASTER_ADMIN_TOKEN}" -hex \
       | awk '{print $NF}')"

curl -sS -X "$METHOD" \
  -H "x-admin-timestamp: ${TS}" \
  -H "x-admin-nonce: ${NONCE}" \
  -H "x-admin-signature: ${SIG}" \
  "${URL}" | jq .
