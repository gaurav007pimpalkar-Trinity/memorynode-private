## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# MemoryNode Monorepo

Verify live configuration and [../external/API_USAGE.md](../external/API_USAGE.md) for API behavior before acting.

## Layout
- `apps/api` – Cloudflare Worker API.
- `apps/dashboard` – implemented dashboard web app (project experience, keys, memories, usage, activation, settings).
- `packages/shared` – shared types.
- `packages/sdk` – lightweight TypeScript SDK.
- `infra/sql` – SQL migrations and schema (apply in order).
- `docs` – documentation.
- `docs/DOCUMENTATION_INDEX.md` – inventory of all top-level docs and mapping to code.
- `docs/internal/RELEASE_RUNBOOK.md` – canonical staging/prod release, validation, rollback, and kill switches.
- `docs/internal/PROD_READY.md` – final go/no-go checklist.
- `docs/internal/ALERTS.md` – lightweight monitoring + alert thresholds and Cloudflare setup notes.
- `docs/external/README.md` – product overview (what it is, who for, capabilities).
- `docs/external/POSITIONING.md` – canonical ICP, promise, and non-goals (keep marketing aligned).
- `docs/start-here/README.md` – get value quickly (API key, store, search).
- `docs/external/API_USAGE.md` – how to call the API and SDK (inputs, outputs, errors).
- `docs/internal/GTM_PLAYBOOK_2026.md` – messaging, agency one-pager, checklist, metrics (internal).

## Documentation Map (Reading Order)

Follow this path depending on what you need:

### New developer? Start here:

1. **`docs/start-here/README.md`** — Mode 1: hosted API, key + four calls in minutes
1. **`docs/external/POSITIONING.md`** — who it is for and what we explicitly are not
1. **`docs/external/API_USAGE.md`** — Mode 2: advanced usage (filters, SDK, OpenAPI)
1. **`docs/external/RECIPE_*.md`** — support, SaaS copilot, SMB chatbot copy-paste paths
1. **`docs/external/API_USAGE.md`** — API field reference (inputs, outputs, errors)
1. **`docs/self-host/LOCAL_DEV.md`** — Mode 3: run the Worker locally (contributors)

### Solo founder / non-technical CTO?

- **`docs/internal/OPERATIONAL_GUIDE.md`** — Single operational guide: how the system works, what healthy looks like, before/after release, when something seems off, minor vs major issues. No code; plain language.

### Deploying to production?

1. **`docs/internal/GO_LIVE_CHECKLIST.md`** — one-page must-do list before first prod traffic
1. **`docs/PROD_SETUP_CHECKLIST.md`** — founder production input checklist (Cloudflare, Supabase, PayU, DNS)
1. **`docs/PRODUCTION_REQUIREMENTS.md`** — production must use real services (no stubs); enforced by Worker and release gate
1. **`docs/internal/RELEASE_RUNBOOK.md`** — canonical staging → production deploy, validate, rollback
1. **`docs/internal/PROD_READY.md`** — final go/no-go checklist and what-you-need-to-do handoff

### Operating in production?

1. **`docs/internal/OBSERVABILITY.md`** — golden metrics, structured events, 60-second health checklist
1. **`docs/internal/ALERTS.md`** — alert definitions mapped 1:1 to golden metrics, triage playbooks
1. **`docs/internal/INCIDENT_RUNBOOKS.md`** — severity model, escalation ownership, and incident playbooks
1. **`docs/internal/LEAST_PRIVILEGE_ROADMAP.md`** — service-role → RPC-first → RLS-first migration guide
1. **`docs/OPERATIONS.md`** — incident checklist, rollback notes, operator procedures
1. **`docs/SECURITY.md`** — secrets hygiene, PayU secret rotation, incident response
1. **`docs/internal/BILLING_RUNBOOK.md`** — PayU webhook ops, replay/reprocess, reconciliation

### Testing?

- Run `pnpm test` for unit tests (Vitest, 150+ tests)
- Shared test helpers in `apps/api/tests/helpers/` (env, supabase, payu, rate_limit_do)
- Run `pnpm smoke` (or `pnpm smoke:ps` on Windows) for local E2E smoke
- See "Local smoke test" and "E2E smoke" sections below for details

### User-facing docs (external):

- **`docs/external/README.md`** — product overview for users and stakeholders
- **`docs/start-here/README.md`** — quick path to first API use
- **`docs/external/API_USAGE.md`** — API and SDK usage

## Billing (PayU)

- Production billing is PayU-only. See `docs/internal/BILLING_RUNBOOK.md` for webhook ops and `docs/PROD_SETUP_CHECKLIST.md` for PayU setup.

## Plans & Limits

**Launch is the paid 7-day trial entry plan.**

| Plan    | Price (INR) | Period   | Limits (per day) |
|---------|-------------|----------|-------------------|
| Launch  | ₹299        | 7 days  | writes, reads, embed_tokens (see below) |
| Build   | ₹499        | per month | Higher caps     |
| Deploy  | ₹1,999      | per month | Higher caps     |
| Scale   | ₹4,999      | per month | Higher caps     |
| Scale+  | custom      | custom  | Custom            |

**Limiter model (Phase 0):** `writes/day`, `reads/day`, `embed_tokens/day`. When `embed_tokens/day` is exceeded, ingest and search/context are blocked (hard gate). In the API, usage is tracked as writes, reads, and embeds (~200 tokens per embed).

**Rate limiting:** Default **60 req/min** per API key. New keys: **15 req/min** for the first 24–48h.

**Cost math (embedding):** Model `text-embedding-3-small`; **$0.02 / 1M tokens** (Batch $0.01/1M as future option). Assume ~200 tokens per embed. Examples: 600 embeds/day → ~3.6M tokens/month → ~$0.072/month; 8,000 → ~$0.96/month; 40,000 → ~$4.80/month; 200,000 → ~$24/month.

**Base infra (early stage):** Cloudflare Workers ~$5–15, Supabase Pro $25, dashboard hosting $0 → **~$30–40 total**. Break-even (word cautiously): ~6 Build OR ~2 Deploy OR ~1 Scale.

Exact limits per plan: `packages/shared/src/plans.ts`. API and dashboard read from this single source. PayU amounts can be overridden via env: `PAYU_LAUNCH_AMOUNT`, `PAYU_BUILD_AMOUNT`, `PAYU_DEPLOY_AMOUNT`, `PAYU_SCALE_AMOUNT` (see `apps/api/.dev.vars.template` and `docs/PROD_SETUP_CHECKLIST.md`).

Internal DB fields may still store legacy values (`pro`/`team`) for backward compatibility. Externally we use `effective_plan` = plan_code (`launch`/`build`/`deploy`/`scale`/`scale_plus`).

## Canonical Ops Docs (Source of Truth)

- `docs/internal/RELEASE_RUNBOOK.md` – canonical staging/production deploy, validate, rollback, kill switches.
- `docs/internal/PROD_READY.md` – canonical go/no-go checklist.
- `docs/internal/BILLING_RUNBOOK.md` – PayU webhook operations, replay/reprocess, reconciliation behavior.
- `docs/internal/OBSERVABILITY.md` – golden metrics, structured events, health checklist, SLOs.
- `docs/internal/ALERTS.md` – alert definitions, thresholds, triage playbooks (maps 1:1 to OBSERVABILITY).
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
- Billing webhook runbook: `docs/internal/BILLING_RUNBOOK.md`

## Analytics & Observability

- **Golden metrics and structured events**: see `docs/internal/OBSERVABILITY.md` for the complete event catalog, golden metrics, and 60-second health checklist.
- **Alert definitions**: see `docs/internal/ALERTS.md` for alert thresholds mapped 1:1 to golden metrics.
- Product event names (persisted to `product_events`): `workspace_created`, `api_key_created`, `first_ingest_success`, `first_search_success`, `first_context_success`, `cap_exceeded`, `checkout_started`, `upgrade_activated`.
- Structured log event names: `request_completed` (with `route_group`), `request_failed`, `cap_exceeded`, `embed_request`, `search_request`, `db_rpc`, `audit_log`, `webhook_received`, `webhook_verified`, `webhook_processed`, `webhook_replayed`, `webhook_deferred`, `webhook_reconciled`, `webhook_failed`, `billing_webhook_signature_invalid`, `billing_webhook_workspace_not_found`, `billing_endpoint_error`.

## Quick path (zero → one memory + one search, &lt;15 min)

```bash
pnpm install
cp .env.example .env && cp apps/api/.dev.vars.template apps/api/.dev.vars   # fill SUPABASE_*, API_KEY_SALT, MASTER_ADMIN_TOKEN, EMBEDDINGS_MODE=stub
DATABASE_URL=postgres://... pnpm db:migrate
pnpm dev:api   # terminal 1
pnpm --filter @memorynode/dashboard dev   # terminal 2 -> dashboard, create project + API key
# curl ingest + search (see docs/start-here/README.md)
```

Full steps: `docs/start-here/README.md` and `docs/external/API_USAGE.md`.

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
2) Run the end-to-end smoke (starts API with stub embeddings, bootstraps project/key, exercises memories/search/context):
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
- `ALLOWED_ORIGINS`: comma-separated allowed origins for CORS. If unset, the API does not send CORS headers, so cross-origin browser requests (e.g. dashboard) will fail; **in production this is required** (release:gate fails without it). Use `*` to explicitly allow all origins.
- `MAX_BODY_BYTES`: maximum request body size in bytes (default 1,000,000).
- `MAX_IMPORT_BYTES`: maximum allowed size (bytes) for `/v1/import` artifacts (default 10,000,000).
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

### Import (paid plans)
- `POST /v1/import` accepts `{ artifact_base64, mode? }` and restores memories/chunks for the authenticated project only (internal workspace row).
- `mode` defaults to non-destructive `upsert`; see API docs for other modes.
- Free plans return `402 UPGRADE_REQUIRED`.

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

Migration manifest (CI-checked): `MIGRATIONS_TOTAL=65; MIGRATIONS_LATEST=063_workspace_trial.sql`

## Admin & Bootstrap
- Admin endpoints require header `x-admin-token: $MASTER_ADMIN_TOKEN`.
- Quick bootstrap for local dev:
  ```bash
  MASTER_ADMIN_TOKEN=secret \
  node scripts/dev_bootstrap.mjs
  ```
  By default this runs `pnpm db:migrate`, `pnpm db:verify-rls`, and `pnpm db:verify-schema` first when `DATABASE_URL`/`SUPABASE_DB_URL` is set.
  Set `BOOTSTRAP_SKIP_DB_CHECKS=1` to skip DB bootstrap checks.
  Outputs a project ID (`workspace_id`) and one-time API key plus sample curl commands.

## Local Env File
Copy the template and fill values before running wrangler:
```bash
cp apps/api/.dev.vars.template apps/api/.dev.vars
```

## RLS quick verification
Apply migrations, then in Supabase SQL:
```sql
-- Tenant visibility (should see only own project rows; internal workspace_id)
set local role authenticated;
set local "request.jwt.claims" = '{"workspace_id":"00000000-0000-0000-0000-000000000001"}';
select count(*) from memories where workspace_id <> '00000000-0000-0000-0000-000000000001'::uuid; -- expect 0

-- Spoofing a different project claim without membership should still return 0
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

### Project creation under RLS
- Use the RPC `select * from create_workspace('My Project')` (or dashboard UI) to create a project. The function inserts the internal workspace row and adds the caller to `workspace_members` as `owner` in one transaction and runs as `security definer` to bypass RLS safely.

### API key management (RLS-safe)
- Create key: `select * from create_api_key('my-key-name', '<workspace_uuid>'::uuid);` — returns the plaintext key once plus masked fields.
- List keys: `select * from list_api_keys('<workspace_uuid>'::uuid);` — masked only (no plaintext).
- Revoke: `select * from revoke_api_key('<key_uuid>'::uuid);`

---

## Release gate (merged from RELEASE_GATE.md)

Canonical release process: `docs/internal/RELEASE_RUNBOOK.md`.

Gate command:

```bash
pnpm release:gate
```

`release:gate` runs:
1) `pnpm check:typed-entry`
2) `pnpm check:wrangler`
3) `pnpm check:config`
4) `pnpm secrets:check`
5) `pnpm secrets:check:tracked`
6) `pnpm migrations:check`
7) `pnpm -w lint`
8) `pnpm -w typecheck`
9) `pnpm -w test`

Optional build:

```bash
RELEASE_INCLUDE_BUILD=1 pnpm release:gate
```

DB-inclusive gate:

```bash
pnpm release:gate:full
```

---

## Production deploy notes (merged from PRODUCTION_DEPLOY.md)

Canonical deploy/rollback workflow: `docs/internal/RELEASE_RUNBOOK.md`, `docs/internal/PROD_READY.md`.

### Vars vs Secrets
- Safe `[vars]` (checked into `apps/api/wrangler.toml`): `SUPABASE_URL`, `SUPABASE_MODE`, `EMBEDDINGS_MODE`, `ENVIRONMENT`, `RATE_LIMIT_MODE`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, optional `PAYU_SUCCESS_PATH`, `PAYU_CANCEL_PATH`, `PAYU_PRO_AMOUNT`, `PAYU_PRODUCT_INFO`, `PAYU_CURRENCY`.
- Secrets (set with `wrangler secret put NAME` in Cloudflare, never in `[vars]`): `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, optional `PAYU_WEBHOOK_SECRET`.
- Reason: Cloudflare overwrites dashboard secrets with values from `[vars]` on deploy. Keeping secrets out of `[vars]` preserves existing secret values.

### Required bindings
- Durable Object binding for rate limit:
  ```
  [durable_objects]
  bindings = [{ name = "RATE_LIMIT_DO", class_name = "RateLimitDO" }]

  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["RateLimitDO"]
  ```

### Validation & guardrails
- Runtime: startup checks fail with `CONFIG_ERROR` if secrets are missing in prod/staging (message tells you to run `wrangler secret put ...`).
- Static: `pnpm check:wrangler` blocks commits if secret-like values appear in `wrangler.toml` vars blocks (`[vars]` and `[env.<name>.vars]`).

### Deploy steps (prod/staging)
1) Run `pnpm check:wrangler && pnpm typecheck && pnpm test`.
2) Set/update secrets: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (repeat for others).
3) Verify `[vars]` only contains safe values; ensure `ENVIRONMENT=production` (or `staging`), `SUPABASE_MODE` not `stub`, `EMBEDDINGS_MODE=openai`.
4) Deploy with repo scripts (no global wrangler dependency):
   - Staging: `pnpm --filter @memorynode/api deploy:staging`
   - Production: `pnpm --filter @memorynode/api deploy:production`
5) Post-deploy: verify `/healthz`, `/v1/memories`, `/v1/search`, `/v1/billing/status`.

---

## Dashboard deployment

Canonical steps, env vars, and caveats: **[DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md)**.

Summary: `pnpm dashboard:deploy:pages` from repo root (or GitHub Actions **Dashboard Pages Deploy**) builds **both** `VITE_APP_SURFACE` targets and deploys `memorynode-console` and `memorynode-app` from the same checkout. Founder routing uses `apps/dashboard/public/_redirects`; security headers are in `apps/dashboard/public/_headers`.

**CORS:** `ALLOWED_ORIGINS` on the API Worker must include `https://console.memorynode.ai` and `https://app.memorynode.ai`.

---

## Dashboard session setup (merged from DASHBOARD_SESSION_SETUP.md)

Tables/columns: `infra/sql/023_dashboard_sessions.sql`, `infra/sql/024_dashboard_sessions_csrf.sql`.

**Option A (recommended):** Set `SUPABASE_DB_URL`, run `pnpm db:migrate`. Confirm with `select * from dashboard_sessions limit 0` or `pnpm db:verify-schema`.

**Option B:** Run SQL manually in Supabase SQL Editor; if using `memorynode_migrations`, insert a row for `023_dashboard_sessions.sql` so the migrator doesn’t re-apply.

**SUPABASE_ANON_KEY:** Required in production for dashboard session (Worker calls Supabase Auth Get User). Set via `wrangler secret put SUPABASE_ANON_KEY`. Release:gate fails if missing.

**Local dev:** Session cookie is Secure on HTTPS; on HTTP (localhost) the code sets cookie without Secure so it works. Tunnel (ngrok) with HTTPS works.

**Recap:** API keys created via Supabase RPC; plaintext shown once. Dashboard ↔ Worker use session cookie only (`mn_dash_session`). Sign out: `POST /v1/dashboard/logout` and Supabase sign out. No long-lived API keys in browser (CI gate G2).

---

## Identity and tenancy (merged from IDENTITY_TENANCY.md)

**Auth:** Supabase Auth (email magic link + OAuth). **Mapping:** Auth user -> project membership (`workspace_members`) -> API keys scoped to project.

**Flow:** 1) Login -> Supabase Auth (session with `user.id`). 2) Project selection -> User picks current project (stored client-side as `workspace_id` only — not secret). 3) Dashboard calls -> Use authenticated `user.id` and current `workspace_id`; API key is project-scoped. 4) Memory search / user-scoped calls -> Send `userId: session.user.id` (and optional `scope`); no hardcoded user.

**Enforcement map:** Project selection = stored client-side as `workspace_id` only. Authorization = server verifies project membership on every dashboard/API call. API scope = `workspace_id` mandatory for dashboard calls; server rejects mismatches. Revocation = membership removal invalidates access immediately.

**No stale project:** On 401/403, the UI forces project reselect and clears cached selection (apiClient `onUnauthorized` clears session, shows “Session expired or access denied”, clears persisted `workspace_id`). Optional: subscribe to membership changes or poll on load.

