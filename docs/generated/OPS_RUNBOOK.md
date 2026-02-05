# Ops Runbook

## Local Dev
1) Install deps: `corepack pnpm install` (root `package.json`).
2) Prepare API env: copy template `cp apps/api/.dev.vars.template apps/api/.dev.vars` and fill values (`apps/api/.dev.vars.template`, `apps/api/src/index.ts:16-44`).
3) Start API (Cloudflare Worker dev): `corepack pnpm dev:api` (prints base URL) or `corepack pnpm dev` (root script uses filter) (`package.json`).
4) (Optional) Start Dashboard: `corepack pnpm dev --filter @memorynode/dashboard` (Vite dev server 4173) with `.env.local` from `apps/dashboard/.env.example`.
5) Smoke test end-to-end (stub mode): Windows `corepack pnpm smoke:ps`; POSIX `corepack pnpm smoke` (`scripts/smoke.ps1`, `scripts/smoke.sh`). Uses stub Supabase/embeddings and hits /healthz, /v1/workspaces, /v1/api-keys, /v1/memories, /v1/search, /v1/context.

## Running Components
- **API (Worker)**: `wrangler dev` via `apps/api/package.json` scripts; config `apps/api/wrangler.toml` (port 8787, durable object binding).
- **Dashboard**: `vite dev` via `apps/dashboard/package.json`; requires Supabase anon URL/key and API base URL envs.
- **Database**: Apply migrations in order `infra/sql/001_init.sql` … `016_webhook_events.sql` (see `docs/generated/DATABASE_SCHEMA.md`).

## Tests & Quality
- Unit/integration tests: `corepack pnpm test` (Vitest) (`package.json`).
- Lint: `corepack pnpm lint`.
- Typecheck: `corepack pnpm typecheck` (currently fails on Stripe key optionality in `apps/api/src/index.ts:214-230`).
- Smoke (local Worker): `corepack pnpm smoke` or `smoke:ps`.
- E2E smoke (API key supplied): `bash scripts/e2e_smoke.sh` or `pwsh -File scripts/e2e_smoke.ps1` (uses `.env.e2e.example`).

## Env Vars (complete list from repo)
- API Worker (`apps/api/src/index.ts:16-44`, `.dev.vars.template`, `wrangler.toml`):
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_MODE` (e.g., `stub`), `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `EMBEDDINGS_MODE` (`openai|stub`), `ENVIRONMENT`, `NODE_ENV`, `RATE_LIMIT_DO` (binding name), `ALLOWED_ORIGINS`, `MAX_BODY_BYTES`, `AUDIT_IP_SALT`, `MAX_IMPORT_BYTES`, `MAX_EXPORT_BYTES`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `PUBLIC_APP_URL`, `STRIPE_PORTAL_CONFIGURATION_ID`, `STRIPE_SUCCESS_PATH`, `STRIPE_CANCEL_PATH`.
- Dashboard (`apps/dashboard/.env.example`, `apps/dashboard/README.md`):
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`.
- Root examples: `.env.example`, `.env.e2e.example` provide templates for smoke/E2E.

## Troubleshooting (from scripts/tests)
- If `/healthz` OK but admin endpoints fail: ensure `MASTER_ADMIN_TOKEN` matches request header (`scripts/smoke.ps1` logic).
- CORS blocked: set `ALLOWED_ORIGINS` (comma list or `*`) (`apps/api/src/index.ts:399-417`).
- API key auth 401/403: verify `API_KEY_SALT` matches DB `app_settings` (error emitted in `apps/api/tests/api_keys.test.ts`).
- 500 on startup: missing `RATE_LIMIT_DO` binding; `ensureRateLimitDo` throws (`apps/api/src/index.ts:360-371`).
- Typecheck failing: make `STRIPE_SECRET_KEY` non-optional in `getStripeClient` (`apps/api/src/index.ts:214-230`).
- Import/export 413: adjust `MAX_IMPORT_BYTES`/`MAX_EXPORT_BYTES` envs (`apps/api/src/index.ts:1540-1635`).
