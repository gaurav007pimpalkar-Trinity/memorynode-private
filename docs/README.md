# MemoryNode Monorepo

## Layout
- `apps/api` – Cloudflare Worker API.
- `apps/dashboard` – placeholder dashboard app.
- `packages/shared` – shared types.
- `packages/sdk` – lightweight TypeScript SDK.
- `infra/sql` – SQL migrations and schema (apply in order).
- `docs` – documentation.
- `docs/LAUNCH_CHECKLIST.md` – go-live checklist (envs, Stripe, RLS, smoke, rollback).
- `docs/QUICKSTART.md` – 10-minute developer quickstart (envs, migrations, dev servers, curls).
- `docs/API_REFERENCE.md` – endpoint reference (Worker API, admin, billing, plans).

## Analytics events (minimal)
- See `docs/LAUNCH_CHECKLIST.md` and product events table (`infra/sql/013_events.sql`).
- Event names: `workspace_created`, `api_key_created`, `first_ingest_success`, `first_search_success`, `first_context_success`, `cap_exceeded`, `checkout_started`, `upgrade_activated`, optional `billing_portal_opened`, `export_completed`.
- Stored fields: `workspace_id`, `event_name`, `request_id`, `route`, `method`, `status`, `effective_plan`, `plan_status`, `props` (redacted-safe counts/booleans only).

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
| 500 errors | DB migrations not applied | Run `infra/sql/001_init.sql`, `002_rpc.sql`, `003_usage_rpc.sql` |
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

### Prod secrets (Cloudflare Workers)
- Do **not** place secrets in `apps/api/wrangler.toml [vars]`; Cloudflare will overwrite dashboard secrets on deploy.
- Set secrets with `wrangler secret put NAME`: `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Safe vars that can live in `[vars]`: `SUPABASE_URL`, `SUPABASE_MODE`, `EMBEDDINGS_MODE`, `ENVIRONMENT`, `RATE_LIMIT_MODE`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, Stripe price ids/paths.

### Security-related env vars
- `ALLOWED_ORIGINS`: comma-separated allowed origins for CORS. If unset, CORS is not enabled. Use `*` to explicitly allow all.
- `MAX_BODY_BYTES`: maximum request body size in bytes (default 1,000,000).
- `MAX_IMPORT_BYTES`: maximum allowed size (bytes) for `/v1/import` artifacts (default 10,000,000).
- `MAX_EXPORT_BYTES`: maximum allowed size (bytes) for `/v1/export` artifacts (default 10,000,000).
- `AUDIT_IP_SALT`: salt used to hash IPs in audit logs.
- `API_KEY_SALT`: prefer setting via environment in prod; the database `app_settings.api_key_salt` is a dev fallback. If both are present and differ, the Worker fails fast with `CONFIG_ERROR` to prevent mismatched key hashes.

### Billing env vars (foundation)
- Required for billing endpoints:
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `STRIPE_PRICE_PRO`
  - `STRIPE_PRICE_TEAM`
  - `PUBLIC_APP_URL` (used for return/cancel URLs)
- Optional:
  - `STRIPE_PORTAL_CONFIGURATION_ID`
  - `STRIPE_SUCCESS_PATH` (default `/settings/billing?status=success`)
  - `STRIPE_CANCEL_PATH` (default `/settings/billing?status=canceled`)
  - `STRIPE_PRICE_TEAM` (required when selling Team plan)

### Billing plan states
- Stored on `workspaces`: `plan` (`free|pro|team`) and `plan_status` (`free|trialing|active|past_due|canceled`).
- Effective caps: `active`/`trialing` → paid caps for the plan; `past_due`/`canceled`/`free` → free caps.

### Billing endpoints
- `GET /v1/billing/status` (API key auth) → `{ plan, plan_status, effective_plan, current_period_end, cancel_at_period_end }`
- `POST /v1/billing/checkout` (API key auth) – creates Stripe Checkout session for the caller's workspace (customer auto-created if missing). Body supports `{ plan: "pro" | "team" }`.
- `POST /v1/billing/portal` (API key auth) – opens Stripe Billing Portal (409 if no customer/checkout yet).
- `POST /v1/billing/webhook` – Stripe webhook receiver (verify with `STRIPE_WEBHOOK_SECRET`); handle `customer.subscription.*` and `invoice.*` events.
- Cap exceedances now return HTTP 402 with `error.code="CAP_EXCEEDED"`, `upgrade_required=true`, `effective_plan`, and `upgrade_url=${PUBLIC_APP_URL}/settings/billing`.
- Checkout retries: clients may send `Idempotency-Key` on `/v1/billing/checkout`; the Worker forwards a stable idempotency key to Stripe to avoid duplicate sessions.

### Stripe webhook setup
- Endpoint: `/v1/billing/webhook`
- Recommended events: `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid`, `invoice.payment_failed`
- Customer metadata includes `workspace_id` so reconciliation can fall back if the Stripe customer link is missing.

### Stripe Webhook Events
- Endpoint path: `/v1/billing/webhook`
- Required events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
- The webhook verifies the Stripe signature against the raw request bytes; failures return 400 `WEBHOOK_SIGNATURE_INVALID`.
- If no workspace is found for a customer/metadata, the webhook returns 200 `{ received: true }` and logs a redacted warning (no payload data logged).

### What to watch in logs (structured JSON, single line each)
Each log includes: `event_name`, `ts`, `route`, `method`, `status`, `request_id`, `workspace_id_redacted` (if known), `effective_plan`, `plan_status` (when applicable). No bodies/headers/Stripe objects are logged.

| event_name | What it means | Likely causes | What to do | Example (redacted) |
| --- | --- | --- | --- | --- |
| `billing_webhook_signature_invalid` | Stripe webhook signature check failed; event ignored. | Wrong `STRIPE_WEBHOOK_SECRET`, hitting wrong endpoint URL, proxy altering body. | 1) Verify env `STRIPE_WEBHOOK_SECRET` matches Stripe dashboard. 2) Confirm endpoint path `/v1/billing/webhook`. 3) Ensure webhook sends raw body (no middleware altering). | `{"event_name":"billing_webhook_signature_invalid","ts":"2026-02-01T12:00:00Z","route":"/v1/billing/webhook","method":"POST","status":400,"request_id":"req-123"}` |
| `billing_webhook_workspace_not_found` | Webhook event couldn’t map customer to a workspace. | Customer created outside our checkout flow; missing `stripe_customer_id` in DB; metadata.workspace_id absent/mismatched. | 1) Search Stripe customer ID in DB `workspaces.stripe_customer_id`. 2) If missing, backfill the mapping to the correct workspace. 3) Re-send the Stripe event from dashboard. | `{"event_name":"billing_webhook_workspace_not_found","ts":"2026-02-01T12:00:01Z","route":"/v1/billing/webhook","method":"POST","status":200,"request_id":"req-raw","customer_id_redacted":"cus_***","workspace_id_redacted":"ws_***"}` |
| `cap_exceeded` | Request blocked due to daily caps, using effective plan. | User legitimately hit limits; plan_status past_due/canceled falling back to free caps; caps set too low. | 1) Check `effective_plan` and `plan_status` in log. 2) If paid user, inspect billing state; if past_due, prompt payment. 3) If free plan, suggest upgrade. 4) If caps too low, adjust limits config. | `{"event_name":"cap_exceeded","ts":"2026-02-01T12:00:02Z","route":"/v1/search","method":"POST","status":402,"request_id":"req-789","workspace_id_redacted":"ws_***","effective_plan":"free","plan_status":"past_due"}` |
| `billing_endpoint_error` | Billing status/checkout/portal failed. | Stripe env vars missing/invalid; Stripe API error; DB error persisting customer id. | 1) Check `route` and `status` in log. 2) Verify Stripe env vars (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `PUBLIC_APP_URL`, portal config). 3) Retry the call; if persistent, check Stripe dashboard logs for the request_id. | `{"event_name":"billing_endpoint_error","ts":"2026-02-01T12:00:03Z","route":"/v1/billing/portal","method":"POST","status":409,"request_id":"req-456","workspace_id_redacted":"ws_***"}` |

### Export / Import
- `POST /v1/export`
  - Default: JSON `{ artifact_base64, bytes, sha256 }` (deterministic ZIP encoded as base64).
  - Binary: set `Accept: application/zip` **or** `?format=zip` to receive a ZIP payload with `Content-Type: application/zip` and a download filename `memorynode-export-<workspace>-<yyyy-mm-dd>.zip`.
  - Both modes enforce `MAX_EXPORT_BYTES` and return 413 on overflow.
- `POST /v1/import` accepts `{ artifact_base64, mode? }` and restores memories/chunks for the authenticated workspace only. `mode` defaults to non-destructive `upsert`; see API docs for other modes.

### Billing status API
- `GET /v1/billing/status` (API key auth) → `{ plan, plan_status, current_period_end, cancel_at_period_end }`
- No Stripe calls yet; values come from `workspaces` billing columns.

## Database Setup (Supabase)
1) Open Supabase SQL editor.
2) Run migrations in order:
   - `infra/sql/001_init.sql`
   - `infra/sql/002_rpc.sql`
   - `infra/sql/003_usage_rpc.sql`
   - `infra/sql/004_workspace_plan.sql`
   - `infra/sql/005_api_audit_log.sql`
   - `infra/sql/006_rls.sql`
   - `infra/sql/007_current_workspace_patch.sql`
   - `infra/sql/008_membership_rls.sql`
   - `infra/sql/009_workspace_rpc.sql`
   - `infra/sql/010_api_keys_mask.sql`
   - `infra/sql/011_api_key_rpcs.sql`
   - `infra/sql/012_billing.sql`
3) Ensure env vars are set in Cloudflare Worker (or `.dev.vars` locally):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_API_KEY`
   - `API_KEY_SALT`
   - `MASTER_ADMIN_TOKEN`
   - `EMBEDDINGS_MODE` (`openai` or `stub`; use `stub` for local dev to avoid OpenAI calls)

## Admin & Bootstrap
- Admin endpoints require header `x-admin-token: $MASTER_ADMIN_TOKEN`.
- Quick bootstrap for local dev:
  ```bash
  MASTER_ADMIN_TOKEN=secret \
  node scripts/dev_bootstrap.mjs
  ```
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

> Note: user_metadata claims are user-editable. Policies enforce membership in `workspace_members` so spoofed claims cannot break isolation.

### Workspace creation under RLS
- Use the RPC `select * from create_workspace('My Workspace')` (or dashboard UI) to create a workspace. The function inserts the workspace and adds the caller to `workspace_members` as `owner` in one transaction and runs as `security definer` to bypass RLS safely.

### API key management (RLS-safe)
- Create key: `select * from create_api_key('my-key-name', '<workspace_uuid>'::uuid);` — returns the plaintext key once plus masked fields.
- List keys: `select * from list_api_keys('<workspace_uuid>'::uuid);` — masked only (no plaintext).
- Revoke: `select * from revoke_api_key('<key_uuid>'::uuid);`
