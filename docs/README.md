# MemoryNode Monorepo

## Layout
- `apps/api` – Cloudflare Worker API.
- `apps/dashboard` – implemented dashboard web app (workspace, keys, memories, usage, activation, settings).
- `packages/shared` – shared types.
- `packages/sdk` – lightweight TypeScript SDK.
- `infra/sql` – SQL migrations and schema (apply in order).
- `docs` – documentation.
- `docs/RELEASE_RUNBOOK.md` – canonical staging/canary/prod release, validation, rollback, and kill switches.
- `docs/PROD_READY.md` – final go/no-go checklist.
- `docs/LAUNCH_CHECKLIST.md` – pointer to canonical release checklist (`docs/PROD_READY.md`).
- `docs/LAUNCH_RUNBOOK.md` – pointer to canonical release runbook (`docs/RELEASE_RUNBOOK.md`).
- `docs/ALERTS.md` – lightweight monitoring + alert thresholds and Cloudflare setup notes.
- `docs/BETA_ONBOARDING.md` – 10–15 minute beta onboarding guide for first successful calls.
- `docs/TROUBLESHOOTING_BETA.md` – beta symptom->cause->fix playbook and support template.
- `docs/QUICKSTART.md` – 10-minute developer quickstart (envs, migrations, dev servers, curls).
- `docs/API_REFERENCE.md` – endpoint reference (Worker API, admin, billing, plans).
- `docs/IMPROVEMENTS.md` – what’s wrong in the repo and improvements to make it invincible and smart.
- `docs/IMPROVEMENT_PLAN.md` – phased plan to fix all wrongs and implement all improvements (with tasks and checklists).
- `docs/BEST_IN_MARKET_PLAN.md` – CEO/CTO strategic plan to make MemoryNode best-in-market (trust breakers, moat, observability, retrieval cockpit).

## Documentation Map (Reading Order)

Follow this path depending on what you need:

### New developer? Start here:

1. **`docs/QUICKSTART.md`** — 10-minute setup: install, env vars, migrations, dev server, first curls
1. **`docs/API_REFERENCE.md`** — endpoint reference (all routes, auth, billing, plans)
1. **`docs/TROUBLESHOOTING_BETA.md`** — symptom → cause → fix playbook

### Deploying to production?

1. **`docs/PROD_SETUP_CHECKLIST.md`** — founder production input checklist (Cloudflare, Supabase, PayU, DNS)
1. **`docs/RELEASE_RUNBOOK.md`** — canonical staging → canary → production deploy, validate, rollback
1. **`docs/PROD_READY.md`** — final go/no-go checklist

### Operating in production?

1. **`docs/OBSERVABILITY.md`** — golden metrics, structured events, 60-second health checklist
1. **`docs/ALERTS.md`** — alert definitions mapped 1:1 to golden metrics, triage playbooks
1. **`docs/OPERATIONS.md`** — incident checklist, rollback notes, operator procedures
1. **`docs/SECURITY.md`** — secrets hygiene, PayU secret rotation, incident response
1. **`docs/BILLING_RUNBOOK.md`** — PayU webhook ops, replay/reprocess, reconciliation

### Testing?

- Run `pnpm test` for unit tests (Vitest, 150+ tests)
- Shared test helpers in `apps/api/tests/helpers/` (env, supabase, payu, rate_limit_do)
- Run `pnpm smoke` (or `pnpm smoke:ps` on Windows) for local E2E smoke
- See "Local smoke test" and "E2E smoke" sections below for details

### Strategy / best-in-market:

- **`docs/BEST_IN_MARKET_PLAN.md`** — CEO/CTO plan: trust breakers (P0), API/config, Worker split, observability, retrieval cockpit, first 10 minutes. Execution order and go/no-go criteria.

### Reference / historical:

- `docs/LAUNCH_CHECKLIST.md` — pointer to `PROD_READY.md`
- `docs/LAUNCH_RUNBOOK.md` — pointer to `RELEASE_RUNBOOK.md`
- `docs/BETA_ONBOARDING.md` — beta onboarding guide
- `docs/IMPROVEMENTS.md` / `docs/IMPROVEMENT_PLAN.md` — improvement tracking

## Billing (PayU)

- Production billing is PayU-only. See `docs/BILLING_RUNBOOK.md` for webhook ops and `docs/PROD_SETUP_CHECKLIST.md` for PayU setup.

## Canonical Ops Docs (Source of Truth)

- `docs/RELEASE_RUNBOOK.md` – canonical staging/canary/production deploy, validate, rollback, kill switches.
- `docs/PROD_READY.md` – canonical go/no-go checklist.
- `docs/BILLING_RUNBOOK.md` – PayU webhook operations, replay/reprocess, reconciliation behavior.
- `docs/OBSERVABILITY.md` – golden metrics, structured events, health checklist, SLOs.
- `docs/ALERTS.md` – alert definitions, thresholds, triage playbooks (maps 1:1 to OBSERVABILITY).
- `docs/OPERATIONS.md` – incident checklist, rollback notes, and operator procedures.
- `docs/SECURITY.md` – secrets hygiene, PayU rotation playbook, incident response SLAs.
- `docs/PROD_SETUP_CHECKLIST.md` – founder production setup checklist.
- Some older docs are retained for historical context; when instructions conflict, follow the canonical docs above.

## Tracked env templates
- Root: `.env.example`, `.env.e2e.example`, `.env.gate.example`, `.env.staging.smoke.example`, `.env.prod.smoke.example`
- API worker: `apps/api/.dev.vars.template`
- Dashboard: `apps/dashboard/.env.example`
- Never commit real values in `.env*`/`.dev.vars*`; use Cloudflare secrets for deployed environments.
- Run secret checks before commit:
  - `pnpm secrets:check`
  - `pnpm secrets:check:tracked`
- Rotation/incident runbook: `docs/SECURITY.md`
- Billing webhook runbook: `docs/BILLING_RUNBOOK.md`

## Analytics & Observability

- **Golden metrics and structured events**: see `docs/OBSERVABILITY.md` for the complete event catalog, golden metrics, and 60-second health checklist.
- **Alert definitions**: see `docs/ALERTS.md` for alert thresholds mapped 1:1 to golden metrics.
- Product event names (persisted to `product_events`): `workspace_created`, `api_key_created`, `first_ingest_success`, `first_search_success`, `first_context_success`, `cap_exceeded`, `checkout_started`, `upgrade_activated`.
- Structured log event names: `request_completed` (with `route_group`), `request_failed`, `cap_exceeded`, `embed_request`, `search_request`, `db_rpc`, `audit_log`, `webhook_received`, `webhook_verified`, `webhook_processed`, `webhook_replayed`, `webhook_deferred`, `webhook_reconciled`, `webhook_failed`, `billing_webhook_signature_invalid`, `billing_webhook_workspace_not_found`, `billing_endpoint_error`.

## Getting Started
1) Install dependencies:
```bash
pnpm install
```
2) Run the API locally:
```bash
pnpm dev
```
   - prints local base URL: 
```bash
pnpm dev:api
```
3) Check the health endpoint (wrangler default port 8787):
```bash
curl http://127.0.0.1:8787/healthz
```

## Local smoke test
1) Ensure `.dev.vars` exists (creates from template if missing):
```bash
cp apps/api/.dev.vars.template apps/api/.dev.vars
```
   - In production, set `SUPABASE_MODE` to your real Supabase (not `stub`) and `EMBEDDINGS_MODE=openai`.
2) Run the end-to-end smoke (starts API with stub embeddings, bootstraps workspace/key, exercises memories/search/context):
```bash
corepack pnpm smoke
```
   - Windows/PowerShell:
```powershell
corepack pnpm smoke:ps
```
   - CI/non-interactive:
```bash
corepack pnpm smoke:ci
```
The script waits for `/healthz`, ingests a sample memory, runs `/v1/search` and `/v1/context`, prints responses, and exits non-zero on failure. Logs are written to `.tmp/wrangler.log`.

### Rate limiting backing store
- The API now uses a Durable Object for rate limiting: binding `RATE_LIMIT_DO` (class `RateLimitDO`).
- Configure it in `apps/api/wrangler.toml` under `durable_objects`; no per-env IDs are needed for dev.

## Sprint 0 acceptance criteria
- Lint + typecheck pass.
- Dev server starts (`pnpm dev:api`).
- Smoke passes on at least one path:
  - Windows: `pnpm smoke:ps`
  - macOS/Linux: `pnpm smoke`

## Troubleshooting
| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/healthz` ok but script fails before `/v1/api-keys` | PowerShell using curl alias | `pnpm smoke:ps` (uses `curl.exe`) |
| 401/403 on admin endpoints | `MASTER_ADMIN_TOKEN` wrong/missing | Set correct token in `.dev.vars` |
| 500 errors | DB migrations not applied / drifted | Run `pnpm db:migrate` then `pnpm db:verify-rls` |
| Timeouts | Wrong `SUPABASE_URL` or blocked network | Verify Supabase project URL/connectivity |

Notes:
- Requires Node.js 20+ and pnpm.
- `pnpm dev` wires to `wrangler dev` for the API.

## E2E smoke
1) Create a one-time E2E API key in the dashboard: **API Keys → Create → copy once**.
2) Copy the template and fill secrets:
```bash
cp .env.e2e.example .env.e2e
```
3) Run the smoke (stub embeddings):
```bash
bash scripts/e2e_smoke.sh
```
Windows: `powershell -File scripts/e2e_smoke.ps1`
The script starts `wrangler dev` on a random port, hits /healthz, then /v1/memories, /v1/search, /v1/context, /v1/usage/today, and cleans up.
You can place these vars in `.env.e2e`; the smoke scripts will load it automatically (not committed).

GitHub Actions job `.github/workflows/e2e-smoke.yml` will run the same script only when secrets are present:
- `E2E_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `API_KEY_SALT`

### One-command staging validation (canonical)
Use this to validate a deployed environment with admin token only:
```bash
TARGET_ENV=staging STAGING_BASE_URL=https://<api-host> ADMIN_TOKEN=<master-admin-token> pnpm release:staging:validate
```
It checks `/healthz`, validates authenticated usage/search/context paths, and verifies `x-request-id` headers. It exits non-zero on failure.

### Prod secrets (Cloudflare Workers)
- Do **not** place secrets in `apps/api/wrangler.toml [vars]`; Cloudflare will overwrite dashboard secrets on deploy.
- Set secrets with `wrangler secret put NAME`: `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`.
- Safe vars that can live in `[vars]`: `SUPABASE_URL`, `SUPABASE_MODE`, `EMBEDDINGS_MODE`, `ENVIRONMENT`, `RATE_LIMIT_MODE`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, `PAYU_SUCCESS_PATH`, `PAYU_CANCEL_PATH`, `PAYU_CURRENCY`.

### Security-related env vars
- `ALLOWED_ORIGINS`: comma-separated allowed origins for CORS. If unset, CORS is not enabled. Use `*` to explicitly allow all.
- `MAX_BODY_BYTES`: maximum request body size in bytes (default 1,000,000).
- `MAX_IMPORT_BYTES`: maximum allowed size (bytes) for `/v1/import` artifacts (default 10,000,000).
- `MAX_EXPORT_BYTES`: maximum allowed size (bytes) for `/v1/export` artifacts (default 10,000,000).
- `AUDIT_IP_SALT`: salt used to hash IPs in audit logs.
- `API_KEY_SALT`: prefer setting via environment in prod; the database `app_settings.api_key_salt` is a dev fallback. If both are present and differ, the Worker fails fast with `CONFIG_ERROR` to prevent mismatched key hashes.

### Billing (PayU only)
- Required billing env vars: `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, `PUBLIC_APP_URL` (plus `PAYU_SUCCESS_PATH`/`PAYU_CANCEL_PATH` if overriding defaults).
- API endpoints:
  - `GET /v1/billing/status` (API key auth) → `{ plan, plan_status, effective_plan, current_period_end, cancel_at_period_end }`
  - `POST /v1/billing/checkout` (API key auth) → PayU hosted checkout payload (platform-only plans)
  - `POST /v1/billing/portal` → always `410 GONE`
  - `POST /v1/billing/webhook` → PayU callback receiver
- Verify-before-grant invariant:
  - Webhook/callback fields alone never grant access.
  - Entitlements are granted only after PayU verify API confirms matching `txnid`, amount, currency, and success status.
- Idempotency invariant:
  - Duplicate webhook `event_id` is replay-safe via `payu_webhook_events`.
  - Entitlement grant is one-per-txn via unique `workspace_entitlements.source_txn_id`.
- Entitlements drive quota enforcement on quota-consuming routes (`/v1/memories`, `/v1/search`, `/v1/context`) and expired entitlements return `ENTITLEMENT_EXPIRED` (HTTP 402).

### Export / Import
- `POST /v1/export`
  - Default: JSON `{ artifact_base64, bytes, sha256 }` (deterministic ZIP encoded as base64).
  - Binary: set `Accept: application/zip` **or** `?format=zip` to receive a ZIP payload with `Content-Type: application/zip` and a download filename `memorynode-export-<workspace>-<yyyy-mm-dd>.zip`.
  - Both modes enforce `MAX_EXPORT_BYTES` and return 413 on overflow.
- `POST /v1/import` accepts `{ artifact_base64, mode? }` and restores memories/chunks for the authenticated workspace only. `mode` defaults to non-destructive `upsert`; see API docs for other modes.

## Database Setup (Supabase)
1) Set `SUPABASE_DB_URL` (or `DATABASE_URL`) for your target database.
2) Run migrations via the scripted migrator (single source of truth):
   ```bash
   pnpm db:migrate
   ```
3) Verify RLS:
   ```bash
   pnpm db:verify-rls
   ```
4) Verify schema sanity (critical tables/functions/columns):
   ```bash
   pnpm db:verify-schema
   ```
5) Print the exact ordered migration manifest from filesystem:
   ```bash
   pnpm migrations:list
   ```
6) If your database was created from an older/broken migration sequence (for example, only one of the legacy usage migrations was applied), just rerun:
   ```bash
   pnpm db:migrate
   ```
   The migrator now self-heals that legacy drift and applies the canonical usage RPC repair migration automatically.
7) Ensure env vars are set in Cloudflare Worker (or `.dev.vars` locally):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_API_KEY`
   - `API_KEY_SALT`
   - `MASTER_ADMIN_TOKEN`
   - `EMBEDDINGS_MODE` (`openai` or `stub`; use `stub` for local dev to avoid OpenAI calls)

Migration manifest (CI-checked): `MIGRATIONS_TOTAL=27; MIGRATIONS_LATEST=025_api_keys_last_used.sql`

## Admin & Bootstrap
- Admin endpoints require header `x-admin-token: $MASTER_ADMIN_TOKEN`.
- Quick bootstrap for local dev:
  ```bash
  MASTER_ADMIN_TOKEN=secret \
  node scripts/dev_bootstrap.mjs
  ```
  By default this runs `pnpm db:migrate`, `pnpm db:verify-rls`, and `pnpm db:verify-schema` first when `DATABASE_URL`/`SUPABASE_DB_URL` is set.
  Set `BOOTSTRAP_SKIP_DB_CHECKS=1` to skip DB bootstrap checks.
  Outputs a workspace ID and one-time API key plus sample curl commands.

## Local Env File
Copy the template and fill values before running wrangler:
```bash
cp apps/api/.dev.vars.template apps/api/.dev.vars
```

## RLS quick verification
Apply migrations, then in Supabase SQL:
```sql
-- Tenant visibility (should see only own workspace rows)
set local role authenticated;
set local "request.jwt.claims" = '{"workspace_id":"00000000-0000-0000-0000-000000000001"}';
select count(*) from memories where workspace_id <> '00000000-0000-0000-0000-000000000001'::uuid; -- expect 0

-- Spoofing a different workspace claim without membership should still return 0
set local "request.jwt.claims" = '{"workspace_id":"ffffffff-ffff-ffff-ffff-ffffffffffff"}';
select count(*) as cross_visible from memories; -- expect 0

-- Service role bypass (should see everything)
reset role;
set local role service_role;
select count(*) from memories;
```
See `infra/sql/verify_rls.sql` for an automated checklist.

### Schema sanity checklist (humans)
- Run:
  ```bash
  DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require pnpm db:verify-schema
  ```
- This executes `infra/sql/verify_schema.sql` and fails if critical schema objects are missing (`workspaces`, `api_keys`, `memories`, `workspace_members`, `usage_daily`, `product_events`, `payu_webhook_events`, `payu_transactions`, `workspace_entitlements`, and key RPCs).

> Note: user_metadata claims are user-editable. Policies enforce membership in `workspace_members` so spoofed claims cannot break isolation.

### Workspace creation under RLS
- Use the RPC `select * from create_workspace('My Workspace')` (or dashboard UI) to create a workspace. The function inserts the workspace and adds the caller to `workspace_members` as `owner` in one transaction and runs as `security definer` to bypass RLS safely.

### API key management (RLS-safe)
- Create key: `select * from create_api_key('my-key-name', '<workspace_uuid>'::uuid);` — returns the plaintext key once plus masked fields.
- List keys: `select * from list_api_keys('<workspace_uuid>'::uuid);` — masked only (no plaintext).
- Revoke: `select * from revoke_api_key('<key_uuid>'::uuid);`

