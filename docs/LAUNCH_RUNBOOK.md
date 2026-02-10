# MemoryNode Launch Runbook

Operator runbook for launching safely from staging to production.

## 1) Environments

| Environment | Purpose | API mode | Data store | Embeddings | Stripe | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| local | Developer iteration | `wrangler dev` | local/stub or dev Supabase | usually `EMBEDDINGS_MODE=stub` | optional | fast feedback, not for reliability signals |
| staging | Release candidate validation | deployed Worker (`DEPLOY_ENV=staging`) | staging Supabase | `stub` or `openai` | Stripe test mode | must run full launch checks here first |
| prod | Customer traffic | deployed Worker (`DEPLOY_ENV=production`) | production Supabase | `openai` | Stripe live mode | no stub modes allowed |

## 2) Required Config By Component

| Component | Required vars/bindings | Where to set |
| --- | --- | --- |
| API Worker (core) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `EMBEDDINGS_MODE`, `SUPABASE_MODE`, `ENVIRONMENT` | Cloudflare Worker vars + secrets (`wrangler secret put` for secrets) |
| Rate limiting (DO) | Durable Object binding `RATE_LIMIT_DO` -> class `RateLimitDO`, migration tag present | `apps/api/wrangler.toml` and deployed Worker config |
| Billing / Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `PUBLIC_APP_URL` | Cloudflare Worker vars + secrets; Stripe dashboard for endpoint/events |
| Supabase operations | `SUPABASE_DB_URL` (or `DATABASE_URL`) | Local shell / CI for migration scripts |
| Dashboard | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL` | `apps/dashboard/.env.local` |

Reference templates:
- `.env.gate.example`
- `.env.staging.smoke.example`
- `.env.prod.smoke.example`
- `.env.e2e.example`
- `apps/api/.dev.vars.template`
- `apps/dashboard/.env.example`

## 3) Pre-flight Checklist

- Install and lock dependencies:
  - `pnpm install`
- Code quality gates:
  - `pnpm lint`
  - `pnpm test`
  - `pnpm typecheck`
- Gate reliability check (must fail when a command fails):
  - `pnpm prod:gate:self-test`
- Cross-shell E2E script parse check:
  - `pnpm e2e:verify`
- Migration safety check (fresh + partial history):
  - `MIGRATION_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres pnpm db:drift:test`
- Dry-run release gate before any real deploy:
  - Staging: `DRY_RUN=1 CHECK_ENV=staging pnpm prod:gate`
  - Production: `DRY_RUN=1 CHECK_ENV=production pnpm prod:gate`

## 4) Deploy Steps

### 4.1 Staging

1. Deploy:
   - `DEPLOY_ENV=staging DRY_RUN=0 pnpm deploy:staging`
2. Verify admin/auth baseline:
   - `BASE_URL=https://<staging-api> ADMIN_TOKEN=<master-admin-token> pnpm staging:verify`
3. Verify ingest/search/context path:
   - `pnpm e2e:verify`
4. Verify Stripe webhook handling (test mode):
   - `BASE_URL=https://<staging-api> STRIPE_WEBHOOK_SECRET=<staging-signing-secret> pnpm stripe:webhook-test`
5. Validate DB migration/RLS consistency:
   - `pnpm db:drift:test`
   - `pnpm db:verify-rls` (when running against target DB)

### 4.2 Production

1. Final dry-run gate:
   - `DRY_RUN=1 CHECK_ENV=production pnpm prod:gate`
2. Deploy with safety latch:
   - `DEPLOY_ENV=production DEPLOY_CONFIRM=memorynode-prod DRY_RUN=0 pnpm deploy:prod`
3. Post-deploy production verification:
   - `BASE_URL=https://<prod-api> ADMIN_TOKEN=<master-admin-token> pnpm staging:verify`
   - `pnpm e2e:verify` (against production key/URL configuration)
   - `BASE_URL=https://<prod-api> STRIPE_WEBHOOK_SECRET=<prod-signing-secret> pnpm stripe:webhook-test`

## 5) Post-Deploy Verification (Required)

1. Health endpoint:
   - `curl -s https://<api>/healthz`
2. Admin create workspace + key:
   - `BASE_URL=https://<api> ADMIN_TOKEN=<token> pnpm staging:verify`
3. Ingest/search/context smoke:
   - `pnpm e2e:verify`
4. Billing webhook sanity:
   - `BASE_URL=https://<api> STRIPE_WEBHOOK_SECRET=<secret> pnpm stripe:webhook-test`
5. DB drift/RLS verification:
   - `pnpm db:drift:test`
   - `pnpm db:verify-rls`

## 6) Rollback Procedure

1. Stop further deploys and mark incident owner.
2. Roll back Worker code to last known-good release:
   - Check last good commit/deployment.
   - Redeploy previous version using your standard deploy command (or wrangler deployment hash).
3. Re-run:
   - `BASE_URL=https://<api> ADMIN_TOKEN=<token> pnpm staging:verify`
   - `pnpm e2e:verify`
4. Do not roll back DB migration history; use a forward fix migration if needed.
5. If billing incident is active, temporarily disable webhook delivery in Stripe until API is stable.

## 7) Incident Playbook

### 7.1 Auth failures surge (401/403 spike)
- Check logs: `event_name="request_summary"` with `status in [401,403]`, inspect `error_code`.
- Validate `MASTER_ADMIN_TOKEN`, `API_KEY_SALT`, and key rotation changes.
- Run `BASE_URL=... ADMIN_TOKEN=... pnpm staging:verify`.
- If salt mismatch appears, align Worker `API_KEY_SALT` with DB `app_settings.api_key_salt` and reissue keys.

### 7.2 5xx surge
- Filter logs: `event_name="request_summary"` and `status>=500`.
- Group by `error_code` (`DB_ERROR`, `CONFIG_ERROR`, `RATE_LIMIT_UNAVAILABLE`, `INTERNAL`).
- Validate Supabase connectivity and Worker secrets, then re-run smoke checks.

### 7.3 Rate-limit spike / abuse
- Filter logs: `error_code="RATE_LIMITED"` and `event_name="cap_exceeded"`.
- Confirm `RATE_LIMIT_DO` binding health and evaluate abusive clients by request patterns.
- Tighten WAF/rate settings or rotate abused API keys if needed.

### 7.4 Supabase outage / RLS issue
- Symptoms: `DB_ERROR`, query failures, cross-tenant failures.
- Run `pnpm db:verify-rls`; if migration drift suspected run `pnpm db:drift:test`.
- Verify `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, then apply forward repair migration if required.

### 7.5 Stripe webhook failure loop
- Watch for `billing_webhook_signature_invalid` and `billing_webhook_workspace_not_found`.
- Validate `STRIPE_WEBHOOK_SECRET` matches endpoint.
- Repair missing customer->workspace mapping, then replay events from Stripe.

## 8) Data Safety

### 8.1 Backups / restore
- Follow `docs/BACKUP_RESTORE.md` for backup schedule, restore drill, and validation.
- Before risky changes, capture a fresh backup/snapshot.
- After restore in staging, run:
  - `pnpm staging:verify`
  - `pnpm e2e:verify`

### 8.2 User-facing recovery (export/import)
- Export: `POST /v1/export` (JSON or ZIP mode).
- Import: `POST /v1/import` with artifact.
- Use export/import for per-workspace recovery and tenant-level rollback assistance.

## 9) Monitoring Basics During Launch

- Cloudflare dashboard: Workers & Pages -> API Worker -> Logs.
- Primary filter:
  - `event_name="request_summary"`
- Fast failure filters:
  - `status>=500`
  - `error_code="DB_ERROR"`
  - `event_name="billing_webhook_signature_invalid"`

For thresholds and alert setup, see `docs/ALERTS.md`.

## 9.1 Beta user handoff

When onboarding new beta developers, send the onboarding pack:
- `docs/BETA_ONBOARDING.md`
- `docs/TROUBLESHOOTING_BETA.md`
- `examples/node-quickstart/`
- `bruno/MemoryNode/`

## 10) Known Gotchas

- `pnpm prod:gate:self-test` must fail when a command is forced to fail; if it passes, gate wiring is broken.
- `pnpm e2e:verify` catches shell parser regressions across bash + PowerShell before runtime failures.
- `pnpm db:drift:test` should be run after migration changes to validate fresh and partially migrated DB histories.
- `pnpm staging:verify` creates real workspace + API key records; run in the intended environment only.
