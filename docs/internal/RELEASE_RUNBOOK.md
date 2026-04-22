# Release Runbook

MemoryNode ships from `main` through two GitHub Actions workflows:

- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — build, test, and every `check:*` gate.
- [`.github/workflows/api-deploy.yml`](../../.github/workflows/api-deploy.yml) — deploys the `memorynode-api` Worker, and (production only) also runs `deploy-dashboards-production` to ship both Pages projects in the same run.
- [`.github/workflows/dashboard-pages-deploy.yml`](../../.github/workflows/dashboard-pages-deploy.yml) — dashboard-only hotfix deploy, manual (`workflow_dispatch`).

Cloudflare Pages "Connect to Git" is disconnected on both Pages projects; uploads happen only via `wrangler pages deploy` from the workflows above.

Scheduled operations (memory hygiene, retention, etc.) run from their own GitHub Actions workflows (`memory-hygiene.yml`, `memory-retention.yml`). No Cloudflare Cron Triggers are used.

## 1. Preconditions

- Branch: `main`.
- CI green. `api-deploy.yml` refuses to start until CI's `workflow_run` completes with `conclusion: success`.
- Local gates (optional but recommended before merging): `pnpm release:gate` and `pnpm prod:gate`.

## 2. Staging

Automatic: merging to `main` triggers `api-deploy.yml → deploy-staging` with `CHECK_ENV=staging`.

Manual: `workflow_dispatch` with `environment=staging` and optional `ref`.

Key steps (lines 89-129 of `api-deploy.yml`):

1. `Validate deploy env` — fails if any of `CLOUDFLARE_API_TOKEN`, `DATABASE_URL`, `BASE_URL`, `MEMORYNODE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `EMBEDDINGS_MODE` is unset. Requires `OPENAI_API_KEY` when `EMBEDDINGS_MODE=openai`. Requires `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, `PUBLIC_APP_URL` unless `BILLING_WEBHOOKS_ENABLED` is `off`. Requires `SUPABASE_ANON_KEY` + `SUPABASE_JWT_SECRET` for `rls-first` / `REQUEST_SCOPED_DB_ENABLED=1` / `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`.
2. `pnpm release:gate` (CHECK_ENV=staging).
3. `pnpm deploy:staging`.

Post-deploy: run `pnpm release:staging:validate` locally against staging. Fix on `main` before promoting.

## 3. Production

Manual only. Trigger `api-deploy.yml` with `workflow_dispatch`, `environment=production`, and an explicit `ref`. One click ships the Worker and both Pages projects:

1. `deploy-production` (Worker).
2. `deploy-dashboards-production` (`needs: [deploy-production]`) — builds both surfaces at the same `ref`, uploads to `memorynode-console` and `memorynode-app`.

If the Worker step fails, the dashboard job is skipped automatically. If dashboard upload fails after the Worker succeeded, retry via the `Dashboard Pages Deploy` hotfix workflow — see [DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md) §3.2.

Extra gates vs staging (lines 187-234):

- `DEPLOY_CONFIRM=memorynode-prod` required.
- `ALLOWED_ORIGINS` and `RATE_LIMIT_MODE` must be set.
- `EMBEDDINGS_MODE=stub` is rejected.
- `rls-first` requires `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`.

Then `pnpm release:gate` with `CHECK_ENV=production`, then `pnpm deploy:prod`.

Dashboard job requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DASHBOARD_VITE_SUPABASE_URL`, `DASHBOARD_VITE_SUPABASE_ANON_KEY` in the `production` GitHub environment.

Post-deploy:

1. `pnpm release:prod:validate` against `api.memorynode.ai`.
2. `GET /healthz`, `GET /ready` → both 200.
3. Hosted MCP smoke: `POST https://mcp.memorynode.ai/mcp` `initialize` → success.
4. Dashboard smokes: `https://console.memorynode.ai` and `https://app.memorynode.ai` return 200 with the expected surface; `/version.json` matches the released SHA.
5. Monitor `request_completed` logs for the next 30 min; watch alerts A1 / A3 / D2.

## 4. Dashboard (Pages)

Two Pages projects are deployed from the single React app in [apps/dashboard](../../apps/dashboard/):

| Surface | Project | `VITE_APP_SURFACE` | `VITE_APP_HOSTNAME` |
| --- | --- | --- | --- |
| console | `memorynode-console` | `console` | `console.memorynode.ai` |
| app | `memorynode-app` | `app` | `app.memorynode.ai` |

Each build needs `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` injected.

Deploy paths:

- Coupled (default): `api-deploy.yml → deploy-dashboards-production` runs automatically after `deploy-production` succeeds. Same `ref`, same run id, same log trail.
- Hotfix-only: [`dashboard-pages-deploy.yml`](../../.github/workflows/dashboard-pages-deploy.yml) for dashboard-only redeploys. Details in [DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md).

## 5. Rollback

1. Stop further deploys (cancel in-flight runs).
2. `npx wrangler deployments list` → pick the previous successful deployment id.
3. `npx wrangler rollback --message "release <incident>"`.
4. Revalidate: `pnpm release:prod:validate`.
5. Author a corrective PR with a failing regression test before attempting to roll forward.

Pages rollback: Cloudflare dashboard → Pages → pick the prior production deployment for the affected project.

## 6. Secrets changes

- Add or rotate via `wrangler secret put <NAME> --env production` (or `--env staging`). Do not store in `wrangler.toml`.
- Bump only one secret at a time when possible; redeploy to pick up changes.
- After rotation, re-run `/healthz` and `/ready`; inspect `db_access_path_selected` and auth logs for 10 min.

## 7. Data plane releases

Migrations in `infra/sql/` are applied **before** the API deploy that depends on them.

1. Open PR with new migration file.
2. On merge, apply to staging DB out-of-band (via Supabase SQL editor or Supabase CLI).
3. `pnpm migrations:check` must pass locally — update `MIGRATIONS_TOTAL` and `MIGRATIONS_LATEST` in [docs/internal/README.md](./README.md) (values come from `pnpm migrations:list`).
4. Staging API deploy.
5. Validate. Apply to production DB.
6. Production API deploy.

## 8. Gate reference

- `pnpm release:gate` — CI-grade preflight (env, migrations, tests, openapi).
- `pnpm prod:gate` — additional production readiness checks.
- `pnpm release:staging:validate`, `pnpm release:prod:validate` — post-deploy smokes.
- `pnpm check:docs-drift`, `pnpm check:docs-billing`, `pnpm check:runbooks`, `pnpm check:observability-contracts`, `pnpm check:least-privilege`, `pnpm openapi:check`, `pnpm migrations:check`.
