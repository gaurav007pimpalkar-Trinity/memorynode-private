# Release Runbook

MemoryNode ships from `main` through two GitHub Actions workflows:

- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — build, test, and every `check:*` gate.
- [`.github/workflows/api-deploy.yml`](../../.github/workflows/api-deploy.yml) — deploy the `memorynode-api` Worker.
- [`.github/workflows/dashboard-pages-deploy.yml`](../../.github/workflows/dashboard-pages-deploy.yml) — deploy the two Pages projects.

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

Manual only. Trigger `api-deploy.yml → deploy-production` with `workflow_dispatch`, `environment=production`, and an explicit `ref`.

Extra gates vs staging (lines 187-234):

- `DEPLOY_CONFIRM=memorynode-prod` required.
- `ALLOWED_ORIGINS` and `RATE_LIMIT_MODE` must be set.
- `EMBEDDINGS_MODE=stub` is rejected.
- `rls-first` requires `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`.

Then `pnpm release:gate` with `CHECK_ENV=production`, then `pnpm deploy:prod`.

Post-deploy:

1. `pnpm release:prod:validate` against `api.memorynode.ai`.
2. `GET /healthz`, `GET /ready` → both 200.
3. Hosted MCP smoke: `POST https://mcp.memorynode.ai/mcp` `initialize` → success.
4. Monitor `request_completed` logs for the next 30 min; watch alerts A1 / A3 / D2.

## 4. Dashboard (Pages)

[`dashboard-pages-deploy.yml`](../../.github/workflows/dashboard-pages-deploy.yml) builds [apps/dashboard](../../apps/dashboard/) once per surface and deploys to two Pages projects:

| Surface | Project | `VITE_APP_SURFACE` | `VITE_APP_HOSTNAME` |
| --- | --- | --- | --- |
| console | `memorynode-console` | `console` | `console.memorynode.ai` |
| app | `memorynode-app` | `app` | `app.memorynode.ai` |

Each build needs `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` injected.

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
