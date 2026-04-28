# Release Runbook

MemoryNode ships from `main` through this GitHub Actions pipeline:

- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — build, test, and every `check:*` gate (all branches; required before deploy).
- [`.github/workflows/release_staging.yml`](../../.github/workflows/release_staging.yml) — after **green CI on `main`**, one job deploys **API staging → Dashboard staging Pages → E2E** at the **same commit SHA** (atomic staging).
- [`.github/workflows/release_production.yml`](../../.github/workflows/release_production.yml) — starts when **Release Staging** succeeds (`workflow_run`) or via **`workflow_dispatch`**. SHA always comes from **`approved-release`** / `approved_release.json` (validated by [scripts/validate_approved_release.mjs](../../scripts/validate_approved_release.mjs)). Manual runs may set optional **`staging_run_id`** (must be one of the **last 5** successful staging runs on `main`); leave empty for **latest**. Job **`promote`** uses GitHub Environment **production** (add required reviewers).
- [`.github/workflows/rollback_production.yml`](../../.github/workflows/rollback_production.yml) — optional **`workflow_dispatch`** Worker rollback (`wrangler rollback --env production`).

Ad hoc remote E2E: [`.github/workflows/e2e-smoke.yml`](../../.github/workflows/e2e-smoke.yml) (manual; not part of the default pipeline).

Cloudflare Pages "Connect to Git" is disconnected on both Pages projects; uploads happen only via `wrangler pages deploy` from the release workflows.

Scheduled operations (memory hygiene, retention, etc.) run from their own GitHub Actions workflows (`memory-hygiene.yml`, `memory-retention.yml`). No Cloudflare Cron Triggers are used.

## 1. Preconditions

- Branch: `main`.
- CI green on the merge commit. `release_staging.yml` runs only when CI’s `workflow_run` completes with `conclusion: success` on `main`.
- Local gates (optional but recommended before merging): `pnpm release:gate` and `pnpm prod:gate`.

## 2. Staging

Automatic: push/merge to `main` with green CI starts [`.github/workflows/release_staging.yml`](../../.github/workflows/release_staging.yml).

Configure the GitHub Environment **`staging`** with the same Worker secrets as before, **plus** dashboard + E2E fields:

- **Dashboard build:** `VITE_CONSOLE_BASE_URL`, `DASHBOARD_VITE_SUPABASE_URL`, `DASHBOARD_VITE_SUPABASE_ANON_KEY` (same names as production dashboard env).
- **Staging-only Pages:** `DASHBOARD_PAGES_PROJECT_CONSOLE`, `DASHBOARD_PAGES_PROJECT_APP` (must **not** be the production project names `memorynode-console` / `memorynode-app` when pointing at a non-prod API).
- **Verify URLs:** `DASHBOARD_VERIFY_CONSOLE_ORIGIN`, `DASHBOARD_VERIFY_APP_ORIGIN` (origins that match those Pages projects).
- **E2E:** `BASE_URL` + `MEMORYNODE_API_KEY` for the staging API (used by `scripts/verify_e2e.sh`).

Key steps in the workflow:

1. Validate API + dashboard secrets (fail fast with `::error::` messages).
2. `pnpm release:gate` with `RELEASE_GATE_LIVE=1` (CHECK_ENV=staging; hits `/healthz`, `/ready`, `/v1/usage/today`, dashboard env alignment — requires `MEMORYNODE_API_KEY` on the staging environment).
3. `pnpm deploy:staging`.
4. `pnpm dashboard:deploy:pages` with `VITE_API_BASE_URL=${{ secrets.BASE_URL }}` and optional `DASHBOARD_PAGES_PROJECT_*` overrides (see [scripts/deploy_dashboard_pages.mjs](../../scripts/deploy_dashboard_pages.mjs)).
5. `./scripts/verify_e2e.sh` against staging.
6. Writes **`approved_release.json`** and uploads artifact **`approved-release`** (strict schema: `sha`, `status`, `timestamp`, `staging_run_id` — this is the only production-eligibility token).

Post-deploy: run `pnpm release:staging:validate` locally against staging if needed. Fix on `main` before production.

## 3. Production

**No manual SHA.** After green staging, **Release Production** runs automatically, or use **Run workflow** with optional **`staging_run_id`** to promote a **recent** successful staging run (still artifact-only).

1. **`resolve-approved-sha`** lists the last 5 successful staging runs (visibility), downloads `approved-release` for the chosen run, runs **`validate_approved_release.mjs`**, and for `workflow_run` requires manifest `sha` === `workflow_run.head_sha`.
2. **`promote`** (waits on environment **production**): checkout that SHA → verify on `main` → secrets → `pnpm release:gate` (`RELEASE_GATE_LIVE`: `/healthz`, `/ready`, `/v1/usage/today`, dashboard URL checks) → `pnpm deploy:prod` → `pnpm dashboard:deploy:pages` → `pnpm smoke:prod`.
   - `smoke:prod` prefers `MEMORYNODE_SMOKE_API_KEY` (recommended dedicated key) and falls back to `MEMORYNODE_API_KEY` for backward compatibility.
   - The dedicated key should belong to a persistent `prod-smoke-tests` workspace with always-active entitlement; otherwise smoke can fail with `ENTITLEMENT_REQUIRED` even when deploy succeeded.

If a step fails, the workflow stops; fix forward with a new commit through staging again.

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

- **Production (default):** [`.github/workflows/release_production.yml`](../../.github/workflows/release_production.yml) — API + both Pages + smoke in one approved run.
- **Staging:** [`.github/workflows/release_staging.yml`](../../.github/workflows/release_staging.yml) — uses **separate** Pages project names via secrets so staging builds never target production Pages by accident.

Hotfix / rollback details: [DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md).

## 5. Rollback

1. Stop further deploys (cancel in-flight runs of `release_staging.yml` / `release_production.yml`).
2. **Worker (one click):** run [`.github/workflows/rollback_production.yml`](../../.github/workflows/rollback_production.yml) with a short message, or locally: `cd apps/api && npx wrangler rollback --env production -y --message "…"`.
3. Revalidate: `pnpm release:prod:validate`.
4. Author a corrective PR with a failing regression test before attempting to roll forward.

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
