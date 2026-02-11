# MemoryNode Production Setup Checklist

Manual, founder-friendly production input checklist for `memorynode.ai`.
This document uses variable names only (no secret values).

## 0) Scope and source of truth

This checklist aligns with:
- [ ] `apps/api/wrangler.toml`
- [ ] `scripts/check_config.mjs`
- [ ] `docs/RELEASE_RUNBOOK.md`
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
  - [ ] `env.canary`
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

Billing vars (required when billing/webhooks are enabled):

- [ ] `PUBLIC_APP_URL`
- [ ] `STRIPE_PRICE_PRO`
- [ ] `STRIPE_PRICE_TEAM`

Common optional vars:

- [ ] `ALLOWED_ORIGINS` (recommended for strict CORS)
- [ ] `STRIPE_PORTAL_CONFIGURATION_ID`
- [ ] `STRIPE_SUCCESS_PATH`
- [ ] `STRIPE_CANCEL_PATH`
- [ ] `BUILD_VERSION`
- [ ] `GIT_SHA`

### A3. Required Worker secrets (production)

Set these with Wrangler secret commands (example uses production env):

```bash
pnpm --filter @memorynode/api exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put API_KEY_SALT --env production
pnpm --filter @memorynode/api exec wrangler secret put MASTER_ADMIN_TOKEN --env production
pnpm --filter @memorynode/api exec wrangler secret put OPENAI_API_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put STRIPE_SECRET_KEY --env production
pnpm --filter @memorynode/api exec wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

Notes:
- [ ] `OPENAI_API_KEY` is required when `EMBEDDINGS_MODE=openai`.
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are required when billing/webhooks are enabled.
- [ ] Do not put secrets in `wrangler.toml [vars]`.

### A4. Recommended production routes/domains

- [ ] API route: `api.memorynode.ai/*` -> Worker `memorynode-api` (production env)
- [ ] Canary route (recommended): `api-canary.memorynode.ai/*` -> Worker canary env
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

## C) Stripe (production) setup

### C1. Products/prices used by API

The API expects two recurring price IDs:

- [ ] `STRIPE_PRICE_PRO` (used when checkout `plan=pro`)
- [ ] `STRIPE_PRICE_TEAM` (used when checkout `plan=team`)

### C2. API + webhook secrets

- [ ] `STRIPE_SECRET_KEY` configured as Worker secret
- [ ] `STRIPE_WEBHOOK_SECRET` configured as Worker secret

### C3. Webhook endpoint

- [ ] Create Stripe webhook endpoint:
  - [ ] URL: `https://api.memorynode.ai/v1/billing/webhook`
- [ ] Ensure endpoint signing secret is mapped to `STRIPE_WEBHOOK_SECRET`
- [ ] Ensure webhook events include:
  - [ ] `customer.subscription.created`
  - [ ] `customer.subscription.updated`
  - [ ] `customer.subscription.deleted`
  - [ ] `invoice.paid`
  - [ ] `invoice.payment_failed`

## D) Domain / DNS setup (`memorynode.ai`)

Recommended hostnames:

- [ ] `api.memorynode.ai` -> Cloudflare Worker production route
- [ ] `api-staging.memorynode.ai` -> Cloudflare Worker staging route
- [ ] `api-canary.memorynode.ai` -> Cloudflare Worker canary route (recommended)
- [ ] `app.memorynode.ai` -> dashboard hosting (Cloudflare Pages or your chosen static host)

Dashboard/API alignment:

- [ ] `VITE_API_BASE_URL=https://api.memorynode.ai`
- [ ] `PUBLIC_APP_URL=https://app.memorynode.ai`
- [ ] `ALLOWED_ORIGINS` includes `https://app.memorynode.ai`

## E) Go-live order (manual release sequence)

1. [ ] Pre-release gate:

```bash
pnpm release:gate
```

2. [ ] Staging DB + deploy + validate:

```bash
DATABASE_URL=<staging-db-url> pnpm db:migrate
DATABASE_URL=<staging-db-url> pnpm db:verify-schema
DATABASE_URL=<staging-db-url> pnpm db:verify-rls
pnpm deploy:staging
TARGET_ENV=staging STAGING_BASE_URL=https://api-staging.memorynode.ai API_KEY=<staging-api-key> pnpm release:staging:validate
```

3. [ ] Canary deploy + validate:

```bash
pnpm deploy:canary
TARGET_ENV=canary CANARY_BASE_URL=https://api-canary.memorynode.ai API_KEY=<canary-api-key> pnpm release:canary:validate
```

4. [ ] Production DB + deploy + validate:

```bash
DATABASE_URL=<prod-db-url> pnpm db:migrate
DATABASE_URL=<prod-db-url> pnpm db:verify-schema
DATABASE_URL=<prod-db-url> pnpm db:verify-rls
DEPLOY_ENV=production DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod
TARGET_ENV=production PROD_BASE_URL=https://api.memorynode.ai API_KEY=<prod-api-key> pnpm release:prod:validate
```

5. [ ] Enable/confirm billing feature flags in production Worker vars:

- [ ] `BILLING_WEBHOOKS_ENABLED=1`
- [ ] `BILLING_RECONCILE_ON_AMBIGUITY=1`

6. [ ] Post-go-live checks:

- [ ] `GET https://api.memorynode.ai/healthz` returns `status=ok` with build/version
- [ ] `x-request-id` is present on responses
- [ ] Stripe test event is accepted by webhook endpoint
- [ ] Worker logs show normal `request_completed` and no burst of `request_failed`

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

- [ ] `STRIPE_SECRET_KEY`
- [ ] `STRIPE_WEBHOOK_SECRET`
- [ ] `PUBLIC_APP_URL`
- [ ] `STRIPE_PRICE_PRO`
- [ ] `STRIPE_PRICE_TEAM`

### Dashboard env

- [ ] `VITE_SUPABASE_URL`
- [ ] `VITE_SUPABASE_ANON_KEY`
- [ ] `VITE_API_BASE_URL`
