# MemoryNode Release Runbook (Canonical)

This is the single source of truth for staging and production releases.

## 1) Prerequisites

### Access
- Cloudflare: permission to deploy Workers and edit Worker vars/secrets for `staging` and `production`.
- Supabase/Postgres: permission to run migrations on staging and production DBs.
- PayU: permission to view merchant dashboard and verify API for webhook/callback troubleshooting.

### Local tooling
- Node.js 20+
- pnpm 9+
- Wrangler authenticated (`pnpm --filter @memorynode/api exec wrangler whoami`).

### Required runtime config in Cloudflare

Safe vars (tracked in `apps/api/wrangler.toml`):
- `EMBEDDINGS_MODE`
- `ENVIRONMENT`
- `RATE_LIMIT_MODE`
- `RATE_LIMIT_MAX`
- `RATE_LIMIT_WINDOW_MS`
- `BILLING_RECONCILE_ON_AMBIGUITY`
- `BILLING_WEBHOOKS_ENABLED`
- `PUBLIC_APP_URL`
- PayU vars as needed: `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, `PAYU_SUCCESS_PATH`, `PAYU_CANCEL_PATH`, etc. (see `apps/api/wrangler.toml` and docs/PROD_SETUP_CHECKLIST.md)

Secrets (never commit to git):
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (when `EMBEDDINGS_MODE=openai`)
- `API_KEY_SALT`
- `MASTER_ADMIN_TOKEN`
- `PAYU_MERCHANT_KEY`
- `PAYU_MERCHANT_SALT`
- Optionally `PAYU_WEBHOOK_SECRET` for webhook verification

## 2) Pre-Release Gate (must pass)

Run once from repo root:

```bash
pnpm release:gate
```

If you run this locally, `check:config` expects production-safe env values in shell:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `API_KEY_SALT`
- `MASTER_ADMIN_TOKEN`
- `EMBEDDINGS_MODE`
- `PAYU_MERCHANT_KEY`
- `PAYU_MERCHANT_SALT`

What this includes:
- `pnpm check:typed-entry`
- `pnpm check:wrangler`
- `pnpm check:config`
- `pnpm secrets:check`
- `pnpm secrets:check:tracked`
- `pnpm migrations:check`
- `pnpm -w lint`
- `pnpm -w typecheck`
- `pnpm -w test`

Optional build in gate:

```bash
RELEASE_INCLUDE_BUILD=1 pnpm release:gate
```

### G5 live security headers (before production go-live)

CI trust gates always check CSP and security headers from config (`apps/dashboard/public/_headers` or `vercel.json`). To **verify that the deployed dashboard actually serves** those headers (e.g. after CDN/Pages), run once before go-live:

```bash
G5_URL=https://console.memorynode.ai pnpm ci:trust-gates
```

Use your real dashboard URL (staging or production). If this fails, fix headers or CDN config before launch.

## 3) DB Migration Path (forward-only)

Staging DB:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
DATABASE_URL=postgres://... pnpm db:verify-schema
DATABASE_URL=postgres://... pnpm db:verify-rls
```

Production DB:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
DATABASE_URL=postgres://... pnpm db:verify-schema
DATABASE_URL=postgres://... pnpm db:verify-rls
```

## 4) Deploy Staging

Bash:

```bash
DEPLOY_ENV=staging \
DATABASE_URL=postgres://... \
BASE_URL=https://api-staging.memorynode.ai \
MEMORYNODE_API_KEY=mn_live_xxx \
pnpm deploy:staging
```

PowerShell:

```powershell
$env:DEPLOY_ENV="staging"
$env:DATABASE_URL="postgres://..."
$env:BASE_URL="https://api-staging.memorynode.ai"
$env:MEMORYNODE_API_KEY="mn_live_xxx"
pnpm deploy:staging
```

Post-deploy validate (canonical command):

```bash
BASE_URL=https://api-staging.memorynode.ai API_KEY=mn_live_xxx pnpm release:validate
```

Environment shortcut:

```bash
TARGET_ENV=staging STAGING_BASE_URL=https://api-staging.memorynode.ai API_KEY=mn_live_xxx pnpm release:staging:validate
```

## 5) Deploy Production

Bash:

```bash
DEPLOY_ENV=production \
DEPLOY_CONFIRM=memorynode-prod \
DATABASE_URL=postgres://... \
BASE_URL=https://api.memorynode.ai \
MEMORYNODE_API_KEY=mn_live_xxx \
pnpm deploy:prod
```

PowerShell:

```powershell
$env:DEPLOY_ENV="production"
$env:DEPLOY_CONFIRM="memorynode-prod"
$env:DATABASE_URL="postgres://..."
$env:BASE_URL="https://api.memorynode.ai"
$env:MEMORYNODE_API_KEY="mn_live_xxx"
pnpm deploy:prod
```

Post-deploy validate:

```bash
BASE_URL=https://api.memorynode.ai API_KEY=mn_live_xxx pnpm release:validate
```

Environment shortcut:

```bash
TARGET_ENV=production PROD_BASE_URL=https://api.memorynode.ai API_KEY=mn_live_xxx pnpm release:prod:validate
```

## 6) Rollback (executable)

List production deployments:

```bash
pnpm --filter @memorynode/api exec wrangler deployments list --env production
```

Rollback Worker to previous version:

```bash
pnpm --filter @memorynode/api exec wrangler rollback <VERSION_ID> --env production --name memorynode-api --yes -m "rollback <incident-id>"
```

Validate after rollback:

```bash
BASE_URL=https://api.memorynode.ai API_KEY=mn_live_xxx pnpm release:validate
```

Database rollback policy:
- DB migrations are forward-only.
- If a migration causes production issues, ship a hotfix migration (do not reverse historical migrations).
- Re-run schema checks after hotfix:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
DATABASE_URL=postgres://... pnpm db:verify-schema
```

## 7) Kill Switches

Use these to reduce blast radius during incidents:
- Disable reconciliation fetches:
  - `BILLING_RECONCILE_ON_AMBIGUITY=0`
- Disable billing webhook processing:
  - `BILLING_WEBHOOKS_ENABLED=0`
- Tighten abuse limits:
  - lower `RATE_LIMIT_MAX`
  - increase `RATE_LIMIT_WINDOW_MS`

After changing vars, redeploy target env and re-run validation:

```bash
pnpm --filter @memorynode/api deploy:production
BASE_URL=https://api.memorynode.ai API_KEY=mn_live_xxx pnpm release:validate
```

## 8) Dashboard Deploy

Dashboard (`apps/dashboard`) — workspace, API keys, memories. See `docs/internal/DASHBOARD_DEPLOY.md`.

```bash
pnpm --filter @memorynode/dashboard build
# Deploy apps/dashboard/dist to Vercel or Cloudflare Pages (console.memorynode.ai)
```

## 9) Go/No-Go

Use `docs/internal/PROD_READY.md` as the release sign-off checklist.

## 10) GitHub Deploy Pipeline (API)

Workflow: `.github/workflows/api-deploy.yml`

- Staging deploy runs automatically after `CI` succeeds on `main`.
- Production deploy is manual (`workflow_dispatch`) and targets the GitHub `production` environment.
- The deploy jobs call existing guarded scripts:
  - Staging: `pnpm deploy:staging`
  - Production: `pnpm deploy:prod`

### Required GitHub environment secrets

Set these in both `staging` and `production` GitHub Environments (Settings -> Environments):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID` (recommended)
- `DATABASE_URL`
- `BASE_URL`
- `MEMORYNODE_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `API_KEY_SALT`
- `MASTER_ADMIN_TOKEN`
- `EMBEDDINGS_MODE`
- `OPENAI_API_KEY` (required when `EMBEDDINGS_MODE=openai`)
- `BILLING_WEBHOOKS_ENABLED`
- `PAYU_MERCHANT_KEY`
- `PAYU_MERCHANT_SALT`
- `PAYU_BASE_URL`
- `PAYU_VERIFY_URL`
- `PUBLIC_APP_URL`

Production-only additional secrets:

- `SUPABASE_ANON_KEY`
- `ALLOWED_ORIGINS`
- `RATE_LIMIT_MODE`

### Recommended protections

- Require reviewers for the `production` environment before job execution.
- Restrict who can approve production deployments.
- Keep branch protection so only green `CI` reaches `main`.
