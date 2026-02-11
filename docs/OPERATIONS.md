# Operations Runbook (Prod/Staging)

## A) Secrets Inventory
| Secret | Where to set | What it affects | Rotation guidance |
| --- | --- | --- | --- |
| `API_KEY_SALT` | Cloudflare Worker secret (prod/staging); local `.env.gate`/`.env.prod.smoke` for checks | API key hashing; must match `app_settings.api_key_salt` in DB | Rotate only if compromised; must align DB `app_settings.api_key_salt` + re-issue keys |
| `MASTER_ADMIN_TOKEN` | Cloudflare Worker secret; local env for admin scripts | Admin plane (`/v1/workspaces`, `/v1/api-keys`); deploy scripts | Rotate if leaked; update all operators’ envs |
| `OPENAI_API_KEY` | Cloudflare Worker secret; local env for smoke when `EMBEDDINGS_MODE=openai` | Embeddings generation | Rotate per OpenAI best practices; ensure `EMBEDDINGS_MODE=openai` |
| `STRIPE_SECRET_KEY` | Cloudflare Worker secret (prod/staging); local for billing tests | Billing endpoints (checkout/portal/webhook) | Rotate via Stripe dashboard; update Worker secret; verify webhook after |
| `STRIPE_WEBHOOK_SECRET` | Cloudflare Worker secret; local for webhook tests | Stripe webhook verification | Rotate in Stripe dashboard; update Worker secret; replay test event |
| `CLOUDFLARE_API_TOKEN` | Local/CI (optional alternative to wrangler login) | Deploy via wrangler | Rotate if leaked; ensure token has Workers write scope |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker secret; local for DB scripts | Supabase service access from Worker | Rotate via Supabase; update Worker secret; re-run smoke |
| `SUPABASE_URL` | Cloudflare Worker var/secret; local for smoke | Supabase endpoint | Update if project URL changes; align with DB URLs |

## B) Rollback Procedure
1) Identify last good git commit or wrangler version (from CI logs).
2) Check out that commit locally (or CI) and run:  
   `DEPLOY_ENV=production DEPLOY_CONFIRM=memorynode-prod DRY_RUN=0 node scripts/deploy_prod.mjs`
3) Confirm rollback: `curl -s https://<BASE_URL>/healthz` should show `status: "ok"` and `version/BUILD_VERSION` matching the rolled-back deploy.
4) If needed, revert DB changes manually (migrations are forward-only; prefer hotfix migration rather than reversal).

## C) Incident Checklist
- Rate limit DO failure: 500 errors mentioning `RATE_LIMIT_DO` missing; fix by ensuring wrangler binding exists per env and redeploy.
- Supabase connectivity issues: 500s with DB errors; verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; run `BASE_URL=... API_KEY=... pnpm release:validate` to confirm core API paths.
- Stripe webhook failures: look for `webhook_failed`, `billing_webhook_signature_invalid`, and `billing_webhook_workspace_not_found`; check `stripe_webhook_events` lifecycle columns from `infra/sql/019_webhook_hardening.sql` and Cloudflare logs; replay from Stripe dashboard after fixing secrets.
- For billing-specific incident procedures, use `docs/BILLING_RUNBOOK.md`.

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
