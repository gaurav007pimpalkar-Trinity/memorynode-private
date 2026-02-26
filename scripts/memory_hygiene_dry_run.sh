#!/usr/bin/env bash
# Memory hygiene dry-run: call POST /admin/memory-hygiene with dry_run=true.
# Schedule weekly via cron. Requires: BASE_URL, MASTER_ADMIN_TOKEN, WORKSPACE_ID.
# Usage: WORKSPACE_ID=<uuid> ./scripts/memory_hygiene_dry_run.sh
# Optional: SIMILARITY_THRESHOLD=0.92 LIMIT=200

set -e
BASE_URL="${BASE_URL:-https://api.memorynode.ai}"
if [[ -z "${MASTER_ADMIN_TOKEN}" ]]; then
  echo "MASTER_ADMIN_TOKEN is required" >&2
  exit 1
fi
if [[ -z "${WORKSPACE_ID}" ]]; then
  echo "WORKSPACE_ID is required (UUID of the workspace to check)" >&2
  exit 1
fi
THRESHOLD="${SIMILARITY_THRESHOLD:-0.92}"
LIMIT="${LIMIT:-200}"
URL="${BASE_URL}/admin/memory-hygiene?workspace_id=${WORKSPACE_ID}&dry_run=true&similarity_threshold=${THRESHOLD}&limit=${LIMIT}"
curl -sS -X POST -H "x-admin-token: ${MASTER_ADMIN_TOKEN}" "${URL}" | jq .
