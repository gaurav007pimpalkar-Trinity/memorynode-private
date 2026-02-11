# PROD READY Checklist

Release is allowed only when every item below is green.

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

Canonical release process: `docs/RELEASE_RUNBOOK.md`
