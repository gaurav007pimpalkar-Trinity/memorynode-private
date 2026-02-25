# Go-Live Checklist (one page)

Do these **before** first production traffic. Full details: [PROD_SETUP_CHECKLIST.md](PROD_SETUP_CHECKLIST.md), [PROD_READY.md](PROD_READY.md), [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md).

---

## 1. Code & CI
- [ ] `main` branch: CI green (build, lint, typecheck, test with coverage, migrations check, secret scan).
- [ ] Run locally: `pnpm release:gate` (use prod-safe env or `CHECK_ENV=staging` for config check).

## 2. Secrets (Worker production)
Set via **Wrangler secrets** (never in repo or `[vars]`):
- [ ] `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- [ ] `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `OPENAI_API_KEY`
- [ ] `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT` (if billing enabled)

Production vars: [ ] `ENVIRONMENT=production`, [ ] `EMBEDDINGS_MODE=openai`, [ ] `RATE_LIMIT_MODE=on`, [ ] `ALLOWED_ORIGINS` includes `https://app.memorynode.ai`.

## 3. Database (staging then production)
- [ ] `DATABASE_URL=... pnpm db:migrate`
- [ ] `DATABASE_URL=... pnpm db:verify-schema`
- [ ] `DATABASE_URL=... pnpm db:verify-rls`

## 4. Deploy & validate (order matters)
1. [ ] Staging: `pnpm deploy:staging` then `TARGET_ENV=staging STAGING_BASE_URL=... API_KEY=... pnpm release:staging:validate`
2. [ ] (Optional) Canary: `pnpm deploy:canary` then canary validate.
3. [ ] Production: `DEPLOY_ENV=production DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod`
4. [ ] Production validate: `TARGET_ENV=production PROD_BASE_URL=https://api.memorynode.ai API_KEY=... pnpm release:prod:validate`

## 5. Dashboard & security (before prod traffic)
- [ ] Dashboard deployed (e.g. `app.memorynode.ai`).
- [ ] **G5 live check:** `G5_URL=https://app.memorynode.ai pnpm ci:trust-gates` (confirms CSP and security headers on live URL).

## 6. Post go-live (same day)
- [ ] `GET https://api.memorynode.ai/healthz` → `status: ok`, `x-request-id` present. Optional: use `GET /ready` for LB readiness (returns 503 if DB unavailable).
- [ ] Log sink + alerts: configure from [ALERTS.md](ALERTS.md); run 60s health checklist from [OBSERVABILITY.md](OBSERVABILITY.md) §3.
- [ ] Billing: if enabled, send test PayU callback; confirm `webhook_verified` / `webhook_processed` in Worker logs.
- [ ] (Recommended) Schedule dashboard session cleanup: `POST /admin/sessions/cleanup` (e.g. daily cron). See [OPERATIONS.md](OPERATIONS.md) §F.

---

**Rollback:** `wrangler rollback <VERSION_ID> --env production` → then re-validate. See [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) §7 and [OPERATIONS.md](OPERATIONS.md) §B.
