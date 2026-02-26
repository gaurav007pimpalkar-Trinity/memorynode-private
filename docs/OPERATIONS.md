# Operations Runbook (Prod/Staging)

## A) Secrets Inventory
| Secret | Where to set | What it affects | Rotation guidance |
| --- | --- | --- | --- |
| `API_KEY_SALT` | Cloudflare Worker secret (prod/staging); local `.env.gate`/`.env.prod.smoke` for checks | API key hashing; must match `app_settings.api_key_salt` in DB | Rotate only if compromised; must align DB `app_settings.api_key_salt` + re-issue keys |
| `MASTER_ADMIN_TOKEN` | Cloudflare Worker secret; local env for admin scripts | Admin plane (`/v1/workspaces`, `/v1/api-keys`); deploy scripts | Rotate if leaked; update all operators’ envs |
| `OPENAI_API_KEY` | Cloudflare Worker secret; local env for smoke when `EMBEDDINGS_MODE=openai` | Embeddings generation | Rotate per OpenAI best practices; ensure `EMBEDDINGS_MODE=openai` |
| `PAYU_MERCHANT_KEY` | Cloudflare Worker secret (prod/staging); local for billing tests | PayU checkout and webhook hash verification | Rotate via PayU merchant dashboard; update Worker secret; verify webhook after |
| `PAYU_MERCHANT_SALT` | Cloudflare Worker secret; local for webhook tests | PayU webhook/callback hash verification | Rotate in PayU merchant dashboard; update Worker secret; replay test callback |
| `CLOUDFLARE_API_TOKEN` | Local/CI (optional alternative to wrangler login) | Deploy via wrangler | Rotate if leaked; ensure token has Workers write scope |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker secret; local for DB scripts | Supabase service access from Worker | Rotate via Supabase; update Worker secret; re-run smoke |
| `SUPABASE_URL` | Cloudflare Worker var/secret; local for smoke | Supabase endpoint | Update if project URL changes; align with DB URLs |

## B) Rollback Procedure
1) Identify last good git commit or wrangler version (from CI logs).
2) Check out that commit locally (or CI) and run:  
   `DEPLOY_ENV=production DEPLOY_CONFIRM=memorynode-prod DRY_RUN=0 node scripts/deploy_prod.mjs`
3) Confirm rollback: `curl -s https://<BASE_URL>/healthz` should show `status: "ok"` and `version/BUILD_VERSION` matching the rolled-back deploy. For readiness (DB up), use `GET /ready`: 200 `{ "status": "ok", "db": "connected" }` or 503 when DB is unavailable.
4) If needed, revert DB changes manually (migrations are forward-only; prefer hotfix migration rather than reversal).

## B.1) Error Budget Policy

When the 28-day rolling error budget is exhausted (see `docs/OBSERVABILITY.md` §4 and Appendix A):

1. **Freeze** non-essential releases.
2. **Focus** on reliability and root-cause.
3. **Resume** normal cadence only after budget recovers.

Details: `docs/INCIDENT_PROCESS.md` § Error Budget Policy.

---

## C) Incident Checklist
- Rate limit DO failure: 500 errors mentioning `RATE_LIMIT_DO` missing; fix by ensuring wrangler binding exists per env and redeploy.
- Supabase connectivity issues: 500s with DB errors; verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; run `BASE_URL=... API_KEY=... pnpm release:validate` to confirm core API paths.
- PayU webhook failures: look for `webhook_failed`, `billing_webhook_signature_invalid`, and `billing_webhook_workspace_not_found`; check `payu_webhook_events` and Cloudflare logs; replay or use `POST /admin/webhooks/reprocess` after fixing secrets (see docs/internal/BILLING_RUNBOOK.md).
- For billing-specific incident procedures, use `docs/internal/BILLING_RUNBOOK.md`.

## C.1) 429 / 413 Handling
- `429` rate-limit response shape:
  - `{ "error": { "code": "rate_limited", "message": "Rate limit exceeded" }, "request_id": "..." }`
  - Headers include `Retry-After`, `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, and `x-request-id`.
- `413` payload-limit response shape:
  - `{ "error": { "code": "payload_too_large", "message": "..." }, "request_id": "..." }`
- Client guidance:
  - `429`: retry with exponential backoff + jitter and honor `Retry-After`.
  - `413`: do not blind-retry; shrink or chunk the payload first.

## D) Request Tracing
- Every API response includes header `x-request-id`. Client-provided `x-request-id` values are respected when valid.
- Error responses include:
  - `{ "error": { "code": "...", "message": "..." }, "request_id": "..." }`
- Use this flow during incidents:
  1. Get `x-request-id` from client response.
  2. Open Cloudflare Worker logs and filter `request_id="<value>"`.
  3. Inspect `request_completed` and `request_failed` events around the same timestamp.

Example success log:
`{"level":"info","event_name":"request_completed","request_id":"req-123","route":"/v1/search","method":"POST","status":200,"duration_ms":42}`

Example failure log:
`{"level":"error","event_name":"request_failed","request_id":"req-123","route":"/v1/search","method":"POST","status":500,"error_code":"DB_ERROR","error":{"message":"***REDACTED***","stack":"***REDACTED***"}}`

## E) Bug Report Minimum Data
- `x-request-id` value
- UTC timestamp
- Endpoint + HTTP method
- Response status code
- `build_version` from `/healthz` (and `git_sha` if present)
- For local/manual deploys, set `BUILD_VERSION` before deploy to stamp `/healthz`.

## F) Dashboard session cleanup (expired rows)

Expired rows in `dashboard_sessions` are not deleted automatically. To prevent unbounded table growth, call the admin cleanup endpoint periodically.

- **Endpoint:** `POST /admin/sessions/cleanup`
- **Auth:** `Authorization: Bearer <MASTER_ADMIN_TOKEN>`
- **Behavior:** Deletes rows where `expires_at < now()`; returns `{ "ok": true, "deleted": <number> }`. Rate-limited (same as other admin endpoints); call at most once per minute.
- **Recommendation:** Run from an external cron (e.g. daily):  
  `curl -X POST -H "Authorization: Bearer $MASTER_ADMIN_TOKEN" https://api.memorynode.ai/admin/sessions/cleanup`

## G) Memory hygiene (near-duplicate detection)

The memory-hygiene endpoint finds memories whose chunks are very similar (by embedding) and marks the lower-priority one as a duplicate. It does **not** delete rows; it sets `duplicate_of` on the duplicate.

- **Endpoint:** `POST /admin/memory-hygiene`
- **Auth:** `x-admin-token: <MASTER_ADMIN_TOKEN>` (same as other admin endpoints).
- **Query params:** `workspace_id` (required, UUID), `similarity_threshold` (optional, 0.80–0.99, default 0.92), `limit` (optional, 1–500, default 200), `dry_run` (optional, default `true`).
- **Recommendation:** Schedule a weekly cron with **dry_run=true** first to inspect reported pairs:
  - **GitHub Actions:** `.github/workflows/memory-hygiene.yml` runs weekly (Mondays 02:00 UTC) and on `workflow_dispatch`. Set repo secrets: `MEMORY_HYGIENE_ADMIN_TOKEN`, `MEMORY_HYGIENE_WORKSPACE_ID`; optional `MEMORY_HYGIENE_BASE_URL` (default `https://api.memorynode.ai`). If secrets are unset, the job skips without failing.
  - Script: `WORKSPACE_ID=<uuid> MASTER_ADMIN_TOKEN=... ./scripts/memory_hygiene_dry_run.sh` (optional: `BASE_URL`, `SIMILARITY_THRESHOLD`, `LIMIT`).
  - Or curl: `curl -X POST -H "x-admin-token: $MASTER_ADMIN_TOKEN" "https://api.memorynode.ai/admin/memory-hygiene?workspace_id=<WORKSPACE_UUID>&dry_run=true"`
- **Enabling non-dry runs:** After reviewing dry-run output and confirming which workspace(s) to run for, call the same URL with `dry_run=false` to persist `duplicate_of` marks. Prefer running during low traffic; the endpoint is rate-limited per admin token.
