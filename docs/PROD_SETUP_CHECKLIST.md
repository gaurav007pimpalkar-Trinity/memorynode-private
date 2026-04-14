# MemoryNode Production Setup Checklist

Manual, founder-friendly production input checklist for `memorynode.ai`.
This document uses variable names only (no secret values).

## 0) Scope and source of truth

This checklist aligns with:
- [ ] `apps/api/wrangler.toml`
- [ ] `scripts/check_config.mjs`
- [ ] `docs/internal/RELEASE_RUNBOOK.md`
- [ ] `docs/PRODUCTION_DEPLOY.md`
- [ ] `docs/OPERATIONS.md`
- [ ] `apps/dashboard/.env.example`
- [ ] `apps/dashboard/src/supabaseClient.ts`
- [ ] `apps/dashboard/src/apiClient.ts`

## A) Cloudflare (production) setup

### A1. Worker + environments

- [ ] Confirm Worker name and env blocks exist in `apps/api/wrangler.toml`:
  - [ ] `memorynode-api` (default)
  - [ ] `env.staging`
  - [ ] `env.production`
- [ ] Confirm Durable Object binding exists in each env:
  - [ ] `RATE_LIMIT_DO` bound to class `RateLimitDO`
- [ ] Confirm Durable Object migration exists:
  - [ ] `[[migrations]]` / `[[env.<name>.migrations]]`
  - [ ] `new_sqlite_classes = ["RateLimitDO"]`

### A2. Required Worker vars (production)

Set these as Worker vars for `--env production` (Cloudflare dashboard or Wrangler vars workflow):

- [ ] `ENVIRONMENT` (must be `production`)
- [ ] `SUPABASE_URL`
- [ ] `EMBEDDINGS_MODE` (production should be `openai`)
- [ ] `RATE_LIMIT_MODE`
- [ ] `RATE_LIMIT_MAX`
- [ ] `RATE_LIMIT_WINDOW_MS`
- [ ] `BILLING_WEBHOOKS_ENABLED`
- [ ] `BILLING_RECONCILE_ON_AMBIGUITY`

PayU billing vars (required when billing/webhooks are enabled):

- [ ] `PUBLIC_APP_URL`
- [ ] `PAYU_BASE_URL`
- [ ] `PAYU_VERIFY_URL`
- [ ] `PAYU_SUCCESS_PATH` (optional; default used if unset)
- [ ] `PAYU_CANCEL_PATH` (optional; default used if unset)
- [ ] `PAYU_PRO_AMOUNT` (optional fallback; default 499.00)
- [ ] Per-plan overrides (optional): `PAYU_LAUNCH_AMOUNT`, `PAYU_BUILD_AMOUNT`, `PAYU_DEPLOY_AMOUNT`, `PAYU_SCALE_AMOUNT`
- [ ] `PAYU_PRODUCT_INFO` (optional)
- [ ] `PAYU_CURRENCY` (optional)

Common optional vars:

- [ ] `ALLOWED_ORIGINS` — **required in production** for dashboard CORS; release:gate fails if missing. Comma-separated origins (e.g. `https://console.memorynode.ai`).
- [ ] `BUILD_VERSION`
- [ ] `GIT_SHA`

### A3. Required Worker secrets (production)

Set these with Wrangler secret commands (example uses production env):

```bash
pnpm --filter @memorynode/api exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put SUPABASE_ANON_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put API_KEY_SALT --env production
pnpm --filter @memorynode/api exec wrangler secret put MASTER_ADMIN_TOKEN --env production
pnpm --filter @memorynode/api exec wrangler secret put OPENAI_API_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_SALT --env production
```

Notes:
- [ ] `SUPABASE_ANON_KEY` is required in production for dashboard session (Supabase Auth Get User); release:gate fails if missing.
- [ ] `OPENAI_API_KEY` is required when `EMBEDDINGS_MODE=openai`.
- [ ] `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT` are required when billing/webhooks are enabled. Optionally set `PAYU_WEBHOOK_SECRET` for webhook verification.
- [ ] Do not put secrets in `wrangler.toml [vars]`.

### A4. Recommended production routes/domains

- [ ] API route: `api.memorynode.ai/*` -> Worker `memorynode-api` (production env)
- [ ] Staging route: `api-staging.memorynode.ai/*` -> Worker staging env

## B) Supabase (production) setup

### B1. Project and keys

- [ ] Create production Supabase project
- [ ] Capture:
  - [ ] `SUPABASE_URL`
  - [ ] `SUPABASE_SERVICE_ROLE_KEY`
  - [ ] `VITE_SUPABASE_URL` (dashboard)
  - [ ] `VITE_SUPABASE_ANON_KEY` (dashboard public anon key)
  - [ ] `DATABASE_URL` (or `SUPABASE_DB_URL`) for migration scripts

### B2. Apply DB migrations and verify

From repo root:

```bash
pnpm migrations:list
DATABASE_URL=<postgres-connection-string> pnpm db:migrate
DATABASE_URL=<postgres-connection-string> pnpm db:verify-schema
DATABASE_URL=<postgres-connection-string> pnpm db:verify-rls
```

### B3. Dashboard app wiring

For dashboard production build/deploy env:

- [ ] `VITE_SUPABASE_URL`
- [ ] `VITE_SUPABASE_ANON_KEY`
- [ ] `VITE_API_BASE_URL` (set to your production API base URL, e.g. `https://api.memorynode.ai`)

## C) PayU (production) setup

### C1. PayU secrets (MANDATORY)

- [ ] `PAYU_MERCHANT_KEY` configured as **Worker secret** (NOT vars) — identifies the merchant for PayU API calls
- [ ] `PAYU_MERCHANT_SALT` configured as **Worker secret** (NOT vars) — used for HMAC-SHA512 hash verification of checkout requests and webhook signatures
- [ ] Optional: `PAYU_WEBHOOK_SECRET` as Worker secret for additional webhook signature verification
- [ ] Verify secrets are NOT in `wrangler.toml [vars]` or any committed file

**Set secrets via:**

```bash
pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_SALT --env production
```

### C2. PayU vars (non-secret configuration)

- [ ] `PAYU_VERIFY_URL` set in Worker vars (PayU verify API URL; e.g. `https://info.payu.in/merchant/postservice?form=2`)
- [ ] `PAYU_BASE_URL` set in Worker vars (PayU checkout base URL)
- [ ] `PUBLIC_APP_URL` set in Worker vars (e.g. `https://console.memorynode.ai`)

### C3. Webhook endpoint & security controls

- [ ] PayU callback URL: `https://api.memorynode.ai/v1/billing/webhook` (or your API base + `/v1/billing/webhook`)
- [ ] Configure PayU dashboard to send payment success/callback to this URL
- [ ] **[MANDATORY] Webhook signature verification**: every inbound PayU callback has its hash verified against `PAYU_MERCHANT_SALT`. The API enforces this automatically — no opt-out.
- [ ] **[MANDATORY] Verify-before-grant**: entitlements are granted ONLY after the PayU Verify API confirms the transaction. This is enforced by `reconcilePayUWebhook()` in the webhook handler.
- [ ] Confirm staging uses a **separate** PayU merchant account or salt from production.

### C4. PayU secret rotation playbook

If PayU secrets are compromised:

1. [ ] Rotate key/salt in PayU merchant dashboard immediately
2. [ ] Update Worker secrets: staging first, then production (see `docs/SECURITY.md` for commands)
3. [ ] Verify webhook flow: send test callback, confirm `webhook_verified` + `webhook_processed` in logs
4. [ ] Audit `billing_events` table for forged transactions during exposure window
5. [ ] Revoke any forged entitlements
6. [ ] Document incident (see `docs/SECURITY.md` § Incident Response)

### C5. PayU least-privilege

- [ ] API Worker: only runtime that needs `PAYU_MERCHANT_KEY` / `PAYU_MERCHANT_SALT`
- [ ] CI/CD: does NOT need PayU secrets (they are Worker-bound)
- [ ] Dashboard app: does NOT need PayU secrets (billing flows go through API)
- [ ] Operators: use PayU dashboard for config; do NOT keep raw salt in personal env files

## D) Domain / DNS setup (`memorynode.ai`)

Recommended hostnames:

- [ ] `api.memorynode.ai` -> Cloudflare Worker production route
- [ ] `api-staging.memorynode.ai` -> Cloudflare Worker staging route
- [ ] `console.memorynode.ai` -> dashboard hosting (see `docs/internal/DASHBOARD_DEPLOY.md`; Vercel or Cloudflare Pages)

Dashboard/API alignment:

- [ ] `VITE_API_BASE_URL=https://api.memorynode.ai`
- [ ] `PUBLIC_APP_URL=https://console.memorynode.ai`
- [ ] `ALLOWED_ORIGINS` includes `https://console.memorynode.ai`

## E) Go-live order (manual release sequence)

1. [ ] Pre-release gate:

```bash
pnpm release:gate
```

1. [ ] Staging DB + deploy + validate:

```bash
DATABASE_URL=<staging-db-url> pnpm db:migrate
DATABASE_URL=<staging-db-url> pnpm db:verify-schema
DATABASE_URL=<staging-db-url> pnpm db:verify-rls
pnpm deploy:staging
TARGET_ENV=staging STAGING_BASE_URL=https://api-staging.memorynode.ai API_KEY=<staging-api-key> pnpm release:staging:validate
```

1. [ ] Production DB + deploy + validate:

```bash
DATABASE_URL=<prod-db-url> pnpm db:migrate
DATABASE_URL=<prod-db-url> pnpm db:verify-schema
DATABASE_URL=<prod-db-url> pnpm db:verify-rls
DEPLOY_ENV=production DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod
TARGET_ENV=production PROD_BASE_URL=https://api.memorynode.ai API_KEY=<prod-api-key> pnpm release:prod:validate
```

1. [ ] Enable/confirm billing feature flags in production Worker vars:

- [ ] `BILLING_WEBHOOKS_ENABLED=1`
- [ ] `BILLING_RECONCILE_ON_AMBIGUITY=1`

1. [ ] Post-go-live checks:

- [ ] `GET https://api.memorynode.ai/healthz` returns `status=ok` with build/version
- [ ] `x-request-id` is present on responses
- [ ] PayU test/callback is accepted by webhook endpoint (check Worker logs for `webhook_verified` / `webhook_processed`)
- [ ] Worker logs show normal `request_completed` and no burst of `request_failed`

1. [ ] Observability verification (see `docs/OBSERVABILITY.md` § 3):

- [ ] `request_completed` events include `route_group` field
- [ ] `embed_request` events appear with `embed_latency_ms` on search/ingest
- [ ] `search_request` events appear with `search_latency_ms` on search
- [ ] `db_rpc` events appear with `db_latency_ms` on search
- [ ] Run the 60-second health checklist from `docs/OBSERVABILITY.md` § 3
- [ ] Confirm alert filters from `docs/ALERTS.md` are configured in your log sink

1. [ ] PayU secret security verification:

- [ ] Confirm `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT` are set as Worker **secrets** (not vars)
- [ ] Confirm staging and production use separate PayU credentials
- [ ] Confirm webhook signature verification is active (send test callback → `webhook_verified` in logs)
- [ ] Confirm verify-before-grant is active (entitlements granted only after PayU verify API confirmation)

## F) Inputs quick reference (names only)

### Required for production release gate + runtime

- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `API_KEY_SALT`
- [ ] `MASTER_ADMIN_TOKEN`
- [ ] `EMBEDDINGS_MODE`
- [ ] `OPENAI_API_KEY` (when `EMBEDDINGS_MODE=openai`)
- [ ] `SUPABASE_DB_URL` or `DATABASE_URL` (migration/verify scripts)

### Required when billing/webhooks are enabled

- [ ] `PAYU_MERCHANT_KEY`
- [ ] `PAYU_MERCHANT_SALT`
- [ ] `PUBLIC_APP_URL`
- [ ] `PAYU_VERIFY_URL`
- [ ] `PAYU_BASE_URL`

### Dashboard env

- [ ] `VITE_SUPABASE_URL`
- [ ] `VITE_SUPABASE_ANON_KEY`
- [ ] `VITE_API_BASE_URL`
