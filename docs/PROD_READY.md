# PROD READY Checklist

Release is allowed only when every item below is green.

**Production requirements (no stubs):** In production, Supabase, embeddings, and rate limiting must be real. See [docs/PRODUCTION_REQUIREMENTS.md](PRODUCTION_REQUIREMENTS.md) for what is forbidden (e.g. `EMBEDDINGS_MODE=stub`, `RATE_LIMIT_MODE=off`). The Worker and release gate enforce this.

## 1) CI and Quality
- [ ] `pnpm release:gate` passed on the release commit.
- [ ] CI pipeline is green on `main`.

## 2) Security and Secrets
- [ ] `pnpm secrets:check` passed.
- [ ] `pnpm secrets:check:tracked -- --ci` passed.
- [ ] No real secrets in tracked files; only templates/placeholders in `.env*` / `.dev.vars*`.

## 3) Database Safety
- [ ] `pnpm migrations:check` passed.
- [ ] Staging DB migrated and verified:
  - [ ] `DATABASE_URL=... pnpm db:migrate`
  - [ ] `DATABASE_URL=... pnpm db:verify-schema`
  - [ ] `DATABASE_URL=... pnpm db:verify-rls`
- [ ] Production DB migration plan reviewed (forward-only hotfix policy acknowledged).

## 4) Release Validation
- [ ] Staging deploy completed (`pnpm deploy:staging`).
- [ ] Staging validation passed (`BASE_URL=... API_KEY=... pnpm release:validate`).
- [ ] Canary validation passed (`pnpm deploy:canary` + `pnpm release:canary:validate`) or low-risk prod path approved.
- [ ] Production validation passed (`BASE_URL=... API_KEY=... pnpm release:validate`).

## 5) Abuse and Billing Reliability
- [ ] Load smoke passed (`pnpm load:smoke`) against target env.
- [ ] Webhook reliability tests passed (idempotency/replay/out-of-order suite).
- [ ] Deferred webhook backlog monitoring is set.

## 6) Operations and Incident Readiness
- [ ] Request tracing documented and on-call can search by `x-request-id`.
- [ ] Rollback command tested/documented (`wrangler rollback` path).
- [ ] Kill switches documented:
  - [ ] `BILLING_RECONCILE_ON_AMBIGUITY`
  - [ ] `BILLING_WEBHOOKS_ENABLED`
  - [ ] rate-limit vars (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`)
- [ ] Backup and export/restore procedures are documented and accessible.

## 7) Security headers (G5 live check)

- [ ] Before production go-live, run: `G5_URL=https://app.memorynode.ai pnpm ci:trust-gates` (use your dashboard URL). This verifies the deployed app serves CSP and security headers. See [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md#g5-live-security-headers-before-production-go-live).

---

## What you need to do (after code changes)

1. **Install dependencies (if lockfile changed)**  
   Run `pnpm install` at repo root. If you added `@vitest/coverage-v8`, run `pnpm test:coverage` locally to enforce coverage thresholds; CI runs `pnpm test:coverage` (see `.github/workflows/ci.yml`).

2. **Secrets and env**  
   Ensure production Worker has all secrets set via `wrangler secret put` (see [PROD_SETUP_CHECKLIST.md](PROD_SETUP_CHECKLIST.md)). No stub modes in prod (see [PRODUCTION_REQUIREMENTS.md](PRODUCTION_REQUIREMENTS.md)).

3. **G5 live check**  
   Once the dashboard is deployed, run `G5_URL=<your-dashboard-url> pnpm ci:trust-gates` to confirm live security headers.

4. **Database**  
   Run migrations and RLS/schema verification on staging and production DBs as in [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md).

5. **Smoke and release gate**  
   Run `pnpm release:gate` (and optionally `RELEASE_INCLUDE_BUILD=1 pnpm release:gate`) before releasing. After deploy, run the validation steps from the runbook.

Canonical release process: `docs/RELEASE_RUNBOOK.md`
