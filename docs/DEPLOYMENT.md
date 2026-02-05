# Staging Deployment (push-button)

Use this runbook to deploy the Cloudflare Worker to staging, including DB migrations and a quick smoke test. Nothing runs automatically; you must invoke it manually with the right env vars.

## Prerequisites
- Cloudflare auth: `pnpm -C apps/api wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
- Env vars (staging):
  - `STAGE=staging` (or `DEPLOY_ENV=staging`)
- `SUPABASE_DB_URL` (or `DATABASE_URL`) – staging Postgres
- `BASE_URL` – staging API base (e.g., https://api-staging.memorynode.ai)
- `MEMORYNODE_API_KEY` – staging API key for smoke
- Optional billing smoke: `STRIPE_WEBHOOK_SECRET` (and Stripe staging keys in the platform)
- Optional `BUILD_VERSION` is auto-set by the deploy script (ISO timestamp). You can override by setting it in the environment before running.

## Command
```
STAGE=staging SUPABASE_DB_URL=postgres://... \
BASE_URL=https://api-staging.memorynode.ai \
MEMORYNODE_API_KEY=mn_xxx \
pnpm deploy:staging
```

### What it does
1) Runs `pnpm release:gate:full` (code/config + db:migrate/verify + lint/typecheck/tests).  
2) Deploys: `pnpm -C apps/api wrangler deploy --env staging`.  
3) Post-deploy smoke: `GET /healthz` then `GET /v1/usage/today` with your API key.  
4) If `STRIPE_WEBHOOK_SECRET` is set, runs `pnpm stripe:webhook-test` (staging webhook).

If any step fails, the script exits non‑zero with a concise message (no secrets printed).

## Rollback (staging)
- List deployments: `pnpm -C apps/api wrangler deployments --env staging`
- Redeploy a previous build: `pnpm -C apps/api wrangler deploy --env staging --hash <deployment-id>`
- If DB migration caused issues, restore from backup (see BACKUP_RESTORE.md) and rerun `pnpm db:migrate`.

## Notes & Links
- Release gate details: `docs/RELEASE_GATE.md`
- Observability signals: `docs/OBSERVABILITY.md`
- Backups & restore drill: `docs/BACKUP_RESTORE.md`
- Perf baseline: `docs/PERFORMANCE.md`
- Dashboard manual checks: `docs/DASHBOARD_TEST_CHECKLIST.md`

---

# Production Deployment (guarded)

## Safety latch (must set)
- `STAGE=production` (or `DEPLOY_ENV=production`)
- `DEPLOY_CONFIRM=memorynode-prod` (exact match, required)

## Required env (prod)
- `SUPABASE_DB_URL` (or `DATABASE_URL`) – prod Postgres
- `BASE_URL` – prod API base (e.g., https://api.memorynode.ai)
- `MEMORYNODE_API_KEY` – prod API key for smoke
- Cloudflare auth: `pnpm -C apps/api wrangler login` or `CLOUDFLARE_API_TOKEN`
- Optional billing smoke: `STRIPE_WEBHOOK_SECRET` (and prod Stripe keys in platform)
- Optional `BUILD_VERSION` is auto-set by the deploy script (ISO timestamp). You can override by setting it in the environment before running.

## Command
```
STAGE=production DEPLOY_CONFIRM=memorynode-prod \
SUPABASE_DB_URL=postgres://... \
BASE_URL=https://api.memorynode.ai \
MEMORYNODE_API_KEY=mn_xxx \
pnpm deploy:prod
```

### What it does
1) `pnpm release:gate:full` (CHECK_ENV=production inside; includes db:check).  
2) `pnpm -C apps/api wrangler deploy --env production`.  
3) Smoke: `GET /healthz` and `GET /v1/usage/today` with API key.  
4) If `STRIPE_WEBHOOK_SECRET` is set, runs `pnpm stripe:webhook-test` (prod webhook).

If `DEPLOY_CONFIRM` is missing/wrong, it refuses to run before touching anything.

## Rollback (prod)
- List deployments: `pnpm -C apps/api wrangler deployments --env production`
- Redeploy previous hash: `pnpm -C apps/api wrangler deploy --env production --hash <deployment-id>`
- If DB migration caused issues, restore from backup (see BACKUP_RESTORE.md) and rerun `pnpm db:migrate`.
